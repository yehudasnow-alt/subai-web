import "./globals.css";
import type { Metadata } from "next";
import Script from "next/script";

export const metadata: Metadata = {
  metadataBase: new URL("https://subai.co.il"),
  alternates: {
    canonical: "https://subai.co.il",
  },
  title: "SubAI — כתוביות AI בעברית לפרמייר פרו",
  description: "תמלול אוטומטי מדויק בעברית ישירות בתוך Adobe Premiere Pro. מופעל על ידי Whisper AI + Claude.",
  keywords: "כתוביות, תמלול, עברית, Premiere Pro, AI, Whisper, פלאגין, subtitle, transcription",
  openGraph: {
    title: "SubAI — כתוביות AI לפרמייר פרו",
    description: "תמלול אוטומטי מדויק בעברית ישירות בתוך Premiere Pro",
    url: "https://subai.co.il",
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
        <Script
          src="https://www.googletagmanager.com/gtag/js?id=G-NZS5FQH1W7"
          strategy="afterInteractive"
        />
        <Script id="google-analytics" strategy="afterInteractive">
          {`
            window.dataLayer = window.dataLayer || [];
            function gtag(){dataLayer.push(arguments);}
            gtag('js', new Date());
            gtag('config', 'G-NZS5FQH1W7');
          `}
        </Script>
      </head>
      <body>{children}</body>
    </html>
  );
}
