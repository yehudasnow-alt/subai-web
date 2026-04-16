/**
 * SubAI — Plugin Session Auth (Production — Supabase-backed)
 * POST /api/auth/plugin-session
 *
 * Flow:
 * 1. Plugin generates session_id, opens browser to /auth?plugin_session=ID
 * 2. User logs in (Google/email), website stores api_key for session_id
 * 3. Plugin polls this endpoint to get the api_key
 *
 * Actions:
 * - store: website stores api_key after login
 * - check: plugin checks if login completed
 *
 * Sessions are stored in Supabase table `plugin_sessions` so they work
 * reliably across serverless containers (no in-memory state).
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const maxDuration = 10;

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(req: NextRequest) {
  try {
    const { action, session_id, user_id } = await req.json();

    if (!session_id || session_id.length < 10) {
      return NextResponse.json({ error: "Invalid session_id" }, { status: 400 });
    }

    // ── Plugin polls this to check if login completed ──
    if (action === "check") {
      const { data: session } = await supabase
        .from("plugin_sessions")
        .select("api_key, user_data")
        .eq("session_id", session_id)
        .gt("expires_at", new Date().toISOString())
        .single();

      if (!session || !session.api_key) {
        return NextResponse.json({ ok: false, status: "waiting" });
      }

      // Login completed — return credentials and delete (one-time use)
      await supabase
        .from("plugin_sessions")
        .delete()
        .eq("session_id", session_id);

      return NextResponse.json({
        ok: true,
        status: "ready",
        api_key: session.api_key,
        user: session.user_data,
      });
    }

    // ── Website calls this after successful login ──
    if (action === "store") {
      if (!user_id) {
        return NextResponse.json({ error: "Missing user_id" }, { status: 400 });
      }

      const { data: profile } = await supabase
        .from("profiles")
        .select("id, email, full_name, plan, minutes_used, minutes_limit, api_key, subscription_status")
        .eq("id", user_id)
        .single();

      if (!profile) {
        return NextResponse.json({ error: "Profile not found" }, { status: 404 });
      }

      const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

      // Upsert — if same session_id exists (retry), overwrite it
      const { error: upsertErr } = await supabase
        .from("plugin_sessions")
        .upsert(
          {
            session_id,
            api_key: profile.api_key,
            user_data: {
              email: profile.email,
              name: profile.full_name,
              plan: profile.plan,
              minutes_used: profile.minutes_used,
              minutes_limit: profile.minutes_limit,
              minutes_remaining: Math.max(0, (profile.minutes_limit || 0) - (profile.minutes_used || 0)),
            },
            expires_at: expiresAt,
          },
          { onConflict: "session_id" }
        );

      if (upsertErr) {
        console.error("Plugin session store error:", upsertErr);
        return NextResponse.json({ error: "Failed to store session" }, { status: 500 });
      }

      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (e: any) {
    console.error("Plugin session error:", e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
