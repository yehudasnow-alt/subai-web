import { NextResponse } from "next/server";

const CURRENT_VERSION = "4.0.0";

export async function GET() {
  return NextResponse.json({
    version: CURRENT_VERSION,
    changelog: "Auto-update via server, minute packages, SRT to project folder",
  });
}
