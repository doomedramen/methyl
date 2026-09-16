import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "ADHD — offline-first Markdown vault",
  description: "Self-hostable, offline-first Markdown vault",
  manifest: "/manifest.webmanifest",
  icons: { icon: "/icon.svg", apple: "/icon.svg" },
  appleWebApp: { capable: true, title: "ADHD", statusBarStyle: "black-translucent" },
  themeColor: "#0f1115",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="h-svh flex flex-col overflow-hidden">{children}</body>
    </html>
  );
}
