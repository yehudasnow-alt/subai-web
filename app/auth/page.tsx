"use client";
import { useState, useEffect } from "react";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export default function AuthPage() {
  const [mode, setMode] = useState<"login" | "signup">("signup");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [gLoading, setGLoading] = useState(false);
  const [msg, setMsg] = useState({ text: "", ok: false });

  // Check if already logged in
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (data.user) window.location.href = "/dashboard";
    });
  }, []);

  async function handleGoogle() {
    setGLoading(true);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/dashboard` },
    });
    if (error) {
      setMsg({ text: error.message, ok: false });
      setGLoading(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true); setMsg({ text: "", ok: false });
    try {
      if (mode === "signup") {
        const { error } = await supabase.auth.signUp({
          email, password,
          options: { data: { full_name: name }, emailRedirectTo: `${window.location.origin}/dashboard` },
        });
        if (error) throw error;
        setMsg({ text: "נרשמת בהצלחה! בדוק את המייל לאימות.", ok: true });
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        window.location.href = "/dashboard";
      }
    } catch (err: any) {
      const messages: Record<string, string> = {
        "Invalid login credentials": "אימייל או סיסמה שגויים",
        "User already registered": "המשתמש כבר רשום — התחבר",
        "Password should be at least 6 characters": "סיסמה חייבת להכיל לפחות 6 תווים",
      };
      setMsg({ text: messages[err.message] || err.message, ok: false });
    }
    setLoading(false);
  }

  const S = {
    page: { minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 } as React.CSSProperties,
    card: { background: "#111118", border: "1px solid #252530", borderRadius: 14, padding: 28 } as React.CSSProperties,
    input: { width: "100%", padding: "11px 14px", background: "#0a0a0f", border: "1px solid #252530", borderRadius: 8, color: "#e8e8ee", fontFamily: "var(--font-he)", fontSize: 14, outline: "none" } as React.CSSProperties,
    label: { fontSize: 12, color: "#8b8b9e", display: "block", marginBottom: 5 } as React.CSSProperties,
    btn: { width: "100%", padding: 14, borderRadius: 8, fontSize: 15, fontWeight: 700, fontFamily: "var(--font-he)", cursor: "pointer", border: "none", color: "#fff", background: "linear-gradient(135deg,#3b82f6,#6366f1)" } as React.CSSProperties,
    divider: { display: "flex", alignItems: "center", gap: 12, margin: "18px 0" } as React.CSSProperties,
    divLine: { flex: 1, height: 1, background: "#252530" } as React.CSSProperties,
  };

  return (
    <div style={S.page}>
      <div style={{ width: "100%", maxWidth: 420 }}>
        {/* Logo */}
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <a href="/" style={{ textDecoration: "none" }}>
            <div style={{ width: 48, height: 48, borderRadius: 14, margin: "0 auto 12px",
              background: "linear-gradient(135deg,#3b82f6,#6366f1)",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 24, fontWeight: 800, color: "#fff" }}>S</div>
            <div style={{ fontSize: 24, fontWeight: 800, color: "#e8e8ee" }}>Sub<span style={{ color: "#60a5fa" }}>AI</span></div>
          </a>
          <p style={{ color: "#8b8b9e", fontSize: 14, marginTop: 6 }}>
            {mode === "signup" ? "צור חשבון חינם — 10 דקות תמלול מתנה" : "התחבר לחשבון שלך"}
          </p>
        </div>

        <div style={S.card}>
          {/* Google Button */}
          <button onClick={handleGoogle} disabled={gLoading}
            style={{
              ...S.btn, background: "#fff", color: "#333", display: "flex",
              alignItems: "center", justifyContent: "center", gap: 10,
              fontWeight: 600, fontSize: 14, opacity: gLoading ? 0.5 : 1,
              border: "1px solid #ddd",
            }}>
            <svg width="18" height="18" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>
            {gLoading ? "מתחבר..." : mode === "signup" ? "הירשם עם Google" : "התחבר עם Google"}
          </button>

          {/* Divider */}
          <div style={S.divider}>
            <div style={S.divLine}></div>
            <span style={{ fontSize: 12, color: "#5a5a6e" }}>או עם אימייל</span>
            <div style={S.divLine}></div>
          </div>

          {/* Email Form */}
          <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {mode === "signup" && (
              <div>
                <label style={S.label}>שם מלא</label>
                <input type="text" value={name} onChange={e => setName(e.target.value)} required
                  placeholder="ישראל ישראלי" style={S.input} />
              </div>
            )}
            <div>
              <label style={S.label}>אימייל</label>
              <input type="email" value={email} onChange={e => setEmail(e.target.value)} required
                placeholder="name@example.com" dir="ltr" style={{ ...S.input, fontFamily: "var(--font-en)" }} />
            </div>
            <div>
              <label style={S.label}>סיסמה</label>
              <input type="password" value={password} onChange={e => setPassword(e.target.value)} required
                placeholder="לפחות 6 תווים" minLength={6} style={S.input} />
            </div>
            <button type="submit" disabled={loading}
              style={{ ...S.btn, opacity: loading ? 0.5 : 1, cursor: loading ? "not-allowed" : "pointer" }}>
              {loading ? "⏳" : mode === "signup" ? "צור חשבון חינם ←" : "התחבר ←"}
            </button>
          </form>

          {msg.text && (
            <div style={{
              marginTop: 12, padding: 10, borderRadius: 8, fontSize: 13, textAlign: "center",
              background: msg.ok ? "#22c55e15" : "#ef444415", color: msg.ok ? "#22c55e" : "#ef4444",
              border: `1px solid ${msg.ok ? "#22c55e30" : "#ef444430"}`,
            }}>{msg.text}</div>
          )}
        </div>

        <div style={{ textAlign: "center", marginTop: 16, fontSize: 13, color: "#5a5a6e" }}>
          {mode === "signup" ? "כבר יש לך חשבון?" : "אין לך חשבון?"}{" "}
          <button onClick={() => { setMode(mode === "signup" ? "login" : "signup"); setMsg({ text: "", ok: false }); }}
            style={{ background: "none", border: "none", color: "#60a5fa", cursor: "pointer", fontFamily: "var(--font-he)", fontSize: 13 }}>
            {mode === "signup" ? "התחבר" : "הירשם בחינם"}
          </button>
        </div>
      </div>
    </div>
  );
}
