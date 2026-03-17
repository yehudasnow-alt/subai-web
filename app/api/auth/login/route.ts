/**
 * SubAI — Auth Login API
 * POST /api/auth/login
 * Authenticates email/password via Supabase, returns api_key + user info
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const maxDuration = 15;

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(req: NextRequest) {
  try {
    const { email, password } = await req.json();

    if (!email || !password) {
      return NextResponse.json({ error: true, message: "Missing email or password" }, { status: 400 });
    }

    // Authenticate with Supabase Auth
    const authClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    );

    const { data: authData, error: authError } = await authClient.auth.signInWithPassword({
      email,
      password,
    });

    if (authError || !authData.user) {
      const messages: Record<string, string> = {
        "Invalid login credentials": "אימייל או סיסמה שגויים",
        "Email not confirmed": "אימייל לא אומת — בדוק את תיבת הדואר",
      };
      return NextResponse.json({
        error: true,
        message: messages[authError?.message || ""] || authError?.message || "שגיאת התחברות",
      }, { status: 401 });
    }

    // Get profile with api_key
    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("id, email, full_name, plan, minutes_used, minutes_limit, api_key, subscription_status")
      .eq("id", authData.user.id)
      .single();

    if (profileError || !profile) {
      return NextResponse.json({ error: true, message: "Profile not found" }, { status: 404 });
    }

    return NextResponse.json({
      ok: true,
      api_key: profile.api_key,
      email: profile.email,
      name: profile.full_name,
      plan: profile.plan,
      minutes_used: profile.minutes_used,
      minutes_limit: profile.minutes_limit,
      minutes_remaining: Math.max(0, (profile.minutes_limit || 0) - (profile.minutes_used || 0)),
      subscription_status: profile.subscription_status,
    });
  } catch (e: any) {
    console.error("Login error:", e);
    return NextResponse.json({ error: true, message: "שגיאה פנימית" }, { status: 500 });
  }
}
