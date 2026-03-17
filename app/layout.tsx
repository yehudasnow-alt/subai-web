import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "SubAI — כתוביות AI לפרימייר פרו",
  description: "תמלול עברית מדויק ומהיר ישירות בתוך Premiere Pro. מבוסס AI, ענן, ומוכן לשימוש תוך שניות.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="he" dir="rtl">
      <body>{children}</body>
    </html>
  );
}
