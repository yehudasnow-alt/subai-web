/**
 * SubAI — Plugin Files Server (for auto-update)
 * GET /api/plugin-files?file=index.html
 * GET /api/plugin-files?file=host.jsx
 * 
 * Serves the latest plugin files from public/plugin-update/.
 * The plugin downloads these to overwrite its own files.
 */

import { NextRequest, NextResponse } from "next/server";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const ALLOWED_FILES: Record<string, string> = {
  "index.html": "text/html",
  "host.jsx": "application/javascript",
};

export async function GET(req: NextRequest) {
  const file = req.nextUrl.searchParams.get("file");
  
  if (!file || !ALLOWED_FILES[file]) {
    return NextResponse.json({ error: "Invalid file" }, { status: 400 });
  }

  const filePath = join(process.cwd(), "public", "plugin-update", file);
  
  if (!existsSync(filePath)) {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }

  try {
    const content = readFileSync(filePath, "utf-8");
    return new NextResponse(content, {
      headers: {
        "Content-Type": ALLOWED_FILES[file] + "; charset=utf-8",
        "Cache-Control": "no-cache, no-store, must-revalidate",
      },
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
