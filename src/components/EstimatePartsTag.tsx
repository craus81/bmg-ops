'use client';

import { useEffect, useState } from 'react';
import type { PartsStageResult } from '@/lib/estimate-parts-stage';

/**
 * The Approved / Parts ordered / Parts in stock tag and banner (Craig,
 * 2026-10-26). Approved is a green outline; the two "parts are handled"
 * stages are solid green so the difference reads at a glance.
 */

const GREEN = '#22c55e';
const SOLID = '#16a34a';

/** Tags for a list of estimates, keyed by id. Missing = no tag. */
export function useEstimatePartsStages(ids: string[]): Record<string, PartsStageResult> {
  const [stages, setStages] = useState<Record<string, PartsStageResult>>({});
  const key = [...new Set(ids)].join(',');
  useEffect(() => {
    if (!key) { setStages({}); return; }
    let cancelled = false;
    // Batches keep each request under the route's 500-id cap.
    const all = key.split(',');
    (async () => {
      const merged: Record<string, PartsStageResult> = {};
      for (let i = 0; i < all.length; i += 500) {
        const batch = all.slice(i, i + 500);
        try {
          const res = await fetch('/api/estimates/parts-status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids: batch }),
          });
          if (!res.ok) continue;
          const data = await res.json();
          Object.assign(merged, data.stages || {});
        } catch { /* no tags is better than a broken list */ }
      }
      if (!cancelled) setStages(merged);
    })();
    return () => { cancelled = true; };
  }, [key]);
  return stages;
}

export function PartsStageTag({ stage, size = 'sm' }: { stage: PartsStageResult | null | undefined; size?: 'sm' | 'md' }) {
  if (!stage) return null;
  const solid = stage.stage !== 'approved';
  return (
    <span
      title={stage.detail}
      style={{
        display: 'inline-block', whiteSpace: 'nowrap', verticalAlign: 'middle',
        fontSize: size === 'md' ? '11px' : '10px', fontWeight: 800,
        padding: size === 'md' ? '2px 9px' : '1px 7px', borderRadius: '999px',
        background: solid ? SOLID : 'rgba(34,197,94,0.14)',
        color: solid ? '#ffffff' : GREEN,
        border: `1px solid ${solid ? SOLID : GREEN}`,
      }}
    >
      {stage.label}
    </span>
  );
}

/** The big banner across the top of an estimate. */
export function PartsStageBanner({ stage, approvedBy }: { stage: PartsStageResult | null | undefined; approvedBy?: string | null }) {
  if (!stage) return null;
  const solid = stage.stage !== 'approved';
  const second = stage.stage === 'approved' && approvedBy ? `${approvedBy} · ${stage.detail}` : stage.detail;
  return (
    <div
      role="status"
      style={{
        width: '100%', padding: '14px 12px', borderRadius: '12px', marginBottom: '12px', textAlign: 'center',
        background: solid ? SOLID : 'rgba(34,197,94,0.14)',
        border: `2px solid ${solid ? SOLID : GREEN}`,
        color: solid ? '#ffffff' : GREEN,
      }}
    >
      <div style={{ fontSize: '22px', fontWeight: 900, letterSpacing: '0.05em' }}>{stage.label.toUpperCase()}</div>
      <div style={{ fontSize: '12px', fontWeight: 600, marginTop: '2px' }}>{second}</div>
    </div>
  );
}
