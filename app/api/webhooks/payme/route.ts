/**
 * SubAI — PayMe Webhook (IPN)
 * POST /api/webhooks/payme
 * 
 * PayMe sends IPN (Instant Payment Notification) after successful payment.
 * This endpoint receives the notification and updates the user's minutes.
 * 
 * PayMe IPN is sent as POST with application/x-www-form-urlencoded
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const PAYME_API_KEY = process.env.PAYME_API_KEY!;

// Plan minutes mapping
const PLAN_MINUTES: Record<string, number> = {
  pro: 120,
  studio: 500,
};

export async function POST(req: NextRequest) {
  try {
    // PayMe sends IPN as form-urlencoded or JSON
    let body: any;
    const contentType = req.headers.get("content-type") || "";
    
    if (contentType.includes("application/json")) {
      body = await req.json();
    } else {
      // x-www-form-urlencoded
      const text = await req.text();
      body = Object.fromEntries(new URLSearchParams(text));
    }

    console.log("[PAYME IPN] Received:", JSON.stringify(body));

    // Validate the notification
    const saleStatus = body.sale_status || body.status;
    const salePaymeId = body.seller_payme_id || body.payme_id;
    const salePrice = body.sale_price || body.price;
    const transactionId = body.sale_payme_id || body.transaction_id || body.payme_transaction_id;
    const buyerEmail = body.buyer_email || body.payer_email || "";
    const saleDescription = body.sale_description || body.description || "";

    // Verify this is from our account
    if (salePaymeId && salePaymeId !== PAYME_API_KEY) {
      console.warn("[PAYME IPN] Wrong seller ID, ignoring");
      return NextResponse.json({ ok: false, error: "Wrong seller" }, { status: 403 });
    }

    // Only process successful payments
    // PayMe status codes: "success" or status_code 0 = successful
    const isSuccess = 
      saleStatus === "success" || 
      saleStatus === "completed" || 
      body.status_code === "0" || 
      body.status_code === 0 ||
      body.sale_paid === "true" ||
      body.sale_paid === true;

    if (!isSuccess) {
      console.log(`[PAYME IPN] Sale not successful (status: ${saleStatus}), ignoring`);
      return NextResponse.json({ ok: true, message: "Noted, not successful" });
    }

    // Parse plan info from sale_description
    let plan = "pro";
    let minutes = 120;
    
    try {
      const desc = JSON.parse(saleDescription);
      plan = desc.plan || "pro";
      minutes = desc.minutes || PLAN_MINUTES[plan] || 120;
    } catch {
      // Fallback: determine plan from price
      const priceNum = parseInt(salePrice) || 0;
      if (priceNum >= 15000) {
        plan = "studio";
        minutes = 500;
      } else {
        plan = "pro";
        minutes = 120;
      }
    }

    console.log(`[PAYME IPN] Successful payment: plan=${plan}, minutes=${minutes}, email=${buyerEmail}, tx=${transactionId}`);

    // Find user by email
    if (!buyerEmail) {
      console.error("[PAYME IPN] No buyer email in notification");
      // Log the payment anyway for manual processing
      await logPayment(transactionId, plan, minutes, salePrice, buyerEmail, "no_email");
      return NextResponse.json({ ok: true, message: "No email, logged for manual processing" });
    }

    // Find the user's profile
    const { data: profile, error: profileErr } = await supabase
      .from("profiles")
      .select("id, email, plan, minutes_used, minutes_limit")
      .eq("email", buyerEmail)
      .single();

    if (profileErr || !profile) {
      console.error(`[PAYME IPN] Profile not found for email: ${buyerEmail}`);
      await logPayment(transactionId, plan, minutes, salePrice, buyerEmail, "profile_not_found");
      return NextResponse.json({ ok: true, message: "Profile not found, logged" });
    }

    // Check for duplicate transaction
    const { data: existing } = await supabase
      .from("payments")
      .select("id")
      .eq("transaction_id", transactionId)
      .single();

    if (existing) {
      console.log(`[PAYME IPN] Duplicate transaction ${transactionId}, ignoring`);
      return NextResponse.json({ ok: true, message: "Already processed" });
    }

    // Update user's plan and minutes
    const newLimit = (profile.minutes_limit || 0) + minutes;
    const { error: updateErr } = await supabase
      .from("profiles")
      .update({
        plan: plan,
        minutes_limit: newLimit,
        subscription_status: "active",
      })
      .eq("id", profile.id);

    if (updateErr) {
      console.error("[PAYME IPN] Failed to update profile:", updateErr);
      await logPayment(transactionId, plan, minutes, salePrice, buyerEmail, "update_failed");
      return NextResponse.json({ ok: false, error: "Update failed" }, { status: 500 });
    }

    // Log the payment
    await logPayment(transactionId, plan, minutes, salePrice, buyerEmail, "success", profile.id);

    console.log(`[PAYME IPN] ✅ Updated ${buyerEmail}: plan=${plan}, minutes_limit=${newLimit}`);

    return NextResponse.json({ ok: true, message: "Payment processed" });
  } catch (e: any) {
    console.error("[PAYME IPN] Error:", e.message);
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}

// Log payment for audit trail
async function logPayment(
  transactionId: string,
  plan: string,
  minutes: number,
  amount: string,
  email: string,
  status: string,
  userId?: string
) {
  try {
    await supabase.from("payments").insert({
      transaction_id: transactionId || `payme_${Date.now()}`,
      provider: "payme",
      plan,
      minutes_added: minutes,
      amount: parseInt(amount) || 0,
      currency: "ILS",
      email,
      user_id: userId || null,
      status,
      created_at: new Date().toISOString(),
    });
  } catch (e: any) {
    console.error("[PAYME IPN] Failed to log payment:", e.message);
  }
}

// Also handle GET for PayMe return URL verification
export async function GET(req: NextRequest) {
  return NextResponse.json({ ok: true, message: "PayMe webhook endpoint" });
}
