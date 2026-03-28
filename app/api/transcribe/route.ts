/**
 * SubAI — Transcription Engine v8.0
 * 
 * ARCHITECTURE:
 * Modal Whisper (sync, ~2s) → Claude AI correction → Smart splitting → RTL SRT
 * No polling, no cold start. Single synchronous request.
 *
 * TIMING: Every timestamp comes from Whisper. We never invent times.
 * CORRECTION: Claude is a proofreader. Fixes only impossible words.
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
const MODAL_ENDPOINT = process.env.MODAL_ENDPOINT_URL!; // e.g. https://your--subai-whisper-whispertranscriber-transcribe.modal.run
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const s3 = new S3Client({
  region: AWS_REGION,
  credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID!, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY! }
});

function err(msg: string, status = 400) { return NextResponse.json({ error: true, message: msg }, { status }); }

interface Segment { start: number; end: number; text: string; }
interface Word { start: number; end: number; word: string; probability?: number; }
interface TimedSegment { start: number; end: number; text: string; words: Word[]; }

// ══════════════════════════════════════════════════════════════
// DATABASE
// ══════════════════════════════════════════════════════════════

async function validateApiKey(apiKey: string) {
  const { data } = await supabase.from("profiles")
    .select("id, email, plan, minutes_used, minutes_limit, subscription_status")
    .eq("api_key", apiKey).single();
  return data || null;
}

async function logUsage(userId: string, audioDur: number, lang: string, model: string,
  status: string, count = 0, procSec = 0, errMsg = "") {
  const mins = Math.ceil(audioDur / 60 * 10) / 10;
  await supabase.from("usage_log").insert({
    user_id: userId, audio_duration_sec: audioDur, minutes_charged: mins,
    language: lang, model, segments_count: count, processing_sec: procSec,
    status, error_message: errMsg,
  });
  return mins;
}

async function deductMinutes(userId: string, mins: number) {
  try { await supabase.rpc("increment_usage", { p_user_id: userId, p_minutes: mins }); return; } catch {}
  try {
    const { data } = await supabase.from("profiles").select("minutes_used").eq("id", userId).single();
    if (data) await supabase.from("profiles").update({ minutes_used: (data.minutes_used || 0) + mins }).eq("id", userId);
  } catch {}
}

// ══════════════════════════════════════════════════════════════
// STEP 1: BUILD TIMED SEGMENTS
// ══════════════════════════════════════════════════════════════

function buildTimedSegments(segments: Segment[], words: Word[]): TimedSegment[] {
  if (!words || words.length === 0) {
    return segments.map(seg => ({
      ...seg,
      words: seg.text.split(/\s+/).filter(w => w).map((w, i, arr) => {
        const dur = seg.end - seg.start;
        const wd = dur / arr.length;
        return { start: +(seg.start + i * wd).toFixed(3), end: +(seg.start + (i + 1) * wd).toFixed(3), word: w };
      }),
    }));
  }

  const result: TimedSegment[] = [];
  let wIdx = 0;

  for (const seg of segments) {
    const sw: Word[] = [];
    while (wIdx < words.length) {
      const w = words[wIdx];
      if (w.start >= seg.start - 0.15 && w.start < seg.end + 0.15) { sw.push(w); wIdx++; }
      else if (w.start >= seg.end + 0.15) break;
      else wIdx++;
    }
    result.push({
      start: sw.length > 0 ? sw[0].start : seg.start,
      end: sw.length > 0 ? sw[sw.length - 1].end : seg.end,
      text: sw.length > 0 ? sw.map(w => w.word).join(" ") : seg.text,
      words: sw,
    });
  }

  if (wIdx < words.length) {
    const rem = words.slice(wIdx);
    result.push({ start: rem[0].start, end: rem[rem.length - 1].end, text: rem.map(w => w.word).join(" "), words: rem });
  }

  return result;
}

// ══════════════════════════════════════════════════════════════
// STEP 2: AI CORRECTION — Claude Predictive Context
// ══════════════════════════════════════════════════════════════

function isGarbageSegment(text: string): boolean {
  const latin = (text.match(/[a-zA-Z]/g) || []).length;
  const greek = (text.match(/[\u0370-\u03FF]/g) || []).length;
  const symbols = (text.match(/[Ó€¡¢£¥©®™°±×÷]/g) || []).length;
  const total = text.replace(/\s/g, "").length;
  if (total === 0) return true;
  return (latin + greek + symbols) / total > 0.3;
}

// ── Whisper Hallucination Filter ──
// Detects and removes segments where Whisper got "stuck" or hallucinated:
// 1. Same word/phrase repeated for a long duration
// 2. Single word lasting more than 5 seconds
// 3. Segment with very long duration but very few unique words
// 4. Duplicate consecutive segments (exact same text)
// 5. Segments that are just the initial prompt leaking through

function filterHallucinations(segments: Segment[], words: Word[], prompt: string): { segments: Segment[]; words: Word[] } {
  const filtered: Segment[] = [];
  const filteredWords: Word[] = [];
  let removedCount = 0;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const dur = seg.end - seg.start;
    const text = seg.text.trim();
    const textWords = text.split(/\s+/).filter(w => w);
    const uniqueWords = new Set(textWords.map(w => w.replace(/[.!?,;:]/g, ""))).size;

    let skip = false;
    let reason = "";

    // 1. Very long segment with very few unique words (stuck/looping)
    if (dur > 5 && uniqueWords <= 2 && textWords.length >= 3) {
      skip = true;
      reason = `stuck loop: ${dur.toFixed(1)}s, ${uniqueWords} unique words`;
    }

    // 2. Single word lasting more than 6 seconds
    if (dur > 6 && textWords.length <= 1) {
      skip = true;
      reason = `single word ${dur.toFixed(1)}s`;
    }

    // 3. Very long duration with very little content (hallucinated silence)
    if (dur > 10 && textWords.length <= 3) {
      skip = true;
      reason = `too long for content: ${dur.toFixed(1)}s, ${textWords.length} words`;
    }

    // 4. Exact duplicate of previous segment
    if (i > 0 && text === segments[i - 1].text.trim()) {
      skip = true;
      reason = "exact duplicate";
    }

    // 5. Prompt leak — segment is just the initial prompt or part of it
    if (prompt && text.length > 5) {
      const cleanText = text.replace(/[.!?,;:\s]/g, "");
      const cleanPrompt = prompt.replace(/[.!?,;:\s]/g, "");
      if (cleanPrompt.includes(cleanText) || cleanText.includes(cleanPrompt)) {
        skip = true;
        reason = "prompt leak";
      }
    }

    // 6. Repeating pattern: same 1-2 words repeated 3+ times
    if (textWords.length >= 4 && uniqueWords <= 2) {
      skip = true;
      reason = `repeating pattern: "${textWords.slice(0, 3).join(" ")}..."`;
    }

    if (skip) {
      console.log(`[FILTER] Removed seg ${i} (${reason}): "${text.substring(0, 40)}${text.length > 40 ? "..." : ""}"`);
      removedCount++;
    } else {
      filtered.push(seg);
    }
  }

  // Filter words: keep only words that fall within remaining segments
  if (removedCount > 0 && words.length > 0) {
    for (const w of words) {
      const inFiltered = filtered.some(s => w.start >= s.start - 0.1 && w.start < s.end + 0.1);
      if (inFiltered) filteredWords.push(w);
    }
    console.log(`[FILTER] Removed ${removedCount} hallucinated segments, kept ${filtered.length}. Words: ${words.length}→${filteredWords.length}`);
    return { segments: filtered, words: filteredWords };
  }

  return { segments, words };
}

async function aiCorrect(timedSegs: TimedSegment[], language: string): Promise<{ segments: TimedSegment[]; method: string }> {
  if (!ANTHROPIC_API_KEY || timedSegs.length === 0) {
    return { segments: timedSegs, method: "none" };
  }

  try {
    const input = timedSegs.map((s, i) =>
      `[${i}|${s.start.toFixed(2)}-${s.end.toFixed(2)}] ${s.text}`
    ).join("\n");

    const langName = language === "he" ? "עברית" : language === "ar" ? "ערבית" : "English";

    const systemPrompt = `You are a contextual prediction engine for ${langName} transcription repair.

CRITICAL: You MUST process and return EVERY segment — no exceptions. If a segment is correct, return it UNCHANGED. If you are unsure, return it UNCHANGED. Every input line produces exactly one output line. Skipping a segment = system failure.

YOUR METHOD — PREDICTIVE CONTEXT:
Read the ENTIRE text first. Build a mental model of topic, speakers, names, terms.
Then for EACH word: predict what SHOULD be there → compare with Whisper → fix only if IMPOSSIBLE.

PHASE 1 — DEEP CONTEXT SCAN:
A) TOPIC MAP: religion/tech/cooking/law/sports/casual/politics/military/education?
B) SPEAKER PROFILE: formal/casual, age, ethnicity, jargon, accent
C) NAME REGISTRY: all names, places, brands — NEVER change these
D) TERM GLOSSARY: domain words that repeat
E) FIXED EXPRESSIONS: phrase pairs that must appear together
F) ABBREVIATIONS: words that are actually abbreviations with גרשיים

PHASE 2 — PREDICTIVE REPAIR:
For each word: MASK → PREDICT from context → COMPARE with Whisper.
- Prediction = Whisper → no change
- Prediction ≠ Whisper, but Whisper is a REAL word that COULD fit → DO NOT CHANGE
- Prediction ≠ Whisper, and Whisper is IMPOSSIBLE in context → FIX

PHASE 3 — GARBAGE DETECTION:
If a segment has Latin, Greek, symbols, or nonsense mixed with Hebrew — this is Whisper failure.
Try to reconstruct from surrounding context. If <90% confident, return segment unchanged.

PHASE 4 — ${langName} INTELLIGENCE:
${language === "he" ? `
SOUND CONFUSION PAIRS — fix ONLY when context makes it clear:
א↔ע: נושאו↔נושעו, אמוק↔עמוק, אל↔על, אישועות↔ישועות
ה↔ח: טהרה↔תהרה, הולך↔חולך, חס↔הס
כ↔ק: כלב↔קלב, כהתה↔קהתה
ט↔ת: טוב↔תוב, טהרה↔תהרה
ס↔ש: סיפור↔שיפור, סגר↔שגר
ב↔פ: חביות↔חוויות, בעיה↔פעיה

ABBREVIATIONS WITH גרשיים:
שליטה/שליט → שליט"א | זצל/זצ ל → זצ"ל | זיעא → זיע"א
הרשש → הרש"ש | הרמבם → הרמב"ם | תנך → תנ"ך | בהמק → בהמ"ק

FIXED EXPRESSIONS (both halves confirm each other):
בקדושה ובטהרה | נושעו ונרפאו | חס ושלום | ברוך השם | בעזרת השם
לרפואה שלמה | כהתה עינו ולא נס ליחו | בשורות טובות | מזל טוב
יהי רצון | אם ירצה השם | שיבנה בית המקדש | זכר צדיק לברכה

PHANTOM LETTERS — Whisper adds phantom א/ה:
האישועות → הישועות | ואישועה → וישועה | אהולך → הולך

CONSTRUCT STATE (סמיכות) — keep together:
יין+הישועות | שמות+הקודש | גן+עדן | בית+המקדש | מערת+המכפלה

ISRAELI SLANG & CULTURE — these are CORRECT, not errors:
Slang: יאללה, וואלה, אחלה, סבבה, באסה, חלאס, תכלס, פאדיחה, מאפו, ג'ובה, כוסית
Filler: כאילו, אממ, אה, נו, אז, בקיצור, בעצם, סתם, פשוט
Food: חומוס, פלאפל, שקשוקה, ג'חנון, מלוואח, קובה, חריימה, ציגר
Cities: ת"א, ב"ש, ירושלים, חיפה, נתניה, רמת גן, פ"ת, ר"ג, כ"ס
Military: צה"ל, חובשים, טירונות, קצינים, גדוד, חטיבה, מילואים, צו 8
Religion: בימ"ד, ביהכנ"ס, ס"ת, פרשת השבוע, הלכה, מנהג, עליה לתורה
Ethnic terms: ספרדי, אשכנזי, מזרחי, תימני, מרוקאי, עיראקי, אתיופי
Historical: השואה, העלייה, תקופת המנדט, מלחמת העצמאות

NUMBERS: 300→3000 only if context clearly indicates thousands (e.g., "3000 תלמידים" vs "300 תלמידים").
Do NOT change numbers unless Whisper clearly dropped/added a digit based on context.
` : language === "ar" ? `
Fix Arabic-specific Whisper errors. Respect dialect (MSA/Levantine/Egyptian/Gulf).
` : ""}

PHASE 5 — PUNCTUATION: Add . , ? only at clear sentence boundaries.

PHASE 6 — VERIFICATION (for EACH change):
□ Is Whisper's word IMPOSSIBLE in context? (YES required to change)
□ Is my replacement the ONLY plausible word? (YES required)
□ Am I 99%+ confident? (YES required)
□ Did I accidentally swap a real word for a synonym? (NO required)
□ Did I change the speaker's meaning? (NO required)
If ANY check fails → REVERT to original.

ABSOLUTE PROHIBITIONS:
❌ No synonyms (גדול→עצום, הלך→צעד, לעשות→לטפל, נדבר→נוצר)
❌ No style improvements or rewrites
❌ No word additions unless filling an obvious 1-word gap with 99% certainty
❌ No filler word removal (כאילו, אממ, אה, נו are timing anchors)
❌ No name/place changes
❌ No sentence restructuring

GOLDEN RULE: If Whisper's word is REAL and COULD make sense → leave it.
Fix ONLY when the word is IMPOSSIBLE in context.

OUTPUT: [index|start-end] text — one line per segment, every segment, no skipping.`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 50000); // 50s — enough for 100+ segments

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 8192,
        system: systemPrompt,
        messages: [{ role: "user", content: input }],
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) return { segments: timedSegs, method: "api_error" };

    const result = await response.json();
    const output = result.content?.[0]?.text || "";

    const corrected: Array<{ idx: number; text: string }> = [];
    for (const line of output.split("\n")) {
      const m = line.match(/\[(\d+)\|([\d.]+)-([\d.]+)\]\s*(.*)/);
      if (m && m[4].trim()) corrected.push({ idx: parseInt(m[1]), text: m[4].trim() });
    }

    if (corrected.length === 0 || Math.abs(corrected.length - timedSegs.length) > timedSegs.length * 0.3) {
      console.warn(`[AI] REJECTED ALL: ${timedSegs.length}→${corrected.length}`);
      return { segments: timedSegs, method: "integrity_fail" };
    }

    let acceptCount = 0, rejectCount = 0;
    const fixed = timedSegs.map((seg, i) => {
      const correction = corrected.find(c => c.idx === i);
      if (!correction) return seg;

      const origClean = seg.text.replace(/[.!?,;:\s]/g, "");
      const corrClean = correction.text.replace(/[.!?,;:\s]/g, "");

      if (origClean === corrClean) {
        if (seg.text.trim() !== correction.text) acceptCount++;
        return { ...seg, text: correction.text };
      }

      const dist = levenshtein(origClean, corrClean);
      const isGarbage = isGarbageSegment(seg.text);
      const threshold = isGarbage ? 0.85 : 0.30;

      if (dist > threshold) {
        console.warn(`[AI] SEG ${i} REJECTED (${(dist * 100).toFixed(0)}%${isGarbage ? " GARBAGE" : ""}): "${seg.text.trim()}" → "${correction.text}"`);
        rejectCount++;
        return seg;
      }

      const origWC = seg.text.split(/\s+/).filter(w => w && !/^[.!?,;:]+$/.test(w)).length;
      const corrWC = correction.text.split(/\s+/).filter(w => w && !/^[.!?,;:]+$/.test(w)).length;
      if (Math.abs(origWC - corrWC) > 2 && !isGarbage) {
        console.warn(`[AI] SEG ${i} REJECTED (words ${origWC}→${corrWC}): "${seg.text.trim()}" → "${correction.text}"`);
        rejectCount++;
        return seg;
      }

      console.log(`[AI] SEG ${i} ACCEPTED (${(dist * 100).toFixed(0)}%): "${seg.text.trim()}" → "${correction.text}"`);
      acceptCount++;

      const corrWords = correction.text.split(/\s+/).filter(w => w);
      const syncedWords = seg.words.map((w, wi) => {
        if (wi < corrWords.length) return { ...w, word: corrWords[wi] };
        return w;
      });
      if (corrWords.length > seg.words.length) {
        for (let extra = seg.words.length; extra < corrWords.length; extra++) {
          const last = seg.words[seg.words.length - 1];
          syncedWords.push({ start: last.end, end: last.end + 0.15, word: corrWords[extra] });
        }
      }

      return { ...seg, text: correction.text, words: syncedWords };
    });

    console.log(`[AI] SUMMARY: ${acceptCount} accepted, ${rejectCount} rejected, ${timedSegs.length - acceptCount - rejectCount} unchanged`);
    return { segments: fixed, method: "claude" };
  } catch (e: any) {
    if (e.name === "AbortError") {
      console.warn(`[AI] Claude timeout (50s) for ${timedSegs.length} segments — using Whisper original`);
      return { segments: timedSegs, method: "timeout_fallback" };
    }
    console.error("[AI] Error:", e.message || e);
    return { segments: timedSegs, method: "error_fallback" };
  }
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
      m[i][j] = Math.min(m[i-1][j]+1, m[i][j-1]+1, m[i-1][j-1]+(a[i-1]===b[j-1]?0:1));
  return m[a.length][b.length] / Math.max(a.length, b.length);
}

// ══════════════════════════════════════════════════════════════
// STEP 2.5: BOUNDARY REPAIR
// ══════════════════════════════════════════════════════════════

function repairBoundaries(segs: TimedSegment[], origWords: Word[]): TimedSegment[] {
  if (!origWords || origWords.length === 0) return segs;

  const allCorr: string[] = [];
  const segMap: number[] = [];
  for (let si = 0; si < segs.length; si++) {
    const ws = segs[si].text.split(/\s+/).filter(w => w);
    for (const w of ws) { allCorr.push(w); segMap.push(si); }
  }

  const matched: Array<{ word: string; start: number; end: number }> = [];
  let oi = 0;
  for (const cw of allCorr) {
    if (oi < origWords.length) {
      matched.push({ word: cw, start: origWords[oi].start, end: origWords[oi].end });
      oi++;
    } else {
      const last = matched.length > 0 ? matched[matched.length - 1].end : 0;
      matched.push({ word: cw, start: last, end: last + 0.15 });
    }
  }

  const result: TimedSegment[] = [];
  let mi = 0;
  for (let si = 0; si < segs.length; si++) {
    const wc = segs[si].text.split(/\s+/).filter(w => w).length;
    const sw: Word[] = [];
    for (let wi = 0; wi < wc && mi < matched.length; wi++) {
      sw.push({ start: matched[mi].start, end: matched[mi].end, word: matched[mi].word });
      mi++;
    }
    if (sw.length > 0) {
      result.push({ start: sw[0].start, end: sw[sw.length - 1].end, text: sw.map(w => w.word).join(" "), words: sw });
    }
  }

  return result.length > 0 ? result : segs;
}

// ══════════════════════════════════════════════════════════════
// STEP 3: SPLITTING — All timestamps from Whisper
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
  return { start: words[0].start, end: words[words.length - 1].end, text: words.map(w => w.word).join(" ") };
}

function splitSentence(all: Word[]): Segment[] {
  const r: Segment[] = []; let c: Word[] = [];
  for (const w of all) { c.push(w); if (/[.!?]$/.test(w.word.trim())) { r.push(mkSeg(c)); c = []; } }
  if (c.length > 0) r.push(mkSeg(c));
  return r;
}

function splitWords(all: Word[], gs: number): Segment[] {
  const r: Segment[] = []; let c: Word[] = [];
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
  const r: Segment[] = []; let c: Word[] = []; let ct = "";

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
      for (let x = 1; x <= chain && (i + x) < all.length; x++) extra += all[i + x].word.length + 1;
      if (ct.length + extra <= HARD) continue;
      const lb = countTail(c);
      if (lb > 0 && c.length - lb >= 2) {
        r.push(mkSeg(c.slice(0, c.length - lb)));
        c = c.slice(c.length - lb); ct = c.map(w => w.word).join(" "); continue;
      }
      r.push(mkSeg(c)); c = []; ct = ""; continue;
    }

    if (ct.length >= HARD || dur >= MAXD) { r.push(mkSeg(c)); c = []; ct = ""; continue; }
  }
  if (c.length > 0) r.push(mkSeg(c));
  return r;
}

function isBound(a: Word, b: Word): boolean {
  const wa = a.word.trim().replace(/[,.:;!?"״]+$/g, "");
  const wb = b.word.trim().replace(/[,.:;!?"״]+$/g, "");
  if (["הרב","הגאון","הרבנית","מורנו","ורבנו","המקובל","הצדיק","ר'","רבי","דר","פרופ","מר","גב",'עו"ד'].includes(wa)) return true;
  if (["לא","אל","אין","בלי","ללא","אינו","אינה","אינם"].includes(wa)) return true;
  if (!wa.startsWith("ה") && wb.startsWith("ה") && wb.length > 2) return true;
  if (["את","של","על","אל","עם","בת","בן","כל","גם","רק","כי","אם","או","כמו"].includes(wa)) return true;
  if (["ו","וגם","אבל","אלא"].includes(wa)) return true;
  if (/^\d+$/.test(wa)) return true;
  if (["ש","כש","לכש","מש"].includes(wa)) return true;
  const bc = wb.replace(/[""״]/g, '"');
  if (['שליט"א',"שליטא",'זצ"ל',"זצל",'זיע"א'].some(h => bc === h || bc.startsWith(h))) return true;
  return false;
}

function countChain(w: Word[], si: number): number {
  let c = 0, i = si;
  while (i < w.length && i > 0 && isBound(w[i-1], w[i])) { c++; i++; }
  return c;
}

function countTail(c: Word[]): number {
  if (c.length < 2) return 0;
  let n = 0;
  for (let i = c.length - 1; i >= 1; i--) {
    const a = c[i].word.trim().replace(/[,.:;!?]+$/g, "");
    if (["הרב","הגאון","מורנו","ורבנו","המקובל","לא","אל","אין","את","של","על","אל","עם","כל","גם","כי","ש","כש"].includes(a)) n++;
    else break;
  }
  return n;
}

// ══════════════════════════════════════════════════════════════
// SRT BUILDER (RTL)
// ══════════════════════════════════════════════════════════════

function buildSrt(segs: Segment[], lang: string = "he"): string {
  const rtl = lang === "he" || lang === "ar";
  const RLM = "\u200F";
  const ts = (s: number) => {
    s = Math.max(0, s);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sc = Math.floor(s % 60),
      ms = Math.round((s - Math.floor(s)) * 1000);
    return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(sc).padStart(2,"0")},${String(ms).padStart(3,"0")}`;
  };
  return segs.map((seg, i) => {
    const t = seg.text.trim();
    if (!t) return "";
    return `${i+1}\n${ts(seg.start)} --> ${ts(seg.end)}\n${rtl ? RLM + t : t}\n`;
  }).filter(Boolean).join("\n");
}

// ══════════════════════════════════════════════════════════════
// MAIN HANDLER
// ══════════════════════════════════════════════════════════════

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { api_key, action, lang, model, offset, audio_duration, caption_style, words_per_group } = body;

    if (!api_key) return err("Missing api_key", 401);
    const user = await validateApiKey(api_key);
    if (!user) return err("Invalid API key", 401);

    const remaining = (user.minutes_limit || 0) - (user.minutes_used || 0);
    if (remaining <= 0) return err("נגמרה המכסה. שדרג תוכנית.", 403);

    if (action === "get_upload_url") {
      const fileKey = `audio/${user.id}/${Date.now()}.mp3`;
      const putCmd = new PutObjectCommand({ Bucket: S3_BUCKET, Key: fileKey, ContentType: "audio/mpeg" });
      const uploadUrl = await getSignedUrl(s3, putCmd, { expiresIn: 300 });
      const getCmd = new GetObjectCommand({ Bucket: S3_BUCKET, Key: fileKey });
      const downloadUrl = await getSignedUrl(s3, getCmd, { expiresIn: 3600 });
      return NextResponse.json({ upload_url: uploadUrl, download_url: downloadUrl, file_key: fileKey, remaining_minutes: remaining });
    }

    if (action === "transcribe") {
      const { download_url, file_key } = body;
      if (!download_url) return err("Missing download_url");
      const audioDur = audio_duration || 0;
      if (Math.ceil(audioDur / 60 * 10) / 10 > remaining) return err("לא מספיק דקות.", 403);

      // ── STEP 1: Modal Whisper (full VAD control, Hebrew optimized) ──
      console.log("[MODAL] Sending to Whisper...");
      const t0 = Date.now();

      const modalRes = await fetch(MODAL_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          audio_url: download_url,
          lang: lang || "he",
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
        console.error("[MODAL] Whisper error:", mr.error);
        await logUsage(user.id, audioDur, lang || "he", "whisper-large-v3", "failed", 0, 0, mr.error);
        return err("שגיאת תמלול: " + mr.error, 500);
      }

      console.log(`[MODAL] Done in ${whisperMs}ms — ${mr.segments?.length || 0} segs, ${mr.words?.length || 0} words`);

      const rawSegs: Segment[] = (mr.segments || []).map((s: any) => ({ start: s.start, end: s.end, text: (s.text || "").trim() }));
      const rawWords: Word[] = (mr.words || []).map((w: any) => ({ start: w.start, end: w.end, word: (w.word || "").trim() }));

      if (rawSegs.length === 0) {
        await logUsage(user.id, audioDur, lang || "he", "whisper-large-v3", "empty", 0, 0);
        return err("לא נמצא דיבור.", 200);
      }

      // ── STEP 1.5: Filter Whisper hallucinations ──
      const hePrompt = lang === "he" ? "שלום, זהו תמלול מקצועי בעברית תקנית. סימני פיסוק: נקודה, פסיק, סימן שאלה. שמות אנשים, מקומות ומונחים מקצועיים נכתבים במדויק." : "";
      const cleaned = filterHallucinations(rawSegs, rawWords, hePrompt);

      if (cleaned.segments.length === 0) {
        await logUsage(user.id, audioDur, lang || "he", "whisper-large-v3", "empty", 0, 0);
        return err("לא נמצא דיבור.", 200);
      }

      // ── STEP 2: Build timed segments ──
      const timedSegs = buildTimedSegments(cleaned.segments, cleaned.words);

      // ── STEP 3: Claude AI correction ──
      const aiResult = await aiCorrect(timedSegs, lang || "he");

      // ── STEP 3.5: Repair boundaries ──
      const repaired = repairBoundaries(aiResult.segments, rawWords);

      // ── STEP 4: Split ──
      const wpg = parseInt(words_per_group) || 1;
      const final = applySplitting(repaired, caption_style || "auto", wpg);

      // ── STEP 5: Build SRT (RTL) ──
      const srt = buildSrt(final, lang || "he");

      // ── STEP 6: Log & deduct ──
      const totalMs = Date.now() - t0;
      const mins = await logUsage(user.id, audioDur, lang || "he", "whisper-large-v3", "completed", final.length, totalMs / 1000);
      await deductMinutes(user.id, mins);

      if (file_key) s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: file_key })).catch(() => {});

      console.log(`[DONE] ${final.length} segs, ${totalMs}ms (Whisper: ${whisperMs}ms, Claude: ${totalMs - whisperMs}ms)`);

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
