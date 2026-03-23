"use client";
import { useState, useEffect } from "react";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export default function Dashboard() {
  const [user, setUser] = useState<any>(null);
  const [profile, setProfile] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Handle plugin session from Google OAuth redirect
    const params = new URLSearchParams(window.location.search);
    const ps = params.get("plugin_session");

    supabase.auth.getUser().then(async ({ data }) => {
      if (!data.user) { window.location.href = "/auth"; return; }
      setUser(data.user);

      if (ps) {
        await fetch("/api/auth/plugin-session", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "store", session_id: ps, user_id: data.user.id }),
        });
        window.history.replaceState({}, "", "/dashboard");
      }

      const { data: p } = await supabase.from("profiles").select("*").eq("id", data.user.id).single();
      setProfile(p);
      setLoading(false);
    });
  }, []);

  async function handleLogout() {
    await supabase.auth.signOut();
    window.location.href = "/";
  }

  if (loading) return (
    <div style={{ background: "#06060e", color: "#e8e8f0", minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Rubik', sans-serif" }}>
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 32, marginBottom: 12 }}>⏳</div>
        <div style={{ color: "#666" }}>טוען...</div>
      </div>
    </div>
  );

  const planNames: Record<string, string> = { free: "חינמי", pro: "פרו ⭐", studio: "סטודיו 💎" };
  const used = profile?.minutes_used || 0;
  const limit = profile?.minutes_limit || 10;
  const remaining = Math.max(0, limit - used);
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;

  return (
    <div style={{ background: "#06060e", color: "#e8e8f0", minHeight: "100vh", fontFamily: "'Rubik', 'Segoe UI', sans-serif", direction: "rtl" }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Rubik:wght@400;500;600;700;800;900&display=swap');`}</style>

      {/* Nav */}
      <nav style={{ padding: "16px 32px", display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
        <a href="/" style={{ display: "flex", alignItems: "center", gap: 10, textDecoration: "none" }}>
          <div style={{ width: 32, height: 32, borderRadius: 9, background: "linear-gradient(135deg,#3b82f6,#818cf8)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, fontWeight: 900, color: "#fff" }}>S</div>
          <span style={{ fontSize: 18, fontWeight: 800, color: "#e8e8f0" }}>Sub<span style={{ color: "#818cf8" }}>AI</span></span>
        </a>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <span style={{ fontSize: 13, color: "#888" }}>{user?.email}</span>
          <button onClick={handleLogout} style={{ background: "none", border: "1px solid rgba(255,255,255,0.1)", color: "#888", padding: "6px 16px", borderRadius: 8, cursor: "pointer", fontSize: 12, fontFamily: "'Rubik', sans-serif" }}>התנתק</button>
        </div>
      </nav>

      {/* Content */}
      <div style={{ maxWidth: 700, margin: "0 auto", padding: "40px 24px" }}>
        <h1 style={{ fontSize: 28, fontWeight: 900, marginBottom: 32 }}>שלום, {user?.user_metadata?.full_name || user?.email?.split("@")[0]} 👋</h1>

        {/* Plan Card */}
        <div style={{ background: "linear-gradient(135deg, rgba(59,130,246,0.08), rgba(99,102,241,0.04))", border: "1px solid rgba(99,102,241,0.2)", borderRadius: 20, padding: 28, marginBottom: 20 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
            <div>
              <div style={{ fontSize: 13, color: "#818cf8", fontWeight: 600, marginBottom: 4 }}>התוכנית שלך</div>
              <div style={{ fontSize: 28, fontWeight: 900 }}>{planNames[profile?.plan] || "חינמי"}</div>
            </div>
            <div style={{ textAlign: "left" }}>
              <div style={{ fontSize: 13, color: "#666", marginBottom: 4 }}>נותרו</div>
              <div style={{ fontSize: 28, fontWeight: 900, color: "#34d399" }}>{remaining.toFixed(0)} דק׳</div>
            </div>
          </div>
          {/* Usage bar */}
          <div style={{ height: 8, background: "rgba(255,255,255,0.06)", borderRadius: 4, overflow: "hidden", marginBottom: 8 }}>
            <div style={{ height: "100%", width: pct + "%", background: pct > 80 ? "linear-gradient(90deg,#f59e0b,#ef4444)" : "linear-gradient(90deg,#3b82f6,#34d399)", borderRadius: 4, transition: "width 0.5s" }} />
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#666" }}>
            <span>{used.toFixed(1)} דקות נוצלו</span>
            <span>{limit} דקות סה״כ</span>
          </div>
        </div>

        {/* Actions Grid */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 20 }}>
          {/* Download Plugin */}
          <a href="/SubAI_Setup.exe" style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 16, padding: 24, textDecoration: "none", color: "#e8e8f0", transition: "border-color 0.2s", display: "block" }}>
            <div style={{ fontSize: 24, marginBottom: 10 }}>⬇️</div>
            <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>הורד פלאגין</div>
            <div style={{ fontSize: 12, color: "#666" }}>Premiere Pro Plugin</div>
          </a>
          {/* Upgrade */}
          {profile?.plan === "free" && (
            <a href="#upgrade" style={{ background: "linear-gradient(135deg, rgba(59,130,246,0.1), rgba(99,102,241,0.05))", border: "1px solid rgba(99,102,241,0.2)", borderRadius: 16, padding: 24, textDecoration: "none", color: "#e8e8f0", display: "block" }}>
              <div style={{ fontSize: 24, marginBottom: 10 }}>⭐</div>
              <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>שדרג לפרו</div>
              <div style={{ fontSize: 12, color: "#818cf8" }}>₪39/חודש — 120 דקות</div>
            </a>
          )}
          {profile?.plan !== "free" && (
            <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 16, padding: 24 }}>
              <div style={{ fontSize: 24, marginBottom: 10 }}>📋</div>
              <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>ניהול מנוי</div>
              <div style={{ fontSize: 12, color: "#666" }}>חידוש: {profile?.current_period_end ? new Date(profile.current_period_end).toLocaleDateString("he-IL") : "—"}</div>
            </div>
          )}
        </div>

        {/* API Key */}
        <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 16, padding: 24, marginBottom: 20 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#888", marginBottom: 10 }}>🔑 API Key</div>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <code style={{ flex: 1, background: "rgba(0,0,0,0.3)", padding: "10px 14px", borderRadius: 8, fontSize: 12, color: "#818cf8", fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", direction: "ltr" }}>{profile?.api_key || "—"}</code>
            <button onClick={() => { navigator.clipboard.writeText(profile?.api_key || ""); }} style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", color: "#aaa", padding: "10px 16px", borderRadius: 8, cursor: "pointer", fontSize: 12, fontFamily: "'Rubik', sans-serif", whiteSpace: "nowrap" }}>העתק</button>
          </div>
          <p style={{ fontSize: 11, color: "#444", marginTop: 8 }}>משמש לחיבור הפלאגין — בד״כ אוטומטי דרך Google Login</p>
        </div>

        {/* Quick guide */}
        <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 16, padding: 24 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#888", marginBottom: 14 }}>🚀 איך להתחיל</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {[
              "הורד והתקן את הפלאגין (כפתור למעלה)",
              "פתח Premiere Pro → Window → Extensions → SubAI",
              "התחבר עם Google בפלאגין",
              "סמן In/Out על הקטע → תמלל עם AI"
            ].map((step, i) => (
              <div key={i} style={{ display: "flex", gap: 10, fontSize: 13, color: "#aaa" }}>
                <span style={{ width: 22, height: 22, borderRadius: 6, background: "rgba(99,102,241,0.1)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: "#818cf8", flexShrink: 0 }}>{i + 1}</span>
                {step}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
