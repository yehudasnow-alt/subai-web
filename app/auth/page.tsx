"use client";
import { useState, useEffect } from "react";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export default function AuthPage() {
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState({ text: "", ok: false });
  const [pluginSession, setPluginSession] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const ps = params.get("plugin_session");
    if (ps) setPluginSession(ps);

    supabase.auth.getUser().then(({ data }) => {
      if (data.user) {
        if (ps) {
          storePluginSession(data.user.id, ps);
        } else {
          window.location.href = "/dashboard";
        }
      }
    });
  }, []);

  async function storePluginSession(userId: string, sessionId: string) {
    try {
      await fetch("/api/auth/plugin-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "store", session_id: sessionId, user_id: userId }),
      });
      setMsg({ text: "התחברת בהצלחה! חזור לפלאגין ב-Premiere Pro.", ok: true });
    } catch (e) {
      setMsg({ text: "שגיאה בחיבור", ok: false });
    }
  }

  async function handleGoogle() {
    setLoading(true);
    const redirectUrl = pluginSession
      ? `${window.location.origin}/dashboard?plugin_session=${pluginSession}`
      : `${window.location.origin}/dashboard`;

    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: redirectUrl },
    });
    if (error) {
      setMsg({ text: error.message, ok: false });
      setLoading(false);
    }
  }

  return (
    <div style={{ background: "#06060e", color: "#e8e8f0", minHeight: "100vh", fontFamily: "'Rubik', 'Segoe UI', sans-serif", direction: "rtl", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Rubik:wght@400;500;600;700;800;900&display=swap');`}</style>

      {/* Background glow */}
      <div style={{ position: "fixed", top: "30%", left: "50%", transform: "translate(-50%,-50%)", width: 600, height: 600, borderRadius: "50%", background: "radial-gradient(circle, rgba(99,102,241,0.1) 0%, transparent 70%)", pointerEvents: "none" }} />

      <div style={{ width: "100%", maxWidth: 400, position: "relative" }}>
        {/* Logo */}
        <div style={{ textAlign: "center", marginBottom: 40 }}>
          <a href="/" style={{ textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 12 }}>
            <div style={{ width: 48, height: 48, borderRadius: 14, background: "linear-gradient(135deg,#3b82f6,#818cf8)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24, fontWeight: 900, color: "#fff" }}>S</div>
            <span style={{ fontSize: 28, fontWeight: 900, color: "#e8e8f0" }}>Sub<span style={{ color: "#818cf8" }}>AI</span></span>
          </a>
        </div>

        {/* Card */}
        <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 20, padding: 36, backdropFilter: "blur(20px)" }}>
          <h2 style={{ textAlign: "center", fontSize: 22, fontWeight: 800, marginBottom: 8 }}>
            {pluginSession ? "חבר את הפלאגין" : "ברוך הבא"}
          </h2>
          <p style={{ textAlign: "center", color: "#8888aa", fontSize: 14, marginBottom: 32 }}>
            {pluginSession ? "התחבר כדי לחבר את Premiere Pro" : "התחבר כדי להתחיל לתמלל"}
          </p>

          <button onClick={handleGoogle} disabled={loading}
            style={{
              width: "100%", padding: 16, borderRadius: 12, fontSize: 16, fontWeight: 700,
              fontFamily: "'Rubik', 'Segoe UI', sans-serif", cursor: loading ? "not-allowed" : "pointer",
              border: "1px solid rgba(255,255,255,0.15)", background: "rgba(255,255,255,0.95)",
              color: "#333", display: "flex", alignItems: "center", justifyContent: "center", gap: 12,
              opacity: loading ? 0.5 : 1, boxShadow: "0 4px 20px rgba(0,0,0,0.3)", transition: "all 0.2s"
            }}>
            <svg width="20" height="20" viewBox="0 0 48 48">
              <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
              <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
              <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
              <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
            </svg>
            {loading ? "מתחבר..." : "התחבר עם Google"}
          </button>

          {msg.text && (
            <div style={{ marginTop: 16, padding: 14, borderRadius: 10, fontSize: 14, textAlign: "center", lineHeight: 1.8,
              background: msg.ok ? "rgba(52,211,153,0.1)" : "rgba(248,113,113,0.1)",
              color: msg.ok ? "#34d399" : "#f87171",
              border: `1px solid ${msg.ok ? "rgba(52,211,153,0.2)" : "rgba(248,113,113,0.2)"}` }}>
              {msg.text}
            </div>
          )}
        </div>

        <p style={{ textAlign: "center", marginTop: 20, fontSize: 12, color: "#444460" }}>
          בהתחברות אתה מסכים ל<a href="#" style={{ color: "#666680" }}>תנאי השימוש</a>
        </p>
      </div>
    </div>
  );
}
