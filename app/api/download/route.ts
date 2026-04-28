export const revalidate = 3600;

export async function GET() {
  try {
    const headers: Record<string, string> = {
      "Accept": "application/vnd.github+json",
      "User-Agent": "SubAI-Web",
    };

    // Required for private repos
    if (process.env.GITHUB_TOKEN) {
      headers["Authorization"] = `Bearer ${process.env.GITHUB_TOKEN}`;
    }

    const res = await fetch(
      "https://api.github.com/repos/yehudasnow-alt/subai-web/releases/latest",
      { headers, next: { revalidate: 3600 } }
    );

    if (!res.ok) {
      console.error(`[DOWNLOAD] GitHub API error: ${res.status} ${res.statusText}`);
      return new Response("Download temporarily unavailable", { status: 502 });
    }

    const data = await res.json();
    const asset = data.assets?.find((a: any) => a.name.endsWith(".exe"));
    
    if (!asset) {
      console.error("[DOWNLOAD] No .exe found in release:", data.tag_name);
      return new Response("Installer not found", { status: 404 });
    }

    // For private repos, browser_download_url needs auth.
    // Fetch the binary and serve it directly.
    if (process.env.GITHUB_TOKEN) {
      const fileRes = await fetch(asset.url, {
        headers: {
          "Accept": "application/octet-stream",
          "Authorization": `Bearer ${process.env.GITHUB_TOKEN}`,
          "User-Agent": "SubAI-Web",
        },
      });

      if (!fileRes.ok) {
        return new Response("Download failed", { status: 502 });
      }

      return new Response(fileRes.body, {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename="${asset.name}"`,
          "Content-Length": String(asset.size),
          "Cache-Control": "public, max-age=3600",
        },
      });
    }

    // Public repo fallback: redirect directly
    return Response.redirect(asset.browser_download_url, 302);
  } catch (e: any) {
    console.error("[DOWNLOAD] Error:", e.message);
    return new Response("Error fetching release", { status: 500 });
  }
}
