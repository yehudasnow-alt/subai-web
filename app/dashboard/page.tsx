"use client";
import { useState, useEffect, useRef } from "react";
import { createClient } from "@supabase/supabase-js";
import Link from "next/link";
import Nav from "../../components/Nav";

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);

export default function Dashboard() {
  const [user, setUser] = useState<any>(null);
  const [profile, setProfile] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const guideRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ps = new URLSearchParams(window.location.search).get("plugin_session");
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

  function scrollToGuide() {
    guideRef.current?.scrollIntoView({ behavior: "smooth" });
  }

  async function handleLogout() { await supabase.auth.signOut(); window.location.href = "/"; }

  if (loading) return (
    <div className="page-wrap">
      <div className="mesh-bg"><div className="blob b1" /><div className="blob b2" /></div>
      <Nav />
      <div style={{ minHeight: "80vh", display: "flex", alignItems: "center", justifyContent: "center", position: "relative", zIndex: 1 }}>
        <div className="glass-card" style={{ padding: 40, textAlign: "center" }}><div style={{ fontSize: 28, marginBottom: 12 }}>⏳</div><div style={{ color: "#888" }}>טוען...</div></div>
      </div>
    </div>
  );

  const used = profile?.minutes_used || 0;
  const limit = profile?.minutes_limit || 10;
  const remaining = Math.max(0, limit - used);
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  const displayName = user?.user_metadata?.full_name || user?.user_metadata?.name || user?.email?.split("@")[0] || "";
  const currentPlan = profile?.plan || "free";

  const planNames: Record<string, string> = { free: "חינמי", pro: "פרו ⭐", studio: "סטודיו 💎" };

  const gradientIconStyle: React.CSSProperties = {
    width: 48, height: 48, borderRadius: 14,
    background: "linear-gradient(135deg, #7c3aed, #a855f7, #c084fc)",
    display: "flex", alignItems: "center", justifyContent: "center",
    fontSize: 22, marginBottom: 8,
    boxShadow: "0 4px 14px rgba(124,58,237,0.25)",
  };

  const stepNumStyle: React.CSSProperties = {
    width: 36, height: 36, borderRadius: 12,
    background: "linear-gradient(135deg, #7c3aed, #a855f7)",
    display: "flex", alignItems: "center", justifyContent: "center",
    fontSize: 15, fontWeight: 800, color: "#fff",
    flexShrink: 0,
  };

  return (
    <div className="page-wrap">
      <div className="mesh-bg"><div className="blob b1" /><div className="blob b2" /><div className="blob b3" /></div>
      <Nav />
      <div className="dash-content" style={{ paddingTop: 100 }}>
        <h1 className="dash-h1">שלום, {displayName} 👋</h1>

        {/* ── Plan & Usage ── */}
        <div className="plan-card glass-card" style={{ borderRadius: 24 }}>
          <div className="plan-row">
            <div>
              <div className="plan-label">החבילה שלך</div>
              <div className="plan-val">{planNames[currentPlan] || "חינמי"}</div>
            </div>
            <div style={{ textAlign: "left" }}>
              <div className="plan-label">דקות נותרות</div>
              <div className={`plan-val ${remaining > 0 ? "green" : ""}`} style={remaining <= 0 ? { color: "#ef4444" } : {}}>{remaining.toFixed(0)}</div>
            </div>
          </div>
          <div className="usage-track"><div className={`usage-fill ${pct > 80 ? "warn" : "ok"}`} style={{ width: pct + "%" }} /></div>
          <div className="usage-meta"><span>{used.toFixed(1)} נוצלו</span><span>{limit} סה״כ</span></div>
          {remaining <= 0 && <div style={{ marginTop: 12, padding: 12, borderRadius: 12, background: "rgba(239,68,68,0.06)", border: "1px solid rgba(239,68,68,0.12)", fontSize: 13, color: "#ef4444", textAlign: "center" }}>נגמרו הדקות! קנה חבילה חדשה כדי להמשיך לתמלל.</div>}
        </div>

        {/* ── Quick Actions ── */}
        <div className="action-grid">
          <a href="/api/download" className="action-card glass-card" style={{ borderRadius: 20, textDecoration: "none" }}>
            <div style={gradientIconStyle}>⬇️</div>
            <div className="ac-title">הורד פלאגין</div>
            <div className="ac-desc">התקנה ל-Adobe Premiere Pro</div>
          </a>
          <div onClick={scrollToGuide} className="action-card glass-card" style={{ borderRadius: 20, textDecoration: "none", cursor: "pointer" }}>
            <div style={gradientIconStyle}>🚀</div>
            <div className="ac-title">איך להתחיל?</div>
            <div className="ac-desc">מדריך מהיר ב-4 שלבים</div>
          </div>
        </div>

        {/* ── Buy Minutes ── */}
        <h2 style={{ fontSize: 22, fontWeight: 800, margin: "36px 0 16px", color: "#1a1a2e" }}>
          {remaining <= 0 ? "קנה דקות" : "קנה עוד דקות"}
        </h2>
        <div className="price-grid" style={{ maxWidth: "100%" }}>
          <div className="price-card glass-card popular" style={{ borderRadius: 20 }}>
            <div className="popular-tag">הכי פופולרי</div>
            <div className="price-name">פרו</div>
            <div className="price-amount" style={{ fontSize: 32 }}>₪59</div>
            <div className="price-period">120 דקות</div>
            <ul className="price-features">
              <li>120 דקות תמלול</li>
              <li>תיקון AI מתקדם</li>
              <li>מצב TikTok</li>
              <li>ייצוא ישר לתוכנה</li>
            </ul>
            <a href="/api/checkout?plan=pro" className="price-btn primary">קנה חבילת פרו ←</a>
          </div>
          <div className="price-card glass-card" style={{ borderRadius: 20 }}>
            <div className="price-name">סטודיו</div>
            <div className="price-amount" style={{ fontSize: 32 }}>₪180</div>
            <div className="price-period">500 דקות</div>
            <ul className="price-features">
              <li>500 דקות תמלול</li>
              <li>תיקון AI מתקדם</li>
              <li>מצב TikTok</li>
              <li>ייצוא ישר לתוכנה</li>
            </ul>
            <a href="/api/checkout?plan=studio" className="price-btn">קנה חבילת סטודיו</a>
          </div>
        </div>

        {/* ── Guide ── */}
        <div ref={guideRef} style={{ marginTop: 48 }}>
          <h2 style={{ fontSize: 22, fontWeight: 800, marginBottom: 20, color: "#1a1a2e" }}>🚀 מתחילים בדקה</h2>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {[
              ["1", "הורד והתקן", "לחץ על ״הורד פלאגין״ למעלה והרץ את ההתקנה. סגור את Premiere לפני ההתקנה."],
              ["2", "פתח את Premiere", "פתח פרויקט ולחץ Window → Extensions → SubAI. הפלאגין ייפתח בחלונית בצד."],
              ["3", "סמן קטע לתמלול", "הגדר נקודות In ו-Out בטיימליין על הקטע שרוצים לתמלל."],
              ["4", "לחץ ״תמלל״ — וזהו!", "SubAI מתמלל בענן, מתקן עם AI, ומכניס כתוביות ישירות לתוכנה. הכל אוטומטי."],
            ].map(([num, title, desc]) => (
              <div key={num} className="glass-card" style={{ borderRadius: 16, padding: "16px 20px", display: "flex", gap: 16, alignItems: "flex-start" }}>
                <div style={stepNumStyle}>{num}</div>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 15, color: "#1a1a2e", marginBottom: 4 }}>{title}</div>
                  <div style={{ fontSize: 13.5, color: "#666", lineHeight: 1.6 }}>{desc}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* ── Footer ── */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 36, paddingTop: 20, borderTop: "1px solid rgba(0,0,0,0.05)" }}>
          <Link href="/" style={{ fontSize: 13, color: "#888" }}>← חזרה לדף הראשי</Link>
          <button className="btn-logout" onClick={handleLogout}>התנתק</button>
        </div>
      </div>
    </div>
  );
}
