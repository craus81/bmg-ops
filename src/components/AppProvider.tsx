'use client';

import { createContext, useContext, useState, useEffect, ReactNode, useCallback } from 'react';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import type { CatalogItem, TimeEntry, TimeBreak } from '@/lib/types';

interface AppState {
  // Clock
  clockStatus: 'out' | 'in' | 'break';
  clockInTime: string | null;
  breakStartTime: string | null;
  currentBreaks: TimeBreak[];
  elapsed: number;
  activeTimeEntry: TimeEntry | null;
  doClockIn: () => Promise<void>;
  doStartBreak: () => Promise<void>;
  doEndBreak: () => Promise<void>;
  doClockOut: () => Promise<void>;
  // Active Part
  activePart: CatalogItem | null;
  setActivePart: (part: CatalogItem | null) => void;
  // Loading
  appLoading: boolean;
}

const AppContext = createContext<AppState>({} as AppState);

export function AppProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const supabase = createClient();

  const [clockStatus, setClockStatus] = useState<'out' | 'in' | 'break'>('out');
  const [clockInTime, setClockInTime] = useState<string | null>(null);
  const [breakStartTime, setBreakStartTime] = useState<string | null>(null);
  const [currentBreaks, setCurrentBreaks] = useState<TimeBreak[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const [activeTimeEntry, setActiveTimeEntry] = useState<TimeEntry | null>(null);
  const [activePart, setActivePart] = useState<CatalogItem | null>(null);
  const [appLoading, setAppLoading] = useState(true);

  // Load active clock session on mount
  useEffect(() => {
    if (!user) {
      setAppLoading(false);
      return;
    }
    const loadSession = async () => {
      try {
        // Check for active time entry (not clocked out)
        const { data: entry } = await supabase
          .from('time_entries')
          .select('*')
          .eq('user_id', user.id)
          .is('clock_out', null)
          .order('clock_in', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (entry) {
          setActiveTimeEntry(entry);
          setClockInTime(entry.clock_in);

          // Load breaks for this entry
          const { data: breaks } = await supabase
            .from('time_breaks')
            .select('*')
            .eq('time_entry_id', entry.id)
            .order('break_start', { ascending: true });

          const loadedBreaks = breaks || [];
          setCurrentBreaks(loadedBreaks);

          // Check if currently on break (break with no end)
          const openBreak = loadedBreaks.find((b: TimeBreak) => !b.break_end);
          if (openBreak) {
            setBreakStartTime(openBreak.break_start);
            setClockStatus('break');
          } else {
            setClockStatus('in');
          }
        }
      } catch (e: any) {
        console.error('AppProvider load error:', e);
      }
      setAppLoading(false);
    };
    loadSession();
  }, [user]);

  // Elapsed timer
  useEffect(() => {
    if (clockStatus === 'out' || !clockInTime) return;
    const iv = setInterval(() => {
      let el = Date.now() - new Date(clockInTime).getTime();
      currentBreaks.forEach((b) => {
        if (b.break_end) {
          el -= new Date(b.break_end).getTime() - new Date(b.break_start).getTime();
        }
      });
      if (clockStatus === 'break' && breakStartTime) {
        el -= Date.now() - new Date(breakStartTime).getTime();
      }
      setElapsed(Math.max(0, el));
    }, 1000);
    return () => clearInterval(iv);
  }, [clockStatus, clockInTime, breakStartTime, currentBreaks]);

  const doClockIn = useCallback(async () => {
    if (!user) return;
    const now = new Date().toISOString();
    const { data, error } = await supabase
      .from('time_entries')
      .insert({ user_id: user.id, clock_in: now, status: 'clocked_in' })
      .select()
      .single();

    if (data && !error) {
      setActiveTimeEntry(data);
      setClockInTime(now);
      setCurrentBreaks([]);
      setClockStatus('in');
      setElapsed(0);
    }
  }, [user, supabase]);

  const doStartBreak = useCallback(async () => {
    if (!activeTimeEntry) return;
    const now = new Date().toISOString();
    const { data } = await supabase
      .from('time_breaks')
      .insert({ time_entry_id: activeTimeEntry.id, break_start: now })
      .select()
      .single();

    await supabase.from('time_entries').update({ status: 'on_break' }).eq('id', activeTimeEntry.id);

    if (data) {
      setCurrentBreaks((prev) => [...prev, data]);
      setBreakStartTime(now);
      setClockStatus('break');
    }
  }, [activeTimeEntry, supabase]);

  const doEndBreak = useCallback(async () => {
    if (!activeTimeEntry || !breakStartTime) return;
    const now = new Date().toISOString();
    const openBreak = currentBreaks.find((b) => !b.break_end);
    if (openBreak) {
      await supabase
        .from('time_breaks')
        .update({ break_end: now })
        .eq('id', openBreak.id);

      setCurrentBreaks((prev) =>
        prev.map((b) => (b.id === openBreak.id ? { ...b, break_end: now } : b))
      );
    }
    await supabase.from('time_entries').update({ status: 'clocked_in' }).eq('id', activeTimeEntry.id);
    setBreakStartTime(null);
    setClockStatus('in');
  }, [activeTimeEntry, breakStartTime, currentBreaks, supabase]);

  const doClockOut = useCallback(async () => {
    if (!activeTimeEntry || !clockInTime) return;
    const now = new Date();
    const nowISO = now.toISOString();

    // End any open break
    const openBreak = currentBreaks.find((b) => !b.break_end);
    if (openBreak) {
      await supabase.from('time_breaks').update({ break_end: nowISO }).eq('id', openBreak.id);
    }

    // Calculate total ms
    let totalMs = now.getTime() - new Date(clockInTime).getTime();
    const finalBreaks = currentBreaks.map((b) => ({
      ...b,
      break_end: b.break_end || nowISO,
    }));
    finalBreaks.forEach((b) => {
      totalMs -= new Date(b.break_end!).getTime() - new Date(b.break_start).getTime();
    });

    await supabase
      .from('time_entries')
      .update({ clock_out: nowISO, status: 'clocked_out', total_ms: Math.max(0, totalMs) })
      .eq('id', activeTimeEntry.id);

    setClockStatus('out');
    setClockInTime(null);
    setBreakStartTime(null);
    setCurrentBreaks([]);
    setElapsed(0);
    setActiveTimeEntry(null);
  }, [activeTimeEntry, clockInTime, currentBreaks, supabase]);

  return (
    <AppContext.Provider value={{
      clockStatus, clockInTime, breakStartTime, currentBreaks, elapsed, activeTimeEntry,
      doClockIn, doStartBreak, doEndBreak, doClockOut,
      activePart, setActivePart,
      appLoading,
    }}>
      {children}
    </AppContext.Provider>
  );
}

export const useApp = () => useContext(AppContext);
