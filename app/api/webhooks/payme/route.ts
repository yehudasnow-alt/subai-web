/**
 * SubAI — PayMe Webhook (IPN) + EasyCount Invoice + Refund
 * POST /api/webhooks/payme
 * 
 * Handles:
 * 1. Successful payment → update minutes + חשבונית מס קבלה (type 320)
 * 2. Refund → deduct minutes + חשבונית זיכוי (type 330)
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const PAYME_API_KEY = process.env.PAYME_API_KEY!;
const EZCOUNT_API_KEY = process.env.EZCOUNT_API_KEY!;

// Plan config
const PLANS: Record<string, { minutes: number; priceILS: number; name: string }> = {
  pro:    { minutes: 120, priceILS: 59,  name: "SubAI פרו — 120 דקות תמלול" },
  studio: { minutes: 500, priceILS: 180, name: "SubAI סטודיו — 500 דקות תמלול" },
};

// ══════════════════════════════════════════════════════════════
// EasyCount — Create Invoice or Credit Note
// ══════════════════════════════════════════════════════════════

async function createEasyCountDoc(params: {
  type: 320 | 330;            // 320 = חשבונית מס קבלה, 330 = חשבונית זיכוי
  buyerEmail: string;
  buyerName: string;
  plan: string;
  priceILS: number;
  transactionId: string;
  originalInvoiceNumber?: string;  // Required for credit notes
}) {
  if (!EZCOUNT_API_KEY) {
    console.warn("[EZCOUNT] No API key configured, skipping");
    return null;
  }

  const planInfo = PLANS[params.plan] || PLANS.pro;
  const price = params.priceILS > 0 ? params.priceILS : planInfo.priceILS;
  const isRefund = params.type === 330;

  const docData: any = {
    api_key: EZCOUNT_API_KEY,
    type: params.type,
    customer_name: params.buyerName || params.buyerEmail,
    customer_email: params.buyerEmail,
    item: [
      {
        details: isRefund
          ? "זיכוי: " + planInfo.name
          : planInfo.name,
        amount: "1",
        price: String(price),
      }
    ],
    payment: [
      {
        payment_type: 3,                // 3 = credit card
        payment: String(price),
        comment: "PayMe #" + params.transactionId,
      }
    ],
    price_total: String(price),
    comment: isRefund
      ? "זיכוי עבור רכישת SubAI"
      : "תודה שרכשת SubAI!",
    email_to: params.buyerEmail,
    transaction_id: params.transactionId + (isRefund ? "_refund" : ""),
  };

  // Link credit note to original invoice
  if (isRefund && params.originalInvoiceNumber) {
    docData.linked_doc_number = params.originalInvoiceNumber;
  }

  try {
    const res = await fetch("https://www.ezcount.co.il/api/createDoc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(docData),
    });

    const result = await res.json();

    if (result.success || result.doc_number) {
      const docType = isRefund ? "Credit note" : "Invoice";
      console.log(`[EZCOUNT] ${docType} #${result.doc_number} sent to ${params.buyerEmail}`);
      return {
        success: true,
        doc_number: result.doc_number,
        doc_url: result.doc_url || result.pdf_link || null,
      };
    } else {
      console.error("[EZCOUNT] Failed:", JSON.stringify(result));
      return { success: false, error: result.errMsg || result.error || "Unknown error" };
    }
  } catch (e: any) {
    console.error("[EZCOUNT] Network error:", e.message);
    return { success: false, error: e.message };
  }
}

// ══════════════════════════════════════════════════════════════
// Detect if PayMe notification is a refund
// ══════════════════════════════════════════════════════════════

function isRefundNotification(body: any): boolean {
  const status = (body.sale_status || body.status || "").toLowerCase();
  const type = (body.type || body.sale_type || "").toLowerCase();
  const debit = parseFloat(body.debit || body.sale_debit || "0");

  return (
    status === "refund" ||
    status === "refunded" ||
    type === "refund" ||
    body.is_refund === true ||
    body.is_refund === "true" ||
    debit < 0
  );
}

// ══════════════════════════════════════════════════════════════
// PayMe Webhook Handler
// ══════════════════════════════════════════════════════════════

export async function POST(req: NextRequest) {
  try {
    let body: any;
    const contentType = req.headers.get("content-type") || "";
    
    if (contentType.includes("application/json")) {
      body = await req.json();
    } else {
      const text = await req.text();
      body = Object.fromEntries(new URLSearchParams(text));
    }

    console.log("[PAYME IPN] Received:", JSON.stringify(body));

    const saleStatus = body.sale_status || body.status;
    const salePaymeId = body.seller_payme_id || body.payme_id;
    const salePrice = body.sale_price || body.price;
    const transactionId = body.sale_payme_id || body.transaction_id || body.payme_transaction_id;
    const buyerEmail = body.buyer_email || body.payer_email || "";
    const buyerName = body.buyer_name || body.payer_name || "";
    const saleDescription = body.sale_description || body.description || "";
    const originalSaleNumber = body.original_sale_payme_id || body.sale_number || "";

    // Verify seller
    if (salePaymeId && salePaymeId !== PAYME_API_KEY) {
      console.warn("[PAYME IPN] Wrong seller ID, ignoring");
      return NextResponse.json({ ok: false, error: "Wrong seller" }, { status: 403 });
    }

    // ── REFUND FLOW ──────────────────────────────────────────
    if (isRefundNotification(body)) {
      console.log(`[PAYME IPN] Refund detected: email=${buyerEmail}, tx=${transactionId}`);

      if (!buyerEmail) {
        await logPayment(transactionId, "refund", 0, salePrice, "", "refund_no_email");
        return NextResponse.json({ ok: true, message: "Refund noted, no email" });
      }

      // Find user
      const { data: profile } = await supabase
        .from("profiles")
        .select("id, email, plan, minutes_used, minutes_limit")
        .eq("email", buyerEmail)
        .single();

      // Parse plan from description
      let plan = "pro";
      let minutes = 120;
      try {
        const desc = JSON.parse(saleDescription);
        plan = desc.plan || "pro";
        minutes = desc.minutes || PLANS[plan]?.minutes || 120;
      } catch {
        const priceNum = parseInt(salePrice) || 0;
        if (priceNum >= 15000) { plan = "studio"; minutes = 500; }
      }

      // Deduct minutes back
      if (profile) {
        const newLimit = Math.max(0, (profile.minutes_limit || 0) - minutes);
        const newPlan = newLimit <= 10 ? "free" : profile.plan;
        await supabase
          .from("profiles")
          .update({ minutes_limit: newLimit, plan: newPlan })
          .eq("id", profile.id);

        console.log(`[PAYME IPN] Deducted ${minutes} minutes from ${buyerEmail}, new limit: ${newLimit}`);
      }

      // Find original invoice number for the credit note link
      let originalInvoiceNumber: string | undefined;
      if (originalSaleNumber) {
        const { data: origPayment } = await supabase
          .from("payments")
          .select("invoice_number")
          .eq("transaction_id", originalSaleNumber)
          .single();
        if (origPayment?.invoice_number) {
          originalInvoiceNumber = origPayment.invoice_number;
        }
      }

      // Create credit note (חשבונית זיכוי)
      const priceNum = parseInt(salePrice) || 0;
      const priceILS = priceNum > 1000 ? priceNum / 100 : priceNum;

      let creditResult = null;
      try {
        creditResult = await createEasyCountDoc({
          type: 330,
          buyerEmail,
          buyerName,
          plan,
          priceILS,
          transactionId: transactionId || `refund_${Date.now()}`,
          originalInvoiceNumber,
        });
      } catch (e: any) {
        console.error("[PAYME IPN] Credit note failed:", e.message);
      }

      await logPayment(
        transactionId, plan, -minutes, salePrice, buyerEmail, "refund",
        profile?.id, creditResult?.success ? creditResult.doc_number : null
      );

      return NextResponse.json({ ok: true, message: "Refund processed", credit_note: creditResult });
    }

    // ── PURCHASE FLOW ────────────────────────────────────────
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

    // Parse plan
    let plan = "pro";
    let minutes = 120;
    try {
      const desc = JSON.parse(saleDescription);
      plan = desc.plan || "pro";
      minutes = desc.minutes || PLANS[plan]?.minutes || 120;
    } catch {
      const priceNum = parseInt(salePrice) || 0;
      if (priceNum >= 15000) { plan = "studio"; minutes = 500; }
    }

    console.log(`[PAYME IPN] Payment: plan=${plan}, minutes=${minutes}, email=${buyerEmail}, tx=${transactionId}`);

    if (!buyerEmail) {
      await logPayment(transactionId, plan, minutes, salePrice, buyerEmail, "no_email");
      return NextResponse.json({ ok: true, message: "No email, logged" });
    }

    // Find profile
    const { data: profile, error: profileErr } = await supabase
      .from("profiles")
      .select("id, email, plan, minutes_used, minutes_limit")
      .eq("email", buyerEmail)
      .single();

    if (profileErr || !profile) {
      console.error(`[PAYME IPN] Profile not found: ${buyerEmail}`);
      await logPayment(transactionId, plan, minutes, salePrice, buyerEmail, "profile_not_found");
      return NextResponse.json({ ok: true, message: "Profile not found, logged" });
    }

    // Dedup
    const { data: existing } = await supabase
      .from("payments")
      .select("id")
      .eq("transaction_id", transactionId)
      .single();

    if (existing) {
      console.log(`[PAYME IPN] Duplicate ${transactionId}, ignoring`);
      return NextResponse.json({ ok: true, message: "Already processed" });
    }

    // Update minutes
    const newLimit = (profile.minutes_limit || 0) + minutes;
    const { error: updateErr } = await supabase
      .from("profiles")
      .update({ plan, minutes_limit: newLimit, subscription_status: "active" })
      .eq("id", profile.id);

    if (updateErr) {
      console.error("[PAYME IPN] Update failed:", updateErr);
      await logPayment(transactionId, plan, minutes, salePrice, buyerEmail, "update_failed");
      return NextResponse.json({ ok: false, error: "Update failed" }, { status: 500 });
    }

    // Create invoice (חשבונית מס קבלה)
    const priceNum = parseInt(salePrice) || 0;
    const priceILS = priceNum > 1000 ? priceNum / 100 : priceNum;

    let invoiceResult = null;
    try {
      invoiceResult = await createEasyCountDoc({
        type: 320,
        buyerEmail,
        buyerName,
        plan,
        priceILS,
        transactionId: transactionId || `payme_${Date.now()}`,
      });
    } catch (e: any) {
      console.error("[PAYME IPN] Invoice failed (non-blocking):", e.message);
    }

    await logPayment(
      transactionId, plan, minutes, salePrice, buyerEmail, "success",
      profile.id, invoiceResult?.success ? invoiceResult.doc_number : null
    );

    console.log(`[PAYME IPN] Done: ${buyerEmail}, plan=${plan}, limit=${newLimit}, invoice=${invoiceResult?.doc_number || 'none'}`);

    return NextResponse.json({ ok: true, message: "Payment processed", invoice: invoiceResult });
  } catch (e: any) {
    console.error("[PAYME IPN] Error:", e.message);
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}

// ══════════════════════════════════════════════════════════════
// Audit Log
// ══════════════════════════════════════════════════════════════

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
    console.error("[PAYME IPN] Log failed:", e.message);
  }
}

export async function GET() {
  return NextResponse.json({ ok: true, message: "PayMe webhook endpoint" });
}
