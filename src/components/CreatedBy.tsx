'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase-browser';
import { createdByText, type CreatedBySource } from '@/lib/created-by';

/**
 * "Created by Jane Doe · Oct 7, 2026" — the one creator tag every
 * transaction (estimate, quote, wrap quote, graphics job, upfit project,
 * purchase request, vehicle, vendor invoice, NetSuite SO/PO, …) shows in
 * its detail header and on its list row (owner ask 2026-10-07).
 *
 * Pass the record's creator profile id and the component resolves the
 * name itself; ids from every tag on the page are batched into one
 * profiles read and cached for the session, so a 200-row list costs one
 * query, not 200. Records made outside FleetSuite pass `source` (and the
 * NetSuite employee's name when the sync captured it). A record with
 * neither a creator nor a source renders nothing — never a guess.
 */

const nameCache = new Map<string, string | null>();
const waiters = new Map<string, Array<(name: string | null) => void>>();
let pending = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;

async function flush() {
  timer = null;
  const ids = [...pending];
  pending = new Set();
  if (ids.length === 0) return;
  const found: Record<string, string | null> = {};
  try {
    const supabase = createClient();
    // .in() lists stay well under the 1000-row cap: one page of tags.
    for (let i = 0; i < ids.length; i += 200) {
      const { data } = await supabase.from('profiles').select('id, full_name').in('id', ids.slice(i, i + 200));
      for (const p of (data || []) as Array<{ id: string; full_name: string | null }>) found[p.id] = p.full_name || null;
    }
  } catch { /* leave unresolved ids as null — the tag just hides the name */ }
  for (const id of ids) {
    const name = found[id] ?? null;
    nameCache.set(id, name);
    for (const cb of waiters.get(id) || []) cb(name);
    waiters.delete(id);
  }
}

function lookup(id: string, cb: (name: string | null) => void) {
  const list = waiters.get(id);
  if (list) { list.push(cb); return; }
  waiters.set(id, [cb]);
  pending.add(id);
  if (!timer) timer = setTimeout(flush, 30);
}

/** Staff member's display name from their profile id (null while loading or unknown). */
export function useStaffName(id: string | null | undefined): string | null {
  const [name, setName] = useState<string | null>(() => (id ? nameCache.get(id) ?? null : null));
  useEffect(() => {
    if (!id) { setName(null); return; }
    if (nameCache.has(id)) { setName(nameCache.get(id) ?? null); return; }
    let live = true;
    lookup(id, n => { if (live) setName(n); });
    return () => { live = false; };
  }, [id]);
  return name;
}

interface CreatedByProps {
  /** Creator's profile id (created_by / requested_by / checked_in_by …). */
  userId?: string | null;
  /** Creator's name when the caller already has it (skips the lookup). */
  name?: string | null;
  /** When the record was created. */
  at?: string | null;
  /** Where a record without a FleetSuite creator came from. */
  source?: CreatedBySource | null;
  /** Wording for the verb, e.g. "Requested by", "Checked in by". */
  label?: string;
  /** List-row size: smaller type, no date. */
  compact?: boolean;
  style?: React.CSSProperties;
}

export default function CreatedBy({ userId, name, at, source, label, compact, style }: CreatedByProps) {
  const looked = useStaffName(name ? null : userId);
  const text = createdByText({ name: name || looked, at: compact ? null : at, source, label });
  if (!text) return null;
  return (
    <span
      title={compact && at ? createdByText({ name: name || looked, at, source, label }) || undefined : undefined}
      style={{
        fontSize: compact ? '11px' : '12px',
        color: 'var(--text-muted)',
        fontWeight: 500,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        maxWidth: '100%',
        ...style,
      }}
    >
      {text}
    </span>
  );
}
