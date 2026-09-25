import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

/**
 * The app was renamed from "adhd" to Methyl (spec item 13). The old name
 * may only appear where it has to: recognising legacy data and migrating
 * it. Anything else is a leftover.
 */
const ALLOWED: Record<string, RegExp> = {
  // Legacy id comment in old Markdown files: must keep matching them.
  "lib/core/doc-id.ts": /ADHD_ID_COMMENT_RE|adhd:id/,
  "lib/core/document.ts": /ADHD_ID_COMMENT_RE/,
  "lib/core/paths.ts": /LEGACY_META_DIRS|previously let "\.adhd"/,
  "lib/vault/meta-migration.ts": /.*/,
  "lib/server/meta-migration.ts": /.*/,
  "lib/browser/storage-keys.ts": /used to start with `adhd`/,
  "lib/browser/sync-config.ts": /LEGACY_STORAGE_KEY = "adhd-sync-config"/,
  "lib/browser/pwa.ts": /startsWith\("adhd-"\)/,
  "lib/browser/vault.ts": /`\.adhd\/` → `\.methyl\/`/,
  "lib/vault/diagnostics.ts": /CRDT files under `\.adhd\/crdt`/,
  "app/sw.ts": /used to be named `adhd-\*`|startsWith\("adhd-"\)/,
  "components/editor/NoteEditor.tsx": /"adhd-name"/,
  "components/vault/sidebar-rows.ts": /"adhd\.sidebar\.collapsedFolders"/,
  // The pre-multi-vault OPFS root and writer lock, which the layout
  // migration moves from and holds.
  "lib/vault/web-locks.ts": /LEGACY_WRITER_LOCK_NAME = "adhd-vault:local:writer"|older build|`adhd-vault` OPFS root/,
  "lib/browser/vault-actions.ts": /made before the rename \(`\.adhd\/`\)/,
  "lib/browser/vault-registry.ts": /LEGACY_ROOT = "adhd-vault"|LEGACY_ROOT_MARKER = "methyl\/migrated-from-adhd-vault"|\(`adhd-vault\/`\)/,
};

describe("the old name", () => {
  it("appears only where legacy data is recognised or migrated", () => {
    const root = join(__dirname, "..", "..", "..");
    const leftovers: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
          if (name !== "__tests__") walk(full);
          continue;
        }
        if (!/\.(tsx?|css)$/.test(name)) continue;
        const rel = relative(root, full);
        readFileSync(full, "utf8")
          .split("\n")
          .forEach((line, i) => {
            if (!/adhd/i.test(line)) return;
            // The legacy id comment's format, described wherever it's handled.
            if (/adhd:id/.test(line)) return;
            if (ALLOWED[rel]?.test(line)) return;
            leftovers.push(`${rel}:${i + 1}: ${line.trim()}`);
          });
      }
    };
    walk(root);
    expect(leftovers).toEqual([]);
  });
});
