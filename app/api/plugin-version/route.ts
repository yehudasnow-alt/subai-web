import { NextResponse } from "next/server";

const CURRENT_VERSION = "5.0.0";

export async function GET() {
  return NextResponse.json({
    version: CURRENT_VERSION,
    changelog: "v5.0.0 — Personal edition: Premiere → Modal relay → Whisper. No login, no AWS/Supabase/Vercel, no AI correction.",
  });
}
