# Methyl logo options

Four original, hand-authored SVG concepts. No Lucide paths, external fonts, embedded bitmaps, scripts, or external resources. Capsule was selected for the app identity. The remaining concepts are retained as explorations.

## Selected direction

The user selected **Capsule**. The app uses the amber mark, a brighter dark-browser variant, and white-on-amber installed-app icons.

[Open the comparison sheet](comparison.svg).

## Options

### Fold

A compact M built from folded paper. Links the name to writing without using a literal document icon. My preferred direction: distinctive silhouette, clear at small sizes.

Trade-off: The central fold can also read as an envelope. Keep the solid version; do not add fold lines.

[Colour mark](fold.svg) · [Monochrome mark](fold-mono.svg) · [App icon](fold-app.svg)

### Open leaves

Two open pages with a clear central spine. The most immediately understandable notebook symbol. Rounded joins make it feel comfortable alongside the app’s interface.

Trade-off: Less ownable: open-book symbols are common. Best when instant recognition matters more than a distinctive monogram.

[Colour mark](leaves.svg) · [Monochrome mark](leaves-mono.svg) · [App icon](leaves-app.svg)

### Ink thread

A lowercase m made from a continuous pen stroke. Suggests writing, continuity and connected ideas. Soft enough to feel personal without introducing a mascot.

Trade-off: More abstract than Fold. Its arched shape needs the wordmark during early brand recognition.

[Colour mark](thread.svg) · [Monochrome mark](thread-mono.svg) · [App icon](thread-app.svg)

### Capsule

A simpler successor to the current pill bottle: a clean capsule with one solid half. Retains the Methyl name’s medication association and amber heritage.

Trade-off: Strongest medical reading. Choose this only if that association is intentional; it says less about notes and ideas.

[Colour mark](capsule.svg) · [Monochrome mark](capsule-mono.svg) · [App icon](capsule-app.svg)

## Asset notes

- Marks use a 64×64 viewBox; app-icon SVGs declare 512×512 output dimensions.
- The comparison sheet includes actual 16px, 24px and 32px examples on light and dark surfaces. Inspect at 100% zoom.
- Standalone marks use explicit `color` with `currentColor` paths. For inline theme-aware use, override the root colour; for an `<img>`, use the appropriate asset colour.
- Monochrome files use dark ink; set the root `color` to white for a reversed mark. App variants already provide a white mark on a coloured tile.
- Wordmarks on the comparison sheet use system typography for context; they are not outlined final wordmark artwork.
- Keep at least 8 viewBox units of clear space around the standalone mark when placing it beside other content.
- Production SVGs live at `public/icon.svg` and `public/icon-dark.svg`. Previous artwork is preserved byte-for-byte as `public/icon_old.svg` and `public/icon-dark_old.svg`. Regenerate installed-app PNGs with `node scripts/gen-icons.mjs`.
