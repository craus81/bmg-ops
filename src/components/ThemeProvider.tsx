'use client';

import { createContext, useContext, useEffect, useState, useCallback } from 'react';

type ThemeMode = 'auto' | 'light' | 'dark';

interface ThemeContextType {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
  resolvedTheme: 'light' | 'dark'; // what's actually showing
}

const ThemeContext = createContext<ThemeContextType>({
  mode: 'auto',
  setMode: () => {},
  resolvedTheme: 'dark',
});

export function useTheme() {
  return useContext(ThemeContext);
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>('auto');
  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>('dark');
  const [mounted, setMounted] = useState(false);

  // Read saved preference on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem('bmg-theme') as ThemeMode | null;
      if (saved && ['auto', 'light', 'dark'].includes(saved)) {
        setModeState(saved);
      }
    } catch {}
    setMounted(true);
  }, []);

  // Apply theme to <html> and resolve actual theme
  useEffect(() => {
    if (!mounted) return;

    const html = document.documentElement;
    html.setAttribute('data-theme', mode);

    const resolve = () => {
      if (mode === 'light') return 'light';
      if (mode === 'dark') return 'dark';
      // auto — check system
      return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    };

    setResolvedTheme(resolve());

    // Listen for system theme changes when in auto mode
    if (mode === 'auto') {
      const mq = window.matchMedia('(prefers-color-scheme: light)');
      const handler = () => setResolvedTheme(mq.matches ? 'light' : 'dark');
      mq.addEventListener('change', handler);
      return () => mq.removeEventListener('change', handler);
    }
  }, [mode, mounted]);

  const setMode = useCallback((newMode: ThemeMode) => {
    setModeState(newMode);
    try {
      localStorage.setItem('bmg-theme', newMode);
    } catch {}
  }, []);

  // Prevent flash of wrong theme — render nothing until mounted
  // Actually we need to render children so server-side works, just apply theme ASAP
  return (
    <ThemeContext.Provider value={{ mode, setMode, resolvedTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}
