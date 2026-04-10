export const revalidate = 3600;

export async function GET() {
  try {
    const res = await fetch(
      "https://api.github.com/repos/yehudasnow-alt/subai-web/releases/latest",
      { next: { revalidate: 3600 } }
    );
    const data = await res.json();
    const asset = data.assets?.find((a: any) => a.name.endsWith(".exe"));
    
    if (!asset) {
      return new Response("Installer not found", { status: 404 });
    }
    
    return Response.redirect(asset.browser_download_url, 302);
  } catch (e) {
    return new Response("Error fetching release", { status: 500 });
  }
}
