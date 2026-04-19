/**
 * SubAI — Checkout Route (PayMe)
 * GET /api/checkout?plan=pro|studio
 * Creates a PayMe sale and redirects to PayMe hosted payment page
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const PAYME_API_KEY = process.env.PAYME_API_KEY!;
const PAYME_API_URL = "https://ng.payme.io/api/generate-sale";

// Plan config — prices in agorot (1 ILS = 100 agorot)
const PLANS: Record<string, { name: string; price: number; minutes: number }> = {
  pro: {
    name: "SubAI פרו — 120 דקות תמלול",
    price: 5900,   // ₪59.00 in agorot
    minutes: 120,
  },
  studio: {
    name: "SubAI סטודיו — 500 דקות תמלול",
    price: 18000,  // ₪180.00 in agorot
    minutes: 500,
  },
};

export async function GET(req: NextRequest) {
  try {
    const plan = req.nextUrl.searchParams.get("plan");
    if (!plan || !PLANS[plan]) {
      return NextResponse.redirect(new URL("/#pricing", req.url));
    }

    const planConfig = PLANS[plan];
    const origin = req.nextUrl.origin;

    // Create PayMe sale via API
    const response = await fetch(PAYME_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        seller_payme_id: PAYME_API_KEY,
        sale_price: planConfig.price,       // in agorot
        currency: "ILS",
        product_name: planConfig.name,
        sale_callback_url: `${origin}/api/webhooks/payme`,  // IPN callback
        sale_return_url: `${origin}/dashboard?purchased=true`,
        sale_cancel_url: `${origin}/#pricing`,
        language: "he",
        // Pass plan info in the sale for the webhook to use
        sale_send_notification: true,
        json: true,
        // Custom field to identify the plan in webhook
        sale_description: JSON.stringify({ plan, minutes: planConfig.minutes }),
      }),
    });

    const data = await response.json();

    if (data.status_code === 0 && data.sale_url) {
      // Success — redirect customer to PayMe payment page
      return NextResponse.redirect(data.sale_url);
    }

    // PayMe returned an error
    console.error("PayMe error:", JSON.stringify(data));
    return NextResponse.redirect(new URL("/#pricing", req.url));
  } catch (e: any) {
    console.error("Checkout error:", e.message);
    return NextResponse.redirect(new URL("/#pricing", req.url));
  }
}
