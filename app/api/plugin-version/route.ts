import { NextResponse } from "next/server";

const CURRENT_VERSION = "4.3.0";

export async function GET() {
  return NextResponse.json({
    version: CURRENT_VERSION,
    changelog: "v4.3.0 — Fix: poll check_job for v11 async transcribe pipeline (resolves 'לא נמצא דיבור בקטע')",
  });
}
