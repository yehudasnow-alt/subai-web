import { NextResponse } from "next/server";
const CURRENT_VERSION = "3.4.0";
export async function GET() {
  return NextResponse.json({ version: CURRENT_VERSION, download_url: "/SubAI_Setup.exe" });
}
