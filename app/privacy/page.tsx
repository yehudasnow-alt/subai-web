"use client";
import Link from "next/link";
import Nav from "../../components/Nav";

export default function Privacy() {
  return (
    <div className="page-wrap">
      <div className="mesh-bg"><div className="blob b1" /><div className="blob b2" /></div>
      <Nav />
      <div style={{ maxWidth: 720, margin: "0 auto", padding: "120px 20px 80px", position: "relative", zIndex: 1 }}>
        <div className="glass-card" style={{ borderRadius: 24, padding: "40px 36px" }}>
          <h1 style={{ fontSize: 28, fontWeight: 800, marginBottom: 8, color: "#1a1a2e" }}>מדיניות פרטיות</h1>
          <p style={{ fontSize: 13, color: "#999", marginBottom: 32 }}>עדכון אחרון: מרץ 2026</p>

          <Section title="מי אנחנו">
            SubAI הוא שירות תמלול אוטומטי בעברית המבוסס על בינה מלאכותית. השירות מופעל כפלאגין ל-Adobe Premiere Pro ודרך אתר subai-web.vercel.app.
          </Section>

          <Section title="מידע שאנחנו אוספים">
            כשאתה נרשם לשירות, אנו אוספים את כתובת האימייל שלך ושמך (דרך Google Sign-In). בנוסף, אנו שומרים נתוני שימוש כגון כמות דקות תמלול, שפת התמלול ותאריכי שימוש — לצורך ניהול המכסה שלך בלבד.
          </Section>

          <Section title="קבצי אודיו">
            קבצי האודיו שאתה מעלה לתמלול נשמרים באופן זמני בלבד לצורך עיבוד, ונמחקים אוטומטית מיד לאחר השלמת התמלול. אנחנו לא שומרים, מאזינים או משתמשים בתוכן האודיו שלך לשום מטרה אחרת.
          </Section>

          <Section title="תשלומים">
            התשלומים מעובדים דרך Stripe. אנחנו לא שומרים את פרטי כרטיס האשראי שלך — הם נשמרים ישירות ובאופן מאובטח אצל Stripe.
          </Section>

          <Section title="שיתוף מידע">
            אנחנו לא מוכרים, משכירים או משתפים את המידע האישי שלך עם צדדים שלישיים, למעט ספקי שירות חיוניים להפעלת המערכת (Google Auth, Stripe, שרתי ענן).
          </Section>

          <Section title="אבטחת מידע">
            אנו משתמשים בהצפנת SSL, אימות מאובטח, והרשאות גישה מוגבלות (Row Level Security) כדי להגן על המידע שלך.
          </Section>

          <Section title="מחיקת חשבון">
            תוכל לבקש מחיקת חשבון ומידע בכל עת על ידי פנייה אלינו בכתובת snow333b@gmail.com. נמחק את כל המידע שלך תוך 30 יום.
          </Section>

          <Section title="שינויים במדיניות">
            אנו עשויים לעדכן מדיניות זו מעת לעת. שינויים מהותיים יפורסמו באתר.
          </Section>

          <Section title="יצירת קשר">
            לכל שאלה בנוגע לפרטיות: snow333b@gmail.com
          </Section>
        </div>

        <div style={{ textAlign: "center", marginTop: 24 }}>
          <Link href="/" style={{ fontSize: 13, color: "#888" }}>← חזרה לדף הראשי</Link>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <h2 style={{ fontSize: 17, fontWeight: 700, color: "#1a1a2e", marginBottom: 6 }}>{title}</h2>
      <p style={{ fontSize: 14, color: "#555", lineHeight: 1.8 }}>{children}</p>
    </div>
  );
}
