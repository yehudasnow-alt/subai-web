/**
 * SubAI — Transcription Engine v7.0
 * 
 * TIMING PHILOSOPHY:
 * Whisper gives us word-level timestamps that are accurate to ~50ms.
 * We NEVER calculate timing proportionally — we always use Whisper's real timestamps.
 * When splitting sentences, we find the exact word where the split happens
 * and use that word's start/end time as the boundary.
 *
 * CORRECTION PHILOSOPHY:
 * Claude is a PROOFREADER, not a writer. It reads the entire transcript,
 * understands context, then makes ONLY spelling fixes where Whisper
 * misheard a sound. It never replaces words, never adds content,
 * never changes meaning. If unsure — don't touch.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export const maxDuration = 60;

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const AWS_REGION = process.env.AWS_REGION || "eu-north-1";
const S3_BUCKET = process.env.S3_BUCKET || "subai-audio";
const RUNPOD_API_KEY = process.env.RUNPOD_API_KEY!;
const RUNPOD_ENDPOINT_ID = process.env.RUNPOD_ENDPOINT_ID!;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const s3 = new S3Client({
  region: AWS_REGION,
  credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID!, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY! }
});

function err(msg: string, status = 400) { return NextResponse.json({ error: true, message: msg }, { status }); }

// ══════════════════════════════════════════════════════════════
// TYPES
// ══════════════════════════════════════════════════════════════

interface Segment { start: number; end: number; text: string; }
interface Word { start: number; end: number; word: string; probability?: number; }

// A segment with its constituent words attached — this is the core data structure
interface TimedSegment {
  start: number;
  end: number;
  text: string;
  words: Word[];   // The actual Whisper words with real timestamps
}

// ══════════════════════════════════════════════════════════════
// DATABASE HELPERS
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
// Attach Whisper's word-level timestamps to each segment.
// This is the foundation — all splitting uses real word times.
// ══════════════════════════════════════════════════════════════

function buildTimedSegments(segments: Segment[], words: Word[]): TimedSegment[] {
  if (!words || words.length === 0) {
    // No word timestamps — create fake words from segment text
    return segments.map(seg => ({
      ...seg,
      words: seg.text.split(/\s+/).filter(w => w).map((w, i, arr) => {
        const dur = seg.end - seg.start;
        const wordDur = dur / arr.length;
        return { start: +(seg.start + i * wordDur).toFixed(3), end: +(seg.start + (i + 1) * wordDur).toFixed(3), word: w };
      }),
    }));
  }

  // Match words to segments by time overlap
  const result: TimedSegment[] = [];
  let wordIdx = 0;

  for (const seg of segments) {
    const segWords: Word[] = [];

    while (wordIdx < words.length) {
      const w = words[wordIdx];
      // Word belongs to this segment if it overlaps
      if (w.start >= seg.start - 0.1 && w.start < seg.end + 0.1) {
        segWords.push(w);
        wordIdx++;
      } else if (w.start >= seg.end + 0.1) {
        break; // Past this segment
      } else {
        wordIdx++; // Before this segment (shouldn't happen, but skip)
      }
    }

    result.push({
      start: segWords.length > 0 ? segWords[0].start : seg.start,
      end: segWords.length > 0 ? segWords[segWords.length - 1].end : seg.end,
      text: segWords.length > 0 ? segWords.map(w => w.word).join(" ") : seg.text,
      words: segWords,
    });
  }

  // Catch any remaining words not matched to segments
  if (wordIdx < words.length) {
    const remaining = words.slice(wordIdx);
    if (remaining.length > 0) {
      result.push({
        start: remaining[0].start,
        end: remaining[remaining.length - 1].end,
        text: remaining.map(w => w.word).join(" "),
        words: remaining,
      });
    }
  }

  return result;
}

// ══════════════════════════════════════════════════════════════
// STEP 2: AI CORRECTION — Contextual Prediction Engine
//
// APPROACH (inspired by Apple QuickType / Predictive Text):
// Instead of asking "is this word spelled correctly?", we ask:
// "Given the FULL context, what word SHOULD be here?"
// Then compare prediction with what Whisper gave us.
// If they match → no change. If they differ → Whisper misheard.
//
// This is fundamentally more accurate because:
// 1. Hebrew has ktiv maleh/haser ambiguity — context resolves it
// 2. Fast speech merges sounds — context predicts the right word
// 3. Domain terms are identified by surrounding context, not dictionary
// ══════════════════════════════════════════════════════════════

async function aiCorrect(timedSegs: TimedSegment[], language: string): Promise<{ segments: TimedSegment[]; method: string }> {
  if (!ANTHROPIC_API_KEY || timedSegs.length === 0) {
    return { segments: timedSegs, method: "none" };
  }

  try {
    const input = timedSegs.map((s, i) =>
      `[${i}|${s.start.toFixed(2)}-${s.end.toFixed(2)}] ${s.text}`
    ).join("\n");

    const langName = language === "he" ? "עברית" : language === "ar" ? "ערבית" : "English";

    // ── THE PREDICTIVE CONTEXT PROMPT ──
    const systemPrompt = `You are a contextual prediction engine for ${langName} transcription repair.

YOUR METHOD — PREDICTIVE CONTEXT (like Apple QuickType):
══════════════════════════════════════════════════════════
You don't just check spelling. You READ the entire text, BUILD a mental model
of what's being discussed, and then for EACH word you PREDICT what word
SHOULD be there based on context. Then you compare your prediction with
what Whisper wrote.

PHASE 1 — DEEP CONTEXT SCAN (read everything first, change nothing):
Read every segment. Build understanding of:

A) TOPIC MAP: What subjects are discussed? (cooking? tech? sports? medicine?)
B) SPEAKER PROFILE: Formal/casual? Age? Professional jargon? Accent patterns?
C) NAME REGISTRY: Collect all names of people, places, brands, products mentioned.
D) TERM GLOSSARY: Identify domain-specific words that repeat (medical terms, legal terms, etc.)
E) SPEECH PATTERNS: Does the speaker use specific filler words? Sentence structures?

Store this context. Every correction decision uses it.

PHASE 2 — PREDICTIVE REPAIR (word by word):
For each word in each segment:

1. MASK the word mentally (pretend it's blank: "אני ___ לבית")
2. PREDICT what word fits based on full context
3. COMPARE prediction with Whisper's word:

   Case A: Prediction = Whisper's word → ✅ No change needed
   Case B: Prediction ≠ Whisper's word, but Whisper's word is a REAL word that makes sense → ⚠️ DO NOT CHANGE (speaker chose that word)
   Case C: Prediction ≠ Whisper's word, AND Whisper's word is clearly a PHONETIC ERROR → ✅ Fix it

CRITICAL: Case B is the trap. "הוא הלך לחנות" vs prediction "הוא נסע לחנות" — 
both work, but the speaker SAID "הלך". Whisper heard correctly. DO NOT CHANGE.
Only fix when Whisper produced a NON-WORD or a word that is IMPOSSIBLE in context.

PHASE 3 — HEBREW-SPECIFIC INTELLIGENCE:
${language === "he" ? `
Hebrew has unique challenges that require contextual prediction:

A) כתיב מלא/חסר (Plene vs Defective spelling):
   Whisper sometimes writes "שלום" vs "שלם" — context tells you which.
   "מחיר" vs "מחר" — completely different words, only context resolves.

B) SOUND CONFUSION PAIRS (Whisper's common Hebrew errors):
   א↔ע (glottal): עבודה↔אבודה, עמוק↔אמוק
   ה↔ח (throat): הולך↔חולך, הזמין↔חזמין  
   כ↔ק (velar): כלב↔קלב, כמעט↔קמעט
   ט↔ת (dental): טוב↔תוב, טבע↔תבע
   ס↔ש (sibilant): סיפור↔שיפור, סגר↔שגר
   ב↔פ (labial): בעיה↔פעיה, ביטוח↔פיטוח
   
   ONLY fix these when your contextual prediction clearly indicates the other word.
   "שיפור" (improvement) vs "סיפור" (story) — ONLY context tells you which.

C) WORD BOUNDARIES:
   Fast Hebrew speech merges words: "שלא" = "ש" + "לא", "שהוא" = "ש" + "הוא"
   Whisper sometimes splits or joins incorrectly.
   Use sentence meaning to determine correct boundaries.

D) INFLECTIONS:
   Hebrew has rich morphology. "הלכתי/הלכת/הלך/הלכו" — 
   Whisper might write wrong inflection. Context (speaker, subject) tells you which.
` : ""}

PHASE 4 — PUNCTUATION (separate pass):
After all word corrections, add punctuation:
- Period (.) where a thought clearly ends and a new one begins
- Comma (,) at natural speech pauses, list separations
- Question mark (?) for interrogative sentences
- DO NOT add punctuation that changes meaning
- DO NOT add punctuation mid-thought just because of a pause

PHASE 5 — SENTENCE BOUNDARY REPAIR:
Check segment boundaries. If word X clearly belongs to the previous sentence:
Move it. "...והוא הלך" | "הביתה. אחרי..." → "...והוא הלך הביתה." | "אחרי..."

PHASE 6 — FINAL VERIFICATION:
For EACH change you made, verify:
□ Is the original word a non-word or impossible in context? (must be YES to change)
□ Is my replacement the ONLY plausible word? (must be YES)
□ Am I 99%+ confident? (must be YES)
□ Did I accidentally add/remove a word? (must be NO)
□ Did I change meaning? (must be NO)
If ANY check fails → REVERT to original.

ABSOLUTE PROHIBITIONS:
═══════════════════════
❌ NEVER replace a real word with a synonym (גדול→עצום)
❌ NEVER "improve" grammar or style
❌ NEVER add words not spoken (except Case C above with 99% certainty)
❌ NEVER remove filler words (כאילו, אממ, אה, נו) — they are timing anchors
❌ NEVER change names, places, brands
❌ NEVER change verb tense, word order, sentence structure

GOLDEN RULE: If Whisper's word is a REAL word that COULD make sense, leave it.
Only fix when context makes it IMPOSSIBLE for that word to be correct.

OUTPUT FORMAT:
[index|start-end] corrected text
One line per segment. No merging, splitting, or skipping.`;

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
    });

    if (!response.ok) return { segments: timedSegs, method: "api_error" };

    const result = await response.json();
    const output = result.content?.[0]?.text || "";

    // Parse corrected text
    const corrected: Array<{ idx: number; text: string }> = [];
    for (const line of output.split("\n")) {
      const m = line.match(/\[(\d+)\|([\d.]+)-([\d.]+)\]\s*(.*)/);
      if (m && m[4].trim()) {
        corrected.push({ idx: parseInt(m[1]), text: m[4].trim() });
      }
    }

    // ── INTEGRITY CHECKS (multi-layer) ──

    // Check 1: Segment count integrity (±20%)
    if (corrected.length === 0 || Math.abs(corrected.length - timedSegs.length) > timedSegs.length * 0.2) {
      console.warn(`Integrity fail: ${timedSegs.length} in → ${corrected.length} out`);
      return { segments: timedSegs, method: "integrity_fail" };
    }

    // Check 2: Per-segment Levenshtein guard
    const fixed = timedSegs.map((seg, i) => {
      const correction = corrected.find(c => c.idx === i);
      if (!correction) return seg;

      // Strip punctuation for comparison (punctuation changes are OK)
      const originalClean = seg.text.replace(/[.!?,;:\s]/g, "");
      const correctedClean = correction.text.replace(/[.!?,;:\s]/g, "");

      // If the actual words are identical (only punctuation changed), always accept
      if (originalClean === correctedClean) {
        return { ...seg, text: correction.text };
      }

      // Check character change ratio
      const distance = levenshteinRatio(originalClean, correctedClean);

      if (distance > 0.30) {
        // More than 30% character change — Claude probably hallucinated
        console.warn(`Segment ${i}: ${(distance * 100).toFixed(0)}% changed — rejected`);
        return seg;
      }

      // Check 3: Word count guard — if Claude added/removed more than 1 word, suspicious
      const origWordCount = seg.text.split(/\s+/).filter(w => w && !w.match(/^[.!?,;:]+$/)).length;
      const corrWordCount = correction.text.split(/\s+/).filter(w => w && !w.match(/^[.!?,;:]+$/)).length;

      if (Math.abs(origWordCount - corrWordCount) > 2) {
        console.warn(`Segment ${i}: word count ${origWordCount}→${corrWordCount} — rejected`);
        return seg;
      }

      // All checks passed — apply correction, KEEP original timestamps
      return { ...seg, text: correction.text };
    });

    return { segments: fixed, method: "claude" };
  } catch (e) {
    console.error("AI correction error:", e);
    return { segments: timedSegs, method: "error_fallback" };
  }
}

// Levenshtein distance ratio (0 = identical, 1 = completely different)
function levenshteinRatio(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return 1;
  if (!b.length) return 1;
  const matrix: number[][] = [];
  for (let i = 0; i <= a.length; i++) matrix[i] = [i];
  for (let j = 0; j <= b.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost);
    }
  }
  return matrix[a.length][b.length] / Math.max(a.length, b.length);
}

// ══════════════════════════════════════════════════════════════
// STEP 3: SMART SPLITTING — Uses real word timestamps
// ══════════════════════════════════════════════════════════════

const MAX_CHARS = 42;
const MAX_DURATION = 4.0;

function applySplitting(timedSegs: TimedSegment[], style: string, wordsPerGroup: number): Segment[] {
  if (style && style.startsWith("word")) {
    const n = parseInt(style.replace("word", "")) || wordsPerGroup || 1;
    return splitByWordCount(timedSegs, Math.max(1, Math.min(6, n)));
  }
  if (style === "sentence") {
    return splitAtSentenceEnds(timedSegs);
  }
  // "auto" — smart split at punctuation, respect max chars/duration
  return smartAutoSplit(timedSegs);
}

// ── WORD MODE: Split every N words using real timestamps ──
function splitByWordCount(timedSegs: TimedSegment[], groupSize: number): Segment[] {
  // Collect ALL words from all segments
  const allWords: Word[] = [];
  for (const seg of timedSegs) {
    for (const w of seg.words) {
      allWords.push(w);
    }
  }

  const result: Segment[] = [];
  for (let i = 0; i < allWords.length; i += groupSize) {
    const group = allWords.slice(i, i + groupSize);
    if (group.length === 0) continue;
    result.push({
      start: group[0].start,
      end: group[group.length - 1].end,
      text: group.map(w => w.word).join(" "),
    });
  }
  return result;
}

// ── SENTENCE MODE: Split only at . ! ? ──
function splitAtSentenceEnds(timedSegs: TimedSegment[]): Segment[] {
  const allWords: Word[] = [];
  for (const seg of timedSegs) {
    for (const w of seg.words) allWords.push(w);
  }

  const result: Segment[] = [];
  let currentWords: Word[] = [];

  for (const w of allWords) {
    currentWords.push(w);
    // Check if this word ends a sentence
    if (/[.!?]$/.test(w.word.trim())) {
      result.push({
        start: currentWords[0].start,
        end: currentWords[currentWords.length - 1].end,
        text: currentWords.map(w => w.word).join(" "),
      });
      currentWords = [];
    }
  }

  // Flush remaining
  if (currentWords.length > 0) {
    result.push({
      start: currentWords[0].start,
      end: currentWords[currentWords.length - 1].end,
      text: currentWords.map(w => w.word).join(" "),
    });
  }

  return result;
}

// ── AUTO MODE: Smart split at natural breaks, respecting timing ──
function smartAutoSplit(timedSegs: TimedSegment[]): Segment[] {
  // First, collect all words
  const allWords: Word[] = [];
  for (const seg of timedSegs) {
    for (const w of seg.words) allWords.push(w);
  }

  if (allWords.length === 0) return timedSegs;

  const result: Segment[] = [];
  let currentWords: Word[] = [];
  let currentText = "";

  for (let i = 0; i < allWords.length; i++) {
    const w = allWords[i];
    const testText = currentText ? currentText + " " + w.word : w.word;
    const testDuration = currentWords.length > 0
      ? w.end - currentWords[0].start
      : w.end - w.start;

    // Should we cut here?
    let shouldCut = false;
    let cutReason = "";

    // Rule 1: Current word ends with sentence punctuation
    if (/[.!?]$/.test(w.word.trim())) {
      currentWords.push(w);
      currentText = testText;
      shouldCut = true;
      cutReason = "sentence_end";
    }
    // Rule 2: Adding this word would exceed max chars
    else if (testText.length > MAX_CHARS && currentWords.length > 0) {
      shouldCut = true;
      cutReason = "max_chars";
      // Don't include this word — it goes to next segment
    }
    // Rule 3: Adding this word would exceed max duration
    else if (testDuration > MAX_DURATION && currentWords.length > 0) {
      shouldCut = true;
      cutReason = "max_duration";
    }
    // Rule 4: Comma is a good break point if we're already over 20 chars
    else if (/,$/.test(w.word.trim()) && currentText.length > 20) {
      currentWords.push(w);
      currentText = testText;
      shouldCut = true;
      cutReason = "comma";
    }
    else {
      // No cut — add word to current group
      currentWords.push(w);
      currentText = testText;
    }

    if (shouldCut && currentWords.length > 0) {
      result.push({
        start: currentWords[0].start,
        end: currentWords[currentWords.length - 1].end,
        text: currentWords.map(w => w.word).join(" "),
      });

      // If we didn't include the current word (max_chars/max_duration), start new with it
      if (cutReason === "max_chars" || cutReason === "max_duration") {
        currentWords = [w];
        currentText = w.word;
      } else {
        currentWords = [];
        currentText = "";
      }
    }
  }

  // Flush remaining words
  if (currentWords.length > 0) {
    result.push({
      start: currentWords[0].start,
      end: currentWords[currentWords.length - 1].end,
      text: currentWords.map(w => w.word).join(" "),
    });
  }

  return result;
}

// ══════════════════════════════════════════════════════════════
// SRT BUILDER
// ══════════════════════════════════════════════════════════════

function buildSrt(segments: Segment[]): string {
  const ts = (s: number) => {
    s = Math.max(0, s);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sc = Math.floor(s % 60),
      ms = Math.round((s - Math.floor(s)) * 1000);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sc).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
  };
  return segments.map((seg, i) => {
    const text = seg.text.trim();
    if (!text) return "";
    return `${i + 1}\n${ts(seg.start)} --> ${ts(seg.end)}\n${text}\n`;
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

    // ── get_upload_url ──
    if (action === "get_upload_url") {
      const fileKey = `audio/${user.id}/${Date.now()}.mp3`;
      const putCmd = new PutObjectCommand({ Bucket: S3_BUCKET, Key: fileKey, ContentType: "audio/mpeg" });
      const uploadUrl = await getSignedUrl(s3, putCmd, { expiresIn: 300 });
      const getCmd = new GetObjectCommand({ Bucket: S3_BUCKET, Key: fileKey });
      const downloadUrl = await getSignedUrl(s3, getCmd, { expiresIn: 3600 });
      return NextResponse.json({ upload_url: uploadUrl, download_url: downloadUrl, file_key: fileKey, remaining_minutes: remaining });
    }

    // ── transcribe (start async job) ──
    if (action === "transcribe") {
      const { download_url, file_key } = body;
      if (!download_url) return err("Missing download_url");
      const audioDurationSec = audio_duration || 0;
      if (Math.ceil(audioDurationSec / 60 * 10) / 10 > remaining) return err("לא מספיק דקות.", 403);

      const rpResponse = await fetch(`https://api.runpod.ai/v2/${RUNPOD_ENDPOINT_ID}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${RUNPOD_API_KEY}` },
        body: JSON.stringify({
          input: { audio_url: download_url, lang: lang || "he", model: model || "large-v3", offset: offset || 0, format: "json" },
        }),
      });

      if (!rpResponse.ok) {
        await logUsage(user.id, audioDurationSec, lang || "he", model || "large-v3", "failed", 0, 0, await rpResponse.text());
        return err("שרת התמלול לא זמין.", 502);
      }

      const rpResult = await rpResponse.json();
      if (!rpResult.id) return err("שגיאה בהפעלת תמלול", 500);
      return NextResponse.json({ ok: true, action: "job_started", job_id: rpResult.id, file_key, audio_duration: audioDurationSec });
    }

    // ── check_job (polled every 3s by plugin) ──
    if (action === "check_job") {
      const { job_id, file_key } = body;
      if (!job_id) return err("Missing job_id");

      const rpResponse = await fetch(`https://api.runpod.ai/v2/${RUNPOD_ENDPOINT_ID}/status/${job_id}`, {
        headers: { "Authorization": `Bearer ${RUNPOD_API_KEY}` },
      });
      if (!rpResponse.ok) return NextResponse.json({ ok: true, status: "processing" });

      const rpResult = await rpResponse.json();

      if (rpResult.status === "IN_QUEUE" || rpResult.status === "IN_PROGRESS") {
        return NextResponse.json({ ok: true, status: "processing" });
      }

      if (rpResult.status === "FAILED") {
        const errMsg = rpResult.output?.error || rpResult.error || "Unknown";
        await logUsage(user.id, audio_duration || 0, lang || "he", model || "large-v3", "failed", 0, 0, errMsg);
        return err("שגיאת תמלול: " + errMsg, 500);
      }

      if (rpResult.status === "COMPLETED") {
        const output = rpResult.output || {};
        const rawSegments: Segment[] = output.segments || [];
        const rawWords: Word[] = output.words || [];
        const audioDurationSec = audio_duration || 0;

        if (rawSegments.length === 0) {
          await logUsage(user.id, audioDurationSec, lang || "he", model || "large-v3", "empty", 0, 0);
          return err("לא נמצא דיבור.", 200);
        }

        // ═══ THE ENGINE ═══

        // Step 1: Build timed segments (attach words to segments)
        const timedSegs = buildTimedSegments(rawSegments, rawWords);

        // Step 2: AI Correction (surgical proofreading — preserves timing)
        const aiResult = await aiCorrect(timedSegs, lang || "he");

        // Step 3: Split according to user's chosen style (using real word timestamps)
        const wpg = parseInt(words_per_group) || 1;
        const finalSegments = applySplitting(aiResult.segments, caption_style || "auto", wpg);

        // Step 4: Build SRT
        const srt = buildSrt(finalSegments);

        // Step 5: Log & deduct
        const mins = await logUsage(user.id, audioDurationSec, lang || "he", model || "large-v3", "completed", finalSegments.length, 0);
        await deductMinutes(user.id, mins);

        if (file_key) s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: file_key })).catch(() => {});

        return NextResponse.json({
          ok: true, status: "completed",
          segments: finalSegments, srt,
          language: output.language || lang,
          elapsed: output.elapsed,
          count: finalSegments.length,
          minutes_charged: mins,
          minutes_remaining: remaining - mins,
          ai_correction: aiResult.method,
        });
      }

      return NextResponse.json({ ok: true, status: "processing" });
    }

    // ── status ──
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
