/**
 * SubAI — Transcription Engine v10.0 (Sonnet — Hebrew Language Expert)
 *
 * CHANGES FROM v9.1:
 * ═══════════════════════════════════════════════════════════════
 * 1. Whisper: ivrit-ai/whisper-large-v3 (Hebrew fine-tuned)
 * 2. AI: Haiku → Sonnet 4 (dramatically better Hebrew)
 * 3. Prompts: Shorter, focused, with examples (not essays)
 * 4. Architecture: Single-pass (Sonnet is good enough for one pass)
 * 5. Batching: 50 segments + 5 overlap (Sonnet handles more)
 * 6. Confidence: Enhanced low-confidence word handling
 * 7. Whisper config: beam_size=5, VAD, initial_prompt
 * ═══════════════════════════════════════════════════════════════
 *
 * IRON LAW: SRT TIMESTAMPS ARE WHISPER'S ORIGINALS — NEVER MODIFIED.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export const maxDuration = 120;

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const AWS_REGION = process.env.AWS_REGION || "eu-north-1";
const S3_BUCKET = process.env.S3_BUCKET || "subai-audio";
const MODAL_ENDPOINT = process.env.MODAL_ENDPOINT_URL!;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";

// ═══════════════════════════════════════════════════════════════
// CONFIG — Easy to tune
// ═══════════════════════════════════════════════════════════════

const AI_CONFIG = {
  // Model: Sonnet for Hebrew (much better morphology understanding)
  // Switch to "claude-haiku-4-5-20251001" for cost savings
  model: "claude-sonnet-4-20250514",
  maxTokens: 8192,
  timeoutMs: 45000,  // Sonnet needs slightly more time

  // Batching
  batchSize: 50,     // Sonnet handles larger context
  batchOverlap: 5,   // More overlap = better continuity

  // Validation
  maxWordDiffShort: 2,   // segments < 10 words
  maxWordDiffLong: 3,    // segments >= 10 words
  levThreshold: 0.4,     // max Levenshtein distance (0-1)
  levThresholdGarbage: 0.85, // more lenient for garbage input
};

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const s3 = new S3Client({
  region: AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

function err(msg: string, status = 400) {
  return NextResponse.json({ error: true, message: msg }, { status });
}

interface Segment { start: number; end: number; text: string; }
interface Word { start: number; end: number; word: string; probability?: number; }
interface TimedSegment { start: number; end: number; text: string; words: Word[]; }

// ══════════════════════════════════════════════════════════════
// DATABASE (unchanged from v9.1)
// ══════════════════════════════════════════════════════════════

async function validateApiKey(apiKey: string) {
  const { data } = await supabase
    .from("profiles")
    .select("id, email, plan, minutes_used, minutes_limit, subscription_status")
    .eq("api_key", apiKey)
    .single();
  return data || null;
}

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
// STEP 1.5: HALLUCINATION FILTER (enhanced)
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

    // Stuck loop
    if (dur > 5 && uniqueWords <= 2 && textWords.length >= 3) {
      skip = true; reason = "stuck loop";
    }
    // Single word spanning too long
    if (dur > 6 && textWords.length <= 1) {
      skip = true; reason = `single word ${dur.toFixed(1)}s`;
    }
    // Too long for content
    if (dur > 10 && textWords.length <= 3) {
      skip = true; reason = "too long for content";
    }
    // Exact duplicate of previous
    if (i > 0 && text === segments[i - 1].text.trim()) {
      skip = true; reason = "exact duplicate";
    }
    // Prompt leak
    if (prompt && text.length > 5) {
      const ct = text.replace(/[.!?,;:\s]/g, "");
      const cp = prompt.replace(/[.!?,;:\s]/g, "");
      if (cp.includes(ct) || ct.includes(cp)) {
        skip = true; reason = "prompt leak";
      }
    }
    // Repeating pattern
    if (textWords.length >= 4 && uniqueWords <= 2) {
      skip = true; reason = "repeating pattern";
    }
    // Repeating characters (e.g. "שששששששש...")
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
    // NEW: Near-duplicate (>90% similar to previous)
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
// STEP 2A: CONFIDENCE HINTS (enhanced — now groups by severity)
// ══════════════════════════════════════════════════════════════

function buildConfidenceHints(timedSegs: TimedSegment[]): string {
  const critical: string[] = [];  // < 40%
  const low: string[] = [];       // 40-70%

  for (let si = 0; si < timedSegs.length; si++) {
    const seg = timedSegs[si];
    const critWords: string[] = [];
    const lowWords: string[] = [];

    for (const w of seg.words) {
      if (w.probability !== undefined) {
        if (w.probability < 0.4) {
          critWords.push(`"${w.word}"(${(w.probability * 100).toFixed(0)}%)`);
        } else if (w.probability < 0.7) {
          lowWords.push(`"${w.word}"(${(w.probability * 100).toFixed(0)}%)`);
        }
      }
    }
    if (critWords.length > 0) critical.push(`[${si}] ⚠️ ${critWords.join(", ")}`);
    if (lowWords.length > 0) low.push(`[${si}] ${lowWords.join(", ")}`);
  }

  if (critical.length === 0 && low.length === 0) return "";

  let hints = "\n\n🔍 WHISPER CONFIDENCE — מילים שWhisper לא בטוח לגביהן:";
  if (critical.length > 0) {
    hints += `\n\nקריטי (confidence < 40% — כנראה שגוי):\n${critical.join("\n")}`;
  }
  if (low.length > 0) {
    hints += `\n\nנמוך (confidence < 70% — בדוק):\n${low.join("\n")}`;
  }
  return hints;
}

// ══════════════════════════════════════════════════════════════
// STEP 2B: THE HEBREW EXPERT PROMPT — v10 (Focused + Examples)
// ══════════════════════════════════════════════════════════════
//
// PHILOSOPHY CHANGE from v9.1:
// - v9.1: Long essay with tables → model gets "lost" in instructions
// - v10: Short principles + CONCRETE EXAMPLES → model learns by pattern
//
// The key insight: Sonnet already knows Hebrew deeply.
// We don't need to teach it Hebrew — we need to teach it
// what Whisper gets wrong and how to fix it.
//

function buildCorrectionPrompt(): string {
  return `אתה מגיה מומחה. קיבלת תמלול Whisper בעברית עם שגיאות אופייניות.

## המשימה
תקן שגיאות כתיב פונטיות. הוסף פיסוק בסיסי. שמור על כל מילה שהדובר אמר.

## 3 כללים בלתי ניתנים לשבירה

1. **פענוח פונטי בלבד**: תקן רק כשהמילה השגויה *נשמעת* כמו המילה הנכונה.
   Whisper שומע צלילים וכותב אותיות — אם הצליל דומה, זה תיקון לגיטימי.
   אם הצליל שונה, זה החלפה אסורה.

2. **אל תחליף מילים**: הדובר *בחר* מילה. גם אם "הלך" פחות מתאים מ"צעד" — הדובר אמר "הלך". נקודה.

3. **סגמנטים עצמאיים**: כל [index] הוא יחידה נפרדת עם תזמון משלה. אסור להעביר מילים בין סגמנטים, למזג או לפצל סגמנטים.

## דוגמאות — תיקון לגיטימי ✓

| Whisper כתב | תיקון | סיבה |
|---|---|---|
| תהרה | טהרה | ת↔ט — פונטי |
| ברחו | ברוך הוא | צלילים דומים, מיזוג שגוי |
| בגצל | בגיא צל | מיזוג שגוי, צלילים דומים |
| שליטא | שליט"א | גרשיים חסרים |
| האישועות | הישועות | א' רפאים מיותרת |
| עם עדי | עמדי | פיצול שגוי |
| אני חושב שזה | אני חושב שזה | תקין — אל תשנה! |

## דוגמאות — תיקון אסור ✗

| Whisper כתב | תיקון שגוי | למה אסור |
|---|---|---|
| הלך | צעד | צליל שונה לגמרי |
| אמר | ציין | צליל שונה |
| גדול | עצום | החלפה סמנטית |
| רוצה | צריך | הדובר אמר רוצה |
| נדבר | נוצר | שום קשר פונטי |

## החלפות פונטיות שכיחות ב-Whisper

א↔ע, ח↔כ, ט↔ת, ס↔ש, ק↔כ, צ↔ס, ה↔ח, ב↔ו (נדיר)

## מה לתקן

- אותיות שנשמעות דומה שהתחלפו (א↔ע, ח↔כ, ט↔ת וכו')
- מילים שWhisper מיזג (בגצל → בגיא צל) — מותר +1/+2 מילים
- מילים שWhisper פיצל (עם עדי → עמדי) — מותר -1/-2 מילים
- קיצורים וגרשיים: רמבם→רמב"ם, שליטא→שליט"א, צהל→צה"ל, בגץ→בג"ץ
- א' רפאים מיותרת: האישועה→הישועה, אהולך→הולך
- פיסוק בסיסי: נקודה בסוף משפט, פסיק לפני מילת קישור, סימן שאלה לשאלות
- התאמת מין/מספר רק כשברור שWhisper טעה (לא דיבור חופשי)

## מה לא לעשות

- לא להחליף מילה למילה שלא נשמעת דומה
- לא למחוק מילות מילוי (אה, אממ, כאילו, נו) — עוגני תזמון
- לא לשפר סגנון / לפרמל שפה מדוברת
- לא לשנות שמות/מותגים/מקומות
- לא לשנות סדר מילים
- לא להעביר מילים בין סגמנטים
- לא להוסיף מילים שלא נאמרו

## מבחן עצמי לפני כל תיקון

"האם התיקון שלי נשמע דומה למה שWhisper כתב?"
כן → לגיטימי. לא → אסור. ספק → אל תשנה.

## פורמט

[index] טקסט מתוקן

שורה אחת לכל סגמנט. אסור לדלג על סגמנטים. אסור להוסיף הסברים.`;
}

// ══════════════════════════════════════════════════════════════
// STEP 2C: AI API (Sonnet) + PARSING
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

      // Rate limit — wait and retry once
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
      // Strip format artifacts AI might echo back
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
// STEP 2D: APPLY CORRECTIONS — SEGMENT-TIMESTAMP-LOCKED
// ══════════════════════════════════════════════════════════════

function redistributeWordTimestamps(
  corrWords: string[],
  segStart: number,
  segEnd: number,
): Word[] {
  const totalDur = segEnd - segStart;
  const n = corrWords.length;
  if (n === 0) return [];
  const wordDur = totalDur / n;
  return corrWords.map((w, i) => ({
    start: +(segStart + i * wordDur).toFixed(3),
    end: +(segStart + (i + 1) * wordDur).toFixed(3),
    word: w,
  }));
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
    const wordDiff = Math.abs(corrWords.length - origWords.length);

    const maxWordDiff = origWords.length >= 10
      ? AI_CONFIG.maxWordDiffLong
      : AI_CONFIG.maxWordDiffShort;

    // REJECT if word count changed too much
    if (wordDiff > maxWordDiff) {
      console.warn(
        `[${passName}] REJECTED seg ${i} (words ${origWords.length}→${corrWords.length}): "${seg.text.trim().substring(0, 60)}" → "${correction.text.substring(0, 60)}"`,
      );
      rejected++;
      return seg;
    }

    // Check if anything actually changed (ignoring punctuation)
    const stripPunct = (w: string) => w.replace(/[.!?,;:"""״'''\-—…·]/g, "");
    const origClean = origWords.map(stripPunct).join(" ");
    const corrClean = corrWords.map(stripPunct).join(" ");

    if (origClean === corrClean) {
      // Punctuation-only change → always accept
      if (seg.text.trim() !== correction.text) {
        accepted++;
        const newWords = seg.words.map((w, wi) => ({
          start: w.start,
          end: w.end,
          probability: w.probability,
          word: wi < corrWords.length ? corrWords[wi] : w.word,
        }));
        return { start: seg.start, end: seg.end, text: correction.text, words: newWords };
      }
      return seg;
    }

    // Substantive text change → Levenshtein check
    const dist = levenshtein(origClean, corrClean);
    const garbage = isGarbageSegment(seg.text);
    const threshold = garbage ? AI_CONFIG.levThresholdGarbage : AI_CONFIG.levThreshold;

    if (dist > threshold) {
      console.warn(
        `[${passName}] REJECTED seg ${i} (lev ${(dist * 100).toFixed(0)}%): "${seg.text.trim().substring(0, 60)}" → "${correction.text.substring(0, 60)}"`,
      );
      rejected++;
      return seg;
    }

    // ACCEPTED
    accepted++;

    let newWords: Word[];

    if (wordDiff === 0) {
      newWords = seg.words.map((w, wi) => ({
        start: w.start,     // LOCKED
        end: w.end,         // LOCKED
        probability: w.probability,
        word: wi < corrWords.length ? corrWords[wi] : w.word,
      }));
    } else {
      newWords = redistributeWordTimestamps(corrWords, seg.start, seg.end);
    }

    console.log(
      `[${passName}] OK seg ${i} (lev ${(dist * 100).toFixed(0)}%, wc ${origWords.length}→${corrWords.length}): "${seg.text.trim().substring(0, 50)}" → "${correction.text.substring(0, 50)}"`,
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
// STEP 2E: SINGLE-PASS ORCHESTRATOR WITH BATCHING
// ══════════════════════════════════════════════════════════════
//
// v10 CHANGE: Single pass instead of 2.
// Sonnet is good enough to do phonetic correction + punctuation in one pass.
// This saves 50% AI cost and reduces latency.
//

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

async function runCorrectionPass(
  allSegs: TimedSegment[],
  batches: Array<{ startIdx: number; segs: TimedSegment[] }>,
  systemPrompt: string,
  confHints: string = "",
): Promise<{ segments: TimedSegment[]; accepted: number; rejected: number }> {
  const allCorrections: Array<{ idx: number; text: string }> = [];

  // Run batches in parallel (up to 3 concurrent)
  const CONCURRENCY = 3;
  const batchPromises: Array<Promise<void>> = [];

  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];

    const promise = (async (batchIndex: number) => {
      const input = batch.segs.map((s, localIdx) => {
        return `[${localIdx}] ${s.text}`;
      }).join("\n") + (batchIndex === 0 ? confHints : "");

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

    // Throttle concurrency
    if (batchPromises.length >= CONCURRENCY) {
      await Promise.race(batchPromises);
      // Clean up resolved promises
      const pending: Array<Promise<void>> = [];
      for (const p of batchPromises) {
        const result = await Promise.race([p, Promise.resolve("pending")]);
        if (result === "pending") pending.push(p);
      }
      batchPromises.length = 0;
      batchPromises.push(...pending);
    }
  }

  // Wait for remaining batches
  await Promise.all(batchPromises);

  if (allCorrections.length === 0) {
    return { segments: allSegs, accepted: 0, rejected: 0 };
  }

  return applyCorrections(allSegs, allCorrections, "CORRECT");
}

async function aiCorrect(
  timedSegs: TimedSegment[],
  language: string,
): Promise<{ segments: TimedSegment[]; method: string }> {
  if (!ANTHROPIC_API_KEY || timedSegs.length === 0) {
    return { segments: timedSegs, method: "none" };
  }

  if (language !== "he") {
    return aiCorrectNonHebrew(timedSegs, language);
  }

  try {
    const confHints = buildConfidenceHints(timedSegs);
    const batches = makeBatches(timedSegs);
    console.log(`[AI] ${timedSegs.length} segs → ${batches.length} batch(es) of ≤${AI_CONFIG.batchSize}`);

    const systemPrompt = buildCorrectionPrompt();
    const result = await runCorrectionPass(
      timedSegs, batches, systemPrompt, confHints,
    );

    console.log(`[AI] Result: ${result.accepted} accepted, ${result.rejected} rejected`);
    return {
      segments: result.segments,
      method: `sonnet_1pass_${batches.length}bat`,
    };
  } catch (e: any) {
    console.error("[AI] Error:", e.message || e);
    return { segments: timedSegs, method: "error_fallback" };
  }
}

async function aiCorrectNonHebrew(
  timedSegs: TimedSegment[],
  language: string,
): Promise<{ segments: TimedSegment[]; method: string }> {
  const langName = language === "ar" ? "Arabic" : "English";
  const prompt = `Fix ${langName} Whisper transcription errors. Add proper punctuation.

CRITICAL: Every output segment MUST have EXACTLY the same word count as input (±2 max).
Punctuation attaches to the preceding word (no extra word count).

Format: [index] corrected text — one per line, every segment.`;

  const input = timedSegs.map((s, i) => `[${i}] ${s.text}`).join("\n");
  const output = await callAI(input, prompt, 30000);
  if (!output) return { segments: timedSegs, method: "api_error" };

  const corrections = parseCorrections(output);
  if (corrections.length === 0) return { segments: timedSegs, method: "empty_response" };

  const { segments, accepted, rejected } = applyCorrections(timedSegs, corrections, "SINGLE");
  console.log(`[AI] Single-pass: ${accepted} accepted, ${rejected} rejected`);
  return { segments, method: accepted > 0 ? "claude_single" : "no_changes" };
}

// ══════════════════════════════════════════════════════════════
// STEP 3: SPLITTING (unchanged from v9.1)
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

function splitWords(all: Word[], gs: number): Segment[] {
  const r: Segment[] = [];
  let c: Word[] = [];
  for (let i = 0; i < all.length; i++) {
    c.push(all[i]);
    if (c.length >= gs) {
      if (i + 1 < all.length && isBound(all[i], all[i + 1]) && c.length < gs + 2) continue;
      r.push(mkSeg(c)); c = [];
    }
  }
  if (c.length > 0) r.push(mkSeg(c));
  return r;
}

function splitAuto(all: Word[]): Segment[] {
  const SOFT = 38, HARD = 50, MAXD = 4;
  const r: Segment[] = [];
  let c: Word[] = [];
  let ct = "";

  for (let i = 0; i < all.length; i++) {
    const w = all[i];
    c.push(w);
    ct = ct ? ct + " " + w.word : w.word;
    const dur = c.length > 1 ? w.end - c[0].start : 0;

    if (/[.!?]$/.test(w.word.trim())) { r.push(mkSeg(c)); c = []; ct = ""; continue; }
    if (/,$/.test(w.word.trim()) && ct.length >= 20) { r.push(mkSeg(c)); c = []; ct = ""; continue; }

    if (ct.length >= SOFT && c.length >= 2) {
      const chain = countChain(all, i + 1);
      if (chain === 0) { r.push(mkSeg(c)); c = []; ct = ""; continue; }
      let extra = 0;
      for (let x = 1; x <= chain && i + x < all.length; x++) extra += all[i + x].word.length + 1;
      if (ct.length + extra <= HARD) continue;
      const lb = countTail(c);
      if (lb > 0 && c.length - lb >= 2) {
        r.push(mkSeg(c.slice(0, c.length - lb)));
        c = c.slice(c.length - lb);
        ct = c.map((w) => w.word).join(" ");
        continue;
      }
      r.push(mkSeg(c)); c = []; ct = ""; continue;
    }

    if (ct.length >= HARD || dur >= MAXD) { r.push(mkSeg(c)); c = []; ct = ""; continue; }
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
// SRT BUILDER (RTL) — unchanged
// ══════════════════════════════════════════════════════════════

function buildSrt(segs: Segment[], lang: string = "he"): string {
  const rtl = lang === "he" || lang === "ar";
  const RLM = "\u200F";
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
      return `${i + 1}\n${ts(seg.start)} --> ${ts(seg.end)}\n${rtl ? RLM + t : t}\n`;
    })
    .filter(Boolean)
    .join("\n");
}

// ══════════════════════════════════════════════════════════════
// RATE LIMITING — unchanged
// ══════════════════════════════════════════════════════════════

const rateLimits = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 10;
const RATE_WINDOW = 60000;

function checkRateLimit(userId: string): boolean {
  const now = Date.now();
  const entry = rateLimits.get(userId);
  if (rateLimits.size > 1000) {
    for (const [k, v] of rateLimits) { if (v.resetAt < now) rateLimits.delete(k); }
  }
  if (!entry || entry.resetAt < now) {
    rateLimits.set(userId, { count: 1, resetAt: now + RATE_WINDOW });
    return true;
  }
  if (entry.count >= RATE_LIMIT) return false;
  entry.count++;
  return true;
}

// ══════════════════════════════════════════════════════════════
// MAIN HANDLER
// ══════════════════════════════════════════════════════════════

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { api_key, action, lang, model, offset, audio_duration, caption_style, words_per_group } = body;

    if (!api_key) return err("Missing api_key", 401);
    if (typeof api_key !== "string" || api_key.length < 10 || api_key.length > 200) {
      return err("Invalid API key format", 401);
    }

    const user = await validateApiKey(api_key);
    if (!user) return err("Invalid API key", 401);

    const remaining = (user.minutes_limit || 0) - (user.minutes_used || 0);
    if (remaining <= 0) return err("נגמרה המכסה. שדרג תוכנית.", 403);

    if (action === "transcribe" || action === "get_upload_url") {
      if (!checkRateLimit(user.id)) {
        return err("יותר מדי בקשות. נסה שוב בעוד דקה.", 429);
      }
    }

    if (action === "get_upload_url") {
      const fileKey = `audio/${user.id}/${Date.now()}.mp3`;
      const putCmd = new PutObjectCommand({ Bucket: S3_BUCKET, Key: fileKey, ContentType: "audio/mpeg" });
      const uploadUrl = await getSignedUrl(s3, putCmd, { expiresIn: 300 });
      const getCmd = new GetObjectCommand({ Bucket: S3_BUCKET, Key: fileKey });
      const downloadUrl = await getSignedUrl(s3, getCmd, { expiresIn: 3600 });
      return NextResponse.json({
        upload_url: uploadUrl, download_url: downloadUrl,
        file_key: fileKey, remaining_minutes: remaining,
      });
    }

    if (action === "transcribe") {
      const { download_url, file_key } = body;
      if (!download_url) return err("Missing download_url");
      const audioDur = audio_duration || 0;
      if (Math.ceil((audioDur / 60) * 10) / 10 > remaining) return err("לא מספיק דקות.", 403);
      if (audioDur > 3600) return err("מקסימום 60 דקות לתמלול בודד.", 400);

      // ── STEP 1: Modal Whisper ──
      // NOTE: Update your Modal endpoint to use ivrit-ai/whisper-large-v3-ct2
      // with the optimized parameters (see analysis.md)
      console.log("[MODAL] Sending to Whisper...");
      const t0 = Date.now();

      const modalRes = await fetch(MODAL_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          audio_url: download_url,
          lang: lang || "he",
          // NEW: Pass optimized config to Modal
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
        console.error("[MODAL] Error:", me);
        await logUsage(user.id, audioDur, lang || "he", "whisper-large-v3", "failed", 0, 0, me);
        return err("שגיאת תמלול.", 502);
      }

      const mr = await modalRes.json();
      const whisperMs = Date.now() - t0;

      if (mr.error) {
        await logUsage(user.id, audioDur, lang || "he", "whisper-large-v3", "failed", 0, 0, mr.error);
        return err("שגיאת תמלול: " + mr.error, 500);
      }

      console.log(`[MODAL] Done ${whisperMs}ms — ${mr.segments?.length || 0} segs, ${mr.words?.length || 0} words`);

      const rawSegs: Segment[] = (mr.segments || []).map((s: any) => ({
        start: s.start, end: s.end, text: (s.text || "").trim(),
      }));
      const rawWords: Word[] = (mr.words || []).map((w: any) => ({
        start: w.start, end: w.end, word: (w.word || "").trim(),
        probability: w.probability,
      }));

      if (rawSegs.length === 0) {
        await logUsage(user.id, audioDur, lang || "he", "whisper-large-v3", "empty", 0, 0);
        return err("לא נמצא דיבור.", 200);
      }

      // ── STEP 1.5: Filter hallucinations ──
      const hePrompt = lang === "he"
        ? "שלום, זהו תמלול מקצועי בעברית תקנית. סימני פיסוק: נקודה, פסיק, סימן שאלה. שמות אנשים, מקומות ומונחים מקצועיים נכתבים במדויק."
        : "";
      const cleaned = filterHallucinations(rawSegs, rawWords, hePrompt);

      if (cleaned.segments.length === 0) {
        await logUsage(user.id, audioDur, lang || "he", "whisper-large-v3", "empty", 0, 0);
        return err("לא נמצא דיבור.", 200);
      }

      // ── STEP 2: Build timed segments (timestamps LOCKED) ──
      const timedSegs = buildTimedSegments(cleaned.segments, cleaned.words);

      // ── STEP 3: AI Correction (SINGLE PASS — Sonnet) ──
      const aiResult = await aiCorrect(timedSegs, lang || "he");

      // ── STEP 4: Split ──
      const wpg = parseInt(words_per_group) || 1;
      const final = applySplitting(aiResult.segments, caption_style || "auto", wpg);

      // ── STEP 5: Build SRT ──
      const srt = buildSrt(final, lang || "he");

      // ── STEP 6: Log & deduct ──
      const totalMs = Date.now() - t0;
      const mins = await logUsage(
        user.id, audioDur, lang || "he", "whisper-large-v3",
        "completed", final.length, totalMs / 1000,
      );
      await deductMinutes(user.id, mins);

      if (file_key) {
        s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: file_key })).catch(() => {});
      }

      console.log(`[DONE] ${final.length} segs, ${totalMs}ms (Whisper:${whisperMs}ms, AI:${totalMs - whisperMs}ms)`);

      return NextResponse.json({
        ok: true, status: "completed", segments: final, srt,
        language: mr.language || lang, elapsed: (totalMs / 1000).toFixed(1),
        count: final.length, minutes_charged: mins,
        minutes_remaining: remaining - mins, ai_correction: aiResult.method,
      });
    }

    if (action === "check_job") {
      return NextResponse.json({ ok: true, status: "completed", message: "Modal is synchronous" });
    }

    if (action === "status") {
      return NextResponse.json({
        ok: true, plan: user.plan, minutes_used: user.minutes_used,
        minutes_limit: user.minutes_limit, minutes_remaining: remaining,
      });
    }

    return err("Unknown action");
  } catch (e: any) {
    console.error("API Error:", e);
    return err("שגיאה פנימית", 500);
  }
}
