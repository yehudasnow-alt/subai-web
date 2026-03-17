"use client";

export default function Home() {
  return (
    <div style={{ background: "#0a0a0f", color: "#e8e8ee", fontFamily: "'Heebo',sans-serif", minHeight: "100vh" }}>
      {/* Grid bg */}
      <div style={{ position: "fixed", inset: 0, zIndex: 0, pointerEvents: "none", opacity: 0.06,
        backgroundImage: "linear-gradient(#252530 1px,transparent 1px),linear-gradient(90deg,#252530 1px,transparent 1px)",
        backgroundSize: "80px 80px" }} />
      <div style={{ position: "fixed", top: -200, left: "50%", transform: "translateX(-50%)",
        width: 800, height: 600, borderRadius: "50%", pointerEvents: "none", opacity: 0.4, zIndex: 0,
        background: "radial-gradient(ellipse,rgba(59,130,246,0.25),transparent 70%)" }} />

      {/* Nav */}
      <nav style={{ position: "fixed", top: 0, left: 0, right: 0, zIndex: 100, padding: "16px 0",
        background: "rgba(10,10,15,0.8)", backdropFilter: "blur(20px)", borderBottom: "1px solid #252530" }}>
        <div style={{ maxWidth: 1100, margin: "0 auto", padding: "0 24px",
          display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 36, height: 36, borderRadius: 10,
              background: "linear-gradient(135deg,#3b82f6,#7c3aed)",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 18, fontWeight: 700, color: "#fff" }}>S</div>
            <div style={{ fontSize: 20, fontWeight: 700 }}>Sub<span style={{ color: "#60a5fa" }}>AI</span></div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
            <a href="#pricing" style={{ color: "#8b8b9e", fontSize: 14, textDecoration: "none" }}>תמחור</a>
            <a href="/auth" style={{
              padding: "9px 22px", borderRadius: 8, fontSize: 13, fontWeight: 500,
              background: "#3b82f6", color: "#fff", textDecoration: "none",
            }}>התחל בחינם →</a>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section style={{ position: "relative", zIndex: 1, padding: "160px 24px 100px", textAlign: "center" }}>
        <div style={{ maxWidth: 800, margin: "0 auto" }}>
          <div style={{
            display: "inline-flex", alignItems: "center", gap: 8,
            padding: "6px 16px", borderRadius: 30, fontSize: 13, fontWeight: 500,
            background: "rgba(34,197,94,0.12)", border: "1px solid rgba(34,197,94,0.3)", color: "#22c55e",
            marginBottom: 28,
          }}>Beta פתוחה — 30 דקות חינם</div>

          <h1 style={{ fontSize: "clamp(36px,6vw,64px)", fontWeight: 900, lineHeight: 1.15, letterSpacing: -1, marginBottom: 20 }}>
            כתוביות עברית<br />
            <span style={{
              background: "linear-gradient(135deg,#60a5fa,#a78bfa,#ec4899)",
              WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
            }}>אוטומטיות ומדויקות</span><br />
            בתוך Premiere Pro
          </h1>

          <p style={{ fontSize: 18, color: "#8b8b9e", maxWidth: 560, margin: "0 auto 36px", fontWeight: 300, lineHeight: 1.8 }}>
            לחץ כפתור אחד בפרימייר — וקבל כתוביות מתוזמנות בטיימליין תוך שניות. AI שמבין עברית מושלם.
          </p>

          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 14, flexWrap: "wrap" }}>
            <a href="/auth" style={{
              display: "inline-flex", alignItems: "center", gap: 8,
              padding: "14px 32px", borderRadius: 10, fontSize: 16, fontWeight: 600,
              background: "linear-gradient(135deg,#3b82f6,#5b5bf6)", color: "#fff",
              textDecoration: "none", boxShadow: "0 4px 24px rgba(59,130,246,0.25)",
            }}>← התחל בחינם — 30 דקות מתנה</a>
          </div>
        </div>
      </section>

      {/* Stats */}
      <section style={{ position: "relative", zIndex: 1, padding: "60px 24px" }}>
        <div style={{ maxWidth: 900, margin: "0 auto", display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 16 }}>
          {[
            { num: "<30s", label: "לדקת אודיו", color: "#60a5fa" },
            { num: "97%", label: "דיוק בעברית", color: "#22c55e" },
            { num: "0", label: "הגדרות מסובכות", color: "#f59e0b" },
            { num: "99+", label: "שפות נתמכות", color: "#ec4899" },
          ].map((s, i) => (
            <div key={i} style={{ textAlign: "center", padding: 24, background: "#111118", border: "1px solid #252530", borderRadius: 12 }}>
              <div style={{ fontSize: 32, fontWeight: 800, color: s.color, fontFamily: "'Outfit',sans-serif" }}>{s.num}</div>
              <div style={{ fontSize: 12, color: "#5a5a6e", marginTop: 4 }}>{s.label}</div>
            </div>
          ))}
        </div>
      </section>

      {/* How it Works */}
      <section style={{ position: "relative", zIndex: 1, padding: "80px 24px", textAlign: "center" }}>
        <div style={{ maxWidth: 900, margin: "0 auto" }}>
          <div style={{ fontSize: 12, fontWeight: 500, color: "#60a5fa", textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 14 }}>⚡ פשוט ומהיר</div>
          <h2 style={{ fontSize: "clamp(28px,4vw,40px)", fontWeight: 800, marginBottom: 40 }}>שלושה שלבים ויש כתוביות</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 20 }}>
            {[
              { n: "1", t: "סמן את הטווח", d: "הגדר In/Out או בחר את כל הרצף." },
              { n: "2", t: 'לחץ "תמלל"', d: "האודיו נשלח לשרת GPU. 10 דקות תוך 30 שניות." },
              { n: "3", t: "כתוביות בטיימליין", d: "SRT מתוזמן חוזר ומיובא אוטומטית." },
            ].map((s, i) => (
              <div key={i} style={{ background: "#111118", border: "1px solid #252530", borderRadius: 12, padding: 28, textAlign: "right" }}>
                <div style={{
                  width: 40, height: 40, borderRadius: 10,
                  background: "linear-gradient(135deg,#3b82f6,#6366f1)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 16, fontWeight: 700, color: "#fff", marginBottom: 16,
                }}>{s.n}</div>
                <h3 style={{ fontSize: 17, fontWeight: 700, marginBottom: 8 }}>{s.t}</h3>
                <p style={{ fontSize: 13, color: "#8b8b9e", lineHeight: 1.8 }}>{s.d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" style={{ position: "relative", zIndex: 1, padding: "80px 24px", textAlign: "center" }}>
        <div style={{ maxWidth: 900, margin: "0 auto" }}>
          <h2 style={{ fontSize: "clamp(28px,4vw,40px)", fontWeight: 800, marginBottom: 40 }}>תוכנית לכל פרויקט</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 20 }}>
            {[
              { name: "חינמי", price: "0", cur: "₪", period: "לנצח", features: ["30 דקות מתנה", "כל השפות", "ייבוא לטיימליין"], pop: false },
              { name: "פרו", price: "39", cur: "₪/חודש", period: "120 דקות/חודש", features: ["120 דקות/חודש", "GPU מהיר", "תמיכה מהירה", "SRT + VTT"], pop: true },
              { name: "סטודיו", price: "99", cur: "₪/חודש", period: "500 דקות/חודש", features: ["500 דקות/חודש", "מהירות מקסימלית", "API ישיר", "חשבונית מס"], pop: false },
            ].map((p, i) => (
              <div key={i} style={{
                background: p.pop ? "linear-gradient(180deg,#111130,#111118)" : "#111118",
                border: p.pop ? "1px solid #3b82f6" : "1px solid #252530",
                borderRadius: 12, padding: "32px 26px", textAlign: "right", position: "relative",
              }}>
                {p.pop && <div style={{
                  position: "absolute", top: -12, right: 24, background: "linear-gradient(135deg,#3b82f6,#7c3aed)",
                  color: "#fff", fontSize: 11, fontWeight: 600, padding: "4px 14px", borderRadius: 20,
                }}>הכי פופולרי</div>}
                <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 6 }}>{p.name}</div>
                <div style={{ display: "flex", alignItems: "baseline", gap: 4, marginBottom: 4 }}>
                  <span style={{ fontSize: 42, fontWeight: 800, fontFamily: "'Outfit',sans-serif" }}>{p.price}</span>
                  <span style={{ fontSize: 16, color: "#8b8b9e" }}>{p.cur}</span>
                </div>
                <div style={{ fontSize: 13, color: "#5a5a6e", marginBottom: 20 }}>{p.period}</div>
                <ul style={{ listStyle: "none", marginBottom: 24 }}>
                  {p.features.map((f, j) => (
                    <li key={j} style={{ fontSize: 13, color: "#8b8b9e", padding: "6px 0", borderBottom: "1px solid #252530", display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ color: "#22c55e", fontWeight: 700 }}>✓</span>{f}
                    </li>
                  ))}
                </ul>
                <a href="/auth" style={{
                  display: "block", width: "100%", padding: 12, borderRadius: 8, fontSize: 14, fontWeight: 600,
                  textAlign: "center", textDecoration: "none",
                  ...(p.pop
                    ? { background: "linear-gradient(135deg,#3b82f6,#5b5bf6)", color: "#fff" }
                    : { background: "transparent", border: "1px solid #2f2f3d", color: "#e8e8ee" }),
                }}>
                  {p.pop ? "← בחר בפרו" : "התחל בחינם"}
                </a>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section style={{ position: "relative", zIndex: 1, padding: "80px 24px", textAlign: "center" }}>
        <div style={{
          maxWidth: 700, margin: "0 auto", padding: "60px 40px", borderRadius: 20,
          background: "linear-gradient(135deg,#111130,#0d1b3a)", border: "1px solid rgba(59,130,246,0.25)",
        }}>
          <h2 style={{ fontSize: 30, fontWeight: 800, marginBottom: 12 }}>מוכן לתמלל כמו מקצוען?</h2>
          <p style={{ color: "#8b8b9e", fontSize: 15, marginBottom: 28 }}>30 דקות חינם. בלי כרטיס אשראי.</p>
          <a href="/auth" style={{
            display: "inline-flex", padding: "14px 32px", borderRadius: 10, fontSize: 16, fontWeight: 600,
            background: "linear-gradient(135deg,#3b82f6,#5b5bf6)", color: "#fff", textDecoration: "none",
          }}>← צור חשבון חינם</a>
        </div>
      </section>

      {/* Footer */}
      <footer style={{ padding: 40, borderTop: "1px solid #252530", textAlign: "center", fontSize: 13, color: "#5a5a6e" }}>
        © 2026 SubAI. כל הזכויות שמורות.
      </footer>
    </div>
  );
}
