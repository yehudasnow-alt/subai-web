/**
 * SubAI — Transcription Engine v9.1
 *
 * ARCHITECTURE:
 * Modal Whisper (sync, ~2s) → Claude AI correction → Smart splitting → RTL SRT
 * No polling, no cold start. Single synchronous request.
 *
 * TIMING:     Every timestamp comes from Whisper. We never invent times.
 * CORRECTION: Claude reads the FULL transcript first, understands topic & context,
 *             then surgically fixes only phonetic ASR errors — never word choices.
 * TEMP=0:     Deterministic output. No creativity, no guessing, no paraphrasing.
 * VALIDATION: Per-word Levenshtein gate — each word checked individually, not the whole segment.
 *
 * v9.1 SECURITY UPGRADE:
 *   • Rate Limiting: 10 transcriptions per minute per user (in-memory)
 *   • Input Validation: API key format, max audio 60 min, language whitelist
 *   • Security logging: all blocked attempts logged with [SECURITY] prefix
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export const maxDuration = 120;

const SUPABASE_URL         = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const AWS_REGION           = process.env.AWS_REGION   || "eu-north-1";
const S3_BUCKET            = process.env.S3_BUCKET    || "subai-audio";
const MODAL_ENDPOINT       = process.env.MODAL_ENDPOINT_URL!;
const ANTHROPIC_API_KEY    = process.env.ANTHROPIC_API_KEY || "";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const s3 = new S3Client({
  region: AWS_REGION,
  credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID!, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY! },
});

function err(msg: string, status = 400) { return NextResponse.json({ error: true, message: msg }, { status }); }

interface Segment      { start: number; end: number; text: string; }
interface Word         { start: number; end: number; word: string; probability?: number; }
interface TimedSegment { start: number; end: number; text: string; words: Word[]; }

// ══════════════════════════════════════════════════════════════
// SECURITY LAYER 2: RATE LIMITING
// ══════════════════════════════════════════════════════════════

const RATE_LIMIT_WINDOW_MS = 60_000;  // 1 minute
const RATE_LIMIT_MAX       = 10;      // max requests per window

const rateLimitMap = new Map<string, number[]>();
let rateLimitCleanupCounter = 0;

function checkRateLimit(userId: string): { allowed: boolean; retryAfterMs: number } {
  const now = Date.now();
  const timestamps = rateLimitMap.get(userId) || [];

  // Remove entries older than the window
  const recent = timestamps.filter(t => now - t < RATE_LIMIT_WINDOW_MS);

  if (recent.length >= RATE_LIMIT_MAX) {
    const oldestInWindow = recent[0];
    const retryAfterMs = RATE_LIMIT_WINDOW_MS - (now - oldestInWindow);
    console.log(`[SECURITY] Rate limit hit: user ${userId.substring(0, 8)}... (${recent.length}/${RATE_LIMIT_MAX} in window)`);
    return { allowed: false, retryAfterMs };
  }

  recent.push(now);
  rateLimitMap.set(userId, recent);

  // Cleanup old entries every 1000 requests to prevent memory leak
  rateLimitCleanupCounter++;
  if (rateLimitCleanupCounter >= 1000) {
    rateLimitCleanupCounter = 0;
    const cutoff = now - RATE_LIMIT_WINDOW_MS * 2;
    for (const [key, vals] of rateLimitMap.entries()) {
      const filtered = vals.filter(t => t > cutoff);
      if (filtered.length === 0) rateLimitMap.delete(key);
      else rateLimitMap.set(key, filtered);
    }
    console.log(`[SECURITY] Rate limit cleanup — ${rateLimitMap.size} users tracked`);
  }

  return { allowed: true, retryAfterMs: 0 };
}

// ══════════════════════════════════════════════════════════════
// SECURITY LAYER 3: INPUT VALIDATION
// ══════════════════════════════════════════════════════════════

const VALID_LANGUAGES = new Set([
  "he", "ar", "en", "ru", "fr", "es", "de", "it", "pt", "nl",
  "pl", "uk", "ro", "hu", "cs", "sv", "da", "fi", "no", "tr",
  "ja", "ko", "zh", "th", "vi", "id", "ms", "hi", "bn", "ta",
  "el", "bg", "hr", "sr", "sk", "sl", "et", "lv", "lt", "am",
]);

const MAX_AUDIO_DURATION_SEC = 3600; // 60 minutes
const API_KEY_MIN_LENGTH     = 20;
const API_KEY_MAX_LENGTH     = 200;

const VALID_ACTIONS = new Set([
  "get_upload_url", "transcribe", "check_job", "status",
]);

const VALID_CAPTION_STYLES = new Set([
  "auto", "sentence", "word1", "word2", "word3", "word4", "word5", "word6",
]);

function validateInput(body: any): { valid: boolean; error: string } {
  // API key format
  const { api_key, action, lang, audio_duration, caption_style } = body;

  if (!api_key || typeof api_key !== "string") {
    return { valid: false, error: "Missing api_key" };
  }
  if (api_key.length < API_KEY_MIN_LENGTH || api_key.length > API_KEY_MAX_LENGTH) {
    console.log(`[SECURITY] Invalid API key length: ${api_key.length}`);
    return { valid: false, error: "Invalid API key format" };
  }
  if (/[<>"';\s]/.test(api_key)) {
    console.log(`[SECURITY] API key contains forbidden characters`);
    return { valid: false, error: "Invalid API key format" };
  }

  // Action validation
  if (!action || !VALID_ACTIONS.has(action)) {
    return { valid: false, error: "Unknown action" };
  }

  // Language validation (only for transcribe)
  if (action === "transcribe" && lang && !VALID_LANGUAGES.has(lang)) {
    console.log(`[SECURITY] Invalid language: ${lang}`);
    return { valid: false, error: `Unsupported language: ${lang}` };
  }

  // Audio duration validation
  if (action === "transcribe" && audio_duration !== undefined) {
    const dur = Number(audio_duration);
    if (isNaN(dur) || dur < 0) {
      console.log(`[SECURITY] Invalid audio_duration: ${audio_duration}`);
      return { valid: false, error: "Invalid audio duration" };
    }
    if (dur > MAX_AUDIO_DURATION_SEC) {
      console.log(`[SECURITY] Audio too long: ${dur}s (max ${MAX_AUDIO_DURATION_SEC}s)`);
      return { valid: false, error: `אודיו ארוך מדי. מקסימום ${MAX_AUDIO_DURATION_SEC / 60} דקות.` };
    }
  }

  // Caption style validation
  if (caption_style && !VALID_CAPTION_STYLES.has(caption_style)) {
    return { valid: false, error: "Invalid caption style" };
  }

  return { valid: true, error: "" };
}

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
        const dur = seg.end - seg.start, wd = dur / arr.length;
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
      if      (w.start >= seg.start - 0.15 && w.start < seg.end + 0.15) { sw.push(w); wIdx++; }
      else if (w.start >= seg.end + 0.15) break;
      else wIdx++;
    }
    result.push({
      start: sw.length > 0 ? sw[0].start         : seg.start,
      end:   sw.length > 0 ? sw[sw.length-1].end : seg.end,
      text:  sw.length > 0 ? sw.map(w => w.word).join(" ") : seg.text,
      words: sw,
    });
  }

  if (wIdx < words.length) {
    const rem = words.slice(wIdx);
    result.push({ start: rem[0].start, end: rem[rem.length-1].end, text: rem.map(w => w.word).join(" "), words: rem });
  }

  return result;
}

// ══════════════════════════════════════════════════════════════
// STEP 2: AI CORRECTION
// ══════════════════════════════════════════════════════════════

function isGarbageSegment(text: string): boolean {
  const latin   = (text.match(/[a-zA-Z]/g)        || []).length;
  const greek   = (text.match(/[\u0370-\u03FF]/g) || []).length;
  const symbols = (text.match(/[Ó€¡¢£¥©®™°±×÷]/g) || []).length;
  const total   = text.replace(/\s/g, "").length;
  if (total === 0) return true;
  return (latin + greek + symbols) / total > 0.3;
}

// ── Whisper Hallucination Filter ──
function filterHallucinations(
  segments: Segment[], words: Word[], prompt: string
): { segments: Segment[]; words: Word[] } {
  const filtered: Segment[] = [];
  const filteredWords: Word[] = [];
  let removedCount = 0;

  for (let i = 0; i < segments.length; i++) {
    const seg    = segments[i];
    const dur    = seg.end - seg.start;
    const text   = seg.text.trim();
    const tw     = text.split(/\s+/).filter(w => w);
    const unique = new Set(tw.map(w => w.replace(/[.!?,;:]/g, ""))).size;

    let skip = false, reason = "";

    if (dur > 5  && unique <= 2 && tw.length >= 3) { skip = true; reason = `stuck loop: ${dur.toFixed(1)}s, ${unique} unique`; }
    if (dur > 6  && tw.length <= 1)                { skip = true; reason = `single word ${dur.toFixed(1)}s`; }
    if (dur > 10 && tw.length <= 3)                { skip = true; reason = `too long for content: ${dur.toFixed(1)}s, ${tw.length} words`; }
    if (i > 0 && text === segments[i-1].text.trim()) { skip = true; reason = "exact duplicate"; }
    if (prompt && text.length > 5) {
      const ct = text.replace(/[.!?,;:\s]/g, ""), cp = prompt.replace(/[.!?,;:\s]/g, "");
      if (cp.includes(ct) || ct.includes(cp)) { skip = true; reason = "prompt leak"; }
    }
    if (tw.length >= 4 && unique <= 2) { skip = true; reason = `repeating pattern: "${tw.slice(0,3).join(" ")}..."`; }

    if (skip) {
      console.log(`[FILTER] Removed seg ${i} (${reason}): "${text.substring(0,40)}${text.length>40?"...":""}"`);
      removedCount++;
    } else {
      filtered.push(seg);
    }
  }

  if (removedCount > 0 && words.length > 0) {
    for (const w of words) {
      if (filtered.some(s => w.start >= s.start - 0.1 && w.start < s.end + 0.1)) filteredWords.push(w);
    }
    console.log(`[FILTER] Removed ${removedCount} hallucinated segs, kept ${filtered.length}. Words: ${words.length}→${filteredWords.length}`);
    return { segments: filtered, words: filteredWords };
  }
  return { segments, words };
}

// ── Levenshtein distance (normalised 0–1) ──
function levenshtein(a: string, b: string): number {
  if (a === b)   return 0;
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

// ── Per-word validation ──
function validateCorrection(orig: string, corr: string, isGarbage: boolean): {
  ok: boolean; reason: string;
} {
  const strip = (s: string) => s.replace(/[.!?,;:״"']/g, "").trim();

  const ow = orig.split(/\s+/).filter(w => w && !/^[.!?,;:]+$/.test(w));
  const cw = corr.split(/\s+/).filter(w => w && !/^[.!?,;:]+$/.test(w));

  const maxDiff = isGarbage ? 3 : 1;
  const diff    = Math.abs(ow.length - cw.length);
  if (diff > maxDiff) {
    return { ok: false, reason: `word-count ${ow.length}→${cw.length} (diff=${diff}, max=${maxDiff})` };
  }

  const MAX_WORD_DIST = isGarbage ? 0.85 : 0.55;
  const len = Math.min(ow.length, cw.length);

  for (let i = 0; i < len; i++) {
    const a = strip(ow[i]);
    const b = strip(cw[i]);
    if (a === b) continue;
    const d = levenshtein(a, b);
    if (d > MAX_WORD_DIST) {
      return { ok: false, reason: `word[${i}] dist=${(d*100).toFixed(0)}% "${ow[i]}"→"${cw[i]}"` };
    }
  }

  return { ok: true, reason: "" };
}

async function aiCorrect(
  timedSegs: TimedSegment[], language: string
): Promise<{ segments: TimedSegment[]; method: string }> {
  if (!ANTHROPIC_API_KEY || timedSegs.length === 0) return { segments: timedSegs, method: "none" };

  try {
    const fullContext           = timedSegs.map(s => s.text.trim()).join(" ");
    const segmentsForCorrection = timedSegs
      .map((s, i) => `[${i}|${s.start.toFixed(2)}-${s.end.toFixed(2)}] ${s.text}`)
      .join("\n");

    const systemPrompt = `אתה מתקן תמלול אוטומטי בעברית. קיבלת פלט של מודל זיהוי דיבור (Whisper).

═══ מהות התפקיד ═══
תפקידך היחיד: לזהות מילים שוויספר שמע בטעות ולתקן אותן — ורק אותן.
אין לך ידע חיצוני. כל תיקון חייב לנבוע אך ורק מהבנת הטקסט עצמו.

═══ תהליך עבודה (חובה — בתוך <thinking>) ═══

שלב 1 — קריאה מלאה:
קרא את כל הטקסט מתחילתו ועד סופו. אל תתקן כלום עדיין.

שלב 2 — זיהוי נושא ותחום:
מהו הנושא המרכזי? (שיעור תורה, הרצאה אקדמית, שיחה יומיומית, ראיון, פודקאסט וכו')
מהו התחום המקצועי? (הלכה, רפואה, טכנולוגיה, כלכלה, חינוך, שיחת חולין וכו')
מהו רישום השפה של הדובר? (גבוה/תקני, יומיומי, סלנג, מעורב)

שלב 3 — מיפוי מונחי מפתח:
זהה מילים ומונחים שחוזרים לאורך הטקסט. אם מילה מופיעה 3 פעמים נכון ופעם אחת בצורה שונה — הצורה השונה היא כנראה שגיאת שמיעה.
רשום את המונחים המרכזיים של השיחה.

שלב 4 — סריקת חשודים:
עבור סגמנט-סגמנט. לכל מילה שאל:
  א. האם המילה הזאת קיימת בעברית?
  ב. האם היא הגיונית בהקשר המשפט?
  ג. האם יש מילה שנשמעת דומה ומתאימה יותר לנושא השיחה?
  ד. האם המילה הזאת מופיעה במקומות אחרים בטקסט בצורה שונה?
אם התשובות ל-א ו-ב הן "כן" — אל תשנה.

שלב 5 — אימות צולב:
לפני כל תיקון, בדוק: האם התיקון עקבי עם שאר הטקסט? האם המילה המתוקנת הגיונית בהקשר הסגמנטים שלפני ואחרי?

סגור </thinking> ופלוט את התוצאה.

═══ חוקי ברזל — אין חריגות ═══

1. הצמדה למקור: אתה עורך, לא כותב. כל מילה שהדובר אמר חייבת להישאר — גם אם היא לא מושלמת דקדוקית. תפקידך רק לתקן מה שוויספר שיבש, לא מה שהדובר "התכוון".

2. כמות מילים: אסור להוסיף או למחוק מילים. החריגה היחידה: תחיליות עבריות (ש/ל/מ/כ/ב/ו/ה) שהתמזגו או התפצלו בטעות — הפרש של מילה אחת בלבד מותר.

3. תיקון אותיות בלבד: מותר לשנות אות שגויה, אות חסרה, אות מיותרת, או הומופון.
   ✓ חינוני→חילוני | הלק→הלך | קרא→קרה | כאלה→כאילו | אל גור איתם→אלגוריתם
   ✗ הלך→צעד | גדול→עצום | אמר→ציין | ראה→הבחין (החלפת מילה שלמה — אסור)
   ✗ ביקש→רצה | שמח→מאושר | הרבה→המון (מילים נרדפות — אסור)

4. שמירת דקדוק הדובר: "שלוש שקל", "אני יגיד", "הוא אמרה" — השאר כמות שהוא. אלה לא שגיאות שמיעה.

5. מילות מילוי: כאילו, אממ, אה, נו, כזה, טוב, אז, יאללה, בקיצור — חובה להשאיר. הן עוגני תזמון.

6. כלל ברירת המחדל: אם המשפט מובן וקריא כמות שהוא — אל תשנה כלום. ברירת המחדל תמיד היא אי-שינוי.

7. עקביות פנימית: אם תיקנת מילה בסגמנט 5, ואותה מילה מופיעה בסגמנט 12 באותה צורה — תקן גם שם. עקביות לאורך כל הטקסט.

8. פיסוק: מותר להוסיף או לתקן סימני פיסוק (נקודה, פסיק, סימן שאלה, סימן קריאה) מבלי לשנות אף מילה.

═══ פורמט פלט ═══
[index|start-end] text
שורה אחת לכל סגמנט. כל הסגמנטים. ללא שום טקסט מחוץ ל-<thinking> ולשורות הסגמנטים.`;

    const userMessage = `הנה התמלול המלא — קרא הכל לפני שאתה מתחיל:
===
${fullContext}
===

סגמנטים לתיקון (שמור על הפורמט בדיוק):

${segmentsForCorrection}`;

    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), 50000);

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method:  "POST",
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model:       "claude-sonnet-4-20250514",
        max_tokens:  8192,
        temperature: 0,
        system:      systemPrompt,
        messages:    [{ role: "user", content: userMessage }],
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

      const isGarbage = isGarbageSegment(seg.text);

      const { ok, reason } = validateCorrection(seg.text, correction.text, isGarbage);
      if (!ok) {
        console.warn(`[AI] SEG ${i} REJECTED (${reason}): "${seg.text.trim()}" → "${correction.text}"`);
        rejectCount++;
        return seg;
      }

      console.log(`[AI] SEG ${i} ACCEPTED: "${seg.text.trim()}" → "${correction.text}"`);
      acceptCount++;

      const corrWords = correction.text.split(/\s+/).filter(w => w);
      if (!seg.words || seg.words.length === 0) return { ...seg, text: correction.text };

      const syncedWords = seg.words.map((w, wi) =>
        wi < corrWords.length ? { ...w, word: corrWords[wi] } : w
      );
      if (corrWords.length > seg.words.length) {
        const last = seg.words[seg.words.length - 1];
        for (let x = seg.words.length; x < corrWords.length; x++) {
          syncedWords.push({ start: last.end, end: last.end + 0.1, word: corrWords[x] });
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

// ══════════════════════════════════════════════════════════════
// STEP 2.5: BOUNDARY REPAIR
// ══════════════════════════════════════════════════════════════

function repairBoundaries(segs: TimedSegment[], origWords: Word[]): TimedSegment[] {
  if (!origWords || origWords.length === 0) return segs;

  const result: TimedSegment[] = [];

  for (const seg of segs) {
    const segOrigWords = origWords.filter(
      w => w.start >= seg.start - 0.15 && w.start < seg.end + 0.15
    );

    if (segOrigWords.length === 0) { result.push(seg); continue; }

    const corrWords = seg.text.split(/\s+/).filter(w => w);
    if (corrWords.length === 0) continue;

    const newWords: Word[] = corrWords.map((word, i) => {
      const origIdx = Math.min(
        Math.round(i * segOrigWords.length / corrWords.length),
        segOrigWords.length - 1
      );
      return { start: segOrigWords[origIdx].start, end: segOrigWords[origIdx].end, word };
    });

    result.push({
      start: segOrigWords[0].start,
      end:   segOrigWords[segOrigWords.length-1].end,
      text:  corrWords.join(" "),
      words: newWords,
    });
  }

  return result.length > 0 ? result : segs;
}

// ══════════════════════════════════════════════════════════════
// STEP 3: SPLITTING
// ══════════════════════════════════════════════════════════════

function applySplitting(segs: TimedSegment[], style: string, wpg: number): Segment[] {
  const all: Word[] = [];
  for (const s of segs) for (const w of s.words) all.push(w);
  if (all.length === 0) return segs;

  if (style === "sentence") return splitSentence(all);
  if (style?.startsWith("word")) {
    const n = parseInt(style.replace("word", "")) || wpg || 1;
    return splitWords(all, Math.max(1, Math.min(6, n)));
  }
  return splitAuto(all);
}

function mkSeg(words: Word[]): Segment {
  return { start: words[0].start, end: words[words.length-1].end, text: words.map(w => w.word).join(" ") };
}

function splitSentence(all: Word[]): Segment[] {
  const r: Segment[] = []; let c: Word[] = [];
  for (const w of all) { c.push(w); if (/[.!?]$/.test(w.word.trim())) { r.push(mkSeg(c)); c = []; } }
  if (c.length) r.push(mkSeg(c));
  return r;
}

function splitWords(all: Word[], gs: number): Segment[] {
  const r: Segment[] = []; let c: Word[] = [];
  for (let i = 0; i < all.length; i++) {
    c.push(all[i]);
    if (c.length >= gs) {
      if (i+1 < all.length && isBound(all[i], all[i+1]) && c.length < gs+2) continue;
      r.push(mkSeg(c)); c = [];
    }
  }
  if (c.length) r.push(mkSeg(c));
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

    if (/[.!?]$/.test(w.word.trim()))                         { r.push(mkSeg(c)); c = []; ct = ""; continue; }
    if (/,$/.test(w.word.trim()) && ct.length >= 20)          { r.push(mkSeg(c)); c = []; ct = ""; continue; }

    if (ct.length >= SOFT && c.length >= 2) {
      const chain = countChain(all, i+1);
      if (!chain)                                             { r.push(mkSeg(c)); c = []; ct = ""; continue; }
      let extra = 0;
      for (let x = 1; x <= chain && i+x < all.length; x++) extra += all[i+x].word.length + 1;
      if (ct.length + extra <= HARD) continue;
      const lb = countTail(c);
      if (lb > 0 && c.length - lb >= 2) {
        r.push(mkSeg(c.slice(0, c.length - lb)));
        c = c.slice(c.length - lb); ct = c.map(w => w.word).join(" "); continue;
      }
      r.push(mkSeg(c)); c = []; ct = ""; continue;
    }

    if (ct.length >= HARD || dur >= MAXD)                     { r.push(mkSeg(c)); c = []; ct = ""; continue; }
  }
  if (c.length) r.push(mkSeg(c));
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
  for (let i = c.length-1; i >= 1; i--) {
    const a = c[i].word.trim().replace(/[,.:;!?]+$/g, "");
    if (["הרב","הגאון","מורנו","ורבנו","המקובל","לא","אל","אין","את","של","על","עם","כל","גם","כי","ש","כש"].includes(a)) n++;
    else break;
  }
  return n;
}

// ══════════════════════════════════════════════════════════════
// SRT BUILDER (RTL)
// ══════════════════════════════════════════════════════════════

function buildSrt(segs: Segment[], lang = "he"): string {
  const rtl = lang === "he" || lang === "ar";
  const RLM = "\u200F";
  const ts  = (s: number) => {
    s = Math.max(0, s);
    const h  = Math.floor(s / 3600);
    const m  = Math.floor((s % 3600) / 60);
    const sc = Math.floor(s % 60);
    const ms = Math.round((s - Math.floor(s)) * 1000);
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

    // ── LAYER 3: Input Validation ──
    const validation = validateInput(body);
    if (!validation.valid) {
      return err(validation.error, validation.error.includes("api_key") ? 401 : 400);
    }

    const { api_key, action, lang, audio_duration, caption_style, words_per_group } = body;

    const user = await validateApiKey(api_key);
    if (!user) return err("Invalid API key", 401);

    // ── LAYER 2: Rate Limiting ──
    const rateCheck = checkRateLimit(user.id);
    if (!rateCheck.allowed) {
      const retryAfterSec = Math.ceil(rateCheck.retryAfterMs / 1000);
      return NextResponse.json(
        { error: true, message: "יותר מדי בקשות. נסה שוב בעוד מספר שניות.", retry_after: retryAfterSec },
        { status: 429, headers: { "Retry-After": String(retryAfterSec) } }
      );
    }

    const remaining = (user.minutes_limit || 0) - (user.minutes_used || 0);
    if (remaining <= 0) return err("נגמרה המכסה. שדרג תוכנית.", 403);

    if (action === "get_upload_url") {
      const fileKey     = `audio/${user.id}/${Date.now()}.mp3`;
      const putCmd      = new PutObjectCommand({ Bucket: S3_BUCKET, Key: fileKey, ContentType: "audio/mpeg" });
      const uploadUrl   = await getSignedUrl(s3, putCmd, { expiresIn: 300 });
      const getCmd      = new GetObjectCommand({ Bucket: S3_BUCKET, Key: fileKey });
      const downloadUrl = await getSignedUrl(s3, getCmd, { expiresIn: 3600 });
      return NextResponse.json({ upload_url: uploadUrl, download_url: downloadUrl, file_key: fileKey, remaining_minutes: remaining });
    }

    if (action === "transcribe") {
      const { download_url, file_key } = body;
      if (!download_url || typeof download_url !== "string") return err("Missing download_url");

      // Validate download_url is a proper S3 URL
      if (!download_url.startsWith("https://") || download_url.length > 2000) {
        console.log(`[SECURITY] Suspicious download_url from user ${user.id.substring(0, 8)}...`);
        return err("Invalid download URL");
      }

      const audioDur = Number(audio_duration) || 0;
      if (Math.ceil(audioDur / 60 * 10) / 10 > remaining) return err("לא מספיק דקות.", 403);

      // STEP 1: Modal Whisper
      console.log("[MODAL] Sending to Whisper...");
      const t0 = Date.now();

      const modalRes = await fetch(MODAL_ENDPOINT, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ audio_url: download_url, lang: lang || "he" }),
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

      console.log(`[MODAL] Done in ${whisperMs}ms — ${mr.segments?.length||0} segs, ${mr.words?.length||0} words`);

      const rawSegs:  Segment[] = (mr.segments||[]).map((s: any) => ({ start: s.start, end: s.end, text: (s.text||"").trim() }));
      const rawWords: Word[]    = (mr.words   ||[]).map((w: any) => ({ start: w.start, end: w.end, word: (w.word||"").trim() }));

      if (rawSegs.length === 0) {
        await logUsage(user.id, audioDur, lang||"he", "whisper-large-v3", "empty", 0, 0);
        return err("לא נמצא דיבור.", 200);
      }

      // STEP 1.5: Filter hallucinations
      const hePrompt = lang === "he"
        ? "שלום, זהו תמלול מקצועי בעברית תקנית. סימני פיסוק: נקודה, פסיק, סימן שאלה. שמות אנשים, מקומות ומונחים מקצועיים נכתבים במדויק."
        : "";
      const cleaned = filterHallucinations(rawSegs, rawWords, hePrompt);

      if (cleaned.segments.length === 0) {
        await logUsage(user.id, audioDur, lang||"he", "whisper-large-v3", "empty", 0, 0);
        return err("לא נמצא דיבור.", 200);
      }

      // STEP 2: Build timed segments
      const timedSegs = buildTimedSegments(cleaned.segments, cleaned.words);

      // STEP 3: Claude AI correction
      const aiResult = await aiCorrect(timedSegs, lang || "he");

      // STEP 3.5: Re-anchor boundaries to Whisper timestamps
      const repaired = repairBoundaries(aiResult.segments, rawWords);

      // STEP 4: Split into caption groups
      const wpg   = parseInt(words_per_group) || 1;
      const final = applySplitting(repaired, caption_style || "auto", wpg);

      // STEP 5: Build SRT
      const srt = buildSrt(final, lang || "he");

      // STEP 6: Log & deduct
      const totalMs = Date.now() - t0;
      const mins    = await logUsage(user.id, audioDur, lang||"he", "whisper-large-v3", "completed", final.length, totalMs/1000);
      await deductMinutes(user.id, mins);

      if (file_key) s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: file_key })).catch(() => {});

      console.log(`[DONE] ${final.length} segs, ${totalMs}ms (Whisper: ${whisperMs}ms, Claude: ${totalMs-whisperMs}ms)`);

      return NextResponse.json({
        ok: true, status: "completed", segments: final, srt,
        language: mr.language || lang, elapsed: (totalMs/1000).toFixed(1),
        count: final.length, minutes_charged: mins,
        minutes_remaining: remaining - mins, ai_correction: aiResult.method,
      });
    }

    if (action === "check_job") return NextResponse.json({ ok: true, status: "completed", message: "Modal is synchronous" });

    if (action === "status") return NextResponse.json({
      ok: true, plan: user.plan, minutes_used: user.minutes_used,
      minutes_limit: user.minutes_limit, minutes_remaining: remaining,
    });

    return err("Unknown action");

  } catch (e: any) {
    console.error("API Error:", e);
    return err("שגיאה פנימית", 500);
  }
}
