'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase-browser';
import { FALLBACK_SALES_TAX_RATE, getSalesTaxRate } from '@/lib/sales-tax';

/**
 * The company sales tax rate as a FRACTION, for the builders. Read-only on
 * purpose -- only Settings -> Sales Tax (super admin) changes it, so there is
 * no setter here.
 */
export function useSalesTaxRate(): { taxRate: number; loaded: boolean } {
  const [taxRate, setTaxRate] = useState(FALLBACK_SALES_TAX_RATE);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getSalesTaxRate(createClient()).then(rate => {
      if (cancelled) return;
      setTaxRate(rate);
      setLoaded(true);
    });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- load once on mount
  }, []);

  return { taxRate, loaded };
}
