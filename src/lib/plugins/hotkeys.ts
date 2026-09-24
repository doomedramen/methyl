import { META_DIR } from "@/lib/core/paths";
import type { Hotkey } from "@/lib/plugins/api";
import type { PluginStorage } from "@/lib/plugins/storage";

const HOTKEYS_JSON_PATH = `${META_DIR}/hotkeys.json`;

export function formatHotkey(hotkey: Hotkey, platform: "mac" | "other"): string {
  const parts: string[] = hotkey.modifiers.map((m) => {
    if (m === "Mod") return platform === "mac" ? "⌘" : "Ctrl";
    if (m === "Meta") return platform === "mac" ? "⌘" : "Win";
    return m;
  });
  parts.push(hotkey.key.toUpperCase());
  return parts.join("+");
}

export function matchesEvent(
  hotkey: Hotkey,
  e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean },
  platform: "mac" | "other",
): boolean {
  if (e.key.toLowerCase() !== hotkey.key.toLowerCase()) return false;
  const want = { ctrl: false, alt: false, shift: false, meta: false };
  for (const m of hotkey.modifiers) {
    if (m === "Mod") {
      if (platform === "mac") want.meta = true;
      else want.ctrl = true;
    } else if (m === "Ctrl") want.ctrl = true;
    else if (m === "Alt") want.alt = true;
    else if (m === "Shift") want.shift = true;
    else if (m === "Meta") want.meta = true;
  }
  return (
    e.metaKey === want.meta && e.ctrlKey === want.ctrl && e.altKey === want.alt && e.shiftKey === want.shift
  );
}

export class HotkeyManager {
  private defaults = new Map<string, Hotkey[]>();
  private overrides = new Map<string, Hotkey[]>();
  private order: string[] = [];

  constructor(private storage: PluginStorage) {}

  async loadOverrides(): Promise<void> {
    const bytes = await this.storage.read(HOTKEYS_JSON_PATH);
    if (!bytes) return;
    try {
      const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, Hotkey[]>;
      this.overrides = new Map(Object.entries(parsed));
    } catch {
      this.overrides = new Map();
    }
  }

  setDefault(fullId: string, hotkeys: Hotkey[]): void {
    this.defaults.set(fullId, hotkeys);
    this.order = this.order.filter((id) => id !== fullId);
    this.order.push(fullId);
  }

  /** Undo a `setDefault` — called when the command that registered it is
   *  disposed (plugin disabled), so a stale binding can't still match. */
  clearDefault(fullId: string): void {
    this.defaults.delete(fullId);
    this.order = this.order.filter((id) => id !== fullId);
  }

  getEffective(fullId: string): Hotkey[] {
    if (this.overrides.has(fullId)) return this.overrides.get(fullId)!;
    return this.defaults.get(fullId) ?? [];
  }

  handleKeydown(e: KeyboardEvent, platform: "mac" | "other"): string[] {
    const matches: string[] = [];
    for (const fullId of this.order) {
      const hotkeys = this.getEffective(fullId);
      if (hotkeys.some((h) => matchesEvent(h, e, platform))) matches.push(fullId);
    }
    if (matches.length <= 1) return matches;
    console.warn(`[plugins] hotkey conflict between ${matches.join(", ")}; last registered wins`);
    return [matches[matches.length - 1]];
  }
}
