import { useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'kb-theme';
const listeners = new Set<(theme: Theme) => void>();

function readInitialTheme(): Theme {
  if (typeof window === 'undefined') return 'light';
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    /* ignore storage errors */
  }
  if (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches) {
    return 'dark';
  }
  return 'light';
}

let currentTheme: Theme = readInitialTheme();

function applyThemeToDocument(theme: Theme): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

export function initTheme(): Theme {
  currentTheme = readInitialTheme();
  applyThemeToDocument(currentTheme);
  return currentTheme;
}

export function getTheme(): Theme {
  return currentTheme;
}

export function setTheme(next: Theme): void {
  currentTheme = next;
  applyThemeToDocument(next);
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* ignore */
  }
  for (const listener of listeners) {
    try {
      listener(next);
    } catch {
      /* ignore */
    }
  }
}

export function toggleTheme(): Theme {
  const next: Theme = currentTheme === 'dark' ? 'light' : 'dark';
  setTheme(next);
  return next;
}

export function subscribeTheme(fn: (theme: Theme) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function useTheme(): [Theme, () => Theme] {
  const [theme, setLocal] = useState<Theme>(currentTheme);
  useEffect(() => {
    setLocal(currentTheme);
    return subscribeTheme(setLocal);
  }, []);
  return [theme, toggleTheme];
}
