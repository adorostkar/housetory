import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

type Theme = "light" | "dark" | "system";

interface ThemeContextValue {
  theme: Theme;
  resolvedTheme: "light" | "dark";
  setTheme: (theme: Theme) => void;
}

const STORAGE_KEY = "housetory-theme";
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

function systemIsDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function applyTheme(theme: Theme): "light" | "dark" {
  const dark = theme === "dark" || (theme === "system" && systemIsDark());
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
  const color = dark ? "#121311" : "#F8F5EF";
  document
    .querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')
    .forEach((meta) => meta.setAttribute("content", color));
  return dark ? "dark" : "light";
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => readStoredTheme());
  const [resolvedTheme, setResolvedTheme] = useState<"light" | "dark">(() =>
    theme === "dark" || (theme === "system" && systemIsDark()) ? "dark" : "light",
  );

  useEffect(() => {
    setResolvedTheme(applyTheme(theme));
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      if (theme === "system") {
        setResolvedTheme(applyTheme("system"));
      }
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // The visual theme still applies for this session.
    }
    setThemeState(next);
  }, []);

  const value = useMemo(
    () => ({ theme, resolvedTheme, setTheme }),
    [theme, resolvedTheme, setTheme],
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
