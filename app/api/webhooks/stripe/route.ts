/**
 * SubAI — Stripe Webhook Handler
 * POST /api/webhooks/stripe
 *
 * Handles: subscription created, updated, deleted, payment failed
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: "2024-04-10" });
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET!;
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const PLAN_MAP: Record<string, { plan: string; minutes: number }> = {
  // Replace with your actual Stripe price IDs
  "price_pro_monthly":    { plan: "pro",    minutes: 120 },
  "price_pro_yearly":     { plan: "pro",    minutes: 120 },
  "price_studio_monthly": { plan: "studio", minutes: 500 },
  "price_studio_yearly":  { plan: "studio", minutes: 500 },
};

export async function POST(req: NextRequest) {
  const body = await req.text();
  const sig = req.headers.get("stripe-signature");

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
        const customerId = session.customer as string;
        const email = session.customer_email || session.customer_details?.email;

        if (email) {
          // Link Stripe customer to Supabase user
          await supabase
            .from("profiles")
            .update({ stripe_customer_id: customerId })
            .eq("email", email);
        }
        break;
      }

      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const sub = event.data.object as Stripe.Subscription;
        const customerId = sub.customer as string;
        const priceId = sub.items.data[0]?.price?.id;
        const planInfo = PLAN_MAP[priceId] || { plan: "pro", minutes: 120 };

        await supabase
          .from("profiles")
          .update({
            plan: planInfo.plan,
            minutes_limit: planInfo.minutes,
            subscription_status: sub.status === "active" ? "active" : sub.status,
            stripe_subscription_id: sub.id,
            period_end: new Date(sub.current_period_end * 1000).toISOString(),
          })
          .eq("stripe_customer_id", customerId);
        break;
      }

      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const customerId = sub.customer as string;

        // Keep access until period_end, then downgrade
        await supabase
          .from("profiles")
          .update({
            subscription_status: "canceled",
            period_end: new Date(sub.current_period_end * 1000).toISOString(),
          })
          .eq("stripe_customer_id", customerId);
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        const customerId = invoice.customer as string;

        await supabase
          .from("profiles")
          .update({ subscription_status: "past_due" })
          .eq("stripe_customer_id", customerId);
        break;
      }
    }
  } catch (e: any) {
    console.error("Webhook handler error:", e);
  }

  return NextResponse.json({ received: true });
}
