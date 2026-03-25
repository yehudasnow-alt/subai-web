/**
 * SubAI — Transcription API v5.0
 * POST /api/transcribe
 *
 * v5.0 Improvements:
 * ─────────────────────────────────────────────────────────
 * • AI correction: two-pass context-aware approach
 *   1. Read full transcript to understand topic/domain
 *   2. Fix ONLY Whisper transcription errors (misspelled words,
 *      swapped letters, misheard phonemes) — never replace
 *      the speaker's intended word
 * • Smart punctuation and sentence boundary repair
 * • Word splitting: 1–6 words per subtitle with proportional
 *   timing based on syllable weight, natural pause detection,
 *   and minimum display duration enforcement
 * • Robust error handling and logging throughout
 * ─────────────────────────────────────────────────────────
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// ── Config ──────────────────────────────────────────────────

export const maxDuration = 120;

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const AWS_REGION = process.env.AWS_REGION || "eu-north-1";
const S3_BUCKET = process.env.S3_BUCKET || "subai-audio";
const AWS_ACCESS_KEY = process.env.AWS_ACCESS_KEY_ID!;
const AWS_SECRET_KEY = process.env.AWS_SECRET_ACCESS_KEY!;
const RUNPOD_API_KEY = process.env.RUNPOD_API_KEY!;
const RUNPOD_ENDPOINT_ID = process.env.RUNPOD_ENDPOINT_ID!;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const s3 = new S3Client({
  region: AWS_REGION,
  credentials: { accessKeyId: AWS_ACCESS_KEY, secretAccessKey: AWS_SECRET_KEY },
});

// ── Types ───────────────────────────────────────────────────

interface Segment {
  start: number;
  end: number;
  text: string;
}

interface UserProfile {
  id: string;
  email: string;
  plan: string;
  minutes_used: number;
  minutes_limit: number;
  subscription_status: string;
}

interface AiCorrectionResult {
  segments: Segment[];
  method: string;
}

// ── Helpers ─────────────────────────────────────────────────

function err(message: string, status = 400) {
  return NextResponse.json({ error: true, message }, { status });
}

async function validateApiKey(apiKey: string): Promise<UserProfile | null> {
  const { data, error } = await supabase
    .from("profiles")
    .select("id, email, plan, minutes_used, minutes_limit, subscription_status")
    .eq("api_key", apiKey)
    .single();
  if (error || !data) return null;
  return data as UserProfile;
}

async function logUsage(
  userId: string,
  audioDuration: number,
  lang: string,
  model: string,
  status: string,
  segmentsCount = 0,
  processingSec = 0,
  errorMessage = ""
): Promise<number> {
  const minutesCharged = Math.ceil((audioDuration / 60) * 10) / 10;
  await supabase.from("usage_log").insert({
    user_id: userId,
    audio_duration_sec: audioDuration,
    minutes_charged: minutesCharged,
    language: lang,
    model,
    segments_count: segmentsCount,
    processing_sec: processingSec,
    status,
    error_message: errorMessage,
  });
  return minutesCharged;
}

async function deductMinutes(userId: string, minutes: number): Promise<void> {
  // Try atomic RPC first
  try {
    const { error } = await supabase.rpc("increment_usage", {
      p_user_id: userId,
      p_minutes: minutes,
    });
    if (!error) return;
    console.warn("increment_usage RPC failed, falling back to manual update:", error.message);
  } catch (e) {
    console.warn("increment_usage RPC threw, falling back:", e);
  }

  // Fallback: read-then-write (not atomic, but better than nothing)
  try {
    const { data } = await supabase
      .from("profiles")
      .select("minutes_used")
      .eq("id", userId)
      .single();
    if (data) {
      await supabase
        .from("profiles")
        .update({ minutes_used: (data.minutes_used || 0) + minutes })
        .eq("id", userId);
    }
  } catch (e) {
    console.error("deductMinutes fallback failed:", e);
  }
}

// ══════════════════════════════════════════════════════════════
//  AI TEXT CORRECTION — Context-aware, conservative, precise
// ══════════════════════════════════════════════════════════════

function buildCorrectionPrompt(language: string): string {
  const langName =
    language === "he"
      ? "עברית"
      : language === "ar"
        ? "ערבית"
        : language === "ru"
          ? "רוסית"
          : language === "en"
            ? "English"
            : language;

  return `You are an expert subtitle proofreader specializing in ${langName} Whisper transcription output.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PHASE 1 — FULL CONTEXT READ (do this FIRST, before any edits)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Read EVERY segment from start to finish. Identify:
• The topic / domain (tech talk? cooking? news? personal conversation?)
• Key recurring names, terms, and jargon
• The speaker's vocabulary level and style
• Any patterns in Whisper's errors for this audio

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PHASE 2 — SURGICAL FIXES ONLY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

FIX these categories and NOTHING else:

1) WHISPER SPELLING ERRORS (highest priority):
   Whisper often mishears or misspells words. Fix ONLY when you can
   determine with HIGH CONFIDENCE what the speaker actually said.
   
   Examples of valid fixes:
   • "אני הולכ לחנות" → "אני הולך לחנות" (missing letter)
   • "זה היה מאד יפה" → "זה היה מאוד יפה" (common Whisper spelling error)
   • "הוא עשא את זה" → "הוא עשה את זה" (swapped letter)
   • "אנכנו" → "אנחנו" (Whisper phoneme confusion)
   • "להתחייל" → "להתחיל" (extra letter inserted)
   • "I went to the stroe" → "I went to the store" (transposed letters)
   
   Examples of what NOT to fix:
   • "אני חושב שזה טוב" — do NOT change to "אני מאמין שזה טוב"
     (both are valid words; the speaker CHOSE "חושב")
   • "סליחה" — do NOT change to "מצטער" (synonym swap = FORBIDDEN)
   • Slang, informal speech, or unusual but real words — KEEP THEM

2) PUNCTUATION:
   • Add period/question mark/exclamation at natural sentence ends
   • Add commas at natural clause boundaries and pauses
   • Fix repeated punctuation ("..." → ".", ".." → ".")
   • Do NOT add excessive punctuation; keep it clean

3) SENTENCE BOUNDARIES between segments:
   If a word clearly starts a new sentence but is stuck at the end of the
   previous segment, move it. If the last word of a segment clearly belongs
   to the next sentence, move it. Only do this when it's obvious.

4) WHISPER HALLUCINATIONS:
   • Remove exact duplicate phrases within a single segment
   • Remove Whisper artifacts like "[מוזיקה]", "(applause)", "[Music]"
   • Remove segments that are 100% hallucinated filler (Whisper sometimes
     generates phantom text for silence or noise)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ABSOLUTE RULES — NEVER BREAK THESE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✗ NEVER replace a correctly-spelled word with a synonym or "better" word
✗ NEVER rewrite sentences for style, grammar improvement, or fluency
✗ NEVER add words the speaker didn't say
✗ NEVER remove filler words (אמ, אה, כאילו, like, um, uh) — the speaker said them
✗ NEVER change names, places, brands, or technical terms unless clearly misspelled
✗ NEVER merge or split segments — keep the exact same number of lines
✗ NEVER change the meaning, even subtly
✗ When in doubt — DO NOT CHANGE. It's always better to leave a small error
  than to accidentally change what the speaker said.

Think of it like autocorrect on a phone keyboard:
• "אני הלוך" → "אני הולך" ✓ (obvious typo fix)
• "אני רוצה" → "אני מעוניין" ✗ (word replacement = FORBIDDEN)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OUTPUT FORMAT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Return ONLY the corrected lines in this exact format (one per input line):
[index|start-end] corrected text

• Every input line MUST have exactly one output line
• Do NOT skip, merge, or reorder lines
• If a segment needs no changes, output it exactly as-is
• Do NOT add any commentary, notes, or explanations`;
}

async function aiCorrectSegments(
  segments: Segment[],
  language: string,
  captionStyle: string,
  wordsPerGroup: number
): Promise<AiCorrectionResult> {
  if (!ANTHROPIC_API_KEY || segments.length === 0) {
    return {
      segments: applyWordSplit(segments, captionStyle, wordsPerGroup),
      method: "none",
    };
  }

  try {
    // Build the input text with markers
    const inputLines = segments
      .map((s, i) => `[${i}|${s.start.toFixed(2)}-${s.end.toFixed(2)}] ${s.text}`)
      .join("\n");

    const systemPrompt = buildCorrectionPrompt(language);

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 16384,
        temperature: 0.1, // Very low temperature for consistent, conservative corrections
        system: systemPrompt,
        messages: [
          {
            role: "user",
            content: `Here are the transcribed segments to proofread:\n\n${inputLines}`,
          },
        ],
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "unknown");
      console.error(`Claude API error: ${response.status} — ${errorBody}`);
      return {
        segments: applyWordSplit(segments, captionStyle, wordsPerGroup),
        method: "fallback",
      };
    }

    const result = await response.json();
    const correctedText: string = result.content?.[0]?.text || "";

    // Parse corrected segments
    const corrected = parseCorrectedOutput(correctedText, segments);

    if (corrected.length > 0) {
      return {
        segments: applyWordSplit(corrected, captionStyle, wordsPerGroup),
        method: "claude",
      };
    }

    console.warn("AI correction returned 0 parseable segments, using originals");
    return {
      segments: applyWordSplit(segments, captionStyle, wordsPerGroup),
      method: "parse_fallback",
    };
  } catch (e) {
    console.error("AI correction error:", e);
    return {
      segments: applyWordSplit(segments, captionStyle, wordsPerGroup),
      method: "error_fallback",
    };
  }
}

/**
 * Parse Claude's corrected output back into Segment[].
 * Falls back to original segments for any lines that can't be parsed.
 */
function parseCorrectedOutput(raw: string, originals: Segment[]): Segment[] {
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  const corrected: Segment[] = [];
  const parsed = new Map<number, Segment>();

  for (const line of lines) {
    const m = line.match(/\[(\d+)\|([\d.]+)-([\d.]+)\]\s*(.*)/);
    if (!m) continue;

    const idx = parseInt(m[1], 10);
    const text = m[4].trim();
    if (!text || idx < 0 || idx >= originals.length) continue;

    parsed.set(idx, {
      start: parseFloat(m[2]),
      end: parseFloat(m[3]),
      text,
    });
  }

  // Ensure every original segment has a corresponding output
  for (let i = 0; i < originals.length; i++) {
    corrected.push(parsed.get(i) || originals[i]);
  }

  return corrected;
}

// ══════════════════════════════════════════════════════════════
//  WORD SPLITTING — Smart grouping with precise timing
// ══════════════════════════════════════════════════════════════

/** Minimum display duration for any subtitle (ms). Below this, text is unreadable. */
const MIN_DISPLAY_MS = 150;
/** Small gap between consecutive word-groups for visual breathing room */
const INTER_GROUP_GAP_MS = 25;

/**
 * Determine group size from caption style string.
 * Returns 0 for no-split modes (auto / sentence).
 */
function resolveGroupSize(style: string, wordsPerGroup: number): number {
  if (!style || style === "auto" || style === "sentence") return 0;

  if (style.startsWith("word")) {
    const n = parseInt(style.replace("word", ""), 10);
    if (n >= 1 && n <= 6) return n;
  }

  if (wordsPerGroup >= 1 && wordsPerGroup <= 6) return wordsPerGroup;
  return 0;
}

/**
 * Estimate the "spoken weight" of a word for proportional timing.
 * Hebrew/Arabic characters are weighted slightly higher because they
 * tend to carry more phonetic density per character.
 */
function wordWeight(word: string): number {
  let weight = 0;
  for (const ch of word) {
    const code = ch.codePointAt(0) || 0;
    // Hebrew: U+0590–U+05FF, Arabic: U+0600–U+06FF
    if ((code >= 0x0590 && code <= 0x05ff) || (code >= 0x0600 && code <= 0x06ff)) {
      weight += 1.3;
    } else if (code > 0x20) {
      // Visible character
      weight += 1.0;
    }
    // Whitespace / control chars contribute 0
  }
  // Minimum weight so even a single-char word gets some time
  return Math.max(weight, 0.5);
}

/**
 * Detect if a word ends with sentence-ending punctuation.
 * Useful for preferring splits at sentence boundaries.
 */
function endsWithPunctuation(word: string): boolean {
  return /[.!?،؟]$/.test(word);
}

function applyWordSplit(segments: Segment[], style: string, wordsPerGroup: number): Segment[] {
  const groupSize = resolveGroupSize(style, wordsPerGroup);
  if (groupSize === 0) return segments;

  const result: Segment[] = [];

  for (const seg of segments) {
    const words = seg.text.split(/\s+/).filter((w) => w.length > 0);
    const duration = seg.end - seg.start;

    // If segment already has fewer words than group size, keep as-is
    if (words.length === 0) continue;
    if (words.length <= groupSize) {
      result.push(seg);
      continue;
    }

    // ── Build smart groups ──────────────────────────────────
    // Try to break at punctuation boundaries when possible,
    // while respecting the max group size.
    const groups: string[][] = [];
    let currentGroup: string[] = [];

    for (let i = 0; i < words.length; i++) {
      currentGroup.push(words[i]);

      const atGroupLimit = currentGroup.length >= groupSize;
      const atPunctuation =
        currentGroup.length >= Math.max(1, groupSize - 1) && endsWithPunctuation(words[i]);
      const isLast = i === words.length - 1;

      if (atGroupLimit || atPunctuation || isLast) {
        groups.push([...currentGroup]);
        currentGroup = [];
      }
    }

    // Handle leftover (shouldn't happen, but be safe)
    if (currentGroup.length > 0) {
      groups.push(currentGroup);
    }

    // ── Assign proportional timing ──────────────────────────
    const groupWeights = groups.map((g) =>
      g.reduce((sum, w) => sum + wordWeight(w), 0)
    );
    const totalWeight = groupWeights.reduce((a, b) => a + b, 0);

    // Total gap time between groups
    const totalGapSec = ((groups.length - 1) * INTER_GROUP_GAP_MS) / 1000;
    const availableDuration = Math.max(duration - totalGapSec, duration * 0.8);

    let cursor = seg.start;

    for (let g = 0; g < groups.length; g++) {
      const proportion = groupWeights[g] / totalWeight;
      let groupDur = availableDuration * proportion;

      // Enforce minimum display time
      const minDur = MIN_DISPLAY_MS / 1000;
      if (groupDur < minDur) groupDur = minDur;

      const groupStart = +cursor.toFixed(3);
      const groupEnd = +Math.min(cursor + groupDur, seg.end).toFixed(3);

      result.push({
        start: groupStart,
        end: groupEnd,
        text: groups[g].join(" "),
      });

      cursor += groupDur + INTER_GROUP_GAP_MS / 1000;
    }
  }

  return result;
}

// ══════════════════════════════════════════════════════════════
//  SRT BUILDER
// ══════════════════════════════════════════════════════════════

function formatTimestamp(seconds: number): string {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sc = Math.floor(s % 60);
  const ms = Math.round((s - Math.floor(s)) * 1000);
  return (
    String(h).padStart(2, "0") +
    ":" +
    String(m).padStart(2, "0") +
    ":" +
    String(sc).padStart(2, "0") +
    "," +
    String(ms).padStart(3, "0")
  );
}

function buildSrt(segments: Segment[], offset = 0): string {
  return segments
    .map((seg, i) => {
      const text = seg.text.trim();
      if (!text) return "";
      const start = formatTimestamp(seg.start + offset);
      const end = formatTimestamp(seg.end + offset);
      return `${i + 1}\n${start} --> ${end}\n${text}\n`;
    })
    .filter(Boolean)
    .join("\n");
}

// ══════════════════════════════════════════════════════════════
//  MAIN HANDLER
// ══════════════════════════════════════════════════════════════

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      api_key,
      action,
      lang,
      model,
      offset,
      audio_duration,
      caption_style,
      words_per_group,
    } = body;

    // ── Auth ──
    if (!api_key) return err("Missing api_key", 401);
    const user = await validateApiKey(api_key);
    if (!user) return err("Invalid API key", 401);

    const remaining = (user.minutes_limit || 0) - (user.minutes_used || 0);
    if (remaining <= 0) return err("נגמרה המכסה. שדרג תוכנית.", 403);

    // ────────────────────────────────────────────────────────
    //  ACTION: get_upload_url
    // ────────────────────────────────────────────────────────
    if (action === "get_upload_url") {
      const fileKey = `audio/${user.id}/${Date.now()}.mp3`;

      const uploadUrl = await getSignedUrl(
        s3,
        new PutObjectCommand({ Bucket: S3_BUCKET, Key: fileKey, ContentType: "audio/mpeg" }),
        { expiresIn: 300 }
      );

      const downloadUrl = await getSignedUrl(
        s3,
        new GetObjectCommand({ Bucket: S3_BUCKET, Key: fileKey }),
        { expiresIn: 3600 }
      );

      return NextResponse.json({
        upload_url: uploadUrl,
        download_url: downloadUrl,
        file_key: fileKey,
        remaining_minutes: remaining,
      });
    }

    // ────────────────────────────────────────────────────────
    //  ACTION: transcribe
    // ────────────────────────────────────────────────────────
    if (action === "transcribe") {
      const { download_url, file_key } = body;
      if (!download_url) return err("Missing download_url");

      const language = lang || "he";
      const whisperModel = model || "large-v3";
      const audioDurationSec = audio_duration || 0;
      const estimatedMinutes = Math.ceil((audioDurationSec / 60) * 10) / 10;

      if (estimatedMinutes > remaining) {
        return err("לא מספיק דקות.", 403);
      }

      // ── Step 1: RunPod Whisper transcription ──
      const runpodUrl = `https://api.runpod.ai/v2/${RUNPOD_ENDPOINT_ID}/runsync`;
      const t0 = Date.now();

      const rpResponse = await fetch(runpodUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${RUNPOD_API_KEY}`,
        },
        body: JSON.stringify({
          input: {
            audio_url: download_url,
            lang: language,
            model: whisperModel,
            offset: offset || 0,
            format: "json",
          },
        }),
      });

      if (!rpResponse.ok) {
        const rpErr = await rpResponse.text().catch(() => "unknown");
        await logUsage(user.id, audioDurationSec, language, whisperModel, "failed", 0, 0, rpErr);
        return err("שרת התמלול לא זמין. נסה שוב.", 502);
      }

      const rpResult = await rpResponse.json();
      const whisperSec = (Date.now() - t0) / 1000;

      if (rpResult.status === "FAILED" || rpResult.output?.error) {
        const errMsg = rpResult.output?.error || "Unknown RunPod error";
        await logUsage(user.id, audioDurationSec, language, whisperModel, "failed", 0, whisperSec, errMsg);
        return err("שגיאת תמלול: " + errMsg, 500);
      }

      const output = rpResult.output || {};
      let segments: Segment[] = output.segments || [];

      if (segments.length === 0) {
        await logUsage(user.id, audioDurationSec, language, whisperModel, "empty", 0, whisperSec);
        return err("לא נמצא דיבור.", 200);
      }

      // ── Step 2: AI text correction + word splitting ──
      const wpg = parseInt(words_per_group) || 1;
      const style = caption_style || "auto";
      const aiResult = await aiCorrectSegments(segments, language, style, wpg);
      segments = aiResult.segments;

      // ── Step 3: Build SRT output ──
      const srt = buildSrt(segments, offset || 0);
      const totalSec = (Date.now() - t0) / 1000;

      // ── Step 4: Log usage & deduct minutes ──
      const minutesCharged = await logUsage(
        user.id,
        audioDurationSec,
        language,
        whisperModel,
        "completed",
        segments.length,
        totalSec
      );
      await deductMinutes(user.id, minutesCharged);

      // ── Step 5: Cleanup S3 ──
      if (file_key) {
        s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: file_key })).catch((e) =>
          console.warn("S3 cleanup failed:", e)
        );
      }

      return NextResponse.json({
        ok: true,
        segments,
        srt,
        language: output.language || language,
        elapsed: output.elapsed,
        count: segments.length,
        minutes_charged: minutesCharged,
        minutes_remaining: remaining - minutesCharged,
        ai_correction: aiResult.method,
      });
    }

    // ────────────────────────────────────────────────────────
    //  ACTION: status
    // ────────────────────────────────────────────────────────
    if (action === "status") {
      return NextResponse.json({
        ok: true,
        plan: user.plan,
        minutes_used: user.minutes_used,
        minutes_limit: user.minutes_limit,
        minutes_remaining: remaining,
      });
    }

    return err("Unknown action");
  } catch (e: any) {
    console.error("API Error:", e);
    return err("שגיאה פנימית בשרת", 500);
  }
}
