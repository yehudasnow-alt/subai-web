"use client";
import { useState } from "react";
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
  const [msg, setMsg] = useState({ text: "", ok: false });

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

  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div style={{ width: "100%", maxWidth: 420 }}>
        {/* Logo */}
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <a href="/" style={{ textDecoration: "none" }}>
            <div style={{
              width: 48, height: 48, borderRadius: 14, margin: "0 auto 12px",
              background: "linear-gradient(135deg, #3b82f6, #6366f1)",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 24, fontWeight: 800, color: "#fff", fontFamily: "var(--font-en)",
            }}>S</div>
            <div style={{ fontSize: 24, fontWeight: 800 }}>Sub<span style={{ color: "#60a5fa" }}>AI</span></div>
          </a>
          <p style={{ color: "#8b8b9e", fontSize: 14, marginTop: 6 }}>
            {mode === "signup" ? "צור חשבון חינם — 30 דקות תמלול מתנה" : "התחבר לחשבון שלך"}
          </p>
        </div>

        {/* Form Card */}
        <div style={{
          background: "#111118", border: "1px solid #252530", borderRadius: 14, padding: 28,
        }}>
          <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {mode === "signup" && (
              <div>
                <label style={{ fontSize: 12, color: "#8b8b9e", display: "block", marginBottom: 5 }}>שם מלא</label>
                <input type="text" value={name} onChange={e => setName(e.target.value)} required
                  placeholder="ישראל ישראלי"
                  style={{
                    width: "100%", padding: "11px 14px", background: "#0a0a0f",
                    border: "1px solid #252530", borderRadius: 8, color: "#e8e8ee",
                    fontFamily: "var(--font-he)", fontSize: 14, outline: "none",
                  }} />
              </div>
            )}
            <div>
              <label style={{ fontSize: 12, color: "#8b8b9e", display: "block", marginBottom: 5 }}>אימייל</label>
              <input type="email" value={email} onChange={e => setEmail(e.target.value)} required
                placeholder="name@example.com" dir="ltr"
                style={{
                  width: "100%", padding: "11px 14px", background: "#0a0a0f",
                  border: "1px solid #252530", borderRadius: 8, color: "#e8e8ee",
                  fontFamily: "var(--font-en)", fontSize: 14, outline: "none",
                }} />
            </div>
            <div>
              <label style={{ fontSize: 12, color: "#8b8b9e", display: "block", marginBottom: 5 }}>סיסמה</label>
              <input type="password" value={password} onChange={e => setPassword(e.target.value)} required
                placeholder="לפחות 6 תווים" minLength={6}
                style={{
                  width: "100%", padding: "11px 14px", background: "#0a0a0f",
                  border: "1px solid #252530", borderRadius: 8, color: "#e8e8ee",
                  fontFamily: "var(--font-he)", fontSize: 14, outline: "none",
                }} />
            </div>

            <button type="submit" disabled={loading}
              style={{
                width: "100%", padding: 14, borderRadius: 8, fontSize: 15, fontWeight: 700,
                fontFamily: "var(--font-he)", cursor: loading ? "not-allowed" : "pointer",
                border: "none", color: "#fff", opacity: loading ? 0.5 : 1,
                background: "linear-gradient(135deg, #3b82f6, #6366f1)",
              }}>
              {loading ? "⏳" : mode === "signup" ? "צור חשבון חינם ←" : "התחבר ←"}
            </button>
          </form>

          {msg.text && (
            <div style={{
              marginTop: 12, padding: 10, borderRadius: 8, fontSize: 13, textAlign: "center",
              background: msg.ok ? "#22c55e15" : "#ef444415",
              color: msg.ok ? "#22c55e" : "#ef4444",
              border: `1px solid ${msg.ok ? "#22c55e30" : "#ef444430"}`,
            }}>{msg.text}</div>
          )}
        </div>

        {/* Toggle */}
        <div style={{ textAlign: "center", marginTop: 16, fontSize: 13, color: "#5a5a6e" }}>
          {mode === "signup" ? "כבר יש לך חשבון?" : "אין לך חשבון?"}{" "}
          <button onClick={() => { setMode(mode === "signup" ? "login" : "signup"); setMsg({ text: "", ok: false }); }}
            style={{
              background: "none", border: "none", color: "#60a5fa",
              cursor: "pointer", fontFamily: "var(--font-he)", fontSize: 13,
            }}>
            {mode === "signup" ? "התחבר" : "הירשם בחינם"}
          </button>
        </div>
      </div>
    </div>
  );
}
