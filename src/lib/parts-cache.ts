'use client';

/**
 * Shared client-side cache for netsuite_parts lookups so any list view can
 * show the kit name / description next to a raw part number without each
 * page running its own query.
 *
 * The full active-parts table (~5k rows max) is fetched once per session
 * and kept in a Map keyed by uppercased item_number. Pages call usePartInfo
 * (or render <PartLabel />) and get O(1) lookups after the initial load.
 */

import { useState, useEffect } from 'react';
import { createClient } from './supabase-browser';

export interface PartInfo {
  id: string;
  item_number: string;
  display_name: string | null;
  description: string | null;
  billable_customer: string | null;
}

let cachePromise: Promise<Map<string, PartInfo>> | null = null;

async function loadParts(): Promise<Map<string, PartInfo>> {
  const supabase = createClient();
  const map = new Map<string, PartInfo>();
  // Page through to defeat PostgREST's default 1k row cap.
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabase
      .from('netsuite_parts')
      .select('id, item_number, display_name, description, billable_customer')
      .eq('is_active', true)
      .order('item_number')
      .range(offset, offset + 999);
    if (error || !data || data.length === 0) break;
    for (const p of data) {
      if (p.item_number) map.set(p.item_number.toUpperCase(), p as PartInfo);
    }
    if (data.length < 1000) break;
  }
  return map;
}

function getCache(): Promise<Map<string, PartInfo>> {
  if (!cachePromise) cachePromise = loadParts();
  return cachePromise;
}

/** Look up part info synchronously after the cache has loaded. */
export function usePartInfo(partNumber: string | null | undefined): PartInfo | null {
  const [info, setInfo] = useState<PartInfo | null>(null);
  useEffect(() => {
    if (!partNumber) { setInfo(null); return; }
    let cancelled = false;
    getCache().then((map) => {
      if (!cancelled) setInfo(map.get(partNumber.toUpperCase()) || null);
    });
    return () => { cancelled = true; };
  }, [partNumber]);
  return info;
}
