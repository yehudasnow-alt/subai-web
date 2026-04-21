/**
 * SubAI — PayMe Webhook (IPN) + EasyCount Invoice
 * POST /api/webhooks/payme
 * 
 * PayMe sends IPN (Instant Payment Notification) after successful payment.
 * This endpoint:
 * 1. Updates the user's minutes in Supabase
 * 2. Creates an invoice via EasyCount API and sends it to the buyer's email
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const PAYME_API_KEY = process.env.PAYME_API_KEY!;
const EZCOUNT_API_KEY = process.env.EZCOUNT_API_KEY!; // Add to Vercel env vars

// Plan config
const PLANS: Record<string, { minutes: number; priceILS: number; name: string }> = {
  pro:    { minutes: 120, priceILS: 59,  name: "SubAI פרו — 120 דקות תמלול" },
  studio: { minutes: 500, priceILS: 180, name: "SubAI סטודיו — 500 דקות תמלול" },
};

// ══════════════════════════════════════════════════════════════
// EasyCount Invoice
// ══════════════════════════════════════════════════════════════

async function createEasyCountInvoice(params: {
  buyerEmail: string;
  buyerName: string;
  plan: string;
  priceAgora: number; // price in agorot (e.g. 5900 for ₪59)
  transactionId: string;
}) {
  if (!EZCOUNT_API_KEY) {
    console.warn("[EZCOUNT] No API key configured, skipping invoice");
    return null;
  }

  const planInfo = PLANS[params.plan] || PLANS.pro;
  const priceILS = params.priceAgora > 0 ? params.priceAgora / 100 : planInfo.priceILS;

  const invoiceData = {
    api_key: EZCOUNT_API_KEY,
    type: 320,                          // חשבונית מס קבלה
    customer_name: params.buyerName || params.buyerEmail,
    customer_email: params.buyerEmail,
    item: [
      {
        details: planInfo.name,
        amount: "1",
        price: String(priceILS),
        // If you're osek patur (exempt), uncomment the next line:
        // vat_type: "INC",
      }
    ],
    payment: [
      {
        payment_type: 3,                // 3 = credit card
        payment: String(priceILS),
        comment: "PayMe #" + params.transactionId,
      }
    ],
    price_total: String(priceILS),
    comment: "תודה שרכשת SubAI! 🎙️",
    // Send invoice to buyer's email automatically:
    email_to: params.buyerEmail,
    // Transaction ID for dedup:
    transaction_id: params.transactionId,
  };

  try {
    const res = await fetch("https://www.ezcount.co.il/api/createDoc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(invoiceData),
    });

    const result = await res.json();

    if (result.success || result.doc_number) {
      console.log(`[EZCOUNT] ✅ Invoice #${result.doc_number} sent to ${params.buyerEmail}`);
      return {
        success: true,
        doc_number: result.doc_number,
        doc_url: result.doc_url || result.pdf_link || null,
      };
    } else {
      console.error("[EZCOUNT] ❌ Failed:", JSON.stringify(result));
      return { success: false, error: result.errMsg || result.error || "Unknown error" };
    }
  } catch (e: any) {
    console.error("[EZCOUNT] ❌ Network error:", e.message);
    return { success: false, error: e.message };
  }
}

// ══════════════════════════════════════════════════════════════
// PayMe Webhook Handler
// ══════════════════════════════════════════════════════════════

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
    const buyerName = body.buyer_name || body.payer_name || "";
    const saleDescription = body.sale_description || body.description || "";

    // Verify this is from our account
    if (salePaymeId && salePaymeId !== PAYME_API_KEY) {
      console.warn("[PAYME IPN] Wrong seller ID, ignoring");
      return NextResponse.json({ ok: false, error: "Wrong seller" }, { status: 403 });
    }

    // Only process successful payments
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
      minutes = desc.minutes || PLANS[plan]?.minutes || 120;
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

    // ══════════════════════════════════════════════════════════
    // NEW: Create & send invoice via EasyCount
    // ══════════════════════════════════════════════════════════
    let invoiceResult = null;
    try {
      invoiceResult = await createEasyCountInvoice({
        buyerEmail,
        buyerName,
        plan,
        priceAgora: parseInt(salePrice) || 0,
        transactionId: transactionId || `payme_${Date.now()}`,
      });
    } catch (e: any) {
      console.error("[PAYME IPN] Invoice creation failed (non-blocking):", e.message);
      // Don't fail the webhook if invoice fails — payment is already processed
    }

    // Log the payment (with invoice info)
    await logPayment(
      transactionId, plan, minutes, salePrice, buyerEmail, "success", profile.id,
      invoiceResult?.success ? invoiceResult.doc_number : null
    );

    console.log(`[PAYME IPN] ✅ Updated ${buyerEmail}: plan=${plan}, minutes_limit=${newLimit}, invoice=${invoiceResult?.doc_number || 'none'}`);

    return NextResponse.json({ ok: true, message: "Payment processed", invoice: invoiceResult });
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
  userId?: string,
  invoiceNumber?: string | null
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
      invoice_number: invoiceNumber || null,
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
