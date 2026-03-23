/**
 * SubAI — Plugin Version Check
 * GET /api/plugin-version
 * Returns current plugin version for auto-update
 */

import { NextResponse } from "next/server";

const CURRENT_VERSION = "3.0.0";

export async function GET() {
  return NextResponse.json({
    version: CURRENT_VERSION,
    download_url: "/SubAI_Plugin.zip",
    changelog: "Liquid Glass UI, Google login, TikTok captions mode",
  });
}
