"use client";
import { useState, useEffect } from "react";
import { createClient } from "@supabase/supabase-js";
import Link from "next/link";

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);

export default function Dashboard() {
  const [user, setUser] = useState<any>(null);
  const [profile, setProfile] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const ps = params.get("plugin_session");

    supabase.auth.getUser().then(async ({ data }) => {
      if (!data.user) { window.location.href = "/auth"; return; }
      setUser(data.user);
      if (ps) {
        await fetch("/api/auth/plugin-session", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "store", session_id: ps, user_id: data.user.id }) });
        window.history.replaceState({}, "", "/dashboard");
      }
      const { data: p } = await supabase.from("profiles").select("*").eq("id", data.user.id).single();
      setProfile(p); setLoading(false);
    });
  }, []);

  async function handleLogout() { await supabase.auth.signOut(); window.location.href = "/"; }

  if (loading) return (
    <div className="page-wrap">
      <div className="mesh-bg"><div className="blob b1" /><div className="blob b2" /></div>
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", position: "relative", zIndex: 1 }}>
        <div className="glass-card" style={{ padding: 40, textAlign: "center" }}>
          <div style={{ fontSize: 28, marginBottom: 12 }}>⏳</div>
          <div style={{ color: "#888" }}>טוען...</div>
        </div>
      </div>
    </div>
  );

  const plans: Record<string, string> = { free: "חינמי", pro: "פרו ⭐", studio: "סטודיו 💎" };
  const used = profile?.minutes_used || 0;
  const limit = profile?.minutes_limit || 10;
  const remaining = Math.max(0, limit - used);
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  const displayName = user?.user_metadata?.full_name || user?.user_metadata?.name || user?.email?.split("@")[0] || "";
  const initials = displayName ? displayName.charAt(0).toUpperCase() : "U";

  return (
    <div className="page-wrap">
      <div className="mesh-bg"><div className="blob b1" /><div className="blob b2" /><div className="blob b3" /></div>
      <div className="dash-wrap">
        {/* Nav */}
        <nav className="dash-nav">
          <Link href="/" className="nav-logo">
            <div className="logo-icon" style={{ width: 30, height: 30, fontSize: 14, borderRadius: 8 }}>S</div>
            <span className="logo-text" style={{ fontSize: 17 }}>Sub<span>AI</span></span>
          </Link>
          <div className="dash-user">
            <div>
              <div className="dash-name">{displayName}</div>
              <div className="dash-email">{user?.email}</div>
            </div>
            <div className="dash-avatar">{initials}</div>
          </div>
        </nav>

        <div className="dash-content">
          <h1 className="dash-h1">שלום, {displayName} 👋</h1>

          {/* Plan & Usage */}
          <div className="plan-card glass-card" style={{ borderRadius: 24 }}>
            <div className="plan-row">
              <div>
                <div className="plan-label">התוכנית שלך</div>
                <div className="plan-val">{plans[profile?.plan] || "חינמי"}</div>
              </div>
              <div style={{ textAlign: "left" }}>
                <div className="plan-label">דקות נותרות</div>
                <div className="plan-val green">{remaining.toFixed(0)}</div>
              </div>
            </div>
            <div className="usage-track">
              <div className={`usage-fill ${pct > 80 ? "warn" : "ok"}`} style={{ width: pct + "%" }} />
            </div>
            <div className="usage-meta">
              <span>{used.toFixed(1)} נוצלו</span>
              <span>{limit} סה״כ</span>
            </div>
          </div>

          {/* Action Cards */}
          <div className="action-grid">
            <a href="/SubAI_Setup.exe" className="action-card glass-card" style={{ borderRadius: 20, textDecoration: "none" }}>
              <div className="ac-icon">⬇️</div>
              <div className="ac-title">הורד פלאגין</div>
              <div className="ac-desc">התקנה ל-Adobe Premiere Pro</div>
            </a>
            {profile?.plan === "free" ? (
              <Link href="/#pricing" className="action-card glass-card" style={{ borderRadius: 20, textDecoration: "none", borderColor: "rgba(99,102,241,0.2)", background: "rgba(99,102,241,0.04)" }}>
                <div className="ac-icon">⭐</div>
                <div className="ac-title">שדרג לפרו</div>
                <div className="ac-desc" style={{ color: "#6366f1" }}>₪39/חודש — 120 דקות</div>
              </Link>
            ) : (
              <div className="action-card glass-card" style={{ borderRadius: 20 }}>
                <div className="ac-icon">📋</div>
                <div className="ac-title">פרטי מנוי</div>
                <div className="ac-desc">
                  {profile?.subscription_status === "active" ? "פעיל" : profile?.subscription_status || "—"}
                  {profile?.current_period_end && ` · חידוש: ${new Date(profile.current_period_end).toLocaleDateString("he-IL")}`}
                </div>
              </div>
            )}
          </div>

          {/* Quick Guide */}
          <div className="guide-card glass-card" style={{ borderRadius: 20 }}>
            <div className="g-title">🚀 איך להתחיל</div>
            {["הורד והתקן את הפלאגין (כפתור למעלה)", "פתח Premiere Pro → Window → Extensions → SubAI", "התחבר עם Google בפלאגין", "סמן In/Out על הקטע → לחץ ״תמלל עם AI״"].map((s, i) => (
              <div key={i} className="guide-step">
                <div className="guide-num">{i + 1}</div>
                <span>{s}</span>
              </div>
            ))}
          </div>

          {/* Navigation back */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 24, paddingTop: 16, borderTop: "1px solid rgba(0,0,0,0.05)" }}>
            <Link href="/" style={{ fontSize: 13, color: "#888" }}>← חזרה לדף הראשי</Link>
            <button className="btn-logout" onClick={handleLogout}>התנתק</button>
          </div>
        </div>
      </div>
    </div>
  );
}
