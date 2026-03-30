import "./globals.css";
import type { Metadata } from "next";
export const metadata: Metadata = {
  title: "SubAI — כתוביות AI בעברית לפרמייר פרו",
  description: "תמלול אוטומטי מדויק בעברית ישירות בתוך Adobe Premiere Pro. מופעל על ידי Whisper AI + Claude.",
  keywords: "כתוביות, תמלול, עברית, Premiere Pro, AI, Whisper, פלאגין, subtitle, transcription",
  openGraph: {
    title: "SubAI — כתוביות AI לפרמייר פרו",
    description: "תמלול אוטומטי מדויק בעברית ישירות בתוך Premiere Pro",
    type: "website",
    siteName: "SubAI",
  },
  verification: {
    google: "BnaHBDpFLqb7f8eTjb84LKNlSOQpFajr_cL1K2QrFIw",
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
