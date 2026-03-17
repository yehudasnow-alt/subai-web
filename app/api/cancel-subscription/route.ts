/**
 * SubAI — Cancel Subscription API
 * POST /api/cancel-subscription
 * Cancels at period end (keeps access until billing cycle ends)
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";

export const maxDuration = 15;

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: "2024-04-10" });
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

export async function POST(req: NextRequest) {
  try {
    const { userId } = await req.json();
    if (!userId) return NextResponse.json({ error: "Missing userId" }, { status: 400 });

    // Get profile
    const { data: profile } = await supabase
      .from("profiles")
      .select("stripe_subscription_id, stripe_customer_id, plan, period_end")
      .eq("id", userId)
      .single();

    if (!profile || !profile.stripe_subscription_id) {
      return NextResponse.json({ error: "No active subscription found" }, { status: 400 });
    }

    // Cancel at period end (not immediately — user keeps access)
    const subscription = await stripe.subscriptions.update(profile.stripe_subscription_id, {
      cancel_at_period_end: true,
    });

    // Update Supabase
    await supabase.from("profiles").update({
      subscription_status: "canceled",
      period_end: new Date(subscription.current_period_end * 1000).toISOString(),
    }).eq("id", userId);

    return NextResponse.json({
      ok: true,
      message: "המנוי יבוטל בסוף תקופת החיוב",
      period_end: new Date(subscription.current_period_end * 1000).toISOString(),
      cancel_at: new Date(subscription.current_period_end * 1000).toLocaleDateString("he-IL"),
    });
  } catch (e: any) {
    console.error("Cancel error:", e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
