"use client";
import { useState, useEffect } from "react";
import { createClient } from "@supabase/supabase-js";
import Link from "next/link";
import Nav from "../../components/Nav";

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);

export default function Dashboard() {
  const [user, setUser] = useState<any>(null);
  const [profile, setProfile] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [cancelLoading, setCancelLoading] = useState(false);
  const [cancelMsg, setCancelMsg] = useState("");

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

  async function handleCancel() {
    if (!confirm("בטוח שברצונך לבטל? תוכל להמשיך להשתמש בדקות שנותרו עד סוף התקופה.")) return;
    setCancelLoading(true);
    try {
      const res = await fetch("/api/cancel-subscription", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: user.id }) });
      const data = await res.json();
      if (data.ok) { setCancelMsg("המנוי יבוטל בסוף התקופה הנוכחית. הדקות שנותרו ימשיכו לעבוד."); }
      else setCancelMsg(data.message || "שגיאה בביטול");
    } catch { setCancelMsg("שגיאה בביטול"); }
    setCancelLoading(false);
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

  const plans: Record<string, string> = { free: "חינמי", pro: "פרו ⭐", studio: "סטודיו 💎" };
  const planLimits: Record<string, number> = { free: 10, pro: 120, studio: 250 };
  const used = profile?.minutes_used || 0;
  const limit = profile?.minutes_limit || 10;
  const remaining = Math.max(0, limit - used);
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  const displayName = user?.user_metadata?.full_name || user?.user_metadata?.name || user?.email?.split("@")[0] || "";
  const currentPlan = profile?.plan || "free";
  const isCanceled = profile?.subscription_status === "canceled";

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
              <div className="plan-label">התוכנית שלך</div>
              <div className="plan-val">{plans[currentPlan] || "חינמי"}</div>
              {isCanceled && <div style={{ fontSize: 12, color: "#f59e0b", marginTop: 4 }}>⚠ המנוי יבוטל בסוף התקופה</div>}
            </div>
            <div style={{ textAlign: "left" }}>
              <div className="plan-label">דקות נותרות</div>
              <div className={`plan-val ${remaining > 0 ? "green" : ""}`} style={remaining <= 0 ? { color: "#ef4444" } : {}}>{remaining.toFixed(0)}</div>
            </div>
          </div>
          <div className="usage-track"><div className={`usage-fill ${pct > 80 ? "warn" : "ok"}`} style={{ width: pct + "%" }} /></div>
          <div className="usage-meta"><span>{used.toFixed(1)} נוצלו</span><span>{limit} סה״כ</span></div>
          {remaining <= 0 && <div style={{ marginTop: 12, padding: 12, borderRadius: 12, background: "rgba(239,68,68,0.06)", border: "1px solid rgba(239,68,68,0.12)", fontSize: 13, color: "#ef4444", textAlign: "center" }}>נגמרו הדקות! שדרג כדי להמשיך לתמלל.</div>}
        </div>

        {/* ── Quick Actions ── */}
        <div className="action-grid">
          <a href="/SubAI_Setup.exe" className="action-card glass-card" style={{ borderRadius: 20, textDecoration: "none" }}>
            <div className="ac-icon">⬇️</div>
            <div className="ac-title">הורד פלאגין</div>
            <div className="ac-desc">התקנה ל-Adobe Premiere Pro</div>
          </a>
          <Link href="/#how" className="action-card glass-card" style={{ borderRadius: 20, textDecoration: "none" }}>
            <div className="ac-icon">🚀</div>
            <div className="ac-title">איך להתחיל?</div>
            <div className="ac-desc">מדריך מהיר ב-4 שלבים</div>
          </Link>
        </div>

        {/* ── Plans / Upgrade ── */}
        <h2 style={{ fontSize: 22, fontWeight: 800, margin: "36px 0 16px", color: "#1a1a2e" }}>
          {currentPlan === "free" ? "שדרג את התוכנית" : "התוכניות שלנו"}
        </h2>
        <div className="price-grid" style={{ maxWidth: "100%" }}>
          {/* Free */}
          <div className={`price-card glass-card ${currentPlan === "free" ? "current" : ""}`} style={{ borderRadius: 20 }}>
            {currentPlan === "free" && <div className="current-tag">התוכנית הנוכחית</div>}
            <div className="price-name">חינמי</div>
            <div className="price-amount" style={{ fontSize: 32 }}>₪0</div>
            <div className="price-period">10 דקות</div>
            <ul className="price-features"><li>עברית + אנגלית</li><li>תיקון AI</li><li>כתוביות בטיימליין</li></ul>
            {currentPlan === "free" ? <div className="price-btn" style={{ opacity: 0.5, cursor: "default" }}>התוכנית הנוכחית</div> :
              <div className="price-btn" style={{ opacity: 0.5, cursor: "default" }}>חינמי</div>}
          </div>
          {/* Pro */}
          <div className={`price-card glass-card ${currentPlan === "pro" ? "current" : "popular"}`} style={{ borderRadius: 20 }}>
            {currentPlan === "pro" ? <div className="current-tag">התוכנית הנוכחית</div> : <div className="popular-tag">מומלץ</div>}
            <div className="price-name">פרו</div>
            <div className="price-amount" style={{ fontSize: 32 }}>₪39<span>/חודש</span></div>
            <div className="price-period">120 דקות לחודש</div>
            <ul className="price-features"><li>120 דקות תמלול</li><li>100+ שפות</li><li>תיקון AI מתקדם</li><li>מצב TikTok</li></ul>
            {currentPlan === "pro" ?
              <button className="price-btn" onClick={handleCancel} disabled={cancelLoading || isCanceled} style={{ color: "#e55", borderColor: "rgba(239,68,68,0.2)" }}>
                {isCanceled ? "ביטול בתהליך" : cancelLoading ? "מבטל..." : "בטל מנוי"}
              </button> :
              <a href="/api/checkout?plan=pro" className="price-btn primary">שדרג לפרו ←</a>}
          </div>
          {/* Studio */}
          <div className={`price-card glass-card ${currentPlan === "studio" ? "current" : ""}`} style={{ borderRadius: 20 }}>
            {currentPlan === "studio" && <div className="current-tag">התוכנית הנוכחית</div>}
            <div className="price-name">סטודיו</div>
            <div className="price-amount" style={{ fontSize: 32 }}>₪99<span>/חודש</span></div>
            <div className="price-period">250 דקות לחודש</div>
            <ul className="price-features"><li>250 דקות תמלול</li><li>100+ שפות</li><li>תיקון AI מתקדם</li><li>תמיכה VIP</li></ul>
            {currentPlan === "studio" ?
              <button className="price-btn" onClick={handleCancel} disabled={cancelLoading || isCanceled} style={{ color: "#e55", borderColor: "rgba(239,68,68,0.2)" }}>
                {isCanceled ? "ביטול בתהליך" : cancelLoading ? "מבטל..." : "בטל מנוי"}
              </button> :
              <a href="/api/checkout?plan=studio" className="price-btn primary">שדרג לסטודיו ←</a>}
          </div>
        </div>
        {cancelMsg && <div style={{ marginTop: 12, padding: 14, borderRadius: 14, fontSize: 13, textAlign: "center", background: "rgba(245,158,11,0.06)", border: "1px solid rgba(245,158,11,0.15)", color: "#f59e0b" }}>{cancelMsg}</div>}

        {/* ── Footer ── */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 36, paddingTop: 20, borderTop: "1px solid rgba(0,0,0,0.05)" }}>
          <Link href="/" style={{ fontSize: 13, color: "#888" }}>← חזרה לדף הראשי</Link>
          <button className="btn-logout" onClick={handleLogout}>התנתק</button>
        </div>
      </div>
    </div>
  );
}
