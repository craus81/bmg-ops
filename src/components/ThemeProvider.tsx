'use client';

import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { TEXT_SIZE_STORAGE_KEY, isTextSize, type TextSize } from '@/lib/text-size';

type ThemeMode = 'auto' | 'light' | 'dark';

interface ThemeContextType {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
  resolvedTheme: 'light' | 'dark'; // what's actually showing
  textSize: TextSize;
  setTextSize: (size: TextSize) => void;
}

const ThemeContext = createContext<ThemeContextType>({
  mode: 'auto',
  setMode: () => {},
  resolvedTheme: 'dark',
  textSize: 'regular',
  setTextSize: () => {},
});

export function useTheme() {
  return useContext(ThemeContext);
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>('auto');
  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>('dark');
  const [textSize, setTextSizeState] = useState<TextSize>('regular');
  const [mounted, setMounted] = useState(false);

  // Read saved preferences on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem('bmg-theme') as ThemeMode | null;
      if (saved && ['auto', 'light', 'dark'].includes(saved)) {
        setModeState(saved);
      }
      const savedSize = localStorage.getItem(TEXT_SIZE_STORAGE_KEY);
      if (isTextSize(savedSize)) {
        setTextSizeState(savedSize);
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

  // Apply text size to <html>. A pre-paint script in layout.tsx stamps the
  // saved value before first paint so the page doesn't visibly re-zoom; this
  // effect keeps it in sync with in-app changes. Gated on `mounted` so the
  // initial 'regular' state doesn't strip the pre-paint attribute for a frame.
  useEffect(() => {
    if (!mounted) return;
    const html = document.documentElement;
    if (textSize === 'regular') html.removeAttribute('data-textsize');
    else html.setAttribute('data-textsize', textSize);
  }, [textSize, mounted]);

  const setMode = useCallback((newMode: ThemeMode) => {
    setModeState(newMode);
    try {
      localStorage.setItem('bmg-theme', newMode);
    } catch {}
  }, []);

  const setTextSize = useCallback((size: TextSize) => {
    setTextSizeState(size);
    try {
      localStorage.setItem(TEXT_SIZE_STORAGE_KEY, size);
    } catch {}
  }, []);

  // Prevent flash of wrong theme — render nothing until mounted
  // Actually we need to render children so server-side works, just apply theme ASAP
  return (
    <ThemeContext.Provider value={{ mode, setMode, resolvedTheme, textSize, setTextSize }}>
      {children}
    </ThemeContext.Provider>
  );
}
