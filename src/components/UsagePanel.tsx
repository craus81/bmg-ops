'use client';

/**
 * Usage tab on System Health (R7-4) — where the real friction is: client
 * errors, slow pages, slow or failing API calls, forms people start and
 * don't finish. Data from GET /api/admin/client-events (a bounded window
 * of client_events, aggregated in src/lib/client-events-report.ts).
 *
 * House rules honoured here:
 *   - a failed read renders "unknown — couldn't load", never zeros
 *   - a truncated window says so at the top, and totals read as lower bounds
 *   - pages are TEXT, never links — templated ones (/vehicles/:vin,
 *     /book/:token, …/:id) have no record to land on, and a concrete page
 *     string is still client data; the only links are deepLinks builders
 *   - submitted/started is shown as a ratio WITH the beacon-loss caveat;
 *     there is no derived "unknown" count
 */

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { apiFetch } from '@/lib/api-client';
import { deepLinks } from '@/lib/deep-links';
import { flashNote } from '@/lib/focus-note';
import type { UsageReport } from '@/lib/client-events-report';

interface UsageResponse extends UsageReport {
  days: number;
  filters: { kind: string | null; page: string | null; form: string | null };
  telemetryEnabled: boolean;
  lastEventAt: string | null;
  lastEventKnown: boolean;
  rowsRead: number;
  truncated: boolean;
  maxRows: number;
  caveats: string[];
  generatedAt: string;
}

type State =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; data: UsageResponse };

const card: React.CSSProperties = { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '14px', padding: '14px', marginBottom: '14px' };
const th: React.CSSProperties = { textAlign: 'left', fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', padding: '6px 8px', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' };
const td: React.CSSProperties = { fontSize: '12px', padding: '6px 8px', borderBottom: '1px solid var(--border)', verticalAlign: 'top', color: 'var(--text-primary)' };
const mono: React.CSSProperties = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '11.5px' };
const muted: React.CSSProperties = { color: 'var(--text-muted)' };
const unknownStyle: React.CSSProperties = { color: '#f59e0b', fontWeight: 600, fontSize: '12px' };

const relTime = (iso: string | null) => {
  if (!iso) return 'never';
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (!Number.isFinite(min)) return 'unknown';
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  if (min < 1440) return `${Math.floor(min / 60)}h ago`;
  return `${Math.floor(min / 1440)}d ago`;
};
const ms = (v: number | null) => (v === null ? <span style={muted}>too few samples</span> : `${(v / 1000).toFixed(1)} s`);
const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`);

/** Pages are always TEXT: templated ones have no record to land on, and a
 *  concrete one is still a client-supplied string — every link on this
 *  panel comes from a deepLinks builder, never a hand-built href. */
function PageCell({ page }: { page: string }) {
  return <span style={mono}>{page}</span>;
}

function Unknown({ what }: { what: string }) {
  return <div style={unknownStyle}>unknown — couldn&apos;t load {what}</div>;
}

function Section({ title, blurb, children }: { title: string; blurb: string; children: React.ReactNode }) {
  return (
    <div style={card}>
      <div style={{ fontSize: '14px', fontWeight: 800, color: 'var(--text-primary)' }}>{title}</div>
      <div style={{ fontSize: '11.5px', color: 'var(--text-muted)', marginBottom: '10px' }}>{blurb}</div>
      {children}
    </div>
  );
}

export default function UsagePanel() {
  const searchParams = useSearchParams();
  const initialDays = searchParams.get('days') === '30' ? 30 : 7;
  const [days, setDays] = useState<7 | 30>(initialDays);
  const [st, setSt] = useState<State>({ state: 'loading' });
  const kindFilter = searchParams.get('kind');
  const pageFilter = searchParams.get('page');
  const formFilter = searchParams.get('form');

  const load = useCallback(async () => {
    setSt({ state: 'loading' });
    try {
      const params = new URLSearchParams({ days: String(days) });
      const res = await apiFetch(`/api/admin/client-events?${params.toString()}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setSt({ state: 'error', message: json.error || `request failed (${res.status})` }); return; }
      setSt({ state: 'ready', data: json });
    } catch (e: any) {
      setSt({ state: 'error', message: e?.message || 'request failed' });
    }
  }, [days]);

  useEffect(() => { load(); }, [load]);

  // Deep link (deepLinks.systemHealthUsage): flash the matching row once the data is in.
  useEffect(() => {
    if (st.state !== 'ready') return;
    if (kindFilter && pageFilter) flashNote(`usage-${kindFilter}-${pageFilter}`);
    else if (formFilter) flashNote(`usage-form-${formFilter}`);
  }, [st.state, kindFilter, pageFilter, formFilter]);

  const header = (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap', marginBottom: '12px' }}>
      <div style={{ display: 'flex', gap: '6px' }}>
        {([7, 30] as const).map(d => (
          <button key={d} onClick={() => setDays(d)} style={{
            padding: '6px 12px', borderRadius: '999px', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
            background: days === d ? 'rgba(96,165,250,0.12)' : 'var(--card)',
            border: `1px solid ${days === d ? 'rgba(96,165,250,0.45)' : 'var(--border)'}`,
            color: days === d ? '#60a5fa' : 'var(--text-muted)',
          }}>Last {d} days</button>
        ))}
      </div>
      <button onClick={load} disabled={st.state === 'loading'} style={{ padding: '6px 12px', borderRadius: '8px', fontSize: '12px', fontWeight: 700, background: 'var(--card)', border: '1px solid var(--border)', color: 'var(--text-secondary)', cursor: 'pointer' }}>
        {st.state === 'loading' ? 'Loading…' : '↻ Refresh'}
      </button>
    </div>
  );

  if (st.state === 'loading') {
    return <div>{header}<div style={{ ...card, color: 'var(--text-muted)', fontSize: '13px' }}>Reading client events…</div></div>;
  }

  if (st.state === 'error') {
    // Every section is unknown — not zero, not empty.
    const what = `client_events: ${st.message}`;
    return (
      <div>
        {header}
        <div style={{ ...card, borderColor: 'rgba(245,158,11,0.45)' }}>
          <div style={{ fontWeight: 800, color: '#f59e0b', fontSize: '13px' }}>Unknown — could not read client_events</div>
          <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '4px' }}>{st.message}</div>
          <button onClick={load} style={{ marginTop: '8px', padding: '6px 12px', borderRadius: '8px', fontSize: '12px', fontWeight: 700, background: 'var(--card)', border: '1px solid var(--border)', color: 'var(--text-secondary)', cursor: 'pointer' }}>Retry</button>
        </div>
        {['Errors', 'Slow pages', 'Slow / failing API calls', 'Forms'].map(t => (
          <Section key={t} title={t} blurb=""><Unknown what={what} /></Section>
        ))}
      </div>
    );
  }

  const d = st.data;
  const filtered = (kindFilter || pageFilter || formFilter)
    ? { kind: kindFilter, page: pageFilter, form: formFilter }
    : null;
  const errors = filtered?.page ? d.errors.filter(e => e.page === filtered.page) : d.errors;
  const slowApi = filtered?.page ? d.slowApi.filter(a => a.route === filtered.page) : d.slowApi;
  const forms = filtered?.form ? d.forms.filter(f => f.formId === filtered.form) : d.forms;
  const slowPagesAll = d.slowPages.filter(p => p.nav === 'all');
  const navSplit = (page: string, nav: 'hard' | 'soft') => d.slowPages.find(p => p.page === page && p.nav === nav);

  const noEventsEver = d.lastEventKnown && d.lastEventAt === null;
  const quietWindow = d.rowsRead === 0 && d.lastEventAt !== null;
  const dash = <span style={muted}>—</span>;

  return (
    <div>
      {header}

      {/* Status strip */}
      <div style={card}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '10px' }}>
          {[
            ['Telemetry', d.telemetryEnabled ? 'on' : 'OFF (build-time)'],
            ['Last event received', d.lastEventKnown ? relTime(d.lastEventAt) : 'unknown'],
            ['Events in window', d.telemetryEnabled ? `${d.rowsRead.toLocaleString()}${d.truncated ? '+' : ''}` : '—'],
            ['Sessions in window', d.telemetryEnabled ? d.totals.sessions.toLocaleString() : '—'],
            ['Client-side drops', d.totals.queueDropped > 0 ? `${d.totals.queueDropped.toLocaleString()} events never sent` : 'none reported'],
          ].map(([k, v]) => (
            <div key={k}>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 700 }}>{k}</div>
              <div style={{ fontSize: '14px', fontWeight: 800, color: 'var(--text-primary)' }}>{v}</div>
            </div>
          ))}
        </div>
        {!d.telemetryEnabled && (
          <div style={{ marginTop: '10px', fontSize: '12px', color: '#f59e0b', fontWeight: 600 }}>
            Telemetry is off (NEXT_PUBLIC_TELEMETRY=off at build time) — nothing is being recorded. Unset it and redeploy to turn it back on.
          </div>
        )}
        {d.telemetryEnabled && noEventsEver && (
          <div style={{ marginTop: '10px', fontSize: '12px', color: '#f59e0b', fontWeight: 600 }}>
            No events ever received — beacons are not arriving (ad-blocker, a deploy that predates this feature, or a broken route), or nobody has hit friction yet. Silence is not evidence of health.
          </div>
        )}
        {d.telemetryEnabled && quietWindow && (
          <div style={{ marginTop: '10px', fontSize: '12px', color: 'var(--text-secondary)' }}>
            Nothing in the last {d.days} days; last event {relTime(d.lastEventAt)}.
          </div>
        )}
        {d.truncated && (
          <div style={{ marginTop: '10px', fontSize: '12px', color: '#f59e0b', fontWeight: 600 }}>
            Showing the most recent {d.maxRows.toLocaleString()} events only — every total below is a lower bound.
          </div>
        )}
        {filtered && (
          <div style={{ marginTop: '10px', fontSize: '12px', color: 'var(--text-secondary)' }}>
            Filtered by link: {[filtered.kind && `kind=${filtered.kind}`, filtered.page && `page=${filtered.page}`, filtered.form && `form=${filtered.form}`].filter(Boolean).join(' · ')}
            {' · '}<a href={deepLinks.systemHealthUsage()} style={{ color: '#60a5fa' }}>clear</a>
          </div>
        )}
        <div style={{ marginTop: '8px', fontSize: '11px', color: 'var(--text-muted)' }}>
          Purge job: see <a href={deepLinks.systemHealth()} style={{ color: '#60a5fa' }}>Jobs &amp; email → Client events purge</a>. Retention is 30 days.
        </div>
      </div>

      {/* Errors */}
      <Section title="Errors" blurb="Uncaught JS errors and unhandled rejections, deduped by masked message + templated page. Sorted by sessions affected — raw counts overweight one looping tablet.">
        {!d.telemetryEnabled ? dash : errors.length === 0 ? <div style={{ fontSize: '12px', ...muted }}>no errors recorded in window</div> : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr><th style={th}>Message</th><th style={th}>Page</th><th style={th}>Sessions</th><th style={th}>Count</th><th style={th}>Last seen</th><th style={th}>Roles</th></tr></thead>
              <tbody>
                {errors.map(e => (
                  <tr key={`${e.message}|${e.page}`} id={`usage-error-${e.page}`}>
                    <td style={td}>
                      <div style={mono}>{e.rejection ? '⟲ ' : ''}{e.message}</div>
                      {e.sampleStack && <details style={{ marginTop: '4px' }}><summary style={{ fontSize: '11px', cursor: 'pointer', ...muted }}>sample stack</summary><pre style={{ ...mono, whiteSpace: 'pre-wrap', margin: '4px 0 0', color: 'var(--text-secondary)' }}>{e.sampleStack}</pre></details>}
                    </td>
                    <td style={td}><PageCell page={e.page} /><div><a href={deepLinks.systemHealthUsage({ kind: 'error', page: e.page, days })} style={{ fontSize: '11px', color: '#60a5fa' }}>filter</a></div></td>
                    <td style={td}>{e.sessions}</td>
                    <td style={td}>{e.count}</td>
                    <td style={td} title={e.lastSeen}>{relTime(e.lastSeen)}</td>
                    <td style={{ ...td, ...muted }}>{e.roles.join(', ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {/* Slow pages */}
      <Section title="Slow pages" blurb="Load / settle time by templated page. p50 and p95 are weighted (timings are sampled 1-in-4; loads over 3 s are always recorded). Under 5 weighted samples there is no percentile.">
        {!d.telemetryEnabled ? dash : slowPagesAll.length === 0 ? <div style={{ fontSize: '12px', ...muted }}>no page timings in window</div> : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr><th style={th}>Page</th><th style={th}>p50</th><th style={th}>p95</th><th style={th}>max</th><th style={th}>&gt; 3 s loads</th><th style={th}>samples (weighted)</th><th style={th}>hard / soft p95</th></tr></thead>
              <tbody>
                {slowPagesAll.map(p => {
                  const hard = navSplit(p.page, 'hard'); const soft = navSplit(p.page, 'soft');
                  return (
                    <tr key={p.page} id={`usage-slow_page-${p.page}`}>
                      <td style={td}><PageCell page={p.page} /></td>
                      <td style={td}>{ms(p.p50)}</td>
                      <td style={td}>{ms(p.p95)}</td>
                      <td style={td}>{(p.max / 1000).toFixed(1)} s</td>
                      <td style={td}>{p.slowCount}</td>
                      <td style={td}>{p.samples} <span style={muted}>({p.rows} rows)</span></td>
                      <td style={{ ...td, ...muted }}>{hard ? ms(hard.p95) : '—'} / {soft ? ms(soft.p95) : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {/* Slow API */}
      <Section title="Slow / failing API calls" blurb="Same-origin /api/* and Supabase REST calls that took over 4 s, returned 5xx, or failed at the network. 4xx are business outcomes and are not recorded. At most 3 per route per 5 min per session.">
        {!d.telemetryEnabled ? dash : slowApi.length === 0 ? <div style={{ fontSize: '12px', ...muted }}>no slow or failing calls in window</div> : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr><th style={th}>Route</th><th style={th}>Count</th><th style={th}>Sessions</th><th style={th}>Failures</th><th style={th}>p95</th><th style={th}>max</th></tr></thead>
              <tbody>
                {slowApi.map(a => (
                  <tr key={`${a.method} ${a.route}`} id={`usage-api_slow-${a.route}`}>
                    <td style={td}><span style={mono}>{a.method} {a.route}</span> <a href={deepLinks.systemHealthUsage({ kind: 'api_slow', page: a.route, days })} style={{ fontSize: '11px', color: '#60a5fa' }}>filter</a></td>
                    <td style={td}>{a.count}</td>
                    <td style={td}>{a.sessions}</td>
                    <td style={{ ...td, color: a.failures > 0 ? '#ef4444' : 'var(--text-primary)', fontWeight: a.failures > 0 ? 700 : 400 }}>{a.failures}</td>
                    <td style={td}>{ms(a.p95)}</td>
                    <td style={td}>{(a.maxMs / 1000).toFixed(1)} s</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {/* Forms */}
      <Section title="Forms" blurb="Started / submitted / abandoned are three separate tallies of distinct attempts. They are NOT expected to add up — beacons can be lost (offline tablet, app killed, ad-blocker) — so the submit ratio is a lower bound, not a conversion rate.">
        {!d.telemetryEnabled ? dash : forms.length === 0 ? <div style={{ fontSize: '12px', ...muted }}>no form activity in window</div> : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr><th style={th}>Form</th><th style={th}>Started</th><th style={th}>Submitted</th><th style={th}>Abandoned</th><th style={th}>Submitted / started</th><th style={th}>Median open (submitted / abandoned)</th><th style={th}>Exit reasons</th><th style={th}>Last step when abandoned</th></tr></thead>
              <tbody>
                {forms.map(f => (
                  <tr key={f.formId} id={`usage-form-${f.formId}`}>
                    <td style={td}><span style={mono}>{f.formId}</span> <a href={deepLinks.systemHealthUsage({ form: f.formId, days })} style={{ fontSize: '11px', color: '#60a5fa' }}>filter</a></td>
                    <td style={td}>{f.started}</td>
                    <td style={td}>{f.submitted}</td>
                    <td style={{ ...td, color: f.abandoned > 0 ? '#f59e0b' : 'var(--text-primary)' }}>{f.abandoned}</td>
                    <td style={td}>
                      {f.started === 0 ? <span style={muted}>not started in window</span> : (
                        <div>
                          <div style={{ height: '6px', borderRadius: '3px', background: 'var(--border)', overflow: 'hidden', width: '120px' }}>
                            <div style={{ width: `${Math.min(100, Math.round((f.submitRatio || 0) * 100))}%`, height: '100%', background: '#22c55e' }} />
                          </div>
                          <div style={{ fontSize: '11px' }}>{pct(f.submitRatio)} <span style={muted}>(lower bound)</span></div>
                        </div>
                      )}
                    </td>
                    <td style={td}>{f.medianSecondsSubmitted === null ? '—' : `${f.medianSecondsSubmitted}s`} / {f.medianSecondsAbandoned === null ? '—' : `${f.medianSecondsAbandoned}s`}</td>
                    <td style={{ ...td, ...muted }}>{Object.entries(f.exits).map(([k, v]) => `${k} ${v}`).join(', ') || '—'}</td>
                    <td style={{ ...td, ...muted }}>{Object.entries(f.lastStep).sort((a, b) => b[1] - a[1]).map(([k, v]) => `step ${k} ×${v}`).join(', ') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {/* Caveats */}
      <div style={{ ...card, fontSize: '11.5px', color: 'var(--text-muted)' }}>
        <div style={{ fontWeight: 700, marginBottom: '4px' }}>Read this with:</div>
        <ul style={{ margin: 0, paddingLeft: '18px' }}>
          {d.caveats.map((c, i) => <li key={i}>{c}</li>)}
          <li>Nothing personal is stored: no user ids, IPs, raw user agents, query strings, field values, or e-mails/VINs/phone numbers in messages. See docs/usage-telemetry.md.</li>
        </ul>
        <div style={{ marginTop: '6px' }}>Generated {relTime(d.generatedAt)}.</div>
      </div>
    </div>
  );
}
