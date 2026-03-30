/**
 * SubAI — Stripe Webhook Handler
 * POST /api/webhooks/stripe
 *
 * One-time payment model:
 * - checkout.session.completed → add purchased minutes to user balance
 * - No subscription management needed
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: "2024-04-10" });
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET!;
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

// Map price IDs to minute packages
const PLAN_MAP: Record<string, { plan: string; minutes: number }> = {
  [process.env.STRIPE_PRICE_PRO    || "price_pro"]:    { plan: "pro",    minutes: 120 },
  [process.env.STRIPE_PRICE_STUDIO || "price_studio"]: { plan: "studio", minutes: 500 },
};

export async function POST(req: NextRequest) {
  const body = await req.text();
  const sig  = req.headers.get("stripe-signature");

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, sig!, webhookSecret);
  } catch (e: any) {
    console.error("Webhook signature verification failed:", e.message);
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  try {
    switch (event.type) {

      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;

        // Only process paid sessions
        if (session.payment_status !== "paid") {
          console.log(`[WEBHOOK] Session ${session.id} not paid yet, skipping`);
          break;
        }

        const email = session.customer_email || session.customer_details?.email;
        const customerId = session.customer as string;
        const plan    = session.metadata?.plan    || "pro";
        const minutes = parseInt(session.metadata?.minutes || "0");

        if (!email || minutes <= 0) {
          console.error(`[WEBHOOK] Missing email or minutes: email=${email}, minutes=${minutes}`);
          break;
        }

        // Find user by email
        const { data: profile, error: findErr } = await supabase
          .from("profiles")
          .select("id, plan, minutes_limit, minutes_used, stripe_customer_id")
          .eq("email", email)
          .single();

        if (findErr || !profile) {
          console.error(`[WEBHOOK] User not found for email: ${email}`);
          break;
        }

        // Add purchased minutes to existing balance
        const currentRemaining = Math.max(0, (profile.minutes_limit || 0) - (profile.minutes_used || 0));
        const newLimit = (profile.minutes_used || 0) + currentRemaining + minutes;

        const { error: updateErr } = await supabase
          .from("profiles")
          .update({
            plan:                plan,
            minutes_limit:       newLimit,
            stripe_customer_id:  customerId || profile.stripe_customer_id,
          })
          .eq("id", profile.id);

        if (updateErr) {
          console.error(`[WEBHOOK] Failed to update profile:`, updateErr);
        } else {
          console.log(`[WEBHOOK] ✅ ${email} purchased ${plan} — added ${minutes} min (remaining: ${currentRemaining} → ${currentRemaining + minutes})`);
        }

        // Log the purchase
        await supabase.from("usage_log").insert({
          user_id:            profile.id,
          audio_duration_sec: 0,
          minutes_charged:    0,
          language:           "he",
          model:              "purchase",
          segments_count:     0,
          processing_sec:     0,
          status:             "purchase",
          error_message:      `Purchased ${plan} package: +${minutes} minutes (₪${plan === "pro" ? "59" : "180"})`,
        });

        break;
      }

      // Keep payment_failed for one-time payments too
      case "payment_intent.payment_failed": {
        const paymentIntent = event.data.object as Stripe.PaymentIntent;
        console.log(`[WEBHOOK] Payment failed: ${paymentIntent.id} — ${paymentIntent.last_payment_error?.message}`);
        break;
      }
    }

  } catch (e: any) {
    console.error("Webhook handler error:", e);
  }

  return NextResponse.json({ received: true });
}
