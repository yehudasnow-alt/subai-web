import Stripe from "stripe";

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2024-04-10",
});

export const PLANS = {
  free:   { name: "חינמי",   minutes: 30,  priceMonthly: null, priceYearly: null },
  pro:    { name: "פרו",     minutes: 120, priceMonthly: process.env.STRIPE_PRICE_PRO_MONTHLY, priceYearly: process.env.STRIPE_PRICE_PRO_YEARLY },
  studio: { name: "סטודיו",  minutes: 500, priceMonthly: process.env.STRIPE_PRICE_STUDIO_MONTHLY, priceYearly: process.env.STRIPE_PRICE_STUDIO_YEARLY },
} as const;

export const PRICE_TO_PLAN: Record<string, { plan: string; minutes: number }> = {};

// Build reverse lookup at runtime
if (process.env.STRIPE_PRICE_PRO_MONTHLY)    PRICE_TO_PLAN[process.env.STRIPE_PRICE_PRO_MONTHLY]    = { plan: "pro", minutes: 120 };
if (process.env.STRIPE_PRICE_PRO_YEARLY)     PRICE_TO_PLAN[process.env.STRIPE_PRICE_PRO_YEARLY]     = { plan: "pro", minutes: 120 };
if (process.env.STRIPE_PRICE_STUDIO_MONTHLY) PRICE_TO_PLAN[process.env.STRIPE_PRICE_STUDIO_MONTHLY] = { plan: "studio", minutes: 500 };
if (process.env.STRIPE_PRICE_STUDIO_YEARLY)  PRICE_TO_PLAN[process.env.STRIPE_PRICE_STUDIO_YEARLY]  = { plan: "studio", minutes: 500 };
