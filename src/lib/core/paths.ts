export const INVALID_WINDOWS_NAMES = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
]);

export function normalizeName(name: string): string {
  return name.normalize("NFC");
}

/**
 * The app's metadata directory at the root of every vault: CRDT state
 * (`crdt/`), the sidecar doc index, the sync journal, caches, plugin data.
 * Every module builds these paths from this constant.
 */
export const META_DIR = ".methyl";

/**
 * Earlier names of META_DIR. A vault still holding one is migrated at
 * startup; until then, and forever after, the name stays reserved so a
 * leftover directory is never read as vault content.
 */
export const LEGACY_META_DIRS: readonly string[] = [".adhd"];

/** Whether a top-level directory name is the app's metadata, current or legacy. */
export function isMetaDirName(name: string): boolean {
  return name === META_DIR || LEGACY_META_DIRS.includes(name);
}

/**
 * Reserved: the metadata directory names above. A user-visible tree node
 * with this exact name would materialise into (and, on rename/delete,
 * remove from) the same on-disk path as real CRDT storage -- sanitizeName
 * previously let ".adhd" through, since it doesn't match the "all
 * dots/whitespace" rejection (it has letters after the leading dot).
 * Rejected case-insensitively.
 */
const RESERVED_NAMES = new Set([META_DIR, ...LEGACY_META_DIRS]);

export function sanitizeName(name: string): string | null {
  if (name.length === 0) return null;
  if (name.includes("/") || name.includes("\\")) return null;
  if (/[\u0000-\u001f\u007f]/.test(name)) return null;
  if (/[<>:"|?*]/.test(name)) return null;
  if (/^[.\s]+$/.test(name)) return null;
  if (RESERVED_NAMES.has(name.toLowerCase())) return null;
  if (INVALID_WINDOWS_NAMES.has(name.replace(/^\.+/, "").split(".")[0]!.toUpperCase()))
    return null;
  const stripped = normalizeName(name.replace(/[ .]+$/g, ""));
  if (stripped.length === 0) return null;
  if (/^\.+\.?$/.test(stripped)) return null;
  if (RESERVED_NAMES.has(stripped.toLowerCase())) return null;
  return stripped;
}

/**
 * Auto-suffix a name to dodge a collision: "Untitled.md" -> "Untitled 2.md"
 * -> "Untitled 3.md". Used uniformly for create/rename/move so a sibling
 * name clash never blocks the user with a dialog — the tree always accepts
 * the op and lands on the next free name.
 */
export function uniqueName(
  name: string,
  taken: (n: string) => boolean,
  _existing?: string,
): string {
  if (!taken(name)) return name;
  const extIdx = name.lastIndexOf(".");
  const ext = extIdx > 0 ? name.slice(extIdx) : "";
  const stem = extIdx > 0 ? name.slice(0, extIdx) : name;
  let counter = 2;
  while (true) {
    const candidate = `${stem} ${counter}${ext}`;
    if (!taken(candidate)) return candidate;
    counter++;
  }
}

export function normalizePath(path: string): string {
  return path.split("/").filter((s) => s.length > 0).join("/");
}