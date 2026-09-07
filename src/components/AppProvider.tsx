'use client';

import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { useAuth } from '@/components/AuthProvider';
import type { CatalogItem } from '@/lib/types';

/**
 * App-wide working state. The in-app punch clock that used to live here
 * (time_entries/time_breaks reads + clock in/out/break actions) was retired
 * 2026-09-07 (R4-2): staff clock in and out in the payroll software, and
 * nothing in the app ever read the entries. The historical tables remain
 * untouched in the database.
 */
interface AppState {
  // Active Part (the scan flow's current selection)
  activePart: CatalogItem | null;
  setActivePart: (part: CatalogItem | null) => void;
  // Loading
  appLoading: boolean;
}

const AppContext = createContext<AppState>({} as AppState);

export function AppProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();

  const [activePart, setActivePart] = useState<CatalogItem | null>(null);
  const [appLoading, setAppLoading] = useState(true);

  useEffect(() => {
    setAppLoading(false);
  }, [user]);

  return (
    <AppContext.Provider value={{ activePart, setActivePart, appLoading }}>
      {children}
    </AppContext.Provider>
  );
}

export const useApp = () => useContext(AppContext);
