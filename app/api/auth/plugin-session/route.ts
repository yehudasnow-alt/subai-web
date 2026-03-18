/**
 * SubAI — Plugin Session Auth
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
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const maxDuration = 10;

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Simple in-memory store (cleared on redeploy, but sessions are short-lived)
// For production, use Supabase or Redis
const sessions: Record<string, { api_key?: string; user?: any; expires: number }> = {};

// Cleanup old sessions
function cleanup() {
  const now = Date.now();
  for (const key in sessions) {
    if (sessions[key].expires < now) delete sessions[key];
  }
}

export async function POST(req: NextRequest) {
  try {
    cleanup();
    const { action, session_id, user_id } = await req.json();

    if (!session_id || session_id.length < 10) {
      return NextResponse.json({ error: "Invalid session_id" }, { status: 400 });
    }

    // ── Plugin polls this to check if login completed ──
    if (action === "check") {
      const session = sessions[session_id];
      if (!session) {
        return NextResponse.json({ ok: false, status: "waiting" });
      }
      if (session.api_key) {
        // Login completed! Return credentials and clean up
        const result = { ok: true, status: "ready", api_key: session.api_key, user: session.user };
        delete sessions[session_id]; // One-time use
        return NextResponse.json(result);
      }
      return NextResponse.json({ ok: false, status: "waiting" });
    }

    // ── Website calls this after successful login ──
    if (action === "store") {
      if (!user_id) {
        return NextResponse.json({ error: "Missing user_id" }, { status: 400 });
      }

      // Get profile
      const { data: profile } = await supabase
        .from("profiles")
        .select("id, email, full_name, plan, minutes_used, minutes_limit, api_key, subscription_status")
        .eq("id", user_id)
        .single();

      if (!profile) {
        return NextResponse.json({ error: "Profile not found" }, { status: 404 });
      }

      // Store in session (expires in 5 minutes)
      sessions[session_id] = {
        api_key: profile.api_key,
        user: {
          email: profile.email,
          name: profile.full_name,
          plan: profile.plan,
          minutes_used: profile.minutes_used,
          minutes_limit: profile.minutes_limit,
          minutes_remaining: Math.max(0, (profile.minutes_limit || 0) - (profile.minutes_used || 0)),
        },
        expires: Date.now() + 5 * 60 * 1000,
      };

      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (e: any) {
    console.error("Plugin session error:", e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
