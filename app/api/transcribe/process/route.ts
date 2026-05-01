/**
 * SubAI — Transcription Engine v10.2 (Plain Text + Sentence-Aware Auto Split)
 * ═══════════════════════════════════════════════════════════════
 * ASYNC PROCESSING ENDPOINT — Called internally by /api/transcribe
 *
 * CHANGES FROM v10.1:
 * ═══════════════════════════════════════════════════════════════
 * 1. SRT output is now PLAIN TEXT — no invisible RTL wrappers
 *    (RLE / RLM / PDF removed). Editors that auto-detect Hebrew/Arabic
 *    will still render right-to-left; the file is just clean text.
 * 2. splitAuto rewritten to be sentence-aware:
 *    - At SOFT length, looks ahead for the next sentence-end (.!?)
 *      or comma (,). If reachable within HARD, WAITS for it instead
 *      of breaking mid-clause.
 *    - This eliminates the "זנב של המשפט הקודם פותח את הבא" bug,
 *      e.g. "יהודה אוהב לאכול" / "בננה, ומשה אוהב פיסטוק" — the
 *      splitter now extends to the comma and produces:
 *      "יהודה אוהב לאכול בננה," / "ומשה אוהב פיסטוק."
 *    - Hard cap (HARD chars / MAXD seconds) still enforced as a
 *      safety net when sentences are too long to fit a single line.
 *    - countTail still pulls dangling connectors forward when a
 *      forced break is unavoidable.
 *
 * IRON LAW: SRT TIMESTAMPS ARE WHISPER'S ORIGINALS — NEVER MODIFIED.
 *           AI may only add/adjust punctuation; word count must match.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { S3Client, DeleteObjectCommand } from "@aws-sdk/client-s3";

export const maxDuration = 300;

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const AWS_REGION = process.env.AWS_REGION || "eu-north-1";
const S3_BUCKET = process.env.S3_BUCKET || "subai-audio";
const MODAL_ENDPOINT = process.env.MODAL_ENDPOINT_URL!;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const PROCESS_SECRET = process.env.PROCESS_SECRET || "subai-internal-process-key";

// ═══════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════

const AI_CONFIG = {
  model: "claude-haiku-4-5-20251001",
  maxTokens: 8192,
  timeoutMs: 45000,

  batchSize: 60,     // Punctuation-only is lighter → larger batches OK
  batchOverlap: 4,
};

// Splitting tuning
const SPLIT_CONFIG = {
  // word4+ smart-break thresholds
  pauseGapSec: 0.45,        // a silence ≥ this between words → natural break
  earlyBreakSlackBefore: 1, // for gs≥4, allow break at (gs - earlyBreakSlackBefore) on .!?
  bindingExtraSlots: 2,     // allow up to gs + bindingExtraSlots when bound
};

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const s3 = new S3Client({
  region: AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

interface Segment { start: number; end: number; text: string; }
interface Word { start: number; end: number; word: string; probability?: number; }
interface TimedSegment { start: number; end: number; text: string; words: Word[]; }

// ══════════════════════════════════════════════════════════════
// DATABASE (unchanged)
// ══════════════════════════════════════════════════════════════

async function logUsage(
  userId: string, audioDur: number, lang: string, model: string,
  status: string, count = 0, procSec = 0, errMsg = "",
) {
  const mins = Math.ceil((audioDur / 60) * 10) / 10;
  await supabase.from("usage_log").insert({
    user_id: userId, audio_duration_sec: audioDur, minutes_charged: mins,
    language: lang, model, segments_count: count, processing_sec: procSec,
    status, error_message: errMsg,
  });
  return mins;
}

async function deductMinutes(userId: string, mins: number) {
  try {
    await supabase.rpc("increment_usage", { p_user_id: userId, p_minutes: mins });
    return;
  } catch {}
  try {
    const { data } = await supabase.from("profiles").select("minutes_used").eq("id", userId).single();
    if (data) {
      await supabase.from("profiles").update({ minutes_used: (data.minutes_used || 0) + mins }).eq("id", userId);
    }
  } catch {}
}

// ══════════════════════════════════════════════════════════════
// JOB STATUS HELPERS
// ══════════════════════════════════════════════════════════════

async function updateJobStatus(jobId: string, status: string) {
  await supabase
    .from("transcription_jobs")
    .update({ status })
    .eq("id", jobId);
}

async function failJob(jobId: string, errorMessage: string) {
  await supabase
    .from("transcription_jobs")
    .update({
      status: "failed",
      error_message: errorMessage,
      completed_at: new Date().toISOString(),
    })
    .eq("id", jobId);
}

// ══════════════════════════════════════════════════════════════
// STEP 1: BUILD TIMED SEGMENTS (unchanged)
// ══════════════════════════════════════════════════════════════

function buildTimedSegments(segments: Segment[], words: Word[]): TimedSegment[] {
  if (!words || words.length === 0) {
    return segments.map((seg) => ({
      ...seg,
      words: seg.text.split(/\s+/).filter((w) => w).map((w, i, arr) => {
        const dur = seg.end - seg.start;
        const wd = dur / arr.length;
        return {
          start: +(seg.start + i * wd).toFixed(3),
          end: +(seg.start + (i + 1) * wd).toFixed(3),
          word: w,
        };
      }),
    }));
  }

  const result: TimedSegment[] = [];
  let wIdx = 0;

  for (const seg of segments) {
    const sw: Word[] = [];
    while (wIdx < words.length) {
      const w = words[wIdx];
      if (w.start >= seg.start - 0.15 && w.start < seg.end + 0.15) {
        sw.push(w);
        wIdx++;
      } else if (w.start >= seg.end + 0.15) {
        break;
      } else {
        wIdx++;
      }
    }
    result.push({
      start: sw.length > 0 ? sw[0].start : seg.start,
      end: sw.length > 0 ? sw[sw.length - 1].end : seg.end,
      text: sw.length > 0 ? sw.map((w) => w.word).join(" ") : seg.text,
      words: sw,
    });
  }

  if (wIdx < words.length) {
    const rem = words.slice(wIdx);
    result.push({
      start: rem[0].start, end: rem[rem.length - 1].end,
      text: rem.map((w) => w.word).join(" "), words: rem,
    });
  }
  return result;
}

// ══════════════════════════════════════════════════════════════
// STEP 1.5: HALLUCINATION FILTER (unchanged)
// ══════════════════════════════════════════════════════════════

function isGarbageSegment(text: string): boolean {
  const latin = (text.match(/[a-zA-Z]/g) || []).length;
  const greek = (text.match(/[\u0370-\u03FF]/g) || []).length;
  const symbols = (text.match(/[Ó€¡¢£¥©®™°±×÷]/g) || []).length;
  const total = text.replace(/\s/g, "").length;
  if (total === 0) return true;
  return (latin + greek + symbols) / total > 0.3;
}

function filterHallucinations(
  segments: Segment[], words: Word[], prompt: string,
): { segments: Segment[]; words: Word[] } {
  const filtered: Segment[] = [];
  let removedCount = 0;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const dur = seg.end - seg.start;
    const text = seg.text.trim();
    const textWords = text.split(/\s+/).filter((w) => w);
    const uniqueWords = new Set(textWords.map((w) => w.replace(/[.!?,;:]/g, ""))).size;

    let skip = false;
    let reason = "";

    if (dur > 5 && uniqueWords <= 2 && textWords.length >= 3) {
      skip = true; reason = "stuck loop";
    }
    if (dur > 6 && textWords.length <= 1) {
      skip = true; reason = `single word ${dur.toFixed(1)}s`;
    }
    if (dur > 10 && textWords.length <= 3) {
      skip = true; reason = "too long for content";
    }
    if (i > 0 && text === segments[i - 1].text.trim()) {
      skip = true; reason = "exact duplicate";
    }
    if (prompt && text.length > 5) {
      const ct = text.replace(/[.!?,;:\s]/g, "");
      const cp = prompt.replace(/[.!?,;:\s]/g, "");
      if (cp.includes(ct) || ct.includes(cp)) {
        skip = true; reason = "prompt leak";
      }
    }
    if (textWords.length >= 4 && uniqueWords <= 2) {
      skip = true; reason = "repeating pattern";
    }
    if (text.length > 10) {
      const charCounts = new Map<string, number>();
      for (const ch of text.replace(/\s/g, "")) {
        charCounts.set(ch, (charCounts.get(ch) || 0) + 1);
      }
      const totalChars = text.replace(/\s/g, "").length;
      for (const [, count] of charCounts) {
        if (count / totalChars > 0.8) {
          skip = true; reason = "repeating character";
          break;
        }
      }
    }
    if (i > 0 && !skip && text.length > 10) {
      const prevText = segments[i - 1].text.trim();
      if (levenshtein(text, prevText) < 0.15) {
        skip = true; reason = "near-duplicate";
      }
    }

    if (skip) {
      console.log(`[FILTER] Removed seg ${i} (${reason}): "${text.substring(0, 40)}…"`);
      removedCount++;
    } else {
      filtered.push(seg);
    }
  }

  if (removedCount > 0 && words.length > 0) {
    const filteredWords: Word[] = [];
    for (const w of words) {
      if (filtered.some((s) => w.start >= s.start - 0.1 && w.start < s.end + 0.1)) {
        filteredWords.push(w);
      }
    }
    console.log(`[FILTER] Removed ${removedCount}, kept ${filtered.length}. Words: ${words.length}→${filteredWords.length}`);
    return { segments: filtered, words: filteredWords };
  }
  return { segments, words };
}

// ══════════════════════════════════════════════════════════════
// STEP 2A: PUNCTUATION-ONLY PROMPT (unchanged from v10.1)
// ══════════════════════════════════════════════════════════════

function buildPunctuationPrompt(): string {
  return `אתה מומחה לפיסוק בעברית. קיבלת תמלול בעברית בלי פיסוק (או עם פיסוק חלקי).

## המשימה היחידה שלך
להוסיף סימני פיסוק במקומות הנכונים. שום דבר אחר.

## כללי ברזל — אסור לחרוג

1. **אסור לשנות מילים.** אפילו לא אחת. גם אם יש שגיאת כתיב, גם אם המילה נשמעת מוזרה — תעזוב אותה.
2. **אסור להוסיף מילים.** רק סימני פיסוק.
3. **אסור להוריד מילים.** כל מילה במקור חייבת להיות בפלט.
4. **אסור לשנות סדר מילים.**
5. **רק 5 סימנים מותרים:** . , ? ! :

## דוגמאות

קלט:  [0] שלום מה שלומך
פלט:  [0] שלום, מה שלומך?

קלט:  [1] אני הולך הביתה אני שמח
פלט:  [1] אני הולך הביתה. אני שמח.

קלט:  [2] הוא אמר לי בוא נלך
פלט:  [2] הוא אמר לי: בוא נלך.

קלט:  [3] תהרה לב מה שאתה אומר
פלט:  [3] תהרה לב, מה שאתה אומר?
       ← שים לב: לא תיקנתי "תהרה" ל"טהרה". אסור! רק פיסוק.

קלט:  [4] רציתי ללכת אבל הוא לא הסכים
פלט:  [4] רציתי ללכת, אבל הוא לא הסכים.

## איפה לשים פיסוק

- **נקודה (.)** — בסוף משפט שהושלם
- **סימן שאלה (?)** — אחרי שאלה ברורה
- **סימן קריאה (!)** — אחרי קריאה / הדגשה (השתמש במשורה)
- **פסיק (,)** — לפני "אבל", "אך", "או", "כי", אחרי פנייה, בין פריטים
- **נקודתיים (:)** — לפני ציטוט / רשימה / הסבר

## מבחן עצמי לפני שאתה שולח

1. האם כל המילים זהות לקלט (חוץ מפיסוק שנוסף)? אם לא — תקן.
2. האם מספר המילים זהה? אם לא — תקן.
3. האם הוספתי רק . , ? ! : ? אם לא — תקן.

## פורמט פלט

[index] טקסט עם פיסוק

שורה אחת לכל [index]. חובה לכלול את כל האינדקסים. אסור להוסיף הסברים, הקדמות או הערות.`;
}

function buildPunctuationPromptNonHebrew(language: string): string {
  const langName = language === "ar" ? "Arabic" : "English";
  return `You are a punctuation expert. You will receive ${langName} text without (or with minimal) punctuation.

## Your only job
Add proper punctuation marks. Nothing else.

## Iron rules — never break

1. **Do NOT change any word.** Not even one. Even if there's a typo, leave it.
2. **Do NOT add words.** Only punctuation.
3. **Do NOT remove words.** Every input word must appear in output.
4. **Do NOT reorder words.**
5. **Only these marks allowed:** . , ? ! : ;

## Examples

Input:  [0] hello how are you
Output: [0] Hello, how are you?

Input:  [1] i went home i was happy
Output: [1] I went home. I was happy.

Input:  [2] he said come with me
Output: [2] He said: come with me.

## Format

[index] text with punctuation

One line per [index]. Include all indices. No explanations.`;
}

// ══════════════════════════════════════════════════════════════
// STEP 2B: AI API + PARSING (unchanged transport)
// ══════════════════════════════════════════════════════════════

async function callAI(
  input: string,
  systemPrompt: string,
  timeoutMs: number = AI_CONFIG.timeoutMs,
): Promise<string | null> {
  if (!ANTHROPIC_API_KEY) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: AI_CONFIG.model,
        max_tokens: AI_CONFIG.maxTokens,
        system: systemPrompt,
        messages: [{ role: "user", content: input }],
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      const status = response.status;
      console.warn(`[AI] API error: ${status}`);

      if (status === 429) {
        const retryAfter = parseInt(response.headers.get("retry-after") || "5");
        console.log(`[AI] Rate limited, waiting ${retryAfter}s...`);
        await new Promise((r) => setTimeout(r, retryAfter * 1000));

        const retryResponse = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: AI_CONFIG.model,
            max_tokens: AI_CONFIG.maxTokens,
            system: systemPrompt,
            messages: [{ role: "user", content: input }],
          }),
        });

        if (!retryResponse.ok) return null;
        const retryResult = await retryResponse.json();
        return retryResult.content?.[0]?.text || null;
      }

      return null;
    }

    const result = await response.json();
    return result.content?.[0]?.text || null;
  } catch (e: any) {
    clearTimeout(timeout);
    if (e.name === "AbortError") console.warn(`[AI] Timeout (${timeoutMs}ms)`);
    else console.error("[AI] Error:", e.message);
    return null;
  }
}

function parseCorrections(output: string): Array<{ idx: number; text: string }> {
  const corrected: Array<{ idx: number; text: string }> = [];
  for (const line of output.split("\n")) {
    const m = line.match(/\[(\d+)(?:\|[^\]]+)?\]\s*(.*)/);
    if (m && m[2].trim()) {
      let text = m[2].trim();
      text = text.replace(/^\(\d+w\)\s*/, "");
      text = text.replace(/^\*{1,3}\s*/, "");
      text = text.trim();
      if (text) {
        corrected.push({ idx: parseInt(m[1]), text });
      }
    }
  }
  return corrected;
}

// ══════════════════════════════════════════════════════════════
// STEP 2C: APPLY CORRECTIONS — PUNCTUATION-ONLY ENFORCEMENT
// ══════════════════════════════════════════════════════════════

const PUNCT_REGEX = /[.!?,;:"""״'''\-—…·()\[\]{}]/g;

function stripPunct(w: string): string {
  return w.replace(PUNCT_REGEX, "");
}

function applyCorrections(
  segs: TimedSegment[],
  corrections: Array<{ idx: number; text: string }>,
  passName: string,
): { segments: TimedSegment[]; accepted: number; rejected: number } {
  let accepted = 0;
  let rejected = 0;

  const result = segs.map((seg, i) => {
    const correction = corrections.find((c) => c.idx === i);
    if (!correction) return seg;

    const origWords = seg.text.split(/\s+/).filter((w) => w);
    const corrWords = correction.text.split(/\s+/).filter((w) => w);

    // RULE 1: word count must be identical
    if (origWords.length !== corrWords.length) {
      console.warn(
        `[${passName}] REJECTED seg ${i} (word count ${origWords.length}→${corrWords.length}): "${seg.text.trim().substring(0, 60)}"`,
      );
      rejected++;
      return seg;
    }

    // RULE 2: each word, with punctuation stripped, must match exactly
    for (let wi = 0; wi < origWords.length; wi++) {
      const o = stripPunct(origWords[wi]);
      const c = stripPunct(corrWords[wi]);
      if (o !== c) {
        console.warn(
          `[${passName}] REJECTED seg ${i} (word changed: "${o}" → "${c}"): "${seg.text.trim().substring(0, 60)}"`,
        );
        rejected++;
        return seg;
      }
    }

    // No actual diff?
    if (seg.text.trim() === correction.text.trim()) {
      return seg;
    }

    // ACCEPTED — punctuation-only change. Timestamps locked.
    accepted++;
    const newWords = seg.words.map((w, wi) => ({
      start: w.start,     // LOCKED
      end: w.end,         // LOCKED
      probability: w.probability,
      word: wi < corrWords.length ? corrWords[wi] : w.word,
    }));

    console.log(
      `[${passName}] OK seg ${i} (punct): "${seg.text.trim().substring(0, 50)}" → "${correction.text.substring(0, 50)}"`,
    );

    return {
      start: seg.start,  // LOCKED
      end: seg.end,       // LOCKED
      text: correction.text,
      words: newWords,
    };
  });

  return { segments: result, accepted, rejected };
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return 1;
  if (!b.length) return 1;
  const m: number[][] = [];
  for (let i = 0; i <= a.length; i++) m[i] = [i];
  for (let j = 0; j <= b.length; j++) m[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return m[a.length][b.length] / Math.max(a.length, b.length);
}

// ══════════════════════════════════════════════════════════════
// STEP 2D: BATCHING + ORCHESTRATOR (unchanged)
// ══════════════════════════════════════════════════════════════

function makeBatches(segs: TimedSegment[]): Array<{ startIdx: number; segs: TimedSegment[] }> {
  const { batchSize, batchOverlap } = AI_CONFIG;

  if (segs.length <= batchSize) {
    return [{ startIdx: 0, segs }];
  }

  const batches: Array<{ startIdx: number; segs: TimedSegment[] }> = [];
  let i = 0;
  while (i < segs.length) {
    const end = Math.min(i + batchSize, segs.length);
    batches.push({ startIdx: i, segs: segs.slice(i, end) });
    i = end - batchOverlap;
    if (i >= segs.length - batchOverlap) break;
  }
  return batches;
}

async function runPunctuationPass(
  allSegs: TimedSegment[],
  batches: Array<{ startIdx: number; segs: TimedSegment[] }>,
  systemPrompt: string,
): Promise<{ segments: TimedSegment[]; accepted: number; rejected: number }> {
  const allCorrections: Array<{ idx: number; text: string }> = [];

  const CONCURRENCY = 3;
  const batchPromises: Array<Promise<void>> = [];

  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];

    const promise = (async (batchIndex: number) => {
      const input = batch.segs.map((s, localIdx) => `[${localIdx}] ${s.text}`).join("\n");

      console.log(`[AI] Batch ${batchIndex + 1}/${batches.length} — ${batch.segs.length} segs`);
      const output = await callAI(input, systemPrompt);

      if (output) {
        const batchCorr = parseCorrections(output);
        for (const c of batchCorr) {
          const globalIdx = batch.startIdx + c.idx;
          if (!allCorrections.some((existing) => existing.idx === globalIdx)) {
            allCorrections.push({ idx: globalIdx, text: c.text });
          }
        }
      } else {
        console.warn(`[AI] Batch ${batchIndex + 1} returned null`);
      }
    })(bi);

    batchPromises.push(promise);

    if (batchPromises.length >= CONCURRENCY) {
      await Promise.race(batchPromises);
      const pending: Array<Promise<void>> = [];
      for (const p of batchPromises) {
        const result = await Promise.race([p, Promise.resolve("pending")]);
        if (result === "pending") pending.push(p);
      }
      batchPromises.length = 0;
      batchPromises.push(...pending);
    }
  }

  await Promise.all(batchPromises);

  if (allCorrections.length === 0) {
    return { segments: allSegs, accepted: 0, rejected: 0 };
  }

  return applyCorrections(allSegs, allCorrections, "PUNCT");
}

async function aiPunctuate(
  timedSegs: TimedSegment[],
  language: string,
): Promise<{ segments: TimedSegment[]; method: string }> {
  if (!ANTHROPIC_API_KEY || timedSegs.length === 0) {
    return { segments: timedSegs, method: "none" };
  }

  try {
    const systemPrompt = language === "he"
      ? buildPunctuationPrompt()
      : buildPunctuationPromptNonHebrew(language);

    const batches = makeBatches(timedSegs);
    console.log(`[AI] ${timedSegs.length} segs → ${batches.length} batch(es) of ≤${AI_CONFIG.batchSize}`);

    const result = await runPunctuationPass(timedSegs, batches, systemPrompt);

    console.log(`[AI] Punct pass: ${result.accepted} accepted, ${result.rejected} rejected`);
    return {
      segments: result.segments,
      method: `punct_only_${batches.length}bat_${result.accepted}acc`,
    };
  } catch (e: any) {
    console.error("[AI] Error:", e.message || e);
    return { segments: timedSegs, method: "error_fallback" };
  }
}

// ══════════════════════════════════════════════════════════════
// STEP 3: SPLITTING — v10.2
// ══════════════════════════════════════════════════════════════

function applySplitting(segs: TimedSegment[], style: string, wpg: number): Segment[] {
  const all: Word[] = [];
  for (const s of segs) for (const w of s.words) all.push(w);
  if (all.length === 0) return segs;

  if (style === "sentence") return splitSentence(all);
  if (style && style.startsWith("word")) {
    const n = parseInt(style.replace("word", "")) || wpg || 1;
    return splitWords(all, Math.max(1, Math.min(6, n)));
  }
  return splitAuto(all);
}

function mkSeg(words: Word[]): Segment {
  return {
    start: words[0].start,
    end: words[words.length - 1].end,
    text: words.map((w) => w.word).join(" "),
  };
}

function splitSentence(all: Word[]): Segment[] {
  const r: Segment[] = [];
  let c: Word[] = [];
  for (const w of all) {
    c.push(w);
    if (/[.!?]$/.test(w.word.trim())) { r.push(mkSeg(c)); c = []; }
  }
  if (c.length > 0) r.push(mkSeg(c));
  return r;
}

/**
 * splitWords — unchanged from v10.1
 *
 * • gs === 1 (TikTok): STRICT — every word is its own segment.
 * • gs === 2 or 3:     binding override allows up to gs+2.
 * • gs >= 4:           smart sentence/pause/comma awareness.
 */
function splitWords(all: Word[], gs: number): Segment[] {
  if (gs === 1) {
    return all.map((w) => mkSeg([w]));
  }

  const r: Segment[] = [];
  let c: Word[] = [];

  for (let i = 0; i < all.length; i++) {
    c.push(all[i]);

    if (gs >= 4) {
      const trimmed = all[i].word.trim();

      if (
        c.length >= gs - SPLIT_CONFIG.earlyBreakSlackBefore &&
        /[.!?]$/.test(trimmed)
      ) {
        r.push(mkSeg(c)); c = [];
        continue;
      }

      if (c.length >= gs && /[.!?]$/.test(trimmed)) {
        r.push(mkSeg(c)); c = [];
        continue;
      }

      if (
        c.length >= gs &&
        i + 1 < all.length &&
        all[i + 1].start - all[i].end >= SPLIT_CONFIG.pauseGapSec
      ) {
        r.push(mkSeg(c)); c = [];
        continue;
      }

      if (c.length >= gs && /,$/.test(trimmed)) {
        r.push(mkSeg(c)); c = [];
        continue;
      }
    }

    if (c.length >= gs) {
      if (
        i + 1 < all.length &&
        isBound(all[i], all[i + 1]) &&
        c.length < gs + SPLIT_CONFIG.bindingExtraSlots
      ) {
        continue;
      }
      r.push(mkSeg(c)); c = [];
    }
  }
  if (c.length > 0) r.push(mkSeg(c));
  return r;
}

/**
 * splitAuto — REWRITTEN in v10.2
 *
 * Goal: a new line should NEVER start with the tail of the previous sentence.
 *
 * Rules in order of priority:
 *  1. Word ends with .!?  → break immediately (sentence end).
 *  2. Word ends with ","  AND ct.length ≥ 20 → break immediately (clause end).
 *  3. ct.length ≥ HARD or duration ≥ MAXD → MUST break:
 *       - if there's a comma earlier in the chunk, break THERE (clean clause)
 *       - else use countTail to push connectors forward
 *       - else hard cut
 *  4. ct.length ≥ SOFT and at least 2 words →
 *       - look ahead: is there a .!? or "," reachable within HARD?
 *           → YES: keep accumulating (wait for the natural boundary)
 *           → NO : check binding chain — extend if it fits within HARD
 *           → else: break (preferring the last seen comma in chunk, then tail)
 *
 * Net effect:
 *   "יהודה אוהב לאכול בננה, ומשה אוהב פיסטוק."
 *   At "לאכול" we're at SOFT range; we look ahead, see "בננה,", reach it
 *   within HARD → wait. At "בננה," the comma rule fires → clean break.
 *   Result: ["יהודה אוהב לאכול בננה,"] ["ומשה אוהב פיסטוק."]
 */
function splitAuto(all: Word[]): Segment[] {
  const SOFT = 38, HARD = 50, MAXD = 4;
  const r: Segment[] = [];
  let c: Word[] = [];
  let ct = "";
  let lastCommaIdx = -1;  // index inside `c` where the most recent "," sits

  // Look ahead from index `i` for the next word ending with .!?,
  // returning true if reachable within HARD chars from currentLen.
  const naturalBreakReachable = (i: number, currentLen: number): boolean => {
    let extra = 0;
    for (let j = i + 1; j < all.length; j++) {
      extra += all[j].word.length + 1;
      if (currentLen + extra > HARD) return false;
      if (/[.!?,]$/.test(all[j].word.trim())) return true;
    }
    return false;
  };

  // Recompute lastCommaIdx for the current `c` (used after a partial flush).
  const recomputeCommaIdx = () => {
    lastCommaIdx = -1;
    for (let j = 0; j < c.length; j++) {
      if (/,$/.test(c[j].word.trim())) lastCommaIdx = j;
    }
  };

  // Flush words c[0..upToIdx] (inclusive), keep the rest as a tail.
  const flushUpTo = (upToIdx: number) => {
    const head = c.slice(0, upToIdx + 1);
    const tail = c.slice(upToIdx + 1);
    if (head.length > 0) r.push(mkSeg(head));
    c = tail;
    ct = c.map((w) => w.word).join(" ");
    recomputeCommaIdx();
  };

  // Flush everything in `c`.
  const flushAll = () => {
    if (c.length > 0) r.push(mkSeg(c));
    c = [];
    ct = "";
    lastCommaIdx = -1;
  };

  for (let i = 0; i < all.length; i++) {
    const w = all[i];
    c.push(w);
    ct = ct ? ct + " " + w.word : w.word;
    const trimmed = w.word.trim();
    const dur = c.length > 1 ? w.end - c[0].start : 0;

    // ── Rule 1: hard sentence end → always break ──
    if (/[.!?]$/.test(trimmed)) {
      flushAll();
      continue;
    }

    // Track the most recent comma inside the current chunk.
    if (/,$/.test(trimmed)) {
      lastCommaIdx = c.length - 1;

      // ── Rule 2: comma break when chunk has meaningful content ──
      if (ct.length >= 20) {
        flushAll();
        continue;
      }
    }

    // ── Rule 3: hard cap reached → must break, prefer last comma ──
    if (ct.length >= HARD || dur >= MAXD) {
      if (lastCommaIdx >= 1 && lastCommaIdx < c.length - 1) {
        // Break at the last comma so the next segment starts cleanly.
        flushUpTo(lastCommaIdx);
        continue;
      }
      // No comma to lean on — push trailing connectors forward.
      const lb = countTail(c);
      if (lb > 0 && c.length - lb >= 2) {
        const head = c.slice(0, c.length - lb);
        const tail = c.slice(c.length - lb);
        r.push(mkSeg(head));
        c = tail;
        ct = c.map((x) => x.word).join(" ");
        recomputeCommaIdx();
        continue;
      }
      flushAll();
      continue;
    }

    // ── Rule 4: soft threshold — wait for a natural boundary if possible ──
    if (ct.length >= SOFT && c.length >= 2) {
      // (a) If a sentence-end or comma is reachable ahead within HARD, wait.
      if (naturalBreakReachable(i, ct.length)) continue;

      // (b) Otherwise, try to extend through a binding chain if it fits.
      const chain = countChain(all, i + 1);
      if (chain > 0) {
        let chainExtra = 0;
        for (let x = 1; x <= chain && i + x < all.length; x++) {
          chainExtra += all[i + x].word.length + 1;
        }
        if (ct.length + chainExtra <= HARD) continue;
      }

      // (c) No good boundary ahead. Break, preferring last comma in chunk.
      if (lastCommaIdx >= 1 && lastCommaIdx < c.length - 1) {
        flushUpTo(lastCommaIdx);
        continue;
      }
      // Else use tail logic.
      const lb = countTail(c);
      if (lb > 0 && c.length - lb >= 2) {
        const head = c.slice(0, c.length - lb);
        const tail = c.slice(c.length - lb);
        r.push(mkSeg(head));
        c = tail;
        ct = c.map((x) => x.word).join(" ");
        recomputeCommaIdx();
        continue;
      }
      flushAll();
    }
  }

  if (c.length > 0) r.push(mkSeg(c));
  return r;
}

function isBound(a: Word, b: Word): boolean {
  const wa = a.word.trim().replace(/[,.:;!?"״""—…]+$/g, "");
  const wb = b.word.trim().replace(/[,.:;!?"״""—…]+$/g, "");

  if ([
    "הרב","הגאון","הרבנית","מורנו","ורבנו","המקובל","הצדיק",
    "ר'","רבי","רבנו","מרן","כבוד","כ\"ק",
    "דר","ד\"ר","פרופ","פרופ'","מר","גב","גב'","עו\"ד",
    "השר","השרה","הנשיא","הנשיאה","ראש","סגן",
    "אלוף","תא\"ל","אל\"מ","סא\"ל","רס\"ן","סרן","סגן",
  ].includes(wa)) return true;

  if (["לא","אל","אין","בלי","ללא","אינו","אינה","אינם","אינן","איננו"].includes(wa)) return true;
  if (!wa.startsWith("ה") && wb.startsWith("ה") && wb.length > 2) return true;

  if ([
    "את","של","על","אל","עם","בת","בן","כל","גם","רק","כי","אם","או","כמו",
    "ו","וגם","אבל","אלא","אך","אולם","לכן","משום","מפני","בגלל","למרות",
    "בין","לבין","כדי","כאשר","כש","לכש","מש","ש","שלא","עד","מול","נגד",
    "לפי","אצל","בשביל","למען","כלפי","מתוך","בתוך","מאחורי","לפני","אחרי",
  ].includes(wa)) return true;

  if (wb === "של") return true;
  if (/^\d+$/.test(wa)) return true;

  if ([
    'שליט"א','שליטא','זצ"ל','זצל','זיע"א','נ"ע','ע"ה','הי"ד','יבדל"א',
  ].some((h) => wb.replace(/[""״]/g, '"') === h)) return true;

  if (wa === "בית" && ["ספר","חולים","כנסת","משפט","דין","מדרש","עלמין"].includes(wb)) return true;
  if (wa === "ארץ" && wb === "ישראל") return true;
  if (wa === "חוק" && wb === "יסוד") return true;
  if (wa === "ראש" && ["הממשלה","העיר","ישיבה","השנה","חודש"].includes(wb)) return true;
  if (wa === "בני" && ["אדם","ישראל","ברק","תורה"].includes(wb)) return true;

  return false;
}

function countChain(w: Word[], si: number): number {
  let c = 0, i = si;
  while (i < w.length && i > 0 && isBound(w[i - 1], w[i])) { c++; i++; }
  return c;
}

function countTail(c: Word[]): number {
  if (c.length < 2) return 0;
  let n = 0;
  for (let i = c.length - 1; i >= 1; i--) {
    const a = c[i].word.trim().replace(/[,.:;!?]+$/g, "");
    if ([
      "הרב","הגאון","מורנו","ורבנו","המקובל","לא","אל","אין",
      "את","של","על","אל","עם","כל","גם","כי","ש","כש",
      "ו","וגם","אבל","אלא","בין","כדי","כאשר",
    ].includes(a)) n++;
    else break;
  }
  return n;
}

// ══════════════════════════════════════════════════════════════
// SRT BUILDER — v10.2 (PLAIN TEXT, no invisible RTL chars)
// ══════════════════════════════════════════════════════════════
//
// The SRT now contains plain UTF-8 text, exactly as it was produced
// by Whisper + the AI punctuation pass — no RLE/RLM/PDF wrapping.
//
// Hebrew/Arabic editors that respect Unicode bidi (Premiere Pro,
// DaVinci Resolve, Subtitle Edit, etc.) will still display the lines
// right-to-left because the characters themselves are RTL. The file
// is just clean and editable as-is.
// ══════════════════════════════════════════════════════════════

function buildSrt(segs: Segment[], _lang: string = "he"): string {
  const ts = (s: number) => {
    s = Math.max(0, s);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sc = Math.floor(s % 60);
    const ms = Math.round((s - Math.floor(s)) * 1000);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sc).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
  };

  return segs
    .map((seg, i) => {
      const t = seg.text.trim();
      if (!t) return "";
      return `${i + 1}\n${ts(seg.start)} --> ${ts(seg.end)}\n${t}\n`;
    })
    .filter(Boolean)
    .join("\n");
}

// ══════════════════════════════════════════════════════════════
// MAIN HANDLER (unchanged flow)
// ══════════════════════════════════════════════════════════════

export async function POST(req: NextRequest) {
  let jobId: string | null = null;

  try {
    const body = await req.json();
    const { job_id, secret } = body;
    jobId = job_id;

    if (secret !== PROCESS_SECRET) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (!job_id) {
      return NextResponse.json({ error: "Missing job_id" }, { status: 400 });
    }

    const { data: job, error: jobErr } = await supabase
      .from("transcription_jobs")
      .select("*")
      .eq("id", job_id)
      .single();

    if (jobErr || !job) {
      console.error("[PROCESS] Job not found:", job_id);
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }

    if (job.status !== "pending") {
      console.log(`[PROCESS] Job ${job_id} already ${job.status}, skipping`);
      return NextResponse.json({ ok: true, status: job.status });
    }

    const t0 = Date.now();
    const { user_id, download_url, file_key, lang, audio_duration, caption_style, words_per_group } = job;
    const audioDur = audio_duration || 0;

    // ── STEP 1: Modal Whisper ──
    await updateJobStatus(job_id, "whisper");
    console.log(`[PROCESS] Job ${job_id} — Sending to Whisper...`);

    const modalRes = await fetch(MODAL_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        audio_url: download_url,
        lang: lang || "he",
        beam_size: 5,
        best_of: 5,
        vad_filter: true,
        initial_prompt: lang === "he"
          ? "שלום, זהו תמלול מקצועי בעברית תקנית. סימני פיסוק: נקודה, פסיק, סימן שאלה. קיצורים: רמב\"ם, רש\"י, צה\"ל, בג\"ץ, ד\"ר, עו\"ד. ביטויים: ברוך השם, בעזרת השם, חס ושלום, יישר כוח."
          : undefined,
      }),
    });

    if (!modalRes.ok) {
      const me = await modalRes.text();
      console.error("[PROCESS] Modal error:", me);
      await logUsage(user_id, audioDur, lang || "he", "whisper-large-v3", "failed", 0, 0, me);
      await failJob(job_id, "שגיאת תמלול.");
      return NextResponse.json({ ok: false, error: me }, { status: 502 });
    }

    const mr = await modalRes.json();
    const whisperMs = Date.now() - t0;

    if (mr.error) {
      await logUsage(user_id, audioDur, lang || "he", "whisper-large-v3", "failed", 0, 0, mr.error);
      await failJob(job_id, "שגיאת תמלול: " + mr.error);
      return NextResponse.json({ ok: false, error: mr.error }, { status: 500 });
    }

    console.log(`[PROCESS] Whisper done ${whisperMs}ms — ${mr.segments?.length || 0} segs, ${mr.words?.length || 0} words`);

    const rawSegs: Segment[] = (mr.segments || []).map((s: any) => ({
      start: s.start, end: s.end, text: (s.text || "").trim(),
    }));
    const rawWords: Word[] = (mr.words || []).map((w: any) => ({
      start: w.start, end: w.end, word: (w.word || "").trim(),
      probability: w.probability,
    }));

    if (rawSegs.length === 0) {
      await logUsage(user_id, audioDur, lang || "he", "whisper-large-v3", "empty", 0, 0);
      await failJob(job_id, "לא נמצא דיבור.");
      return NextResponse.json({ ok: false, error: "No speech found" });
    }

    // ── STEP 1.5: Filter hallucinations ──
    const hePrompt = lang === "he"
      ? "שלום, זהו תמלול מקצועי בעברית תקנית. סימני פיסוק: נקודה, פסיק, סימן שאלה. שמות אנשים, מקומות ומונחים מקצועיים נכתבים במדויק."
      : "";
    const cleaned = filterHallucinations(rawSegs, rawWords, hePrompt);

    if (cleaned.segments.length === 0) {
      await logUsage(user_id, audioDur, lang || "he", "whisper-large-v3", "empty", 0, 0);
      await failJob(job_id, "לא נמצא דיבור.");
      return NextResponse.json({ ok: false, error: "No speech found" });
    }

    // ── STEP 2: Build timed segments (timestamps LOCKED) ──
    const timedSegs = buildTimedSegments(cleaned.segments, cleaned.words);

    // ── STEP 3: AI Punctuation Pass (no word changes allowed) ──
    await updateJobStatus(job_id, "punctuation");
    const aiResult = await aiPunctuate(timedSegs, lang || "he");

    // ── STEP 4: Split ──
    const wpg = parseInt(words_per_group) || 1;
    const final = applySplitting(aiResult.segments, caption_style || "auto", wpg);

    // ── STEP 5: Build SRT (plain text) ──
    const srt = buildSrt(final, lang || "he");

    // ── STEP 6: Log & deduct ──
    const totalMs = Date.now() - t0;
    const mins = await logUsage(
      user_id, audioDur, lang || "he", "whisper-large-v3",
      "completed", final.length, totalMs / 1000,
    );
    await deductMinutes(user_id, mins);

    const { data: profile } = await supabase
      .from("profiles")
      .select("minutes_used, minutes_limit")
      .eq("id", user_id)
      .single();
    const remaining = profile ? (profile.minutes_limit || 0) - (profile.minutes_used || 0) : 0;

    // ── STEP 7: Save results to Supabase ──
    await supabase
      .from("transcription_jobs")
      .update({
        status: "completed",
        srt,
        segments: final,
        result_meta: {
          language: mr.language || lang,
          elapsed: (totalMs / 1000).toFixed(1),
          count: final.length,
          minutes_charged: mins,
          minutes_remaining: remaining,
          ai_punctuation: aiResult.method,
          caption_style: caption_style || "auto",
          words_per_group: wpg,
        },
        completed_at: new Date().toISOString(),
      })
      .eq("id", job_id);

    if (file_key) {
      s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: file_key })).catch(() => {});
    }

    console.log(`[DONE] Job ${job_id} — ${final.length} segs, ${totalMs}ms (Whisper:${whisperMs}ms, AI:${totalMs - whisperMs}ms)`);

    return NextResponse.json({ ok: true, status: "completed" });

  } catch (e: any) {
    console.error("[PROCESS] Fatal error:", e);
    if (jobId) {
      await failJob(jobId, "שגיאה פנימית: " + (e.message || "unknown")).catch(() => {});
    }
    return NextResponse.json({ error: "שגיאה פנימית" }, { status: 500 });
  }
}
