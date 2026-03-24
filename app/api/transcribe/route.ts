/**
 * SubAI — Transcription API v4.0
 * POST /api/transcribe
 * 
 * Improved:
 * - AI correction reads full context first, only fixes clear typos
 * - Does NOT replace real words/concepts, only spelling errors
 * - Fixes sentence boundaries (words that belong to previous/next sentence)
 * - Word splitting supports 1-6 words per subtitle with proportional timing
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
  const { data, error } = await supabase.from("profiles")
    .select("id, email, plan, minutes_used, minutes_limit, subscription_status")
    .eq("api_key", apiKey).single();
  if (error || !data) return null;
  return data;
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
  } catch (e) {}
  try {
    const { data } = await supabase.from("profiles").select("minutes_used").eq("id", userId).single();
    if (data) await supabase.from("profiles").update({ minutes_used: (data.minutes_used || 0) + minutes }).eq("id", userId);
  } catch (e) {}
}

// ══════════════════════════════════════════════════════════════
// AI TEXT CORRECTION — Context-aware, conservative, precise
// ══════════════════════════════════════════════════════════════

interface Segment { start: number; end: number; text: string; }

async function aiCorrectSegments(
  segments: Segment[], language: string, captionStyle: string, wordsPerGroup: number
): Promise<{ segments: Segment[]; method: string }> {
  if (!ANTHROPIC_API_KEY || segments.length === 0) {
    return { segments: applyWordSplit(segments, captionStyle, wordsPerGroup), method: "none" };
  }

  try {
    // Build full text with markers
    const fullText = segments.map((s, i) =>
      `[${i}|${s.start.toFixed(2)}-${s.end.toFixed(2)}] ${s.text}`
    ).join("\n");

    const langName = language === "he" ? "עברית" : language === "ar" ? "ערבית" : "English";

    const systemPrompt = `You are a professional subtitle proofreader for ${langName} content.
Your job: fix ONLY clear errors in AI-transcribed text. Be extremely conservative.

STEP 1 — READ ALL TEXT FIRST:
Read every segment from start to finish. Understand the topic, context, and speaking style before making any changes.

STEP 2 — FIX ONLY THESE (and nothing else):

A) CLEAR SPELLING ERRORS:
   - If Whisper wrote "עבוק" but context shows it should be "עמוק" → fix it
   - If Whisper wrote "להתפלל" but context is about cooking and it should be "להתפלל" → DON'T touch it (might be correct)
   - Rule: Only fix if you are 95%+ sure from context what the correct word is
   - If unsure → leave the original word as-is

B) PUNCTUATION:
   - Add missing periods at sentence ends
   - Add missing commas where natural pauses occur
   - Add question marks where questions are asked
   - Fix double/triple punctuation to single

C) SENTENCE BOUNDARIES:
   - If a word clearly belongs to the PREVIOUS sentence but Whisper put it at the start of the next segment → move it back
   - If a sentence starts mid-thought in one segment and the beginning is at the end of the previous segment → merge them correctly
   - Each subtitle segment should start and end at natural sentence/clause boundaries

D) REMOVE HALLUCINATIONS:
   - Remove exact duplicate phrases within a segment
   - Remove segments that are clearly not speech (music descriptions, [applause], etc.)

STEP 3 — DO NOT DO ANY OF THESE:
- Do NOT replace real words with synonyms
- Do NOT rewrite sentences in "better" Hebrew
- Do NOT add words that weren't spoken
- Do NOT remove words that were spoken (even filler words like "אמ", "אה" — keep them)
- Do NOT change names, places, technical terms, or domain-specific words
- Do NOT change the meaning even slightly
- When in doubt — DO NOT CHANGE

FORMAT:
Return ONLY the corrected segments in the exact same format:
[index|start-end] corrected text

Every input line must have a corresponding output line. Do not skip or merge lines.`;

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
      console.error("Claude API error:", response.status);
      return { segments: applyWordSplit(segments, captionStyle, wordsPerGroup), method: "fallback" };
    }

    const result = await response.json();
    const correctedText = result.content?.[0]?.text || "";

    // Parse corrected segments
    const corrected: Segment[] = [];
    for (const line of correctedText.split("\n")) {
      const m = line.match(/\[(\d+)\|([\d.]+)-([\d.]+)\]\s*(.*)/);
      if (m && m[4].trim()) {
        corrected.push({ start: parseFloat(m[2]), end: parseFloat(m[3]), text: m[4].trim() });
      }
    }

    if (corrected.length > 0) {
      return { segments: applyWordSplit(corrected, captionStyle, wordsPerGroup), method: "claude" };
    }
    return { segments: applyWordSplit(segments, captionStyle, wordsPerGroup), method: "parse_fallback" };
  } catch (e) {
    console.error("AI correction error:", e);
    return { segments: applyWordSplit(segments, captionStyle, wordsPerGroup), method: "error_fallback" };
  }
}

// ══════════════════════════════════════════════════════════════
// WORD SPLITTING — Configurable 1-6 words with precise timing
// ══════════════════════════════════════════════════════════════

function applyWordSplit(segments: Segment[], style: string, wordsPerGroup: number): Segment[] {
  // style "auto" or "sentence" = no word splitting
  if (!style || style === "auto" || style === "sentence") return segments;

  // Determine how many words per subtitle
  let groupSize = wordsPerGroup || 1;
  if (style === "word1") groupSize = 1;
  else if (style === "word2") groupSize = 2;
  else if (style === "word3") groupSize = 3;
  else if (style === "word4") groupSize = 4;
  else if (style === "word5") groupSize = 5;
  else if (style === "word6") groupSize = 6;
  else if (style.startsWith("word")) {
    const n = parseInt(style.replace("word", ""));
    if (n >= 1 && n <= 6) groupSize = n;
  }

  const result: Segment[] = [];

  for (const seg of segments) {
    const duration = seg.end - seg.start;
    const words = seg.text.split(/\s+/).filter(w => w.length > 0);

    if (words.length === 0) continue;
    if (words.length <= groupSize) {
      // Fewer words than group size — keep as single subtitle
      result.push(seg);
      continue;
    }

    // Calculate timing proportionally based on character count per word
    // Longer words take more time to say than shorter ones
    const wordLengths = words.map(w => {
      // Hebrew/Arabic characters weigh slightly more (more complex pronunciation)
      const hebrewChars = (w.match(/[\u0590-\u05FF\u0600-\u06FF]/g) || []).length;
      const otherChars = w.length - hebrewChars;
      return hebrewChars * 1.2 + otherChars;
    });
    const totalWeight = wordLengths.reduce((sum, l) => sum + l, 0);

    // Build word groups
    let currentTime = seg.start;

    for (let i = 0; i < words.length; i += groupSize) {
      const groupWords = words.slice(i, i + groupSize);
      const groupIndices = [];
      for (let j = i; j < Math.min(i + groupSize, words.length); j++) {
        groupIndices.push(j);
      }

      // Calculate this group's duration based on its character weight
      const groupWeight = groupIndices.reduce((sum, idx) => sum + wordLengths[idx], 0);
      const groupDuration = duration * (groupWeight / totalWeight);

      // Add small padding between groups for natural feel (20ms)
      const padding = 0.02;
      const startTime = currentTime;
      const endTime = currentTime + groupDuration - padding;

      result.push({
        start: +startTime.toFixed(3),
        end: +Math.max(endTime, startTime + 0.1).toFixed(3), // minimum 100ms
        text: groupWords.join(" "),
      });

      currentTime += groupDuration;
    }
  }

  return result;
}

// ══════════════════════════════════════════════════════════════
// SRT BUILDER
// ══════════════════════════════════════════════════════════════

function buildSrt(segments: Segment[], offset: number = 0): string {
  const ts = (s: number) => {
    s = Math.max(0, s);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sc = Math.floor(s % 60),
      ms = Math.round((s - Math.floor(s)) * 1000);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sc).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
  };
  return segments.map((seg, i) => {
    const text = seg.text.trim();
    if (!text) return "";
    return `${i + 1}\n${ts(seg.start + offset)} --> ${ts(seg.end + offset)}\n${text}\n`;
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
      const putCommand = new PutObjectCommand({ Bucket: S3_BUCKET, Key: fileKey, ContentType: "audio/mpeg" });
      const uploadUrl = await getSignedUrl(s3, putCommand, { expiresIn: 300 });
      const getCommand = new GetObjectCommand({ Bucket: S3_BUCKET, Key: fileKey });
      const downloadUrl = await getSignedUrl(s3, getCommand, { expiresIn: 3600 });
      return NextResponse.json({ upload_url: uploadUrl, download_url: downloadUrl, file_key: fileKey, remaining_minutes: remaining });
    }

    // ── transcribe ──
    if (action === "transcribe") {
      const { download_url, file_key } = body;
      if (!download_url) return err("Missing download_url");

      const audioDurationSec = audio_duration || 0;
      const estimatedMinutes = Math.ceil(audioDurationSec / 60 * 10) / 10;
      if (estimatedMinutes > remaining) return err("לא מספיק דקות.", 403);

      // Step 1: RunPod Whisper
      const runpodUrl = `https://api.runpod.ai/v2/${RUNPOD_ENDPOINT_ID}/runsync`;
      const t0 = Date.now();

      const rpResponse = await fetch(runpodUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${RUNPOD_API_KEY}` },
        body: JSON.stringify({
          input: { audio_url: download_url, lang: lang || "he", model: model || "large-v3", offset: offset || 0, format: "json" },
        }),
      });

      if (!rpResponse.ok) {
        const rpErr = await rpResponse.text();
        await logUsage(user.id, audioDurationSec, lang || "he", model || "large-v3", "failed", 0, 0, rpErr);
        return err("שרת התמלול לא זמין. נסה שוב.", 502);
      }

      const rpResult = await rpResponse.json();
      const whisperSec = (Date.now() - t0) / 1000;

      if (rpResult.status === "FAILED" || rpResult.output?.error) {
        const errMsg = rpResult.output?.error || "Unknown error";
        await logUsage(user.id, audioDurationSec, lang || "he", model || "large-v3", "failed", 0, whisperSec, errMsg);
        return err("שגיאת תמלול: " + errMsg, 500);
      }

      const output = rpResult.output || {};
      let segments: Segment[] = output.segments || [];

      if (segments.length === 0) {
        await logUsage(user.id, audioDurationSec, lang || "he", model || "large-v3", "empty", 0, whisperSec);
        return err("לא נמצא דיבור.", 200);
      }

      // Step 2: AI Text Correction + Word Splitting
      const wpg = parseInt(words_per_group) || 1;
      const aiResult = await aiCorrectSegments(segments, lang || "he", caption_style || "auto", wpg);
      segments = aiResult.segments;

      // Step 3: Build SRT
      const srt = buildSrt(segments);
      const totalSec = (Date.now() - t0) / 1000;

      // Step 4: Log & deduct
      const minutesCharged = await logUsage(
        user.id, audioDurationSec, lang || "he", model || "large-v3",
        "completed", segments.length, totalSec
      );
      await deductMinutes(user.id, minutesCharged);

      // Cleanup S3
      if (file_key) s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: file_key })).catch(() => { });

      return NextResponse.json({
        ok: true, segments, srt,
        language: output.language || lang,
        elapsed: output.elapsed,
        count: segments.length,
        minutes_charged: minutesCharged,
        minutes_remaining: remaining - minutesCharged,
        ai_correction: aiResult.method,
      });
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
    return err("שגיאה פנימית בשרת", 500);
  }
}
