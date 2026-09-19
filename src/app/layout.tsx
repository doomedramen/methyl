import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";
import { THEME_IDS } from "@/lib/themes";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Methyl",
  description: "Self-hostable, offline-first Markdown vault",
  manifest: "/manifest.webmanifest",
  icons: {
    // Browsers pick the variant that suits their current theme. Both files
    // are identical for now; theme-specific artwork lands here later.
    icon: [
      { url: "/icon.svg", media: "(prefers-color-scheme: light)" },
      { url: "/icon-dark.svg", media: "(prefers-color-scheme: dark)" },
    ],
    apple: "/icons/apple-touch-icon.png",
  },
  // No black-translucent / viewport-fit=cover: iOS 26+ blurs anything drawn
  // under the status bar, so the app stays inside the safe area.
  appleWebApp: { capable: true, title: "Methyl" },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0f1115" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="h-svh flex flex-col overflow-hidden">
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
          themes={THEME_IDS}
        >
          <TooltipProvider>
            {children}
            <Toaster />
          </TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
