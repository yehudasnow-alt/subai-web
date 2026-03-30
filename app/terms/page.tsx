"use client";
import Link from "next/link";
import Nav from "../../components/Nav";

export default function Terms() {
  return (
    <div className="page-wrap">
      <div className="mesh-bg"><div className="blob b1" /><div className="blob b2" /></div>
      <Nav />
      <div style={{ maxWidth: 720, margin: "0 auto", padding: "120px 20px 80px", position: "relative", zIndex: 1 }}>
        <div className="glass-card" style={{ borderRadius: 24, padding: "40px 36px" }}>
          <h1 style={{ fontSize: 28, fontWeight: 800, marginBottom: 8, color: "#1a1a2e" }}>תנאי שימוש</h1>
          <p style={{ fontSize: 13, color: "#999", marginBottom: 32 }}>עדכון אחרון: מרץ 2026</p>

          <Section title="קבלת התנאים">
            בשימוש בשירות SubAI, אתה מסכים לתנאים אלה. אם אינך מסכים, אל תשתמש בשירות.
          </Section>

          <Section title="תיאור השירות">
            SubAI מספק שירות תמלול אוטומטי בעברית באמצעות בינה מלאכותית. השירות כולל פלאגין ל-Adobe Premiere Pro, תיקון טקסט חכם והכנסת כתוביות ישירות לתוכנה.
          </Section>

          <Section title="חשבון משתמש">
            עליך ליצור חשבון כדי להשתמש בשירות. אתה אחראי לשמור על אבטחת החשבון שלך ולא לשתף את מפתח ה-API שלך עם אחרים.
          </Section>

          <Section title="חבילות דקות ותשלומים">
            SubAI מציע חבילות דקות לרכישה חד-פעמית. דקות שנרכשו אינן פוקעות ואינן ניתנות להחזר לאחר שימוש. ניתן לקנות חבילות נוספות בכל עת. הנסיון החינמי (10 דקות) ניתן פעם אחת בלבד לכל משתמש.
          </Section>

          <Section title="שימוש הוגן">
            אסור להשתמש בשירות באופן שמפר חוקים, פוגע במערכת או מנצל את השירות לרעה. שימוש לא סביר עלול לגרום להשעיית החשבון.
          </Section>

          <Section title="קניין רוחני">
            התמלולים שנוצרים הם שלך. SubAI לא טוען בעלות על התוכן שלך. אנחנו לא שומרים את קבצי האודיו לאחר התמלול.
          </Section>

          <Section title="זמינות השירות">
            אנו שואפים לזמינות גבוהה, אך לא מתחייבים לזמינות של 100%. השירות ניתן "כמות שהוא" (as is) ללא אחריות מפורשת או משתמעת.
          </Section>

          <Section title="הגבלת אחריות">
            SubAI לא יישא באחריות לנזקים ישירים או עקיפים הנובעים מהשימוש בשירות, כולל אי-דיוקים בתמלול. מומלץ תמיד לבדוק את התמלול לפני פרסום.
          </Section>

          <Section title="שינויים בתנאים">
            אנו רשאים לעדכן תנאים אלה. המשך שימוש בשירות לאחר עדכון מהווה הסכמה לתנאים המעודכנים.
          </Section>

          <Section title="יצירת קשר">
            לכל שאלה: snow333b@gmail.com
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
