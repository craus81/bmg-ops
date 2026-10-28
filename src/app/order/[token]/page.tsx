'use client';

/**
 * Customer Order status page (migration 449) — the link in the rep's "We got
 * your approval" email. Read-only, no login: the token is the credential.
 * One approved estimate, seven plain stages that move on their own, and the
 * rep to call. No prices.
 *
 * Fixed light styling, like the approval pages and the PO portal — this
 * renders outside the app's theme provider and on the customer's devices.
 */

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import type { OrderStageView } from '@/lib/order-status';

interface OrderStatusPayload {
  status: 'ready';
  generatedAt: string;
  estimate: { number: string | null; title: string | null; customerName: string | null };
  rep: { name: string | null; email: string | null } | null;
  company: { name: string; phone: string | null };
  current: string;
  currentLabel: string;
  stages: OrderStageView[];
}

type PageState = { kind: 'loading' } | { kind: 'invalid' } | { kind: 'error'; message: string } | { kind: 'ready'; data: OrderStatusPayload };

const ink = '#0f172a';
const muted = '#64748b';
const line = '#e2e8f0';
const blue = '#1d4ed8';
const green = '#16a34a';

export default function OrderStatusPage() {
  const params = useParams<{ token: string }>();
  const token = String(params?.token || '');
  const [state, setState] = useState<PageState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`/api/order-status/${encodeURIComponent(token)}`, { cache: 'no-store' });
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (res.status === 404) setState({ kind: 'invalid' });
        else if (!res.ok || data.status !== 'ready') setState({ kind: 'error', message: data.error || 'Could not load your order. Try again in a minute.' });
        else setState({ kind: 'ready', data });
      } catch {
        if (!cancelled) setState({ kind: 'error', message: 'Could not reach us. Check your connection and try again.' });
      }
    };
    load();
    // A page left open on a desk catches up on its own.
    const t = setInterval(load, 5 * 60 * 1000);
    return () => { cancelled = true; clearInterval(t); };
  }, [token]);

  return (
    <div style={{ minHeight: '100%', background: '#f3f4f6', color: ink, fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' }}>
      <div style={{ maxWidth: '520px', margin: '0 auto', padding: '20px 16px 48px' }}>
        <div style={{ background: '#fff', border: `1px solid ${line}`, borderRadius: '14px', overflow: 'hidden' }}>
          <div style={{ padding: '14px 18px', borderBottom: `1px solid ${line}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/bmg-logo-color.png" alt="BMG Fleet Installations" style={{ height: '34px', width: 'auto' }} />
            {state.kind === 'ready' && (
              <span style={{
                fontSize: '13px', fontWeight: 700, borderRadius: '999px', padding: '4px 10px',
                background: ['done', 'invoiced'].includes(state.data.current) ? '#dcfce7' : '#dbeafe',
                color: ['done', 'invoiced'].includes(state.data.current) ? '#15803d' : blue,
              }}>{state.data.currentLabel}</span>
            )}
          </div>
          <div style={{ padding: '18px' }}>
            {state.kind === 'loading' && <div style={{ color: muted }}>Loading your order…</div>}
            {state.kind === 'invalid' && (
              <div>
                <div style={{ fontWeight: 800, fontSize: '18px', marginBottom: '6px' }}>This link isn&apos;t active</div>
                <div style={{ color: muted, fontSize: '14px' }}>Ask your BMG rep for a new order status link.</div>
              </div>
            )}
            {state.kind === 'error' && <div style={{ color: '#dc2626', fontWeight: 600 }}>{state.message}</div>}
            {state.kind === 'ready' && <Ready data={state.data} token={token} />}
          </div>
        </div>
      </div>
    </div>
  );
}

function Ready({ data, token }: { data: OrderStatusPayload; token: string }) {
  const { estimate, rep, company, stages } = data;
  return (
    <>
      <div style={{ fontSize: '13px', color: muted }}>Order status{estimate.customerName ? ` · ${estimate.customerName}` : ''}</div>
      <div style={{ fontSize: '20px', fontWeight: 800, margin: '2px 0 4px' }}>Estimate {estimate.number ? `#${estimate.number}` : ''}</div>
      {estimate.title && <div style={{ fontSize: '14px', color: muted, marginBottom: '16px' }}>{estimate.title}</div>}
      <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {stages.map((s, i) => {
          const last = i === stages.length - 1;
          const nextDone = !last && stages[i + 1].state !== 'todo';
          const mark = s.state === 'done' ? { bg: green, border: green, color: '#fff' }
            : s.state === 'now' ? { bg: blue, border: blue, color: '#fff' }
              : { bg: '#fff', border: '#cbd5e1', color: '#94a3b8' };
          return (
            <li key={s.key} style={{ display: 'grid', gridTemplateColumns: '28px 1fr', gap: '10px', position: 'relative', paddingBottom: last ? 0 : '16px' }}>
              {!last && (
                <span aria-hidden style={{ position: 'absolute', left: '13px', top: '28px', bottom: 0, width: '2px', background: nextDone ? green : line }} />
              )}
              <span style={{
                width: '28px', height: '28px', borderRadius: '50%', boxSizing: 'border-box', zIndex: 1,
                display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '14px', fontWeight: 700,
                background: mark.bg, border: `2px solid ${mark.border}`, color: mark.color,
                boxShadow: s.state === 'now' ? '0 0 0 4px #dbeafe' : undefined,
              }}>{s.state === 'done' ? '✓' : i + 1}</span>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: '15px', color: s.state === 'todo' ? '#94a3b8' : ink }}>{s.label}</div>
                {s.detail && <div style={{ fontSize: '13px', color: s.state === 'todo' ? '#94a3b8' : '#475569' }}>{s.detail}</div>}
              </div>
            </li>
          );
        })}
      </ol>
      <div style={{ borderTop: `1px solid ${line}`, paddingTop: '12px', marginTop: '16px', fontSize: '14px' }}>
        <b>Questions?</b> {rep?.name || company.name}
        <div style={{ color: muted, overflowWrap: 'anywhere' }}>
          {[rep?.email, company.phone].filter(Boolean).join(' · ')}
        </div>
      </div>
      <div style={{ marginTop: '12px', fontSize: '13px', color: muted, display: 'flex', flexWrap: 'wrap', gap: '6px 14px' }}>
        <a href={`/api/order-status/${encodeURIComponent(token)}/pdf`} style={{ color: blue, fontWeight: 600 }}>Download approved estimate (PDF)</a>
        <span>Updated {new Date(data.generatedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
      </div>
    </>
  );
}
