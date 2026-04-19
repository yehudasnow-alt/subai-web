import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "SubAI — כתוביות אוטומטיות בעברית לפרמייר פרו",
  description: "תוסף כתוביות אוטומטי ל-Adobe Premiere Pro. תמלול בעברית, אנגלית וערבית עם AI. ייצוא SRT ישירות לטיימליין. הכי מדויק בשוק הישראלי.",
  keywords: "כתוביות פרמייר פרו, תמלול אוטומטי עברית, כתוביות אוטומטיות, תוסף כתוביות, SRT עברית, subtitle premiere pro, תמלול וידאו, כתוביות לסרטונים, תמלול AI, כתוביות טיקטוק, כתוביות רילס, עריכת וידאו",
  openGraph: {
    title: "SubAI — כתוביות AI לפרמייר פרו",
    description: "תמלול אוטומטי מדויק בעברית ישירות בתוך Premiere Pro. התקנה בדקה, תמלול ב-30 שניות.",
    type: "website",
    siteName: "SubAI",
    url: "https://www.subai.co.il",
    locale: "he_IL",
  },
  verification: {
    google: "BnaHBDpFLqb7f8eTjb84LKNlSOQpFajr_cL1K2QrFIw",
  },
  alternates: {
    canonical: "https://www.subai.co.il",
  },
  robots: {
    index: true,
    follow: true,
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="he" dir="rtl">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
      </head>
      <body>{children}</body>
    </html>
  );
}
