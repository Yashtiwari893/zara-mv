// src/app/layout.tsx

import type { Metadata, Viewport } from "next";
import { DM_Sans } from "next/font/google";
import "./globals.css";
import { APP } from "@/config";

const dmSans = DM_Sans({
  variable: "--font-dm-sans",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600"],
  display: "swap",
});

// ─── SEO Metadata ─────────────────────────────────────────────
export const metadata: Metadata = {
  title: `${APP.NAME} — Your Personal Assistant on WhatsApp`,
  description:
    "Reminders, lists, documents, AI chat — sab kuch WhatsApp mein. Hindi, English, Gujarati — kisi bhi bhasha mein. No app download needed.",

  keywords: [
    "WhatsApp assistant",
    "personal assistant WhatsApp",
    "WhatsApp reminder",
    "11za",
    "11za Assistant",
    "WhatsApp bot India",
    "Hindi WhatsApp bot",
    "Gujarati WhatsApp assistant",
  ],

  authors: [{ name: "11za by Engees Communications Pvt Ltd" }],

  // Open Graph — WhatsApp/Facebook share preview
  openGraph: {
    title: `${APP.NAME} — Your Personal Assistant on WhatsApp`,
    description:
      "Reminders, lists, documents aur AI chat — sab kuch WhatsApp pe. No app download.",
    url: "https://11za-assistant.vercel.app",
    siteName: APP.NAME,
    locale: "en_IN",
    type: "website",
  },

  // Twitter card
  twitter: {
    card: "summary_large_image",
    title: `${APP.NAME} — WhatsApp Personal Assistant`,
    description: "Reminders, lists, documents aur AI chat — sab WhatsApp pe!",
  },

  // Favicon
  icons: {
    icon: "/favicon.ico",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#25D366",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="scroll-smooth">
      <body className={`${dmSans.variable} antialiased`}>
        {children}
      </body>
    </html>
  );
}
