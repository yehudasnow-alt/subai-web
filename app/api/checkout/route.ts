/**
 * SubAI — Stripe Checkout (FIXED)
 * POST /api/checkout
 * Handles both price IDs and product IDs
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";

export const maxDuration = 15;

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: "2024-04-10" });
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function getPriceId(idOrPrice: string): Promise<string | null> {
  if (!idOrPrice) return null;

  // Already a price ID
  if (idOrPrice.startsWith("price_")) return idOrPrice;

  // It's a product ID — look up the first recurring price
  if (idOrPrice.startsWith("prod_")) {
    try {
      const prices = await stripe.prices.list({ product: idOrPrice, active: true, type: "recurring", limit: 1 });
      if (prices.data.length > 0) return prices.data[0].id;
    } catch (e) {
      console.error("Price lookup error:", e);
    }
  }

  return null;
}

export async function POST(req: NextRequest) {
  try {
    const { plan, period, userId, email } = await req.json();

    if (!plan || !email) {
      return NextResponse.json({ error: "Missing plan or email" }, { status: 400 });
    }

    // Get the configured ID (could be price_ or prod_)
    let configuredId: string | null = null;
    if (plan === "pro") {
      configuredId = period === "yearly"
        ? (process.env.STRIPE_PRICE_PRO_YEARLY || process.env.STRIPE_PRICE_PRO_MONTHLY || null)
        : (process.env.STRIPE_PRICE_PRO_MONTHLY || null);
    } else if (plan === "studio") {
      configuredId = period === "yearly"
        ? (process.env.STRIPE_PRICE_STUDIO_YEARLY || process.env.STRIPE_PRICE_STUDIO_MONTHLY || null)
        : (process.env.STRIPE_PRICE_STUDIO_MONTHLY || null);
    }

    if (!configuredId) {
      return NextResponse.json({ error: "Plan not configured. Contact support." }, { status: 400 });
    }

    // Resolve to actual price ID
    const priceId = await getPriceId(configuredId);
    if (!priceId) {
      return NextResponse.json({ error: "Price not found for this plan. Contact support." }, { status: 400 });
    }

    // Check if user already has a Stripe customer
    const { data: profile } = await supabase
      .from("profiles")
      .select("stripe_customer_id")
      .eq("id", userId)
      .single();

    let customerId = profile?.stripe_customer_id;

    if (!customerId) {
      const customer = await stripe.customers.create({ email, metadata: { supabase_id: userId } });
      customerId = customer.id;
      await supabase.from("profiles").update({ stripe_customer_id: customerId }).eq("id", userId);
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${req.nextUrl.origin}/dashboard?upgraded=true`,
      cancel_url: `${req.nextUrl.origin}/dashboard`,
      metadata: { supabase_id: userId },
      subscription_data: { metadata: { supabase_id: userId } },
      allow_promotion_codes: true,
    });

    return NextResponse.json({ url: session.url });
  } catch (e: any) {
    console.error("Checkout error:", e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
