"use client";
import { useState, useEffect } from "react";
import { createClient } from "@supabase/supabase-js";
import Link from "next/link";

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);

export default function AuthPage() {
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState({ text: "", ok: false });
  const [pluginSession, setPluginSession] = useState<string | null>(null);

  useEffect(() => {
    const ps = new URLSearchParams(window.location.search).get("plugin_session");
    if (ps) setPluginSession(ps);
    supabase.auth.getUser().then(({ data }) => {
      if (data.user) {
        if (ps) storePluginSession(data.user.id, ps);
        else window.location.href = "/dashboard";
      }
    });
  }, []);

  async function storePluginSession(userId: string, sid: string) {
    try {
      await fetch("/api/auth/plugin-session", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "store", session_id: sid, user_id: userId }) });
      setMsg({ text: "התחברת בהצלחה! חזור לפלאגין ב-Premiere Pro.", ok: true });
    } catch { setMsg({ text: "שגיאה בחיבור", ok: false }); }
  }

  async function handleGoogle() {
    setLoading(true);
    const redirect = pluginSession ? `${window.location.origin}/dashboard?plugin_session=${pluginSession}` : `${window.location.origin}/dashboard`;
    const { error } = await supabase.auth.signInWithOAuth({ provider: "google", options: { redirectTo: redirect } });
    if (error) { setMsg({ text: error.message, ok: false }); setLoading(false); }
  }

  return (
    <div className="page-wrap">
      <div className="mesh-bg"><div className="blob b1" /><div className="blob b2" /><div className="blob b3" /></div>
      <div className="auth-wrap">
        <div className="auth-card">
          <div className="auth-logo">
            <Link href="/" style={{ display: "inline-flex", alignItems: "center", gap: 12 }}>
              <div className="logo-icon" style={{ width: 48, height: 48, fontSize: 24, borderRadius: 14 }}>S</div>
              <span className="logo-text" style={{ fontSize: 28 }}>Sub<span>AI</span></span>
            </Link>
          </div>
          <div className="auth-box glass-card">
            <h2>{pluginSession ? "חיבור הפלאגין" : "ברוך הבא"}</h2>
            <p className="auth-sub">{pluginSession ? "התחבר כדי לחבר את Premiere Pro" : "התחבר עם Google והתחל לתמלל"}</p>
            <button className="btn-google" onClick={handleGoogle} disabled={loading}>
              <svg width="20" height="20" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>
              {loading ? "מתחבר..." : "התחבר עם Google"}
            </button>
            {msg.text && <div className={`auth-msg ${msg.ok ? "ok" : "bad"}`}>{msg.text}</div>}
          </div>
          <p className="auth-foot">בהתחברות אתה מסכים ל<a href="#">תנאי השימוש</a> ול<a href="#">מדיניות הפרטיות</a></p>
        </div>
      </div>
    </div>
  );
}
