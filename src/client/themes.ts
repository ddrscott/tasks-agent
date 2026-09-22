import type { THEME_IDS } from "../shared";

export type ThemeId = (typeof THEME_IDS)[number];

export type Theme = {
  id: ThemeId;
  name: string;
  blurb: string;
  // bg, surface, accent, ink: drawn as the swatch in the picker
  swatch: [string, string, string, string];
};

// The palettes themselves live in styles.css under [data-theme="…"].
export const THEMES: Theme[] = [
  { id: "auto", name: "Auto", blurb: "Follows your system", swatch: ["#1A1A1A", "#FFFEF9", "#E85D00", "#888888"] },
  { id: "signal", name: "Signal", blurb: "Terminal dark, orange", swatch: ["#1A1A1A", "#242424", "#E85D00", "#E0E0E0"] },
  { id: "paper", name: "Paper", blurb: "Warm light, orange", swatch: ["#FFFEF9", "#F7F6F3", "#E85D00", "#2C2C2C"] },
  { id: "nord", name: "Nord", blurb: "Cool arctic dark", swatch: ["#2E3440", "#3B4252", "#88C0D0", "#ECEFF4"] },
  { id: "dracula", name: "Dracula", blurb: "Purple night", swatch: ["#282A36", "#343746", "#FF79C6", "#F8F8F2"] },
  { id: "solar", name: "Solarized", blurb: "Classic light", swatch: ["#FDF6E3", "#EEE8D5", "#268BD2", "#586E75"] },
  { id: "forest", name: "Forest", blurb: "Deep green, moss", swatch: ["#17211B", "#1F2C24", "#8BC34A", "#E4EDE3"] },
  { id: "sakura", name: "Sakura", blurb: "Soft pink, rounded", swatch: ["#FFF5F7", "#FFFFFF", "#E0457B", "#4A2B36"] },
  { id: "ocean", name: "Ocean", blurb: "Bright teal", swatch: ["#F0F7FA", "#FFFFFF", "#0E9AA7", "#16323F"] },
  { id: "synthwave", name: "Synthwave", blurb: "Neon on violet", swatch: ["#1B1033", "#261847", "#FF2E97", "#F4E9FF"] },
  { id: "newsprint", name: "Newsprint", blurb: "Serif, sepia", swatch: ["#F4EFE4", "#FBF8F1", "#9B2C1F", "#2B2622"] },
  { id: "contrast", name: "High contrast", blurb: "Maximum legibility", swatch: ["#000000", "#000000", "#FFD400", "#FFFFFF"] },
];

const KEY = "todo-theme";

export function readCachedTheme(): ThemeId {
  try {
    const t = localStorage.getItem(KEY);
    if (t && THEMES.some((x) => x.id === t)) return t as ThemeId;
  } catch {}
  return "auto";
}

/** Apply a theme to the page now; the account copy syncs separately through the agent. */
export function applyTheme(id: string) {
  const t = THEMES.some((x) => x.id === id) ? id : "auto";
  const resolved = t === "auto" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "signal" : "paper") : t;
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.dataset.themeChoice = t;
  const bg = getComputedStyle(root).getPropertyValue("--bg").trim();
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", bg);
  try {
    localStorage.setItem(KEY, t);
  } catch {}
}
