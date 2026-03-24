"use client";
import { useEffect, useState } from "react";
import Link from "next/link";

export default function Home() {
  const [v, setV] = useState(false);
  useEffect(() => { setV(true); }, []);
  const a = (d: number) => ({ opacity: v ? 1 : 0, transform: v ? "translateY(0)" : "translateY(40px)", transition: `all 0.9s cubic-bezier(0.16,1,0.3,1) ${d}s` });

  return (
    <div className="page-wrap">
      {/* ── Mesh gradient background ── */}
      <div className="mesh-bg">
        <div className="blob b1" /><div className="blob b2" /><div className="blob b3" /><div className="blob b4" />
      </div>

      {/* ── Nav ── */}
      <nav className="nav-glass">
        <Link href="/" className="nav-logo">
          <div className="logo-icon">S</div>
          <span className="logo-text">Sub<span>AI</span></span>
        </Link>
        <div className="nav-links">
          <a href="#features">יתרונות</a>
          <a href="#how">איך זה עובד</a>
          <a href="#pricing">מחירים</a>
          <Link href="/auth" className="nav-cta">התחל בחינם</Link>
        </div>
      </nav>

      {/* ── Hero ── */}
      <section className="hero">
        <div style={a(0)}>
          <div className="hero-badge">✨ Whisper AI + Claude — תמלול וטקסט מושלמים</div>
        </div>
        <h1 style={a(0.1)}>
          כתוביות AI בעברית<br />
          <span className="grad-text">ישירות בפרמייר פרו</span>
        </h1>
        <p className="hero-sub" style={a(0.2)}>
          תמלול אוטומטי בעברית, ערבית ואנגלית עם דיוק מרשים.<br />
          הכתוביות נכנסות ישירות לטיימליין — לחיצה אחת וזהו.
        </p>
        <div className="hero-btns" style={a(0.3)}>
          <Link href="/auth" className="btn-primary">התחל בחינם — 10 דקות מתנה</Link>
          <a href="#pricing" className="btn-ghost">ראה מחירים ←</a>
        </div>
        {/* Glass demo card */}
        <div className="hero-demo glass-card" style={a(0.5)}>
          <div className="demo-bar">
            <div className="demo-dots"><span /><span /><span /></div>
            <span className="demo-title">Adobe Premiere Pro — SubAI</span>
          </div>
          <div className="demo-content">
            <div className="demo-track">
              <div className="demo-label">C1 Subtitle</div>
              <div className="demo-clips">
                <div className="demo-clip" style={{width:"22%"}}>שלום, היום נדבר על...</div>
                <div className="demo-clip" style={{width:"18%"}}>הנושא המרכזי הוא</div>
                <div className="demo-clip" style={{width:"25%"}}>בואו נצלול לעומק</div>
                <div className="demo-clip" style={{width:"15%"}}>לסיכום</div>
              </div>
            </div>
            <div className="demo-track">
              <div className="demo-label">V1 Video</div>
              <div className="demo-video" />
            </div>
            <div className="demo-track">
              <div className="demo-label">A1 Audio</div>
              <div className="demo-wave" />
            </div>
          </div>
        </div>
      </section>

      {/* ── Stats ── */}
      <section className="stats" style={a(0.3)}>
        {[["99%","דיוק בעברית"],["10 שניות","לדקת תמלול"],["100+","שפות נתמכות"],["0","התקנות נוספות"]].map(([v,l],i)=>(
          <div key={i} className="stat-item">
            <div className="stat-val">{v}</div>
            <div className="stat-label">{l}</div>
          </div>
        ))}
      </section>

      {/* ── Features ── */}
      <section id="features" className="section">
        <h2 className="sec-title">למה SubAI?</h2>
        <p className="sec-sub">הכלי הכי מתקדם לכתוביות בעברית — מבוסס AI מהדור האחרון</p>
        <div className="feat-grid">
          {[
            ["🎯","דיוק שאין כמותו","Whisper large-v3 הוא המודל הכי מדויק בעולם לזיהוי דיבור. הוספנו שכבת AI של Claude לתיקון דקדוק ופיסוק."],
            ["⚡","מהירות בזק","דקה של אודיו? 10 שניות תמלול. שעה? פחות מ-3 דקות. הכל בענן על GPU ייעודי."],
            ["🔤","עברית ברמה אחרת","אופטימיזציה מיוחדת לעברית — פיסוק מדויק, זיהוי שמות, ומילים מקצועיות."],
            ["🎬","בתוך Premiere","פלאגין מובנה בתוך Premiere Pro. סמן In/Out, לחץ כפתור — הכתוביות בטיימליין."],
            ["📱","מצב TikTok","כתוביות מילה-מילה או 2 מילים — מושלם ל-Reels, TikTok, Shorts ו-YouTube."],
            ["🤖","תיקון AI אוטומטי","Claude AI עובר על כל תמלול ומתקן שגיאות, מילים כפולות ופיסוק שגוי."]
          ].map(([icon,title,desc],i)=>(
            <div key={i} className="feat-card glass-card">
              <div className="feat-icon">{icon}</div>
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
          {[
            ["01","סמן In/Out","סמן את הקטע בטיימליין של Premiere Pro שרוצים לתמלל."],
            ["02","לחץ ״תמלל״","SubAI מייצא אודיו, שולח לענן ומקבל תמלול מדויק."],
            ["03","AI מתקן","Claude עובר על הטקסט ומתקן דקדוק, פיסוק ושגיאות."],
            ["04","כתוביות מוכנות","SRT נכנס ישירות ל-Caption Track — ערוך ויצא."]
          ].map(([num,title,desc],i)=>(
            <div key={i} className="step-card glass-card">
              <div className="step-num">{num}</div>
              <div className="step-title">{title}</div>
              <div className="step-desc">{desc}</div>
            </div>
          ))}
        </div>
      </section>

      {/* ── Pricing ── */}
      <section id="pricing" className="section">
        <h2 className="sec-title">מחירים</h2>
        <p className="sec-sub">התחל בחינם. שדרג כשתרצה. בטל מתי שרוצים.</p>
        <div className="price-grid">
          {/* Free */}
          <div className="price-card glass-card">
            <div className="price-name">חינמי</div>
            <div className="price-amount">₪0</div>
            <div className="price-period">לנצח</div>
            <ul className="price-features">
              <li>10 דקות תמלול</li><li>עברית + אנגלית</li><li>תיקון AI</li><li>כתוביות בטיימליין</li>
            </ul>
            <Link href="/auth" className="price-btn">התחל בחינם</Link>
          </div>
          {/* Pro */}
          <div className="price-card glass-card popular">
            <div className="popular-tag">הכי פופולרי</div>
            <div className="price-name">פרו</div>
            <div className="price-amount">₪39<span>/חודש</span></div>
            <div className="price-period">120 דקות לחודש</div>
            <ul className="price-features">
              <li>120 דקות תמלול</li><li>100+ שפות</li><li>תיקון AI מתקדם</li><li>מצב TikTok</li><li>תמיכה מהירה</li>
            </ul>
            <Link href="/auth" className="price-btn primary">שדרג לפרו ←</Link>
          </div>
          {/* Studio */}
          <div className="price-card glass-card">
            <div className="price-name">סטודיו</div>
            <div className="price-amount">₪99<span>/חודש</span></div>
            <div className="price-period">500 דקות לחודש</div>
            <ul className="price-features">
              <li>500 דקות תמלול</li><li>100+ שפות</li><li>תיקון AI מתקדם</li><li>מצב TikTok</li><li>תמיכה VIP</li><li>עדיפות בתור</li>
            </ul>
            <Link href="/auth" className="price-btn">שדרג לסטודיו</Link>
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
          <div className="nav-logo" style={{gap:8}}>
            <div className="logo-icon" style={{width:28,height:28,fontSize:14,borderRadius:8}}>S</div>
            <span className="logo-text" style={{fontSize:16}}>Sub<span>AI</span></span>
          </div>
          <div className="footer-links">
            <a href="#features">יתרונות</a>
            <a href="#pricing">מחירים</a>
            <Link href="/auth">התחברות</Link>
          </div>
          <div className="footer-copy">© 2026 SubAI — כתוביות AI לפרמייר פרו</div>
        </div>
      </footer>
    </div>
  );
}
