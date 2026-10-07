import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { ThemeProvider } from "@/components/theme-provider";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "ClipForge AI — YouTube Auto-Clipping Studio",
  description:
    "AI-assisted YouTube clip studio. Paste a video link, get viral highlight clips with timestamps, virality scores, hooks, and tags — ready to export for Shorts, Reels, and TikTok.",
  keywords: [
    "YouTube clipping",
    "auto clipping",
    "shorts maker",
    "AI video editor",
    "ClipForge",
    "content repurposing",
  ],
  authors: [{ name: "ClipForge AI" }],
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
  openGraph: {
    title: "ClipForge AI — YouTube Auto-Clipping Studio",
    description:
      "Paste a YouTube link. Get AI-suggested viral clips with timestamps, scores, and hooks.",
    url: "https://chat.z.ai",
    siteName: "ClipForge AI",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "ClipForge AI",
    description: "AI-assisted YouTube clip studio.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground min-h-screen`}
      >
        <ThemeProvider>{children}</ThemeProvider>
        <Toaster />
      </body>
    </html>
  );
}
