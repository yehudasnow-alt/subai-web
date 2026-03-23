"use client";
import { useEffect, useState } from "react";

export default function Home() {
  const [show, setShow] = useState(false);
  useEffect(() => { setShow(true); }, []);

  return (
    <div style={{ background: "#06060e", color: "#e8e8f0", minHeight: "100vh", fontFamily: "'Rubik', 'Segoe UI', sans-serif", direction: "rtl" }}>
      {/* Google Fonts */}
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Rubik:wght@400;500;600;700;800;900&display=swap');`}</style>

      {/* ── Nav ── */}
      <nav style={{ position: "fixed", top: 0, left: 0, right: 0, zIndex: 100, padding: "16px 32px", display: "flex", alignItems: "center", justifyContent: "space-between", background: "rgba(6,6,14,0.8)", backdropFilter: "blur(20px)", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: "linear-gradient(135deg,#3b82f6,#818cf8)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, fontWeight: 900, color: "#fff" }}>S</div>
          <span style={{ fontSize: 20, fontWeight: 800, letterSpacing: -0.5 }}>Sub<span style={{ color: "#818cf8" }}>AI</span></span>
        </div>
        <div style={{ display: "flex", gap: 24, alignItems: "center" }}>
          <a href="#features" style={{ color: "#888", textDecoration: "none", fontSize: 14, fontWeight: 500 }}>יתרונות</a>
          <a href="#pricing" style={{ color: "#888", textDecoration: "none", fontSize: 14, fontWeight: 500 }}>מחירים</a>
          <a href="/auth" style={{ padding: "10px 24px", borderRadius: 10, background: "linear-gradient(135deg,#3b82f6,#6366f1)", color: "#fff", textDecoration: "none", fontSize: 14, fontWeight: 700, border: "none" }}>התחל בחינם →</a>
        </div>
      </nav>

      {/* ── Hero ── */}
      <section style={{ paddingTop: 160, paddingBottom: 100, textAlign: "center", position: "relative", overflow: "hidden" }}>
        <div style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)", width: 800, height: 800, borderRadius: "50%", background: "radial-gradient(circle, rgba(99,102,241,0.12) 0%, transparent 70%)", pointerEvents: "none" }} />
        <div style={{ position: "relative", maxWidth: 800, margin: "0 auto", padding: "0 24px", opacity: show ? 1 : 0, transform: show ? "translateY(0)" : "translateY(30px)", transition: "all 0.8s cubic-bezier(0.16,1,0.3,1)" }}>
          <div style={{ display: "inline-block", padding: "6px 18px", borderRadius: 20, background: "rgba(99,102,241,0.1)", border: "1px solid rgba(99,102,241,0.2)", fontSize: 13, fontWeight: 600, color: "#818cf8", marginBottom: 24 }}>✨ מופעל על ידי Whisper AI + Claude</div>
          <h1 style={{ fontSize: "clamp(36px, 6vw, 64px)", fontWeight: 900, lineHeight: 1.15, marginBottom: 20, letterSpacing: -1 }}>
            כתוביות AI בעברית<br />
            <span style={{ background: "linear-gradient(135deg,#3b82f6,#818cf8,#c084fc)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>ישירות בפרמייר פרו</span>
          </h1>
          <p style={{ fontSize: 18, color: "#8888aa", maxWidth: 560, margin: "0 auto 36px", lineHeight: 1.8 }}>
            תמלול אוטומטי מדויק בעברית, ערבית ואנגלית. הכתוביות נכנסות ישירות לטיימליין — בלחיצת כפתור אחת.
          </p>
          <div style={{ display: "flex", gap: 16, justifyContent: "center", flexWrap: "wrap" }}>
            <a href="/auth" style={{ padding: "16px 40px", borderRadius: 12, background: "linear-gradient(135deg,#3b82f6,#6366f1)", color: "#fff", textDecoration: "none", fontSize: 17, fontWeight: 800, boxShadow: "0 8px 32px rgba(99,102,241,0.3)", transition: "transform 0.2s" }}>התחל בחינם — 10 דקות מתנה</a>
            <a href="#pricing" style={{ padding: "16px 32px", borderRadius: 12, background: "rgba(255,255,255,0.06)", color: "#c8c8e0", textDecoration: "none", fontSize: 16, fontWeight: 600, border: "1px solid rgba(255,255,255,0.1)" }}>מחירים ←</a>
          </div>
        </div>
      </section>

      {/* ── Stats ── */}
      <section style={{ padding: "40px 24px 60px", maxWidth: 900, margin: "0 auto" }}>
        <div style={{ display: "flex", justifyContent: "center", gap: 48, flexWrap: "wrap" }}>
          {[["99%", "דיוק בעברית"], ["< 30 שניות", "זמן תמלול לדקה"], ["100+", "שפות נתמכות"], ["0", "התקנות נוספות"]].map(([val, label], i) => (
            <div key={i} style={{ textAlign: "center" }}>
              <div style={{ fontSize: 32, fontWeight: 900, background: "linear-gradient(135deg,#3b82f6,#818cf8)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>{val}</div>
              <div style={{ fontSize: 13, color: "#666680", marginTop: 4 }}>{label}</div>
            </div>
          ))}
        </div>
      </section>

      {/* ── Features ── */}
      <section id="features" style={{ padding: "80px 24px", maxWidth: 1000, margin: "0 auto" }}>
        <h2 style={{ textAlign: "center", fontSize: 36, fontWeight: 900, marginBottom: 12 }}>למה SubAI?</h2>
        <p style={{ textAlign: "center", color: "#666680", marginBottom: 48, fontSize: 16 }}>הכלי המהיר והמדויק ביותר לכתוביות בעברית</p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 20 }}>
          {[
            ["🎯", "תמלול מדויק", "Whisper large-v3 — המודל המתקדם בעולם. תיקון AI אוטומטי עם Claude."],
            ["⚡", "מהיר", "דקה של אודיו מתומללת ב-10 שניות. ישירות לטיימליין."],
            ["🔤", "עברית מושלמת", "אופטימיזציה מיוחדת לעברית. פיסוק, ניקוד ודקדוק מתוקנים ב-AI."],
            ["🎬", "בתוך Premiere", "פלאגין מובנה — בלי לצאת מהתוכנה, בלי ייצוא/יבוא קבצים."],
            ["📱", "מצב TikTok", "כתוביות מילה-מילה לסרטוני Reels, TikTok ו-Shorts."],
            ["🔄", "עדכון אוטומטי", "גרסאות חדשות מתעדכנות ישירות מהפלאגין."]
          ].map(([icon, title, desc], i) => (
            <div key={i} style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 16, padding: 24, transition: "border-color 0.3s" }}>
              <div style={{ fontSize: 28, marginBottom: 12 }}>{icon}</div>
              <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 8 }}>{title}</div>
              <div style={{ fontSize: 14, color: "#8888aa", lineHeight: 1.8 }}>{desc}</div>
            </div>
          ))}
        </div>
      </section>

      {/* ── How it works ── */}
      <section style={{ padding: "80px 24px", maxWidth: 800, margin: "0 auto" }}>
        <h2 style={{ textAlign: "center", fontSize: 36, fontWeight: 900, marginBottom: 48 }}>איך זה עובד?</h2>
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          {[
            ["1", "סמן In/Out", "סמן את הקטע שרוצים לתמלל בטיימליין של Premiere Pro."],
            ["2", "לחץ תמלל", "SubAI מייצא את האודיו, שולח ל-AI ומקבל תמלול מדויק."],
            ["3", "Claude מתקן", "AI מתקן שגיאות דקדוק, פיסוק ומילים כפולות אוטומטית."],
            ["4", "כתוביות בטיימליין", "ה-SRT נכנס ישירות ל-Caption Track — מוכן לעריכה וייצוא."]
          ].map(([num, title, desc], i) => (
            <div key={i} style={{ display: "flex", gap: 20, alignItems: "flex-start" }}>
              <div style={{ width: 44, height: 44, borderRadius: 12, background: "linear-gradient(135deg,#3b82f6,#818cf8)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, fontWeight: 900, flexShrink: 0 }}>{num}</div>
              <div>
                <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 4 }}>{title}</div>
                <div style={{ fontSize: 14, color: "#8888aa", lineHeight: 1.7 }}>{desc}</div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ── Pricing ── */}
      <section id="pricing" style={{ padding: "80px 24px", maxWidth: 1000, margin: "0 auto" }}>
        <h2 style={{ textAlign: "center", fontSize: 36, fontWeight: 900, marginBottom: 12 }}>מחירים פשוטים</h2>
        <p style={{ textAlign: "center", color: "#666680", marginBottom: 48, fontSize: 16 }}>התחל בחינם, שדרג כשתצטרך</p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 20, maxWidth: 860, margin: "0 auto" }}>
          {/* Free */}
          <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 20, padding: 32, display: "flex", flexDirection: "column" }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: "#888", marginBottom: 8 }}>חינמי</div>
            <div style={{ fontSize: 40, fontWeight: 900, marginBottom: 4 }}>₪0</div>
            <div style={{ fontSize: 13, color: "#666", marginBottom: 24 }}>לנצח</div>
            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 12, marginBottom: 24 }}>
              {["10 דקות תמלול", "עברית + אנגלית", "תיקון AI", "כתוביות בטיימליין"].map((f, i) => (
                <div key={i} style={{ fontSize: 14, color: "#aaa", display: "flex", gap: 8 }}><span style={{ color: "#34d399" }}>✓</span>{f}</div>
              ))}
            </div>
            <a href="/auth" style={{ display: "block", textAlign: "center", padding: 14, borderRadius: 10, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", color: "#c8c8e0", textDecoration: "none", fontWeight: 700, fontSize: 14 }}>התחל בחינם</a>
          </div>
          {/* Pro */}
          <div style={{ background: "linear-gradient(135deg, rgba(59,130,246,0.08), rgba(99,102,241,0.05))", border: "2px solid rgba(99,102,241,0.3)", borderRadius: 20, padding: 32, position: "relative", display: "flex", flexDirection: "column" }}>
            <div style={{ position: "absolute", top: -12, right: 24, background: "linear-gradient(135deg,#3b82f6,#6366f1)", color: "#fff", fontSize: 11, fontWeight: 700, padding: "4px 14px", borderRadius: 20 }}>הכי פופולרי ⭐</div>
            <div style={{ fontSize: 14, fontWeight: 600, color: "#818cf8", marginBottom: 8 }}>פרו</div>
            <div style={{ fontSize: 40, fontWeight: 900, marginBottom: 4 }}>₪39<span style={{ fontSize: 16, fontWeight: 500, color: "#666" }}>/חודש</span></div>
            <div style={{ fontSize: 13, color: "#666", marginBottom: 24 }}>120 דקות לחודש</div>
            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 12, marginBottom: 24 }}>
              {["120 דקות תמלול", "100+ שפות", "תיקון AI מתקדם", "מצב TikTok", "תמיכה בצ׳אט"].map((f, i) => (
                <div key={i} style={{ fontSize: 14, color: "#aaa", display: "flex", gap: 8 }}><span style={{ color: "#34d399" }}>✓</span>{f}</div>
              ))}
            </div>
            <a href="/auth" style={{ display: "block", textAlign: "center", padding: 14, borderRadius: 10, background: "linear-gradient(135deg,#3b82f6,#6366f1)", color: "#fff", textDecoration: "none", fontWeight: 700, fontSize: 14, boxShadow: "0 4px 20px rgba(99,102,241,0.3)" }}>שדרג לפרו</a>
          </div>
          {/* Studio */}
          <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 20, padding: 32, display: "flex", flexDirection: "column" }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: "#c084fc", marginBottom: 8 }}>סטודיו</div>
            <div style={{ fontSize: 40, fontWeight: 900, marginBottom: 4 }}>₪99<span style={{ fontSize: 16, fontWeight: 500, color: "#666" }}>/חודש</span></div>
            <div style={{ fontSize: 13, color: "#666", marginBottom: 24 }}>500 דקות לחודש</div>
            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 12, marginBottom: 24 }}>
              {["500 דקות תמלול", "100+ שפות", "תיקון AI מתקדם", "מצב TikTok", "תמיכה VIP", "API גישה"].map((f, i) => (
                <div key={i} style={{ fontSize: 14, color: "#aaa", display: "flex", gap: 8 }}><span style={{ color: "#34d399" }}>✓</span>{f}</div>
              ))}
            </div>
            <a href="/auth" style={{ display: "block", textAlign: "center", padding: 14, borderRadius: 10, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", color: "#c8c8e0", textDecoration: "none", fontWeight: 700, fontSize: 14 }}>שדרג לסטודיו</a>
          </div>
        </div>
      </section>

      {/* ── CTA ── */}
      <section style={{ padding: "80px 24px", textAlign: "center" }}>
        <div style={{ maxWidth: 600, margin: "0 auto", background: "linear-gradient(135deg, rgba(59,130,246,0.1), rgba(99,102,241,0.05))", border: "1px solid rgba(99,102,241,0.2)", borderRadius: 24, padding: "48px 32px" }}>
          <h2 style={{ fontSize: 28, fontWeight: 900, marginBottom: 12 }}>מוכן לתמלל?</h2>
          <p style={{ color: "#8888aa", marginBottom: 28, fontSize: 15 }}>10 דקות חינם, בלי כרטיס אשראי</p>
          <a href="/auth" style={{ display: "inline-block", padding: "16px 48px", borderRadius: 12, background: "linear-gradient(135deg,#3b82f6,#6366f1)", color: "#fff", textDecoration: "none", fontSize: 17, fontWeight: 800, boxShadow: "0 8px 32px rgba(99,102,241,0.3)" }}>התחל עכשיו בחינם →</a>
        </div>
      </section>

      {/* ── Footer ── */}
      <footer style={{ borderTop: "1px solid rgba(255,255,255,0.06)", padding: "32px 24px", textAlign: "center" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, marginBottom: 12 }}>
          <div style={{ width: 28, height: 28, borderRadius: 8, background: "linear-gradient(135deg,#3b82f6,#818cf8)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, fontWeight: 900, color: "#fff" }}>S</div>
          <span style={{ fontSize: 16, fontWeight: 700 }}>Sub<span style={{ color: "#818cf8" }}>AI</span></span>
        </div>
        <div style={{ fontSize: 13, color: "#444460" }}>© 2026 SubAI — כתוביות AI לפרמייר פרו</div>
      </footer>
    </div>
  );
}
