'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import { useDialog } from '@/components/DialogProvider';
import { deepLinks } from '@/lib/deep-links';
import { GRAPHICS_STATUS_LABELS, type GraphicsJobStatus } from '@/lib/types';
import { isFinishedStatus } from '@/lib/graphics-status';
import type { JobKit } from '@/lib/graphics-fleet';

const shortDate = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

/** Where a kit stands, from the job's stage and its vehicle. */
function kitState(kit: JobKit, status: GraphicsJobStatus): { text: string; tone: 'ok' | 'warn' | 'info' | 'muted' } {
  if (kit.installedAt) return { text: `Installed ${shortDate(kit.installedAt)}`, tone: 'ok' };
  if (status === 'cancelled') return { text: 'Cancelled', tone: 'muted' };
  if (status === 'ready' || status === 'ready_to_pickup' || isFinishedStatus(status)) {
    return kit.van.state === 'here' ? { text: 'Ready to install', tone: 'warn' } : { text: 'Packed, waiting on vehicle', tone: 'info' };
  }
  return { text: GRAPHICS_STATUS_LABELS[status] || status, tone: 'muted' };
}

const TONES = {
  ok: { color: '#34d399', bg: 'rgba(52,211,153,0.12)' },
  warn: { color: '#f59e0b', bg: 'rgba(245,158,11,0.14)' },
  info: { color: '#60a5fa', bg: 'rgba(96,165,250,0.12)' },
  muted: { color: 'var(--text-muted)', bg: 'var(--subtle-bg)' },
};

function Chip({ text, tone }: { text: string; tone: keyof typeof TONES }) {
  const t = TONES[tone];
  return (
    <span style={{ fontSize: '11px', fontWeight: 700, padding: '2px 8px', borderRadius: '999px', color: t.color, background: t.bg, whiteSpace: 'nowrap' }}>
      {text}
    </span>
  );
}

/**
 * "Kits" on a fleet order graphics job (migration 411, Craig 2026-10-19):
 * one row per vehicle in the order with the unit number to print, its
 * estimate / SO, whether the vehicle is here, and its kit's state. Each kit
 * is marked installed on its own; the last one moves the job to Installed
 * through the page's normal status change (`onAllInstalled`).
 */
export default function GraphicsJobKits({ jobId, status, cardStyle, labelStyle, onKits, onAllInstalled }: {
  jobId: string;
  status: GraphicsJobStatus;
  cardStyle: React.CSSProperties;
  labelStyle: React.CSSProperties;
  /** The kits as loaded, so the page can warn before finishing early. */
  onKits?: (kits: JobKit[]) => void;
  onAllInstalled: (count: number) => void;
}) {
  const dialog = useDialog();
  const [kits, setKits] = useState<JobKit[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const apply = useCallback((list: JobKit[]) => {
    setKits(list);
    onKits?.(list);
  }, [onKits]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch(`/api/graphics-jobs/${encodeURIComponent(jobId)}/kits`);
        const data = res.ok ? await res.json() : { kits: [] };
        if (!cancelled) apply(data.kits || []);
      } catch {
        if (!cancelled) apply([]);
      }
    })();
    return () => { cancelled = true; };
  }, [jobId, apply]);

  if (!kits || kits.length === 0) return null;

  const done = kits.filter(k => k.installedAt).length;
  const units = kits.map(k => k.unitNumber || '?').join(', ');

  const toggle = async (kit: JobKit) => {
    const installed = !kit.installedAt;
    if (!installed && !(await dialog.confirm(`Mark the kit for unit ${kit.unitNumber || '?'} as not installed?`, { confirmLabel: 'Not installed' }))) return;
    setBusy(kit.estimateId);
    try {
      const res = await apiFetch(`/api/graphics-jobs/${encodeURIComponent(jobId)}/kits`, {
        method: 'POST',
        body: JSON.stringify({ estimateId: kit.estimateId, installed }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) {
        await dialog.alert(data.error || 'Could not save that kit.');
        return;
      }
      apply(data.kits || []);
      if (data.allInstalled) onAllInstalled((data.kits || []).length);
    } catch {
      await dialog.alert('Network error. Nothing changed, try again.');
    } finally {
      setBusy(null);
    }
  };

  const copyUnits = async () => {
    try {
      await navigator.clipboard.writeText(units);
    } catch {
      await dialog.alert(`Unit numbers: ${units}`);
    }
  };

  const th: React.CSSProperties = { textAlign: 'left', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', fontWeight: 700, padding: '6px 8px', borderBottom: '1px solid var(--border)' };
  const td: React.CSSProperties = { padding: '8px', borderBottom: '1px solid var(--border)', fontSize: '12px', verticalAlign: 'middle' };

  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
        <div style={labelStyle}>Kits · fleet order of {kits.length}</div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-body)' }}>{done} of {kits.length} installed</span>
          <button
            onClick={copyUnits}
            title={`Copy the unit numbers: ${units}`}
            style={{ padding: '3px 9px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--subtle-bg)', color: 'var(--text-body)', fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}
          >
            Copy unit list
          </button>
        </div>
      </div>
      <div style={{ display: 'flex', gap: '4px', margin: '8px 0' }} aria-label={`${done} of ${kits.length} kits installed`}>
        {kits.map(k => (
          <span key={k.estimateId} style={{ flex: 1, height: '6px', borderRadius: '3px', background: k.installedAt ? '#34d399' : 'var(--border)' }} />
        ))}
      </div>
      <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '6px' }}>
        Same graphics on each vehicle. Print one kit per unit number.
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '520px', fontVariantNumeric: 'tabular-nums' }}>
          <thead>
            <tr><th style={th}>Unit #</th><th style={th}>Estimate / SO</th><th style={th}>Vehicle</th><th style={th}>Kit</th><th style={th} /></tr>
          </thead>
          <tbody>
            {kits.map(k => {
              const state = kitState(k, status);
              const van = k.van.state === 'not_here'
                ? <Chip text="Not here yet" tone="muted" />
                : k.van.state === 'here'
                  ? <Chip text={`Here since ${shortDate(k.van.since)}`} tone="info" />
                  : <Chip text={`Done ${shortDate(k.van.since)}`} tone="ok" />;
              return (
                <tr key={k.estimateId}>
                  <td style={{ ...td, fontFamily: 'ui-monospace, monospace', fontWeight: 700 }}>{k.unitNumber || '?'}</td>
                  <td style={td}>
                    <a href={deepLinks.estimate(k.estimateId)} style={{ color: 'var(--text-body)' }}>{k.estimateNumber}</a>
                    {k.soNumber ? <span style={{ color: 'var(--text-muted)' }}> · SO {k.soNumber}</span> : null}
                  </td>
                  <td style={td}>{van}</td>
                  <td style={td}><Chip text={state.text} tone={state.tone} /></td>
                  <td style={{ ...td, textAlign: 'right' }}>
                    <button
                      onClick={() => toggle(k)}
                      disabled={busy === k.estimateId || status === 'cancelled'}
                      style={{
                        padding: '4px 9px', borderRadius: '6px', fontSize: '11px', fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap',
                        border: k.installedAt ? '1px solid var(--border)' : '1px solid rgba(52,211,153,0.45)',
                        background: k.installedAt ? 'transparent' : 'rgba(52,211,153,0.1)',
                        color: k.installedAt ? 'var(--text-muted)' : '#34d399',
                        opacity: busy === k.estimateId ? 0.5 : 1,
                      }}
                    >
                      {busy === k.estimateId ? 'Saving…' : k.installedAt ? 'Undo' : 'Mark installed'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
