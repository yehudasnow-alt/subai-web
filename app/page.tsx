"use client";
import { useEffect, useState } from "react";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

type Profile = {
  id: string; email: string; full_name: string;
  plan: string; minutes_used: number; minutes_limit: number;
  api_key: string; subscription_status: string; period_end: string | null;
};

export default function Dashboard() {
  const [user, setUser] = useState<any>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [upgrading, setUpgrading] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [cancelMsg, setCancelMsg] = useState("");
  const [showUpgraded, setShowUpgraded] = useState(false);

  useEffect(() => {
    // Check for upgrade success
    if (window.location.search.includes("upgraded=true")) {
      setShowUpgraded(true);
      window.history.replaceState({}, "", "/dashboard");
      setTimeout(() => setShowUpgraded(false), 5000);
    }
    loadUser();
  }, []);

  async function loadUser() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { window.location.href = "/auth"; return; }
    setUser(user);
    const { data } = await supabase.from("profiles").select("*").eq("id", user.id).single();
    setProfile(data);
    setLoading(false);
  }

  async function copyKey() {
    if (!profile?.api_key) return;
    await navigator.clipboard.writeText(profile.api_key);
    setCopied(true); setTimeout(() => setCopied(false), 2000);
  }

  async function handleUpgrade(plan: string) {
    if (!user || !profile) return;
    setUpgrading(true);
    try {
      const res = await fetch("/api/checkout", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan, period: "monthly", userId: user.id, email: user.email }),
      });
      const data = await res.json();
      if (data.url) window.location.href = data.url;
      else alert(data.error || "שגיאה");
    } catch (e) { alert("שגיאת חיבור"); }
    setUpgrading(false);
  }

  async function handleCancel() {
    if (!user || !confirm("האם אתה בטוח? המנוי ישאר פעיל עד סוף תקופת החיוב.")) return;
    setCanceling(true); setCancelMsg("");
    try {
      const res = await fetch("/api/cancel-subscription", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.id }),
      });
      const data = await res.json();
      if (data.ok) {
        setCancelMsg(`המנוי יבוטל ב-${data.cancel_at}. עד אז תוכל להמשיך להשתמש.`);
        loadUser(); // Refresh
      } else {
        setCancelMsg(data.error || "שגיאה בביטול");
      }
    } catch (e) { setCancelMsg("שגיאת חיבור"); }
    setCanceling(false);
  }

  async function handleLogout() {
    await supabase.auth.signOut();
    window.location.href = "/";
  }

  if (loading) return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ color: "#8b8b9e" }}>⏳ טוען...</div>
    </div>
  );

  const remaining = Math.max(0, (profile?.minutes_limit || 0) - (profile?.minutes_used || 0));
  const usagePct = profile?.minutes_limit ? Math.min(100, ((profile.minutes_used || 0) / profile.minutes_limit) * 100) : 0;
  const planNames: Record<string, string> = { free: "חינמי 🆓", pro: "פרו ⭐", studio: "סטודיו 💎" };
  const isCanceled = profile?.subscription_status === "canceled";
  const isPaid = profile?.plan === "pro" || profile?.plan === "studio";

  // Format renewal/cancel date
  const periodEnd = profile?.period_end ? new Date(profile.period_end) : null;
  const periodEndStr = periodEnd ? periodEnd.toLocaleDateString("he-IL", { day: "numeric", month: "long", year: "numeric" }) : null;

  const S: Record<string, React.CSSProperties> = {
    page: { minHeight: "100vh", padding: 24, maxWidth: 700, margin: "0 auto" },
    nav: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 32, paddingBottom: 16, borderBottom: "1px solid #252530" },
    logo: { display: "flex", alignItems: "center", gap: 10, textDecoration: "none" },
    logoSq: { width: 32, height: 32, borderRadius: 9, background: "linear-gradient(135deg,#3b82f6,#6366f1)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, fontWeight: 800, color: "#fff" },
    card: { background: "#111118", border: "1px solid #252530", borderRadius: 14, padding: 24, marginBottom: 16 },
    label: { fontSize: 11, fontWeight: 700, color: "#5a5a6e", textTransform: "uppercase" as const, letterSpacing: "0.5px", marginBottom: 12 },
    btn: { padding: "10px 20px", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "var(--font-he)", transition: "all 0.2s", border: "none" },
  };

  return (
    <div style={S.page}>
      {/* Upgrade success banner */}
      {showUpgraded && (
        <div style={{
          background: "#22c55e15", border: "1px solid #22c55e30", borderRadius: 12,
          padding: "14px 20px", marginBottom: 16, textAlign: "center", fontSize: 14, color: "#22c55e",
        }}>🎉 המנוי שודרג בהצלחה! תוכנית חדשה פעילה.</div>
      )}

      {/* Nav */}
      <div style={S.nav}>
        <a href="/" style={S.logo}>
          <div style={S.logoSq}>S</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: "#e8e8ee" }}>Sub<span style={{ color: "#60a5fa" }}>AI</span></div>
        </a>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 13, color: "#8b8b9e" }}>{user?.email}</span>
          <button onClick={handleLogout} style={{ ...S.btn, background: "none", border: "1px solid #2f2f3d", color: "#8b8b9e" }}>יציאה</button>
        </div>
      </div>

      {/* Welcome */}
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 26, fontWeight: 800, marginBottom: 4 }}>שלום, {profile?.full_name || "👋"}</h1>
        <p style={{ color: "#8b8b9e", fontSize: 14 }}>
          תוכנית: <span style={{ color: "#60a5fa", fontWeight: 600 }}>{planNames[profile?.plan || "free"]}</span>
          {isCanceled && <span style={{ color: "#f59e0b", marginRight: 8 }}> (מבוטל — פעיל עד {periodEndStr})</span>}
        </p>
      </div>

      {/* Usage */}
      <div style={S.card}>
        <div style={S.label}>📊 שימוש החודש</div>
        <div style={{ height: 10, background: "#1a1a28", borderRadius: 5, overflow: "hidden", marginBottom: 10 }}>
          <div style={{
            height: "100%", borderRadius: 5, transition: "width 0.5s", width: `${usagePct}%`,
            background: usagePct > 90 ? "#ef4444" : usagePct > 70 ? "#f59e0b" : "linear-gradient(90deg,#3b82f6,#22c55e)",
          }} />
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
          <span style={{ color: remaining < 5 ? "#ef4444" : "#22c55e", fontWeight: 600 }}>{remaining.toFixed(1)} דקות נותרו</span>
          <span style={{ color: "#5a5a6e" }}>{(profile?.minutes_used || 0).toFixed(1)} / {profile?.minutes_limit || 0} דקות</span>
        </div>
      </div>

      {/* Subscription Info (for paid users) */}
      {isPaid && (
        <div style={S.card}>
          <div style={S.label}>📅 פרטי מנוי</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: 13 }}>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ color: "#8b8b9e" }}>תוכנית</span>
              <span style={{ fontWeight: 600 }}>{planNames[profile?.plan || "free"]}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ color: "#8b8b9e" }}>סטטוס</span>
              <span style={{ fontWeight: 600, color: isCanceled ? "#f59e0b" : "#22c55e" }}>
                {isCanceled ? "מבוטל — פעיל עד סוף התקופה" : "פעיל ✓"}
              </span>
            </div>
            {periodEndStr && (
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ color: "#8b8b9e" }}>{isCanceled ? "תאריך סיום" : "חידוש הבא"}</span>
                <span style={{ fontWeight: 600 }}>{periodEndStr}</span>
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ color: "#8b8b9e" }}>מכסה חודשית</span>
              <span style={{ fontWeight: 600 }}>{profile?.minutes_limit} דקות</span>
            </div>
          </div>

          {/* Cancel button */}
          {!isCanceled && (
            <div style={{ marginTop: 16, paddingTop: 16, borderTop: "1px solid #252530" }}>
              <button onClick={handleCancel} disabled={canceling}
                style={{
                  ...S.btn, width: "100%", background: "none", border: "1px solid #3a3a50",
                  color: "#8b8b9e", fontSize: 12, opacity: canceling ? 0.5 : 1,
                }}>
                {canceling ? "מבטל..." : "ביטול מנוי"}
              </button>
              <p style={{ fontSize: 11, color: "#5a5a6e", marginTop: 6, textAlign: "center" }}>
                הביטול ייכנס לתוקף בסוף תקופת החיוב. עד אז תוכל להמשיך להשתמש בכל הדקות.
              </p>
            </div>
          )}

          {cancelMsg && (
            <div style={{
              marginTop: 10, padding: 10, borderRadius: 8, fontSize: 12, textAlign: "center",
              background: cancelMsg.includes("שגיאה") ? "#ef444415" : "#f59e0b15",
              color: cancelMsg.includes("שגיאה") ? "#ef4444" : "#f59e0b",
            }}>{cancelMsg}</div>
          )}
        </div>
      )}

      {/* Upgrade (for free users) */}
      {profile?.plan === "free" && (
        <div style={S.card}>
          <div style={S.label}>⚡ שדרג תוכנית</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div style={{ background: "#1a1a28", border: "1px solid #3b82f640", borderRadius: 10, padding: 18, textAlign: "center" }}>
              <div style={{ fontSize: 18, fontWeight: 800 }}>פרו ⭐</div>
              <div style={{ fontSize: 28, fontWeight: 800, fontFamily: "var(--font-en)", margin: "6px 0" }}>₪39<span style={{ fontSize: 13, color: "#8b8b9e" }}>/חודש</span></div>
              <div style={{ fontSize: 12, color: "#8b8b9e", marginBottom: 12 }}>120 דקות / חודש</div>
              <button onClick={() => handleUpgrade("pro")} disabled={upgrading}
                style={{ ...S.btn, width: "100%", background: "linear-gradient(135deg,#3b82f6,#6366f1)", color: "#fff" }}>
                {upgrading ? "⏳" : "שדרג לפרו ←"}
              </button>
            </div>
            <div style={{ background: "#1a1a28", border: "1px solid #6366f140", borderRadius: 10, padding: 18, textAlign: "center" }}>
              <div style={{ fontSize: 18, fontWeight: 800 }}>סטודיו 💎</div>
              <div style={{ fontSize: 28, fontWeight: 800, fontFamily: "var(--font-en)", margin: "6px 0" }}>₪99<span style={{ fontSize: 13, color: "#8b8b9e" }}>/חודש</span></div>
              <div style={{ fontSize: 12, color: "#8b8b9e", marginBottom: 12 }}>500 דקות / חודש</div>
              <button onClick={() => handleUpgrade("studio")} disabled={upgrading}
                style={{ ...S.btn, width: "100%", background: "#222233", color: "#e8e8ee", border: "1px solid #2f2f3d" }}>
                {upgrading ? "⏳" : "שדרג לסטודיו ←"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Download Plugin */}
      <div style={S.card}>
        <div style={S.label}>📦 הורד את הפלאגין</div>
        <p style={{ fontSize: 13, color: "#8b8b9e", marginBottom: 12, lineHeight: 1.8 }}>
          הורד, חלץ, הרץ את ה-Installer, ופתח Premiere Pro.
        </p>
        <a href="/SubAI_Plugin.zip" download
          style={{
            display: "inline-flex", alignItems: "center", gap: 8,
            padding: "10px 20px", borderRadius: 8, fontSize: 13, fontWeight: 600,
            background: "#22c55e", color: "#fff", textDecoration: "none",
          }}>⬇ הורד SubAI Plugin</a>
      </div>

      {/* Quick Start */}
      <div style={{
        ...S.card, background: "linear-gradient(135deg,rgba(34,197,94,0.05),rgba(59,130,246,0.05))",
        border: "1px solid rgba(34,197,94,0.2)",
      }}>
        <div style={S.label}>🚀 מדריך מהיר</div>
        <ol style={{ fontSize: 13, color: "#8b8b9e", lineHeight: 2.2, paddingRight: 18 }}>
          <li>הורד והתקן את הפלאגין</li>
          <li>פתח Premiere → Window → Extensions → SubAI</li>
          <li>התחבר עם האימייל והסיסמה שלך</li>
          <li>פתח רצף, סמן In/Out, לחץ <strong style={{ color: "#e8e8ee" }}>"תמלל עם AI"</strong></li>
          <li>כתוביות מופיעות בטיימליין ✨</li>
        </ol>
      </div>
    </div>
  );
}
