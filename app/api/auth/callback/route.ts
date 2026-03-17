import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");

  if (code) {
    const supabase = createServerClient();
    // Exchange code is handled client-side by Supabase SDK
  }

  return NextResponse.redirect(new URL("/dashboard", req.url));
}
