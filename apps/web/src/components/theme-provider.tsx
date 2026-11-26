import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

type Theme = "light" | "dark" | "system";

/** Colour themes. A palette changes colours only; layout and type stay the same. */
export const PALETTES = [
  {
    id: "housetory",
    name: "Current Housetory",
    description: "Cream, ink, sage and brass.",
    light: "#F8F5EF",
    dark: "#121311",
    swatch: ["#F8F5EF", "#27231F", "#4A6352", "#A37B4C"],
  },
  {
    id: "design-d",
    name: "Design D",
    description: "Kraft paper and stamp blue.",
    light: "#F3EEE5",
    dark: "#15130F",
    swatch: ["#F3EEE5", "#2A2521", "#28405F", "#735107"],
  },
  {
    id: "field-notes",
    name: "Field notes",
    description: "Warm paper and forest green.",
    light: "#F5F2E9",
    dark: "#1D241E",
    swatch: ["#F5F2E9", "#262D25", "#355C43", "#7A5A12"],
  },
  {
    id: "collected",
    name: "Collected",
    description: "Soft cream, terracotta and plum.",
    light: "#FAF4EE",
    dark: "#1F1617",
    swatch: ["#FAF4EE", "#482D30", "#98483F", "#7C5410"],
  },
] as const;

export type Palette = (typeof PALETTES)[number]["id"];

interface ThemeContextValue {
  theme: Theme;
  resolvedTheme: "light" | "dark";
  setTheme: (theme: Theme) => void;
  palette: Palette;
  setPalette: (palette: Palette) => void;
}

const STORAGE_KEY = "housetory-theme";
const PALETTE_STORAGE_KEY = "housetory-palette";
const ThemeContext = createContext<ThemeContextValue | null>(null);

function readStoredTheme(): Theme {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value === "light" || value === "dark") return value;
  } catch {
    // Ignore storage exceptions in private browsing contexts.
  }
  return "system";
}

function readStoredPalette(): Palette {
  try {
    const value = localStorage.getItem(PALETTE_STORAGE_KEY);
    const known = PALETTES.find((palette) => palette.id === value);
    if (known) return known.id;
  } catch {
    // Ignore storage exceptions in private browsing contexts.
  }
  return "housetory";
}

function systemIsDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function applyTheme(theme: Theme, palette: Palette): "light" | "dark" {
  const dark = theme === "dark" || (theme === "system" && systemIsDark());
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.dataset.theme = theme;
  if (palette === "housetory") delete document.documentElement.dataset.palette;
  else document.documentElement.dataset.palette = palette;
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
  const colors = PALETTES.find((entry) => entry.id === palette) ?? PALETTES[0];
  const color = dark ? colors.dark : colors.light;
  document
    .querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')
    .forEach((meta) => meta.setAttribute("content", color));
  return dark ? "dark" : "light";
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => readStoredTheme());
  const [palette, setPaletteState] = useState<Palette>(() => readStoredPalette());
  const [resolvedTheme, setResolvedTheme] = useState<"light" | "dark">(() =>
    theme === "dark" || (theme === "system" && systemIsDark()) ? "dark" : "light",
  );

  useEffect(() => {
    setResolvedTheme(applyTheme(theme, palette));
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      if (theme === "system") {
        setResolvedTheme(applyTheme("system", palette));
      }
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [theme, palette]);

  const setTheme = useCallback((next: Theme) => {
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // The visual theme still applies for this session.
    }
    setThemeState(next);
  }, []);

  const setPalette = useCallback((next: Palette) => {
    try {
      if (next === "housetory") localStorage.removeItem(PALETTE_STORAGE_KEY);
      else localStorage.setItem(PALETTE_STORAGE_KEY, next);
    } catch {
      // The colours still apply for this session.
    }
    setPaletteState(next);
  }, []);

  const value = useMemo(
    () => ({ theme, resolvedTheme, setTheme, palette, setPalette }),
    [theme, resolvedTheme, setTheme, palette, setPalette],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used inside ThemeProvider");
  }
  return context;
}
