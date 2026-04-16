/**
 * SubAI — Transcription API v11.1 (Async Architecture — Production Ready)
 *
 * v11.0 → v11.1 CHANGES:
 * ═══════════════════════════════════════════════════════════════
 * 1. Rate limiter: in-memory Map → Supabase query (works cross-container)
 * 2. getBaseUrl: prefers request host over VERCEL_URL (avoids SSO block)
 * 3. waitUntil: ensures fire-and-forget fetch survives function return
 * ═══════════════════════════════════════════════════════════════
 */

import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { createClient } from "@supabase/supabase-js";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// This route is FAST — it just dispatches. 10s is more than enough.
export const maxDuration = 10;

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const AWS_REGION = process.env.AWS_REGION || "eu-north-1";
const S3_BUCKET = process.env.S3_BUCKET || "subai-audio";
const PROCESS_SECRET = process.env.PROCESS_SECRET!;

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

// ══════════════════════════════════════════════════════════════
// DATABASE — validateApiKey
// ══════════════════════════════════════════════════════════════

async function validateApiKey(apiKey: string) {
  const { data } = await supabase
    .from("profiles")
    .select("id, email, plan, minutes_used, minutes_limit, subscription_status")
    .eq("api_key", apiKey)
    .single();
  return data || null;
}

// ══════════════════════════════════════════════════════════════
// RATE LIMITING — Supabase-based (works across serverless containers)
//
// Counts active jobs in the DB per user. If a user already has
// MAX_CONCURRENT jobs running, they must wait. This prevents abuse
// and protects the Modal GPU budget.
// ══════════════════════════════════════════════════════════════

const MAX_CONCURRENT_JOBS = 3;

async function checkRateLimit(userId: string): Promise<boolean> {
  const { count, error } = await supabase
    .from("transcription_jobs")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .in("status", ["pending", "whisper", "ai_correction"]);

  if (error) {
    console.warn("[RATE] DB check failed, allowing:", error.message);
    return true;
  }

  return (count || 0) < MAX_CONCURRENT_JOBS;
}

// ══════════════════════════════════════════════════════════════
// Get the base URL for internal calls
// ══════════════════════════════════════════════════════════════

function getBaseUrl(req: NextRequest): string {
  // Use the request's own host first, NOT process.env.VERCEL_URL.
  // VERCEL_URL points to the deployment-specific *.vercel.app URL which is
  // protected by Vercel SSO on team projects. The custom domain is not.
  const host = req.headers.get("host");
  if (host) {
    const proto = req.headers.get("x-forwarded-proto") || "https";
    return `${proto}://${host}`;
  }
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`;
  }
  return "http://localhost:3000";
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
      if (!await checkRateLimit(user.id)) {
        return err("יותר מדי בקשות. נסה שוב בעוד דקה.", 429);
      }
    }

    // ─────────────────────────────────────────────
    // ACTION: get_upload_url
    // ─────────────────────────────────────────────
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

    // ─────────────────────────────────────────────
    // ACTION: transcribe (ASYNC)
    // ─────────────────────────────────────────────
    if (action === "transcribe") {
      const { download_url, file_key } = body;
      if (!download_url) return err("Missing download_url");
      const audioDur = audio_duration || 0;
      if (Math.ceil((audioDur / 60) * 10) / 10 > remaining) return err("לא מספיק דקות.", 403);
      if (audioDur > 3600) return err("מקסימום 60 דקות לתמלול בודד.", 400);

      // 1. Create job in Supabase
      const { data: job, error: jobErr } = await supabase
        .from("transcription_jobs")
        .insert({
          user_id: user.id,
          status: "pending",
          download_url,
          file_key: file_key || null,
          lang: lang || "he",
          model: model || "whisper-large-v3",
          audio_duration: audioDur,
          caption_style: caption_style || "auto",
          words_per_group: parseInt(words_per_group) || 1,
        })
        .select("id")
        .single();

      if (jobErr || !job) {
        console.error("[TRANSCRIBE] Failed to create job:", jobErr);
        return err("שגיאה ביצירת משימה.", 500);
      }

      const jobId = job.id;
      console.log(`[TRANSCRIBE] Created job ${jobId} for user ${user.id}`);

      // 2. Fire-and-forget via waitUntil (keeps the fetch alive after return)
      const baseUrl = getBaseUrl(req);
      const processUrl = `${baseUrl}/api/transcribe/process`;

      waitUntil(
        fetch(processUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            job_id: jobId,
            secret: PROCESS_SECRET,
          }),
        }).catch((e) => {
          console.error(`[TRANSCRIBE] Failed to trigger process for job ${jobId}:`, e);
        })
      );

      // 3. Return immediately
      return NextResponse.json({
        ok: true,
        status: "processing",
        job_id: jobId,
        message: "התמלול התחיל. בדוק סטטוס עם action: check_job",
      });
    }

    // ─────────────────────────────────────────────
    // ACTION: check_job (plugin polls this)
    // ─────────────────────────────────────────────
    if (action === "check_job") {
      const { job_id } = body;
      if (!job_id) return err("Missing job_id");

      const { data: job, error: jobErr } = await supabase
        .from("transcription_jobs")
        .select("*")
        .eq("id", job_id)
        .eq("user_id", user.id)
        .single();

      if (jobErr || !job) {
        return err("Job not found", 404);
      }

      if (["pending", "whisper", "ai_correction"].includes(job.status)) {
        return NextResponse.json({
          ok: true,
          status: job.status,
          job_id: job.id,
          message: job.status === "pending" ? "ממתין בתור..."
            : job.status === "whisper" ? "מתמלל עם Whisper..."
            : "מתקן עם AI...",
        });
      }

      if (job.status === "failed") {
        return NextResponse.json({
          ok: false,
          status: "failed",
          job_id: job.id,
          error: true,
          message: job.error_message || "שגיאת תמלול.",
        });
      }

      if (job.status === "completed") {
        const meta = job.result_meta || {};
        return NextResponse.json({
          ok: true,
          status: "completed",
          job_id: job.id,
          segments: job.segments,
          srt: job.srt,
          language: meta.language,
          elapsed: meta.elapsed,
          count: meta.count,
          minutes_charged: meta.minutes_charged,
          minutes_remaining: meta.minutes_remaining,
          ai_correction: meta.ai_correction,
        });
      }

      return NextResponse.json({ ok: true, status: job.status, job_id: job.id });
    }

    // ─────────────────────────────────────────────
    // ACTION: status
    // ─────────────────────────────────────────────
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
