"use client";

import { ThemeProvider as NextThemesProvider, useTheme } from "next-themes";
import { useEffect } from "react";
import type { ComponentProps } from "react";

export function ThemeProvider({
  children,
  ...props
}: ComponentProps<typeof NextThemesProvider>) {
  return (
    <NextThemesProvider {...props}>
      {children}
      <ThemeColorMeta />
    </NextThemesProvider>
  );
}

/**
 * Keeps the browser chrome (Android's status bar/task-switcher card, PWA
 * title bar) matching whichever of the 7 themes is active. layout.tsx's
 * static `viewport.themeColor` (two `prefers-color-scheme` metas) covers
 * the gap before hydration; once mounted, this replaces them with one
 * managed meta so a manually-picked theme (not just light/dark) is
 * reflected too. Reads the *computed* body background rather than the
 * `--background` CSS variable directly since that variable can be oklch()
 * or a plain hex depending on the theme (see globals.css) — the resolved
 * style is always a browser-normalized color the meta tag can use as-is.
 */
function ThemeColorMeta() {
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    if (!resolvedTheme) return;
    document.querySelectorAll('meta[name="theme-color"][media]').forEach((el) => el.remove());
    let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]:not([media])');
    if (!meta) {
      meta = document.createElement("meta");
      meta.setAttribute("name", "theme-color");
      document.head.appendChild(meta);
    }
    const color = getComputedStyle(document.body).backgroundColor;
    if (color) meta.setAttribute("content", color);
  }, [resolvedTheme]);

  return null;
}
