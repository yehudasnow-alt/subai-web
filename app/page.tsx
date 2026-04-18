"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Nav from "../components/Nav";
import ScrollAnimation from "../components/ScrollAnimation";

export default function Home() {
  const [v, setV] = useState(false);
  useEffect(() => { setV(true); }, []);
  const a = (d: number) => ({ opacity: v ? 1 : 0, transform: v ? "translateY(0)" : "translateY(40px)", transition: `all 0.9s cubic-bezier(0.16,1,0.3,1) ${d}s` });

  return (
    <div className="page-wrap" style={{ overflowX: "clip" }}>
      <style>{`
        @media (max-width: 768px) {
          .scroll-3d-wrap { display: none !important; }
        }
        .hero { overflow: visible !important; }
      `}</style>
      <div className="mesh-bg"><div className="blob b1" /><div className="blob b2" /><div className="blob b3" /><div className="blob b4" /></div>
      <Nav />

      {/* ── Hero ── */}
      <section className="hero" style={{ position: "relative", overflow: "visible" }}>
        {/* 3D Animation - left side (desktop only) */}
        <div className="scroll-3d-wrap" style={{
          position: "absolute",
          left: "-380px",
          top: "50%",
          transform: "translateY(-45%) rotate(-12deg)",
          width: "840px",
          height: "840px",
          zIndex: 1,
          opacity: v ? 0.85 : 0,
          transition: "opacity 1.2s ease 0.4s",
        }}>
          <ScrollAnimation />
        </div>

        <div style={a(0)}><div className="hero-badge"><span style={{display:"inline-block",width:24,height:24,overflow:"hidden",verticalAlign:"middle",marginLeft:6}}><img src="/icons/sparkles.png" alt="sparkles" style={{width:40,height:40,objectFit:"contain",marginTop:-8,marginRight:-8}} /></span> Whisper AI + Claude — תמלול וטקסט מושלמים</div></div>
        <h1 style={a(0.1)}>כתוביות AI בעברית<br /><span className="grad-text">ישירות בפרמייר פרו</span></h1>
        <p className="hero-sub" style={a(0.2)}>תמלול אוטומטי בעברית, עם דיוק מרשים.<br />הכתוביות נכנסות ישירות לתוכנה — לחיצה אחת וזהו.</p>
        <div className="hero-btns" style={a(0.3)}>
          <Link href="/auth" className="btn-primary">התחל בחינם — 10 דקות מתנה</Link>
          <a href="#pricing" className="btn-ghost">ראה מחירים ←</a>
        </div>
        <div className="hero-demo glass-card" style={a(0.5)}>
          <div className="demo-bar"><div className="demo-dots"><span /><span /><span /></div><span className="demo-title">Adobe Premiere Pro — SubAI</span></div>
          <div className="demo-content">
            <div className="demo-track"><div className="demo-label">C1 Subtitle</div><div className="demo-clips">
              <div className="demo-clip" style={{width:"22%"}}>שלום, היום נדבר על...</div>
              <div className="demo-clip" style={{width:"18%"}}>הנושא המרכזי הוא</div>
              <div className="demo-clip" style={{width:"25%"}}>בואו נצלול לעומק</div>
              <div className="demo-clip" style={{width:"15%"}}>לסיכום</div>
            </div></div>
            <div className="demo-track"><div className="demo-label">V1 Video</div><div className="demo-video" /></div>
            <div className="demo-track"><div className="demo-label">A1 Audio</div><div className="demo-wave" /></div>
          </div>
        </div>
      </section>

      {/* ── Stats ── */}
      <section className="stats" style={a(0.3)}>
        {[["95%","דיוק בעברית"],["GPU","תמלול בענן"],["AI","תיקון טקסט חכם"],["0","התקנות נוספות"]].map(([val,label],i)=>(
          <div key={i} className="stat-item"><div className="stat-val">{val}</div><div className="stat-label">{label}</div></div>
        ))}
      </section>

      {/* ── Features ── */}
      <section id="features" className="section">
        <h2 className="sec-title">למה SubAI?</h2>
        <p className="sec-sub">הכלי הכי מתקדם לכתוביות בעברית — מבוסס AI מהדור האחרון</p>
        <div className="feat-grid">
          {[
            ["/icons/target.png","דיוק שאין כמותו","Whisper large-v3 הוא המודל הכי מדויק בעולם. הוספנו שכבת AI של Claude לתיקון דקדוק ופיסוק."],
            ["/icons/lightning.png","מהיר ויעיל","תמלול בענן על GPU ייעודי. הכתוביות מוכנות תוך שניות."],
            ["/icons/letters.png","עברית ברמה אחרת","אופטימיזציה מיוחדת לעברית — פיסוק מדויק, זיהוי שמות, ומילים מקצועיות."],
            ["/icons/clapperboard.png","בתוך Premiere","פלאגין מובנה. סמן In/Out, לחץ כפתור — ייצוא ישר לתוכנה."],
            ["/icons/phone.png","מצב TikTok","כתוביות מילה-מילה — מושלם ל-Reels, TikTok, Shorts ו-YouTube."],
            ["/icons/robot.png","תיקון AI אוטומטי","Claude AI עובר על כל תמלול ומתקן שגיאות, מילים כפולות ופיסוק."]
          ].map(([icon,title,desc],i)=>(
            <div key={i} className="feat-card glass-card">
              <div className="feat-icon" style={{
                width: 90, height: 90,
                display: "flex", alignItems: "center", justifyContent: "center",
                marginBottom: 8, overflow: "hidden"
              }}>
                <img
                  src={icon}
                  alt={title}
                  style={{
                    width: 130,
                    height: 130,
                    objectFit: "contain",
                    filter: "drop-shadow(0 4px 12px rgba(124,58,237,0.3))"
                  }}
                />
              </div>
              <div className="feat-title">{title}</div>
              <div className="feat-desc">{desc}</div>
            </div>
          ))}
        </div>
      </section>

      {/* ── How it works ── */}
      <section id="how" className="section">
        <h2 className="sec-title">איך זה עובד?</h2>
        <p className="sec-sub">4 שלבים פשוטים — מתמלול ועד כתוביות מוכנות</p>
        <div className="steps-wrap">
          {[["01","סמן In/Out","סמן את הקטע בטיימליין של Premiere Pro."],["02","לחץ ״תמלל״","SubAI שולח לענן ומקבל תמלול מדויק."],["03","AI מתקן","Claude מתקן דקדוק, פיסוק ושגיאות."],["04","כתוביות מוכנות","SRT נכנס ל-Caption Track — ערוך ויצא."]].map(([num,title,desc],i)=>(
            <div key={i} className="step-card glass-card"><div className="step-num">{num}</div><div className="step-title">{title}</div><div className="step-desc">{desc}</div></div>
          ))}
        </div>
      </section>

      {/* ── Pricing ── */}
      <section id="pricing" className="section">
        <h2 className="sec-title">חבילות דקות</h2>
        <p className="sec-sub">קנה דקות. השתמש בקצב שלך. נגמר? קנה עוד.</p>
        <div className="price-grid">
          <div className="price-card glass-card">
            <div className="price-name">חינמי</div>
            <div className="price-amount">₪0</div>
            <div className="price-period">10 דקות לנסיון</div>
            <ul className="price-features">
              <li>10 דקות תמלול</li>
              <li>תמלול בעברית</li>
              <li>תיקון AI</li>
              <li>ייצוא ישר לתוכנה</li>
            </ul>
            <Link href="/auth" className="price-btn">התחל בחינם</Link>
          </div>
          <div className="price-card glass-card popular">
            <div className="popular-tag">הכי פופולרי</div>
            <div className="price-name">פרו</div>
            <div className="price-amount">₪59</div>
            <div className="price-period">120 דקות</div>
            <ul className="price-features">
              <li>120 דקות תמלול</li>
              <li>תיקון AI מתקדם</li>
              <li>מצב TikTok</li>
              <li>ייצוא ישר לתוכנה</li>
            </ul>
            <Link href="/api/checkout?plan=pro" className="price-btn primary">קנה חבילת פרו ←</Link>
          </div>
          <div className="price-card glass-card">
            <div className="price-name">סטודיו</div>
            <div className="price-amount">₪180</div>
            <div className="price-period">500 דקות</div>
            <ul className="price-features">
              <li>500 דקות תמלול</li>
              <li>תיקון AI מתקדם</li>
              <li>מצב TikTok</li>
              <li>ייצוא ישר לתוכנה</li>
            </ul>
            <Link href="/api/checkout?plan=studio" className="price-btn">קנה חבילת סטודיו</Link>
          </div>
        </div>
      </section>

      {/* ── CTA ── */}
      <section className="section" style={{paddingBottom:100}}>
        <div className="cta-card glass-card">
          <h2>מוכן להתחיל?</h2>
          <p>10 דקות תמלול בחינם. בלי כרטיס אשראי. בלי התחייבות.</p>
          <Link href="/auth" className="btn-primary" style={{fontSize:18}}>התחל עכשיו בחינם →</Link>
        </div>
      </section>

      {/* ── Footer ── */}
      <footer className="footer">
        <div className="footer-inner">
          <div className="nav-logo" style={{gap:8}}><div className="logo-icon" style={{width:28,height:28,fontSize:14,borderRadius:8}}>S</div><span className="logo-text" style={{fontSize:16}}>Sub<span>AI</span></span></div>
          <div className="footer-links"><a href="#features">יתרונות</a><a href="#pricing">מחירים</a><Link href="/privacy">פרטיות</Link><Link href="/terms">תנאי שימוש</Link><Link href="/auth">התחברות</Link></div>
          <div className="footer-copy">© 2026 SubAI — כתוביות AI לפרמייר פרו</div>
        </div>
      </footer>
    </div>
  );
}
