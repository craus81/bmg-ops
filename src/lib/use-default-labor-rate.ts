'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase-browser';
import { FALLBACK_LABOR_RATE, getDefaultLaborRate } from '@/lib/labor-rate';

/**
 * The company default labor rate ($/hour) for the builders. Read-only --
 * only Settings -> Default Labor Rate (super admin) changes it.
 */
export function useDefaultLaborRate(): { laborRate: number; loaded: boolean } {
  const [laborRate, setLaborRate] = useState(FALLBACK_LABOR_RATE);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getDefaultLaborRate(createClient()).then(rate => {
      if (cancelled) return;
      setLaborRate(rate);
      setLoaded(true);
    });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- load once on mount
  }, []);

  return { laborRate, loaded };
}
