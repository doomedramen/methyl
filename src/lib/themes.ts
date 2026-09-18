import { Gem, Moon, Snowflake, Sun, Sunrise, Coffee, type LucideIcon } from "lucide-react";

export type AppTheme = {
  /** next-themes value; also the class applied to <html>. */
  id: string;
  label: string;
  icon: LucideIcon;
  /** Whether `dark:` utilities and dark-leaning widgets should apply. */
  dark: boolean;
};

/** Single source of truth for the theme pickers. Every id here needs a
    matching class block in globals.css (light/dark come from :root/.dark). */
export const APP_THEMES: AppTheme[] = [
  { id: "light", label: "Light", icon: Sun, dark: false },
  { id: "obsidian-light", label: "Obsidian Light", icon: Gem, dark: false },
  { id: "rose-pine-dawn", label: "Rosé Pine Dawn", icon: Sunrise, dark: false },
  { id: "dark", label: "Dark", icon: Moon, dark: true },
  { id: "obsidian", label: "Obsidian", icon: Gem, dark: true },
  { id: "nord", label: "Nord", icon: Snowflake, dark: true },
  { id: "catppuccin", label: "Catppuccin Mocha", icon: Coffee, dark: true },
];

export const THEME_IDS = APP_THEMES.map((t) => t.id);

export function isDarkTheme(id: string | undefined): boolean {
  return APP_THEMES.find((t) => t.id === id)?.dark ?? false;
}
