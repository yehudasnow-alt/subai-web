import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "SubAI — כתוביות AI בעברית לפרמייר פרו",
  description: "תמלול אוטומטי מדויק בעברית ישירות בתוך Adobe Premiere Pro. מופעל על ידי Whisper AI + Claude.",
  keywords: "כתוביות, תמלול, עברית, Premiere Pro, AI, Whisper, פלאגין",
  openGraph: {
    title: "SubAI — כתוביות AI לפרמייר פרו",
    description: "תמלול אוטומטי מדויק בעברית ישירות בתוך Premiere Pro",
    type: "website",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="he" dir="rtl">
      <body>{children}</body>
    </html>
  );
}
