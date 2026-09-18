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
  // Opaque ("default"), not black-translucent: from iOS 26 the system paints a
  // Liquid Glass blur over anything drawn under the status bar (heavy in
  // iOS 27), with no CSS to disable it. Opaque keeps the web view below it.
  // iOS reads this once at install — reinstall the home-screen app to apply.
  appleWebApp: { capable: true, title: "Methyl", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0f1115" },
  ],
  // Lets the app draw under the notch/home-indicator safe areas (env(safe-area-inset-*)
  // in globals.css) instead of leaving a plain background band there.
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="h-svh flex flex-col overflow-hidden">
        {/* iOS 26+ ignores theme-color and tints the status bar from a real
            element's background-color at the top edge, so give it one. */}
        <div aria-hidden className="pointer-events-none fixed inset-x-0 top-0 z-50 h-px bg-background" />
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
