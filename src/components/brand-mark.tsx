/**
 * Methyl's mark — same artwork as public/icon.svg (light contexts) and
 * public/icon-dark.svg (dark contexts), inlined so a 24px graphic doesn't
 * cost a request and can follow the theme.
 *
 * The plate flips with the theme so the mark never blends into the
 * surface behind it; the blue accent bar stays put in both. Keep the two
 * public/*.svg files in sync with these colours — today the artwork is a
 * placeholder standing in for lines of text.
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 512 512" aria-hidden className={className}>
      <rect width="512" height="512" className="fill-[#0f1115] dark:fill-[#fafafa]" />
      <rect x="104" y="96" width="304" height="40" rx="12" fill="#3b82f6" />
      <rect
        x="104"
        y="168"
        width="208"
        height="40"
        rx="12"
        className="fill-[#e4e4e7] dark:fill-[#27272a]"
      />
      <rect
        x="104"
        y="240"
        width="262"
        height="40"
        rx="12"
        className="fill-[#71717a] dark:fill-[#52525b]"
      />
      <rect
        x="104"
        y="312"
        width="160"
        height="40"
        rx="12"
        className="fill-[#52525b] dark:fill-[#a1a1aa]"
      />
    </svg>
  );
}
