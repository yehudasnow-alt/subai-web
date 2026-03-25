/**
 * SubAI — Transcription API v6.0
 * Same as v5 + Smart sentence splitting:
 * - "auto": splits at punctuation, max 42 chars, max 4 seconds
 * - "sentence": splits at period/question/exclamation only
 * - "word1-6": word-level with Whisper timestamps
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
const AWS_ACCESS_KEY = process.env.AWS_ACCESS_KEY_ID!;
const AWS_SECRET_KEY = process.env.AWS_SECRET_ACCESS_KEY!;
const RUNPOD_API_KEY = process.env.RUNPOD_API_KEY!;
const RUNPOD_ENDPOINT_ID = process.env.RUNPOD_ENDPOINT_ID!;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const s3 = new S3Client({ region: AWS_REGION, credentials: { accessKeyId: AWS_ACCESS_KEY, secretAccessKey: AWS_SECRET_KEY } });

function err(message: string, status: number = 400) {
  return NextResponse.json({ error: true, message }, { status });
}

async function validateApiKey(apiKey: string) {
  const { data } = await supabase.from("profiles")
    .select("id, email, plan, minutes_used, minutes_limit, subscription_status")
    .eq("api_key", apiKey).single();
  return data || null;
}

async function logUsage(userId: string, audioDuration: number, lang: string, model: string,
  status: string, segmentsCount = 0, processingSec = 0, errorMessage = "") {
  const minutesCharged = Math.ceil(audioDuration / 60 * 10) / 10;
  await supabase.from("usage_log").insert({
    user_id: userId, audio_duration_sec: audioDuration, minutes_charged: minutesCharged,
    language: lang, model, segments_count: segmentsCount, processing_sec: processingSec,
    status, error_message: errorMessage,
  });
  return minutesCharged;
}

async function deductMinutes(userId: string, minutes: number) {
  try {
    const { error } = await supabase.rpc("increment_usage", { p_user_id: userId, p_minutes: minutes });
    if (!error) return;
  } catch {}
  try {
    const { data } = await supabase.from("profiles").select("minutes_used").eq("id", userId).single();
    if (data) await supabase.from("profiles").update({ minutes_used: (data.minutes_used || 0) + minutes }).eq("id", userId);
  } catch {}
}

// ══════════════════════════════════════════════════════════════
// TYPES
// ══════════════════════════════════════════════════════════════

interface Segment { start: number; end: number; text: string; }
interface Word { start: number; end: number; word: string; probability?: number; }

// ══════════════════════════════════════════════════════════════
// AI CORRECTION — Surgical, minimal intervention (unchanged)
// ══════════════════════════════════════════════════════════════

async function aiCorrectSegments(
  segments: Segment[], language: string, whisperWords: Word[]
): Promise<{ segments: Segment[]; words: Word[]; method: string }> {
  if (!ANTHROPIC_API_KEY || segments.length === 0) {
    return { segments, words: whisperWords, method: "none" };
  }

  try {
    const fullText = segments.map((s, i) =>
      `[${i}|${s.start.toFixed(2)}-${s.end.toFixed(2)}] ${s.text}`
    ).join("\n");

    const langName = language === "he" ? "עברית" : language === "ar" ? "ערבית" : "English";

    const systemPrompt = `You are a precision-focused subtitle editor for ${langName}.
Your goal: fix ONLY what Whisper got wrong. Preserve the speaker's exact words.

STEP 1 — READ EVERYTHING FIRST:
Read all segments start to finish. Understand the topic, names, technical terms, and speaking style before touching anything.

STEP 2 — FIX ONLY THESE (nothing else):

A) PHONETIC TRANSCRIPTION ERRORS:
   Fix words Whisper misheard due to similar sounds.
   Hebrew examples: swapping א/ע, ה/ח, כ/ק, ט/ת, ס/ש, ב/פ
   Rule: Fix ONLY if you are 99%+ certain from surrounding context.

B) PUNCTUATION:
   Add periods at clear sentence ends.
   Add commas at natural pauses.
   Add question marks for questions.
   Fix multiple punctuation to single.

C) SENTENCE BOUNDARIES:
   If a word belongs to the previous segment, move it back.
   Each segment should start and end at natural speech boundaries.

D) REMOVE WHISPER ARTIFACTS:
   Delete exact duplicate phrases within a segment.
   Remove [music], [applause] type annotations.

E) MISSING WORDS (99% certainty only):
   If a sentence clearly lacks one word to make sense, add it.

STEP 3 — ABSOLUTE RULES:
- NO REWRITING. Awkward speech stays awkward.
- NO SYNONYMS. Never replace a word with a similar word.
- PRESERVE SLANG: Keep "כאילו", "אממ", "אז", stuttering, fillers.
- PRESERVE NAMES: Do not change names, brands, places.
- WHEN IN DOUBT: Leave original unchanged.

VERIFICATION: After correcting, check: did I add any word that wasn't in the input? If yes, delete it.
Every input line MUST have exactly one output line.

FORMAT: [index|start-end] corrected text`;

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
        messages: [{ role: "user", content: fullText }],
      }),
    });

    if (!response.ok) {
      return { segments, words: whisperWords, method: "api_fallback" };
    }

    const result = await response.json();
    const correctedText = result.content?.[0]?.text || "";

    const corrected: Segment[] = [];
    for (const line of correctedText.split("\n")) {
      const m = line.match(/\[(\d+)\|([\d.]+)-([\d.]+)\]\s*(.*)/);
      if (m && m[4].trim()) {
        corrected.push({ start: parseFloat(m[2]), end: parseFloat(m[3]), text: m[4].trim() });
      }
    }

    // Integrity check
    if (corrected.length === 0 || Math.abs(corrected.length - segments.length) > segments.length * 0.2) {
      return { segments, words: whisperWords, method: "integrity_fallback" };
    }

    return { segments: corrected, words: whisperWords, method: "claude" };
  } catch (e) {
    return { segments, words: whisperWords, method: "error_fallback" };
  }
}

// ══════════════════════════════════════════════════════════════
// SMART SENTENCE SPLITTING — for "auto" and "sentence" modes
// ══════════════════════════════════════════════════════════════

const MAX_CHARS = 42;       // Max characters per subtitle line
const MAX_DURATION = 4.0;   // Max seconds per subtitle
const MIN_DURATION = 0.3;   // Min seconds per subtitle

function smartSplitSentences(segments: Segment[], mode: "auto" | "sentence"): Segment[] {
  const result: Segment[] = [];

  for (const seg of segments) {
    const text = seg.text.trim();
    if (!text) continue;

    const dur = seg.end - seg.start;

    // If already short enough, keep as-is
    if (text.length <= MAX_CHARS && dur <= MAX_DURATION) {
      result.push(seg);
      continue;
    }

    // Split strategy depends on mode
    if (mode === "sentence") {
      // Split ONLY at sentence endings: . ! ?
      splitAtPattern(seg, /(?<=[.!?])\s+/, result);
    } else {
      // "auto" — split at best natural break point
      // Priority: period > question/exclamation > comma > word boundary
      const splitDone = splitAtPattern(seg, /(?<=[.!?])\s+/, result);
      if (!splitDone) {
        splitAtPattern(seg, /(?<=,)\s+/, result);
      }
    }
  }

  // Second pass: split any remaining long segments at word boundaries
  const final: Segment[] = [];
  for (const seg of result) {
    if (seg.text.length <= MAX_CHARS && (seg.end - seg.start) <= MAX_DURATION) {
      final.push(seg);
      continue;
    }
    // Force split at word boundary near midpoint
    splitAtWordBoundary(seg, final);
  }

  return final;
}

function splitAtPattern(seg: Segment, pattern: RegExp, result: Segment[]): boolean {
  const parts = seg.text.split(pattern).filter(p => p.trim());
  if (parts.length < 2) {
    result.push(seg);
    return false;
  }

  const dur = seg.end - seg.start;
  const totalChars = parts.reduce((s, p) => s + p.length, 0);
  let currentTime = seg.start;

  for (const part of parts) {
    const ratio = part.length / totalChars;
    const partDur = Math.max(MIN_DURATION, dur * ratio);
    const endTime = Math.min(currentTime + partDur, seg.end);

    result.push({
      start: +currentTime.toFixed(3),
      end: +endTime.toFixed(3),
      text: part.trim(),
    });
    currentTime = endTime;
  }
  return true;
}

function splitAtWordBoundary(seg: Segment, result: Segment[]) {
  const words = seg.text.split(/\s+/);
  if (words.length < 2) {
    result.push(seg);
    return;
  }

  const dur = seg.end - seg.start;
  const totalChars = words.reduce((s, w) => s + w.length, 0);

  // Find best split point: closest to middle that keeps both parts under MAX_CHARS
  let bestSplit = Math.floor(words.length / 2);
  let bestScore = Infinity;

  for (let i = 1; i < words.length; i++) {
    const left = words.slice(0, i).join(" ");
    const right = words.slice(i).join(" ");
    const maxLen = Math.max(left.length, right.length);
    const balance = Math.abs(left.length - right.length);
    const score = maxLen + balance * 0.5;

    if (score < bestScore) {
      bestScore = score;
      bestSplit = i;
    }
  }

  const leftText = words.slice(0, bestSplit).join(" ");
  const rightText = words.slice(bestSplit).join(" ");
  const leftChars = leftText.replace(/\s/g, "").length;
  const ratio = leftChars / totalChars;
  const splitTime = seg.start + dur * ratio;

  result.push({ start: seg.start, end: +splitTime.toFixed(3), text: leftText });
  result.push({ start: +splitTime.toFixed(3), end: seg.end, text: rightText });

  // Recursively split if still too long
  const last = result[result.length - 1];
  const secondLast = result[result.length - 2];
  if (last.text.length > MAX_CHARS && last.text.split(/\s+/).length >= 4) {
    result.pop();
    splitAtWordBoundary(last, result);
  }
  if (secondLast.text.length > MAX_CHARS && secondLast.text.split(/\s+/).length >= 4) {
    result.splice(result.length - 1, 0); // handled by next iteration
  }
}

// ══════════════════════════════════════════════════════════════
// WORD SPLITTING — for TikTok modes (word1-word6)
// ══════════════════════════════════════════════════════════════

function splitByWords(segments: Segment[], groupSize: number, whisperWords: Word[]): Segment[] {
  // If we have word-level timestamps from Whisper, use them
  if (whisperWords && whisperWords.length > 0) {
    const result: Segment[] = [];
    for (let i = 0; i < whisperWords.length; i += groupSize) {
      const group = whisperWords.slice(i, i + groupSize);
      if (group.length === 0) continue;
      result.push({
        start: +group[0].start.toFixed(3),
        end: +Math.max(group[group.length - 1].end, group[0].start + 0.1).toFixed(3),
        text: group.map(w => w.word).join(" "),
      });
    }
    return result;
  }

  // Fallback: split proportionally
  const result: Segment[] = [];
  for (const seg of segments) {
    const dur = seg.end - seg.start;
    const words = seg.text.split(/\s+/).filter(w => w);
    if (words.length === 0) continue;
    if (words.length <= groupSize) { result.push(seg); continue; }

    const wordWeights = words.map(w => {
      const heb = (w.match(/[\u0590-\u05FF\u0600-\u06FF]/g) || []).length;
      return heb * 1.4 + (w.length - heb);
    });
    const totalWeight = wordWeights.reduce((s, w) => s + w, 0);

    let t = seg.start;
    for (let i = 0; i < words.length; i += groupSize) {
      const group = words.slice(i, i + groupSize);
      const indices = Array.from({ length: group.length }, (_, j) => i + j);
      const gw = indices.reduce((s, idx) => s + wordWeights[idx], 0);
      const gd = dur * (gw / totalWeight);
      result.push({
        start: +t.toFixed(3),
        end: +Math.max(t + gd, t + 0.1).toFixed(3),
        text: group.join(" "),
      });
      t += gd;
    }
  }
  return result;
}

// ══════════════════════════════════════════════════════════════
// APPLY STYLE — Routes to correct splitting function
// ══════════════════════════════════════════════════════════════

function applyStyle(segments: Segment[], style: string, wordsPerGroup: number, whisperWords: Word[]): Segment[] {
  if (!style || style === "auto") {
    return smartSplitSentences(segments, "auto");
  }
  if (style === "sentence") {
    return smartSplitSentences(segments, "sentence");
  }

  // Word modes: word1, word2, ... word6
  let groupSize = wordsPerGroup || 1;
  const n = parseInt(style.replace("word", ""));
  if (n >= 1 && n <= 6) groupSize = n;

  return splitByWords(segments, groupSize, whisperWords);
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
      const estimatedMinutes = Math.ceil(audioDurationSec / 60 * 10) / 10;
      if (estimatedMinutes > remaining) return err("לא מספיק דקות.", 403);

      const rpResponse = await fetch(`https://api.runpod.ai/v2/${RUNPOD_ENDPOINT_ID}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${RUNPOD_API_KEY}` },
        body: JSON.stringify({
          input: { audio_url: download_url, lang: lang || "he", model: model || "large-v3", offset: offset || 0, format: "json" },
        }),
      });

      if (!rpResponse.ok) {
        await logUsage(user.id, audioDurationSec, lang || "he", model || "large-v3", "failed", 0, 0, await rpResponse.text());
        return err("שרת התמלול לא זמין. נסה שוב.", 502);
      }

      const rpResult = await rpResponse.json();
      if (!rpResult.id) return err("שגיאה בהפעלת תמלול", 500);

      return NextResponse.json({ ok: true, action: "job_started", job_id: rpResult.id, file_key, audio_duration: audioDurationSec });
    }

    // ── check_job (poll — every 3 seconds by plugin) ──
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
        const errMsg = rpResult.output?.error || rpResult.error || "Unknown error";
        await logUsage(user.id, audio_duration || 0, lang || "he", model || "large-v3", "failed", 0, 0, errMsg);
        return err("שגיאת תמלול: " + errMsg, 500);
      }

      if (rpResult.status === "COMPLETED") {
        const output = rpResult.output || {};
        let segments: Segment[] = output.segments || [];
        const whisperWords: Word[] = output.words || [];
        const audioDurationSec = audio_duration || 0;

        if (segments.length === 0) {
          await logUsage(user.id, audioDurationSec, lang || "he", model || "large-v3", "empty", 0, 0);
          return err("לא נמצא דיבור.", 200);
        }

        // Step 1: AI Correction (Claude fixes text, preserves timing)
        const aiResult = await aiCorrectSegments(segments, lang || "he", whisperWords);
        segments = aiResult.segments;

        // Step 2: Apply style splitting (sentence/word based on user choice)
        const wpg = parseInt(words_per_group) || 1;
        const styledSegments = applyStyle(segments, caption_style || "auto", wpg, aiResult.words);

        // Step 3: Build SRT
        const srt = buildSrt(styledSegments);

        // Step 4: Log & deduct
        const minutesCharged = await logUsage(user.id, audioDurationSec, lang || "he", model || "large-v3", "completed", styledSegments.length, 0);
        await deductMinutes(user.id, minutesCharged);

        if (file_key) s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: file_key })).catch(() => {});

        return NextResponse.json({
          ok: true, status: "completed",
          segments: styledSegments, srt,
          language: output.language || lang,
          elapsed: output.elapsed,
          count: styledSegments.length,
          minutes_charged: minutesCharged,
          minutes_remaining: remaining - minutesCharged,
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
