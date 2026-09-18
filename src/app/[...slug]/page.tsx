import { VaultApp } from "@/components/vault/VaultApp";

/**
 * Catch-all so note routes (`/<vault>/<path>.md`) resolve to the app, both
 * in `next dev` and from the in-process Next server in production
 * (src/server/main.ts). Every path is a normal dynamic route rendered on
 * demand — no params are pre-listed — and the page itself is static
 * (VaultApp is a client component that reads the URL at runtime), so Next
 * serves the same prerendered shell for any note path.
 */
export default function NoteRoute() {
  return <VaultApp />;
}
