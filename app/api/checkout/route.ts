/**
 * SubAI — Checkout Route
 * GET /api/checkout?plan=pro|studio
 * Redirects to Stripe Checkout — one-time payment for minute packages
 */
import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: "2023-10-16" as any });
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const PRICES: Record<string, string> = {
  pro:    process.env.STRIPE_PRICE_PRO    || "",
  studio: process.env.STRIPE_PRICE_STUDIO || "",
};

const PLAN_MINUTES: Record<string, number> = {
  pro:    120,
  studio: 500,
};

export async function GET(req: NextRequest) {
  try {
    const plan = req.nextUrl.searchParams.get("plan");
    if (!plan || !PRICES[plan]) {
      return NextResponse.redirect(new URL("/#pricing", req.url));
    }

    let priceId = PRICES[plan];

    // If someone put a product ID (prod_...) instead of price ID, resolve it
    if (priceId.startsWith("prod_")) {
      const prices = await stripe.prices.list({ product: priceId, active: true, limit: 1 });
      if (prices.data.length > 0) {
        priceId = prices.data[0].id;
      } else {
        return NextResponse.redirect(new URL("/#pricing", req.url));
      }
    }

    // Create Stripe checkout session — ONE-TIME payment
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${req.nextUrl.origin}/dashboard?purchased=true`,
      cancel_url:  `${req.nextUrl.origin}/#pricing`,
      metadata: {
        plan,
        minutes: String(PLAN_MINUTES[plan] || 0),
      },
      allow_promotion_codes: true,
    });

    if (session.url) {
      return NextResponse.redirect(session.url);
    }
    return NextResponse.redirect(new URL("/#pricing", req.url));

  } catch (e: any) {
    console.error("Checkout error:", e.message);
    return NextResponse.redirect(new URL("/#pricing", req.url));
  }
}
