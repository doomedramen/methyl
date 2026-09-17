import { VaultApp } from "@/components/vault/VaultApp";

/**
 * Catch-all so note routes (`/<vault>/<path>.md`) resolve to the app in
 * `next dev` and in any host that serves `index.html` for unknown paths
 * (see src/server/static.ts). The static export prerenders no pages here —
 * the client reads the path and opens the matching note.
 */
export function generateStaticParams() {
  // One placeholder page so the export has an entry for this route; every
  // real note path is resolved on the client from the URL.
  return [{ slug: ["local"] }];
}

export default function NoteRoute() {
  return <VaultApp />;
}
