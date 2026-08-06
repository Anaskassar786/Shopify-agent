import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

/**
 * Theme controller (P9: dark default · light · system auto). The provider
 * resolves "system" eagerly and writes ONLY resolved themes to the DOM —
 * `data-theme` is always "dark" | "light", so CSS never branches on media
 * queries mid-session. Persistence is per-browser (localStorage), key is
 * versioned so future token-scale changes cannot resurrect stale choices.
 */

export type ThemeChoice = "dark" | "light" | "system";
export type ResolvedTheme = "dark" | "light";

export const THEME_STORAGE_KEY = "profit.theme.v1";

function resolveSystem(): ResolvedTheme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return "dark";
  }
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function applyToDocument(theme: ResolvedTheme): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset["theme"] = theme;
}

export interface ThemeContextValue {
  /** What the merchant selected. */
  readonly choice: ThemeChoice;
  /** What is actually painted. */
  readonly resolved: ResolvedTheme;
  readonly setChoice: (choice: ThemeChoice) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export interface ThemeProviderProps {
  readonly children: ReactNode;
  /** Initial choice before storage is read (tests + SSR). */
  readonly defaultChoice?: ThemeChoice;
  /** Injectable storage for hermetic tests. */
  readonly storage?: Pick<Storage, "getItem" | "setItem"> | undefined;
}

export function ThemeProvider({
  children,
  defaultChoice = "dark",
  storage,
}: ThemeProviderProps): ReactNode {
  const store = storage ?? (typeof window !== "undefined" ? window.localStorage : undefined);
  const [choice, setChoiceState] = useState<ThemeChoice>(() => {
    const saved = store?.getItem(THEME_STORAGE_KEY);
    return saved === "dark" || saved === "light" || saved === "system" ? saved : defaultChoice;
  });

  const resolved: ResolvedTheme = choice === "system" ? resolveSystem() : choice;

  useEffect(() => {
    applyToDocument(resolved);
  }, [resolved]);

  // React to OS theme changes while the merchant chose "system".
  useEffect(() => {
    if (choice !== "system" || typeof window === "undefined") return;
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = (): void => {
      applyToDocument(media.matches ? "light" : "dark");
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [choice]);

  const setChoice = useCallback(
    (next: ThemeChoice) => {
      setChoiceState(next);
      store?.setItem(THEME_STORAGE_KEY, next);
    },
    [store],
  );

  const value = useMemo(
    () => ({ choice, resolved, setChoice }),
    [choice, resolved, setChoice],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (ctx === null) throw new Error("useTheme must be used inside <ThemeProvider>");
  return ctx;
}
