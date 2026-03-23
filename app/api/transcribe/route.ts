/**
 * SubAI — Transcription API v3.0
 * POST /api/transcribe
 * Flow: Validate → S3 → RunPod Whisper → Claude AI Correction → SRT → Return
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
  const { data, error } = await supabase
    .from("profiles")
    .select("id, email, plan, minutes_used, minutes_limit, subscription_status")
    .eq("api_key", apiKey)
    .single();
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
    if (data) {
      await supabase.from("profiles").update({ minutes_used: (data.minutes_used || 0) + minutes }).eq("id", userId);
    }
  } catch (e) {}
}

// ── AI Text Correction (#8) ──────────────────────────────────
interface Segment { start: number; end: number; text: string; }

async function aiCorrectSegments(segments: Segment[], language: string, captionStyle: string): Promise<{ segments: Segment[]; method: string }> {
  if (!ANTHROPIC_API_KEY || segments.length === 0) {
    return { segments: applyStyle(segments, captionStyle), method: "none" };
  }

  try {
    const fullText = segments.map((s, i) => `[${i}|${s.start.toFixed(2)}-${s.end.toFixed(2)}] ${s.text}`).join("\n");
    const langName = language === "he" ? "עברית" : language === "ar" ? "ערבית" : "English";

    const systemPrompt = `You are a subtitle editor. Fix AI-transcribed text.
Rules:
- Fix grammar, punctuation, spelling
- Remove hallucinated/repeated phrases
- Remove filler words
- Keep EXACT timing markers [index|start-end]
- Keep original language (${langName})
- Do NOT translate or add content
- Max 42 chars per subtitle line
- Return ONLY corrected segments in same format`;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: "user", content: `Fix:\n\n${fullText}` }],
      }),
    });

    if (!response.ok) {
      console.error("Claude API error:", response.status);
      return { segments: applyStyle(segments, captionStyle), method: "fallback" };
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
      return { segments: applyStyle(corrected, captionStyle), method: "claude" };
    }
    return { segments: applyStyle(segments, captionStyle), method: "parse_fallback" };
  } catch (e) {
    console.error("AI correction error:", e);
    return { segments: applyStyle(segments, captionStyle), method: "error_fallback" };
  }
}

function applyStyle(segments: Segment[], style: string): Segment[] {
  if (!style || style === "auto") return segments;
  const result: Segment[] = [];
  for (const seg of segments) {
    const dur = seg.end - seg.start;
    const words = seg.text.split(/\s+/).filter(w => w);
    if (words.length === 0) continue;
    const totalChars = words.reduce((sum, w) => sum + w.length, 0);

    if (style === "word1") {
      let t = seg.start;
      for (const w of words) {
        const d = dur * (w.length / totalChars);
        result.push({ start: +t.toFixed(3), end: +(t + d).toFixed(3), text: w });
        t += d;
      }
    } else if (style === "word2") {
      let t = seg.start;
      for (let i = 0; i < words.length; i += 2) {
        const pair = words.slice(i, i + 2).join(" ");
        const pairLen = pair.replace(/\s/g, "").length;
        const d = dur * (pairLen / totalChars);
        result.push({ start: +t.toFixed(3), end: +(t + d).toFixed(3), text: pair });
        t += d;
      }
    } else {
      result.push(seg);
    }
  }
  return result;
}

function buildSrt(segments: Segment[], offset: number = 0): string {
  const ts = (s: number) => {
    s = Math.max(0, s);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sc = Math.floor(s % 60), ms = Math.round((s - Math.floor(s)) * 1000);
    return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(sc).padStart(2,"0")},${String(ms).padStart(3,"0")}`;
  };
  return segments.map((seg, i) => {
    const text = seg.text.trim();
    if (!text) return "";
    return `${i + 1}\n${ts(seg.start + offset)} --> ${ts(seg.end + offset)}\n${text}\n`;
  }).filter(Boolean).join("\n");
}

// ── Main Handler ─────────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { api_key, action, lang, model, offset, audio_duration, caption_style } = body;

    if (!api_key) return err("Missing api_key", 401);
    const user = await validateApiKey(api_key);
    if (!user) return err("Invalid API key", 401);

    if (user.subscription_status === "canceled" || user.subscription_status === "past_due") {
      return err("מנוי לא פעיל. חדש את המנוי באתר.", 403);
    }

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

      // Step 2: AI Text Correction (#8)
      const aiResult = await aiCorrectSegments(segments, lang || "he", caption_style || "auto");
      segments = aiResult.segments;

      // Step 3: Build SRT from corrected segments
      const srt = buildSrt(segments);
      const totalSec = (Date.now() - t0) / 1000;

      // Step 4: Log & deduct
      const minutesCharged = await logUsage(
        user.id, audioDurationSec, lang || "he", model || "large-v3",
        "completed", segments.length, totalSec
      );
      await deductMinutes(user.id, minutesCharged);

      // Cleanup S3
      if (file_key) s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: file_key })).catch(() => {});

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
