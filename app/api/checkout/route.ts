import { NextRequest, NextResponse } from "next/server";
import { stripe, PLANS } from "@/lib/stripe";
import { createServerClient } from "@/lib/supabase";

export async function POST(req: NextRequest) {
  try {
    const { plan, period, userId, email } = await req.json();

    if (!plan || !period || !email) {
      return NextResponse.json({ error: "Missing plan, period, or email" }, { status: 400 });
    }

    const planInfo = PLANS[plan as keyof typeof PLANS];
    if (!planInfo) {
      return NextResponse.json({ error: "Invalid plan" }, { status: 400 });
    }

    const priceId = period === "yearly" ? planInfo.priceYearly : planInfo.priceMonthly;
    if (!priceId) {
      return NextResponse.json({ error: "Price not configured" }, { status: 400 });
    }

    // Check if user already has a Stripe customer
    const supabase = createServerClient();
    const { data: profile } = await supabase
      .from("profiles")
      .select("stripe_customer_id")
      .eq("id", userId)
      .single();

    let customerId = profile?.stripe_customer_id;

    if (!customerId) {
      // Create new Stripe customer
      const customer = await stripe.customers.create({ email, metadata: { supabase_id: userId } });
      customerId = customer.id;
      await supabase.from("profiles").update({ stripe_customer_id: customerId }).eq("id", userId);
    }

    // Create checkout session
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
