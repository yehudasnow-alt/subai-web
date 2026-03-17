/**
 * SubAI — Transcription API Endpoint
 * POST /api/transcribe
 *
 * Flow:
 * 1. Validate API key → get user from Supabase
 * 2. Check usage quota
 * 3. Generate S3 signed upload URL
 * 4. Client uploads audio to S3
 * 5. Trigger RunPod serverless
 * 6. Return SRT result
 *
 * Deploy: Vercel (Next.js API Route)
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// ── Environment Variables ───────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const AWS_REGION = process.env.AWS_REGION || "eu-central-1";
const S3_BUCKET = process.env.S3_BUCKET || "subai-audio";
const AWS_ACCESS_KEY = process.env.AWS_ACCESS_KEY_ID!;
const AWS_SECRET_KEY = process.env.AWS_SECRET_ACCESS_KEY!;
const RUNPOD_API_KEY = process.env.RUNPOD_API_KEY!;
const RUNPOD_ENDPOINT_ID = process.env.RUNPOD_ENDPOINT_ID!;

// ── Clients ─────────────────────────────────────────────────────
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const s3 = new S3Client({
  region: AWS_REGION,
  credentials: { accessKeyId: AWS_ACCESS_KEY, secretAccessKey: AWS_SECRET_KEY },
});

// ── Helpers ─────────────────────────────────────────────────────
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

async function logUsage(
  userId: string,
  audioDuration: number,
  lang: string,
  model: string,
  status: string,
  segmentsCount: number = 0,
  processingSec: number = 0,
  errorMessage: string = ""
) {
  const minutesCharged = Math.ceil(audioDuration / 60 * 10) / 10; // round up to 0.1 min
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

async function deductMinutes(userId: string, minutes: number) {
  await supabase.rpc("", {}).catch(() => {}); // ignore
  // Direct update
  const { error } = await supabase
    .from("profiles")
    .update({ minutes_used: supabase.rpc ? undefined : undefined })
    .eq("id", userId);
  // Use raw SQL via RPC for atomic increment
  await supabase.rpc("increment_usage", { p_user_id: userId, p_minutes: minutes }).catch(async () => {
    // Fallback: read + write
    const { data } = await supabase.from("profiles").select("minutes_used").eq("id", userId).single();
    if (data) {
      await supabase.from("profiles").update({ minutes_used: (data.minutes_used || 0) + minutes }).eq("id", userId);
    }
  });
}

// ── Step 1: Get Upload URL ──────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { api_key, action, lang, model, offset, audio_duration } = body;

    // Validate API key
    if (!api_key) return err("Missing api_key", 401);
    const user = await validateApiKey(api_key);
    if (!user) return err("Invalid API key", 401);

    // Check subscription
    if (user.subscription_status === "canceled" || user.subscription_status === "past_due") {
      return err("מנוי לא פעיל. חדש את המנוי באתר.", 403);
    }

    // Check quota
    const remaining = (user.minutes_limit || 0) - (user.minutes_used || 0);
    if (remaining <= 0) {
      return err(`נגמרה המכסה (${user.minutes_limit} דקות). שדרג תוכנית לעוד דקות.`, 403);
    }

    // ── Action: get_upload_url ───────────────────────────────────
    if (action === "get_upload_url") {
      const fileKey = `audio/${user.id}/${Date.now()}.mp3`;
      const putCommand = new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: fileKey,
        ContentType: "audio/mpeg",
      });
      const uploadUrl = await getSignedUrl(s3, putCommand, { expiresIn: 300 }); // 5 min

      // Also create download URL for RunPod
      const getCommand = new GetObjectCommand({
        Bucket: S3_BUCKET,
        Key: fileKey,
      });
      const downloadUrl = await getSignedUrl(s3, getCommand, { expiresIn: 3600 }); // 1 hour

      return NextResponse.json({
        upload_url: uploadUrl,
        download_url: downloadUrl,
        file_key: fileKey,
        remaining_minutes: remaining,
      });
    }

    // ── Action: transcribe ──────────────────────────────────────
    if (action === "transcribe") {
      const { download_url, file_key } = body;
      if (!download_url) return err("Missing download_url");

      const audioDurationSec = audio_duration || 0;
      const estimatedMinutes = Math.ceil(audioDurationSec / 60 * 10) / 10;

      if (estimatedMinutes > remaining) {
        return err(`לא מספיק דקות. נדרש: ${estimatedMinutes}, נותר: ${remaining.toFixed(1)}`, 403);
      }

      // Trigger RunPod
      const runpodUrl = `https://api.runpod.ai/v2/${RUNPOD_ENDPOINT_ID}/runsync`;

      const t0 = Date.now();
      const rpResponse = await fetch(runpodUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${RUNPOD_API_KEY}`,
        },
        body: JSON.stringify({
          input: {
            audio_url: download_url,
            lang: lang || "he",
            model: model || "large-v3",
            offset: offset || 0,
            format: "json",
          },
        }),
      });

      if (!rpResponse.ok) {
        const rpErr = await rpResponse.text();
        await logUsage(user.id, audioDurationSec, lang || "he", model || "large-v3", "failed", 0, 0, rpErr);
        return err("שרת התמלול לא זמין כרגע. נסה שוב.", 502);
      }

      const rpResult = await rpResponse.json();
      const processingSec = (Date.now() - t0) / 1000;

      // Check for RunPod error
      if (rpResult.status === "FAILED" || rpResult.output?.error) {
        const errMsg = rpResult.output?.error || "Unknown error";
        await logUsage(user.id, audioDurationSec, lang || "he", model || "large-v3", "failed", 0, processingSec, errMsg);
        return err(`שגיאת תמלול: ${errMsg}`, 500);
      }

      const output = rpResult.output || {};
      const segments = output.segments || [];
      const srt = output.srt || "";

      // Deduct minutes
      const minutesCharged = await logUsage(
        user.id, audioDurationSec, lang || "he", model || "large-v3",
        "completed", output.count || segments.length, processingSec
      );
      await deductMinutes(user.id, minutesCharged);

      // Cleanup S3 (async, don't wait)
      if (file_key) {
        s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: file_key })).catch(() => {});
      }

      return NextResponse.json({
        ok: true,
        segments,
        srt,
        language: output.language || lang,
        elapsed: output.elapsed,
        count: output.count || segments.length,
        minutes_charged: minutesCharged,
        minutes_remaining: remaining - minutesCharged,
      });
    }

    // ── Action: status (check quota) ────────────────────────────
    if (action === "status") {
      return NextResponse.json({
        ok: true,
        plan: user.plan,
        minutes_used: user.minutes_used,
        minutes_limit: user.minutes_limit,
        minutes_remaining: remaining,
      });
    }

    return err("Unknown action. Use: get_upload_url, transcribe, status");

  } catch (e: any) {
    console.error("API Error:", e);
    return err("שגיאה פנימית בשרת", 500);
  }
}
