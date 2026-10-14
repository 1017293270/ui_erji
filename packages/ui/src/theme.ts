export type ThemeChoice = "light" | "dark" | "system";
export const THEME_KEY = "echomind-theme";

// Runs in <head> before first paint: marks JS (for drawing entrances) and applies the saved theme.
export const themeBootScript = `(()=>{const d=document.documentElement;d.classList.add("js");let t="system";try{t=localStorage.getItem("${THEME_KEY}")||"system"}catch{}const dark=t==="dark"||(t!=="light"&&matchMedia("(prefers-color-scheme: dark)").matches);d.classList.toggle("dark",dark);d.style.colorScheme=dark?"dark":"light"})()`;

export function readTheme(): ThemeChoice {
  try { const t = localStorage.getItem(THEME_KEY); return t === "light" || t === "dark" ? t : "system"; } catch { return "system"; }
}
export function applyTheme(choice: ThemeChoice) {
  try { if (choice === "system") localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, choice); } catch {}
  const dark = choice === "dark" || (choice === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
}
