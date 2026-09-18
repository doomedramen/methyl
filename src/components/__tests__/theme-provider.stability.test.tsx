// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ThemeProvider } from "@/components/theme-provider";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }
});

/**
 * Regression test for the dev-only "Cannot read properties of null (reading
 * 'removeChild')" crash (see docs/superpowers/plans/2026-09-18-plugins-roadmap.md,
 * Track B).
 *
 * Root cause: layout.tsx renders two React/Next-managed `<meta
 * name="theme-color" media="...">` tags. React 19 treats `<meta>` as a
 * "Hoistable" resource and tracks its own DOM node for later cleanup.
 * ThemeColorMeta (src/components/theme-provider.tsx) used to call
 * `el.remove()` directly on those same nodes once the real theme resolved,
 * detaching them from the DOM outside React's bookkeeping. The next time
 * React tears down that resource — which happens on every Next.js Fast
 * Refresh, since it fully unmounts and remounts the tree — it tries
 * `stateNode.parentNode.removeChild(stateNode)`. `parentNode` is already
 * null because of the earlier manual `.remove()`, so React throws.
 *
 * This test renders the same shape (static prefers-color-scheme metas +
 * ThemeProvider), lets the effect run once (mirroring one real paint), then
 * unmounts the root (mirroring the full remount Fast Refresh performs) and
 * asserts that doesn't throw.
 */
function StaticThemeColorMetas() {
  return (
    <>
      <meta name="theme-color" media="(prefers-color-scheme: light)" content="#fff" />
      <meta name="theme-color" media="(prefers-color-scheme: dark)" content="#000" />
    </>
  );
}

describe("ThemeProvider / ThemeColorMeta stability", () => {
  it("survives a full unmount after the theme-color effect has run", async () => {
    document.querySelectorAll('meta[name="theme-color"]').forEach((el) => el.remove());

    const container = document.createElement("div");
    document.body.appendChild(container);
    let root: Root | null = null;

    try {
      await act(async () => {
        root = createRoot(container);
        root.render(
          <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
            <StaticThemeColorMetas />
            <div>content</div>
          </ThemeProvider>,
        );
      });

      // Simulate Next.js Fast Refresh, which fully unmounts and remounts
      // the React tree. This is where the bug threw.
      expect(() => {
        act(() => {
          root?.unmount();
        });
      }).not.toThrow();
    } finally {
      container.remove();
      document.querySelectorAll('meta[name="theme-color"]').forEach((el) => el.remove());
    }
  });
});
