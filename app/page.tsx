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
        .section { overflow: visible !important; }
      `}</style>
      <div className="mesh-bg"><div className="blob b1" /><div className="blob b2" /><div className="blob b3" /><div className="blob b4" /></div>
      <Nav />

      {/* ── Hero ── */}
      <section className="hero" style={{ position: "relative", overflow: "visible" }}>
        {/* 3D Animation - left side (desktop only) */}
        <div className="scroll-3d-wrap" style={{
          position: "absolute",
          left: "-560px",
          top: "50%",
          transform: "translateY(-45%) rotate(-12deg)",
          width: "714px",
          height: "714px",
          zIndex: 1,
          opacity: v ? 0.85 : 0,
          transition: "opacity 1.2s ease 0.4s",
        }}>
          <ScrollAnimation framesDir="/frames" totalFrames={96} scrollStart={0} scrollEnd={0.10} />
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
      <section id="features" className="section" style={{ position: "relative", overflow: "visible" }}>
        {/* 3D Animation 2 - right side (desktop only) */}
        <div className="scroll-3d-wrap" style={{
          position: "absolute",
          right: "-450px",
          top: "-10%",
          transform: "rotate(15deg)",
          width: "600px",
          height: "600px",
          zIndex: 1,
          opacity: 0.7,
        }}>
          <ScrollAnimation framesDir="/frames2" totalFrames={96} scrollStart={0.08} scrollEnd={0.20} />
        </div>
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
      <section id="how" className="section" style={{ position: "relative", overflow: "visible" }}>
        {/* 3D Animation 3 - left side (desktop only) */}
        <div className="scroll-3d-wrap" style={{
          position: "absolute",
          left: "-450px",
          top: "-20%",
          transform: "rotate(-10deg)",
          width: "600px",
          height: "600px",
          zIndex: 1,
          opacity: 0.7,
        }}>
          <ScrollAnimation framesDir="/frames3" totalFrames={105} scrollStart={0.22} scrollEnd={0.34} />
        </div>
        <h2 className="sec-title">איך זה עובד?</h2>
        <p className="sec-sub">4 שלבים פשוטים — מתמלול ועד כתוביות מוכנות</p>
        <div className="steps-wrap">
          {[["01","סמן In/Out","סמן את הקטע בטיימליין של Premiere Pro."],["02","לחץ ״תמלל״","SubAI שולח לענן ומקבל תמלול מדויק."],["03","AI מתקן","Claude מתקן דקדוק, פיסוק ושגיאות."],["04","כתוביות מוכנות","SRT נכנס ל-Caption Track — ערוך ויצא."]].map(([num,title,desc],i)=>(
            <div key={i} className="step-card glass-card"><div className="step-num">{num}</div><div className="step-title">{title}</div><div className="step-desc">{desc}</div></div>
          ))}
        </div>
      </section>

      {/* ── Pricing ── */}
      <section id="pricing" className="section" style={{ position: "relative", overflow: "visible" }}>
        {/* 3D Animation 4 - right side (desktop only) */}
        <div className="scroll-3d-wrap" style={{
          position: "absolute",
          right: "-400px",
          top: "0%",
          transform: "rotate(8deg)",
          width: "550px",
          height: "550px",
          zIndex: 1,
          opacity: 0.7,
        }}>
          <ScrollAnimation framesDir="/frames4" totalFrames={96} scrollStart={0.33} scrollEnd={0.45} />
        </div>
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
      <section className="section" style={{paddingBottom:60}}>
        <div className="cta-card glass-card">
          <h2>מוכן להתחיל?</h2>
          <p>10 דקות תמלול בחינם. בלי כרטיס אשראי. בלי התחייבות.</p>
          <Link href="/auth" className="btn-primary" style={{fontSize:18}}>התחל עכשיו בחינם →</Link>
        </div>
      </section>

      {/* ── SEO Content ── */}
      <section className="section" style={{ paddingBottom: 60 }}>
        <div style={{ maxWidth: 800, margin: "0 auto", padding: "0 20px" }}>

          <h2 className="sec-title">כתוביות אוטומטיות בעברית — למה SubAI?</h2>
          <p style={{ fontSize: 15, lineHeight: 1.9, color: "#555", textAlign: "center", marginBottom: 48 }}>
            SubAI הוא תוסף כתוביות אוטומטי ל-Adobe Premiere Pro שמאפשר תמלול מדויק בעברית,.
            במקום לשבת שעות על כתיבת כתוביות ידנית — פשוט סמן את הקטע בטיימליין, לחץ כפתור אחד, וקבל כתוביות מוכנות תוך שניות.
            SubAI משתמש בטכנולוגיית Whisper AI של OpenAI בשילוב Claude AI של Anthropic כדי להבטיח דיוק מקסימלי בעברית.
          </p>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: 32, marginBottom: 48 }}>

            <div className="glass-card" style={{ borderRadius: 20, padding: "28px 24px" }}>
              <h3 style={{ fontSize: 17, fontWeight: 700, color: "#1a1a2e", marginBottom: 12 }}>תמלול וידאו בעברית — איך זה עובד?</h3>
              <p style={{ fontSize: 14, lineHeight: 1.85, color: "#666" }}>
                SubAI שולח את האודיו לשרתי ענן עם GPU ייעודי שמריץ את מודל Whisper large-v3 —
                המודל הכי מדויק בעולם לתמלול אוטומטי. לאחר התמלול, שכבת AI של Claude עוברת על הטקסט
                ומתקנת שגיאות כתיב, פיסוק ודקדוק. התוצאה: קובץ SRT מדויק שנכנס ישירות ל-Caption Track
                בתוך Premiere Pro — בלי לצאת מהתוכנה.
              </p>
            </div>

            <div className="glass-card" style={{ borderRadius: 20, padding: "28px 24px" }}>
              <h3 style={{ fontSize: 17, fontWeight: 700, color: "#1a1a2e", marginBottom: 12 }}>כתוביות לטיקטוק, רילס ויוטיוב</h3>
              <p style={{ fontSize: 14, lineHeight: 1.85, color: "#666" }}>
                מצב TikTok של SubAI יוצר כתוביות מילה-מילה — בדיוק כמו שרואים בסרטונים הכי פופולריים.
                כל מילה מופיעה בתזמון מדויק, מה שמגביר צפיות ומעורבות.
                מתאים לקליפים קצרים, סרטוני Reels, YouTube Shorts, סטוריז ברשתות החברתיות,
                וכל תוכן וידאו שדורש כתוביות דינמיות ומרשימות.
              </p>
            </div>

            <div className="glass-card" style={{ borderRadius: 20, padding: "28px 24px" }}>
              <h3 style={{ fontSize: 17, fontWeight: 700, color: "#1a1a2e", marginBottom: 12 }}>למי SubAI מתאים?</h3>
              <p style={{ fontSize: 14, lineHeight: 1.85, color: "#666" }}>
                עורכי וידאו שעובדים עם לקוחות ישראלים וצריכים כתוביות בעברית.
                יוצרי תוכן שמעלים סרטונים ליוטיוב, טיקטוק, אינסטגרם ופייסבוק.
                סטודיואים ובתי הפקה שצריכים תמלול מהיר ומדויק לפרויקטים.
                פרילנסרים בתחום עריכת הוידאו שרוצים לחסוך שעות עבודה על כתוביות ידניות.
              </p>
            </div>

            <div className="glass-card" style={{ borderRadius: 20, padding: "28px 24px" }}>
              <h3 style={{ fontSize: 17, fontWeight: 700, color: "#1a1a2e", marginBottom: 12 }}>יתרונות על כלי תמלול אחרים</h3>
              <p style={{ fontSize: 14, lineHeight: 1.85, color: "#666" }}>
                בניגוד לכלים חיצוניים כמו Kapwing, Veed או Happy Scribe — SubAI עובד ישירות בתוך Premiere Pro.
                אין צורך לייצא אודיו, להעלות לאתר, לחכות, להוריד SRT ולייבא חזרה.
                הכל קורה בלחיצה אחת מתוך התוכנה. בנוסף, SubAI מותאם במיוחד לעברית —
                עם תיקון AI שמבין דקדוק עברי, גרשיים, ראשי תיבות ושמות בעברית.
              </p>
            </div>
          </div>

          <div className="glass-card" style={{ borderRadius: 20, padding: "32px 28px", marginBottom: 32 }}>
            <h3 style={{ fontSize: 18, fontWeight: 700, color: "#1a1a2e", marginBottom: 20, textAlign: "center" }}>שאלות נפוצות</h3>
            {[
              ["האם SubAI עובד רק עם עברית?", "כן. SubAI תומך בתמלול בעברית. המודל מומחה לשפה העברית."],
              ["האם צריך חיבור לאינטרנט?", "כן. התמלול מתבצע בענן על שרתי GPU חזקים — זה מה שמאפשר תמלול מהיר ומדויק בלי לעמיס על המחשב שלך."],
              ["כמה זמן לוקח לתמלל?", "תמלול של סרטון בן 3 דקות לוקח בערך 15-30 שניות. סרטון של 10 דקות — כדקה."],
              ["האם אפשר לערוך את הכתוביות אחרי התמלול?", "בוודאי. הכתוביות נכנסות כ-Caption Track רגיל בפרמייר — אפשר לערוך, לזוז ולעצב כמו כל טקסט."],
              ["מה ההבדל בין SubAI לתמלול המובנה של פרמייר?", "התמלול המובנה של Premiere לא תומך בעברית. SubAI נבנה במיוחד לעברית עם מודל Whisper ותיקון AI."],
              ["האם הכתוביות נשמרות בפרויקט?", "כן. ברגע שהכתוביות נכנסות ל-Caption Track הן חלק מהפרויקט ונשמרות איתו."],
            ].map(([q, ans], i) => (
              <div key={i} style={{ marginBottom: i < 5 ? 20 : 0, paddingBottom: i < 5 ? 20 : 0, borderBottom: i < 5 ? "1px solid rgba(0,0,0,0.06)" : "none" }}>
                <div style={{ fontSize: 15, fontWeight: 600, color: "#1a1a2e", marginBottom: 6 }}>{q}</div>
                <div style={{ fontSize: 14, lineHeight: 1.8, color: "#666" }}>{ans}</div>
              </div>
            ))}
          </div>

        </div>
      </section>

      {/* ── Footer ── */}
      <footer className="footer">
        <div className="footer-inner">
          <Link href="/" className="nav-logo" style={{gap:8, textDecoration:"none"}}><img src="/icons/subai-logo.webp" alt="SubAI" style={{height:48, objectFit:"contain"}} /></Link>
          <div className="footer-links"><a href="#features">יתרונות</a><a href="#pricing">מחירים</a><Link href="/privacy">פרטיות</Link><Link href="/terms">תנאי שימוש</Link><Link href="/auth">התחברות</Link></div>
          <div className="footer-copy">© 2026 SubAI — כתוביות AI לפרמייר פרו</div>
        </div>
      </footer>
    </div>
  );
}
