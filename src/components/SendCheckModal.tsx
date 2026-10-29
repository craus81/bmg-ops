'use client';

import { useCallback, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { closeOnEscape } from '@/lib/modal-escape';
import type { SupabaseClient } from '@supabase/supabase-js';
import { loadSendChecks, type SendCheckGroup } from '@/lib/send-check';

interface Ask {
  groups: SendCheckGroup[] | null;
  /** Couldn't read the estimates: still a reminder, just without the list. */
  failed: boolean;
  count: number;
  action: string;
  saved: boolean;
  resolve: (go: boolean) => void;
}

/**
 * The labor and freight pop-up before an estimate email opens (Craig,
 * 2026-10-29; see src/lib/send-check.ts). `ask` resolves true on Continue,
 * false on Go back or Esc. Full screen on a phone, clear of the Duo's clock
 * bubble (globals.css .send-check).
 */
export function useSendCheck(supabase: SupabaseClient): {
  ask: (ids: string[], opts: { action: string; saved?: boolean }) => Promise<boolean>;
  element: ReactNode;
} {
  const [state, setState] = useState<Ask | null>(null);

  const ask = useCallback((ids: string[], opts: { action: string; saved?: boolean }) => new Promise<boolean>(resolve => {
    const base = { count: ids.length, action: opts.action, saved: !!opts.saved, resolve };
    setState({ ...base, groups: null, failed: false });
    loadSendChecks(supabase, ids)
      .then(groups => setState(s => (s && s.resolve === resolve ? { ...s, groups } : s)))
      .catch(() => setState(s => (s && s.resolve === resolve ? { ...s, failed: true } : s)));
  }), [supabase]);

  const done = (go: boolean) => {
    if (!state) return;
    state.resolve(go);
    setState(null);
  };

  let element: ReactNode = null;
  if (state && typeof document !== 'undefined') {
    const off = (state.groups || []).filter(g => g.findings.length > 0);
    const many = state.count > 1;
    const what = many ? `these ${state.count} estimates` : 'this estimate';
    const loading = !state.groups && !state.failed;
    element = createPortal(
      <div
        ref={closeOnEscape(() => done(false))}
        className="send-check-backdrop"
        style={{
          position: 'fixed', inset: 0, zIndex: 1200, background: 'var(--overlay, rgba(0,0,0,0.7))',
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px',
        }}
      >
        <div
          role="dialog" aria-modal="true" aria-labelledby="send-check-title"
          className="send-check duo-clear-status"
          style={{
            background: 'var(--card)', border: '1px solid var(--border-strong)', borderRadius: '12px',
            width: '100%', maxWidth: '480px', maxHeight: 'calc(90vh / var(--ts, 1))', overflowY: 'auto',
            padding: '18px', display: 'flex', flexDirection: 'column', gap: '14px', boxShadow: 'var(--shadow-md)',
          }}
        >
          <div>
            <div id="send-check-title" style={{ fontSize: '17px', fontWeight: 800, color: 'var(--text-primary)' }}>
              Check labor and freight
            </div>
            <div style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: '4px' }}>
              {state.saved ? 'Saved. ' : ''}Before {state.action}, look over labor hours and freight on {what}.
            </div>
          </div>

          {loading && <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>Checking…</div>}
          {state.failed && (
            <div style={{ fontSize: '13px', color: 'var(--error)' }}>
              Couldn&apos;t read the estimates to check them. Look them over yourself before you continue.
            </div>
          )}
          {state.groups && off.length > 0 && (
            <div style={{
              background: 'var(--warning-bg)', border: '1px solid var(--warning-border)', borderRadius: '8px',
              padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '13.5px', color: 'var(--text-body)',
            }}>
              <div style={{ fontSize: '12px', fontWeight: 800, color: 'var(--warning)' }}>Looks off</div>
              {off.map(g => (
                <div key={g.id}>
                  {many && <div style={{ fontWeight: 700 }}>{g.label}</div>}
                  <ul style={{ margin: 0, paddingLeft: '18px' }}>
                    {g.findings.map(f => <li key={f}>{f}</li>)}
                  </ul>
                </div>
              ))}
            </div>
          )}
          {state.groups && off.length === 0 && (
            <div style={{
              background: 'var(--success-bg)', border: '1px solid var(--success-border)', borderRadius: '8px',
              padding: '10px 12px', fontSize: '13.5px', color: 'var(--success)',
            }}>
              Nothing looks off: every line has labor set and there is a freight line.
            </div>
          )}

          <div style={{ fontSize: '13.5px', color: 'var(--text-body)', display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <div>☐ Labor hours are right for this job</div>
            <div>☐ Freight is on the estimate if the parts ship to us</div>
          </div>

          <div className="send-check-buttons" style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            <button
              onClick={() => done(false)} autoFocus
              style={{
                padding: '10px 16px', borderRadius: '8px', border: '1px solid var(--border-strong)', background: 'transparent',
                color: 'var(--text-body)', fontSize: '14px', fontWeight: 700, cursor: 'pointer',
              }}
            >Go back</button>
            <button
              onClick={() => done(true)} disabled={loading}
              style={{
                padding: '10px 16px', borderRadius: '8px', border: 'none', background: '#16a34a', color: '#fff',
                fontSize: '14px', fontWeight: 800, cursor: loading ? 'default' : 'pointer', opacity: loading ? 0.5 : 1,
              }}
            >Continue</button>
          </div>
        </div>
      </div>,
      document.body,
    );
  }

  return { ask, element };
}
