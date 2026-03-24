import { NextResponse } from "next/server";

const CURRENT_VERSION = "3.2.0";

export async function GET() {
  return NextResponse.json({
    version: CURRENT_VERSION,
    download_url: "/SubAI_Setup.exe",
    changelog: "Word split 1-6, improved AI correction, dark readable dropdowns",
  });
}
