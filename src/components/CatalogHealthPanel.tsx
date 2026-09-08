'use client';

/**
 * Catalog health + fix-it worklists + the enrichment review queue (R6-7).
 *
 * Each attribute gets one bar. The headline number is coverage across the
 * parts actually IN PLAY — on an open sales order, on an open vendor PO, or
 * in the pending purchase-request queue — with whole-catalog coverage shown
 * beside it in smaller type. A raw catalog-wide percentage over 12,000 rows
 * of mostly dead stock is true and useless; the in-demand number is the one
 * somebody can act on, which is why it leads and why the worklist under
 * each bar puts in-demand parts first.
 *
 * The enrichment queue below is the review gate: a pass writes proposals,
 * never the catalog. Accepting is the only thing that touches a part.
 */

import { useCallback, useEffect, useState } from 'react';
import { theme } from '@/lib/theme';
import { coverageTone, type AttributeCoverage } from '@/lib/catalog-health';
import { deepLinks } from '@/lib/deep-links';

const TONE_COLOR: Record<string, string> = {
  good: '#34d399', warn: '#f59e0b', bad: '#f87171', none: 'var(--text-muted)',
};

const FIELD_LABEL: Record<string, string> = {
  product_category_id: 'Browse category',
  vehicle_type: 'Vehicle type',
  graphic_package: 'Graphic package',
  marketing_description: 'Marketing description',
  vendor: 'Vendor',
  catalog: 'Catalog',
  misfile: 'Looks misfiled',
};

interface Health {
  attributes: AttributeCoverage[];
  parts: number;
  hotParts: number;
  uncatalogued: string[];
  nonStockExcluded?: number;
  /** In play, in the catalog, but deactivated — a different gap from
   *  "no row at all", so it gets its own line. */
  deactivatedInPlay?: string[];
}

interface Proposal {
  id: string;
  item_number: string;
  field: string;
  proposed_value: string | null;
  proposed_label: string | null;
  current_value: string | null;
  confidence: 'high' | 'medium' | 'low';
  evidence: string | null;
  source: 'model' | 'purchase_history';
  part?: { id: string; item_number: string; display_name: string | null; description: string | null } | null;
}

export default function CatalogHealthPanel() {
  const [open, setOpen] = useState(false);
  const [health, setHealth] = useState<Health | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [lastRun, setLastRun] = useState<{ at: string | null; result: any } | null>(null);
  const [modelAvailable, setModelAvailable] = useState(true);
  const [running, setRunning] = useState(false);
  const [runNote, setRunNote] = useState<string | null>(null);
  const [deciding, setDeciding] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/parts/catalog-health');
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.success) throw new Error(body?.error || `HTTP ${res.status}`);
      setHealth(body.health);
    } catch (e: any) {
      setError(e?.message || 'Could not measure catalog health');
    }
    setLoading(false);
  }, []);

  const loadProposals = useCallback(async () => {
    try {
      const res = await fetch('/api/parts/enrich');
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.success) return;
      setProposals(body.proposals || []);
      setLastRun(body.lastRun || null);
      setModelAvailable(body.modelAvailable !== false);
    } catch { /* the queue simply stays empty */ }
  }, []);

  useEffect(() => {
    if (!open || health) return;
    load();
    loadProposals();
  }, [open, health, load, loadProposals]);

  const runPass = async (vendorOnly: boolean) => {
    setRunning(true);
    setRunNote(null);
    try {
      const res = await fetch('/api/parts/enrich', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vendorOnly, limit: 25 }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.success) throw new Error(body?.error || `HTTP ${res.status}`);
      setRunNote(
        `${body.proposals} new proposal${body.proposals !== 1 ? 's' : ''}`
        + ` (${body.vendorProposals} from purchase history, ${body.modelProposals} from part text)`
        + (body.unchanged ? ` · ${body.unchanged} unchanged` : '')
        + (body.modelFailures ? ` · ${body.modelFailures} part${body.modelFailures !== 1 ? 's' : ''} failed` : '')
        + (body.problems?.length ? ` · ${body.problems[0]}` : ''),
      );
      await loadProposals();
    } catch (e: any) {
      setRunNote(`Pass failed: ${e?.message || 'unknown error'}`);
    }
    setRunning(false);
  };

  const decide = async (ids: string[], action: 'accept' | 'reject') => {
    if (ids.length === 0) return;
    setDeciding(true);
    try {
      const res = await fetch('/api/parts/enrich', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, action }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.success) throw new Error(body?.error || `HTTP ${res.status}`);
      await loadProposals();
      // Accepting changes the very numbers above, so they get refreshed too.
      if (action === 'accept') await load();
    } catch (e: any) {
      setRunNote(`Could not save: ${e?.message || 'unknown error'}`);
    }
    setDeciding(false);
  };

  const pendingCount = proposals.length;

  return (
    <div style={{ marginBottom: '10px' }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%', padding: '9px 12px', borderRadius: '10px', textAlign: 'left',
          background: 'rgba(96,165,250,0.08)', border: '1px solid rgba(96,165,250,0.28)',
          color: '#60a5fa', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
        }}
      >
        📊 Catalog health{pendingCount > 0 ? ` · ${pendingCount} enrichment proposal${pendingCount !== 1 ? 's' : ''} to review` : ''}
        <span style={{ float: 'right' }}>{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div style={{
          marginTop: '8px', padding: '14px', borderRadius: '12px',
          background: theme.card, border: `1px solid ${theme.border}`,
        }}>
          {loading && <div style={{ fontSize: '12px', color: theme.textMuted }}>Measuring the catalog…</div>}

          {error && (
            <div style={{ fontSize: '12px', color: '#f87171' }}>
              Could not measure catalog health: {error}
              <div style={{ fontSize: '11px', color: theme.textMuted, marginTop: '4px' }}>
                Nothing partial is shown on purpose — a short read would understate a gap.
              </div>
              <button onClick={load} style={{ marginTop: '8px', padding: '5px 11px', borderRadius: '7px', border: `1px solid ${theme.border}`, background: 'transparent', color: theme.textSecondary, fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}>
                Try again
              </button>
            </div>
          )}

          {health && (
            <>
              <div style={{ fontSize: '11.5px', color: theme.textSecondary, marginBottom: '12px' }}>
                <b style={{ color: theme.textPrimary }}>{health.hotParts}</b> of {health.parts} active parts are in play right now
                {' '}(on an open sales order, an open PO, or in the purchase queue).
                {' '}Each bar leads with coverage on those.
                {health.nonStockExcluded ? (
                  <span style={{ color: theme.textMuted }}> {health.nonStockExcluded} labor/service item{health.nonStockExcluded !== 1 ? 's' : ''} excluded — they have no photo or dimensions to miss.</span>
                ) : null}
              </div>

              {(health.deactivatedInPlay?.length ?? 0) > 0 && (
                <div style={{
                  fontSize: '11.5px', color: 'var(--text-body)', marginBottom: '12px',
                  padding: '9px 11px', borderRadius: '9px',
                  background: 'rgba(245,158,11,0.07)', border: '1px solid rgba(245,158,11,0.3)',
                }}>
                  ⚠ {health.deactivatedInPlay!.length} deactivated part{health.deactivatedInPlay!.length !== 1 ? 's are' : ' is'} still on an open job or PO:{' '}
                  <span style={{ fontWeight: 700 }}>{health.deactivatedInPlay!.slice(0, 8).join(', ')}</span>
                  {health.deactivatedInPlay!.length > 8 && ` +${health.deactivatedInPlay!.length - 8} more`}
                </div>
              )}

              {health.uncatalogued.length > 0 && (
                <div style={{
                  fontSize: '11.5px', color: 'var(--text-body)', marginBottom: '12px',
                  padding: '9px 11px', borderRadius: '9px',
                  background: 'rgba(245,158,11,0.07)', border: '1px solid rgba(245,158,11,0.3)',
                }}>
                  ⚠ {health.uncatalogued.length} item number{health.uncatalogued.length !== 1 ? 's are' : ' is'} on a job or a PO with no catalog row at all,
                  so {health.uncatalogued.length !== 1 ? 'they appear' : 'it appears'} in none of the bars below:{' '}
                  <span style={{ fontWeight: 700 }}>{health.uncatalogued.slice(0, 8).join(', ')}</span>
                  {health.uncatalogued.length > 8 && ` +${health.uncatalogued.length - 8} more`}
                </div>
              )}

              {health.attributes.map(a => {
                const tone = coverageTone(a.hotPct);
                const isOpen = expanded === a.key;
                return (
                  <div key={a.key} style={{ marginBottom: '11px' }}>
                    <div
                      onClick={() => setExpanded(isOpen ? null : a.key)}
                      style={{ display: 'flex', alignItems: 'baseline', gap: '8px', cursor: 'pointer' }}
                    >
                      <div style={{ fontSize: '12px', fontWeight: 700, color: theme.textPrimary, minWidth: '112px' }}>{a.label}</div>
                      <div style={{ flex: 1, height: '8px', borderRadius: '4px', background: 'var(--progress-track)', overflow: 'hidden' }}>
                        <div style={{
                          width: `${a.hotPct ?? 0}%`, height: '100%',
                          background: TONE_COLOR[tone], transition: 'width 0.2s',
                        }} />
                      </div>
                      <div style={{ fontSize: '12px', fontWeight: 800, color: TONE_COLOR[tone], minWidth: '48px', textAlign: 'right' }}>
                        {a.hotPct === null ? '—' : `${a.hotPct}%`}
                      </div>
                      <div style={{ fontSize: '10px', color: theme.textMuted, minWidth: '96px', textAlign: 'right' }}>
                        {a.hotFilled}/{a.hotTotal} in play · {a.pct === null ? '—' : `${a.pct}%`} of all
                      </div>
                    </div>
                    <div style={{ fontSize: '10.5px', color: theme.textMuted, marginLeft: '120px', marginTop: '2px' }}>
                      {a.why}
                    </div>
                    {isOpen && (
                      <div style={{ marginTop: '7px', marginLeft: '120px', fontSize: '11px' }}>
                        <div style={{ color: theme.textSecondary, marginBottom: '5px' }}>{a.fixHint}</div>
                        {a.worklist.length === 0 ? (
                          <div style={{ color: theme.textMuted }}>Nothing missing — this one is done.</div>
                        ) : (
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px' }}>
                            {a.worklist.map(p => (
                              <a
                                key={p.id} href={deepLinks.part(p.id)}
                                style={{
                                  padding: '3px 7px', borderRadius: '6px', textDecoration: 'none',
                                  background: 'var(--subtle-bg)', border: `1px solid ${theme.border}`,
                                  color: theme.textSecondary, fontSize: '10.5px', fontWeight: 700,
                                }}
                              >
                                {p.item_number}
                              </a>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </>
          )}

          {/* ── Enrichment pass + review queue ───────────────────────── */}
          <div style={{ marginTop: '16px', paddingTop: '13px', borderTop: `1px solid ${theme.border}` }}>
            <div style={{ fontSize: '12.5px', fontWeight: 800, color: theme.textPrimary, marginBottom: '3px' }}>
              Auto-enrichment
            </div>
            <div style={{ fontSize: '11px', color: theme.textMuted, marginBottom: '9px' }}>
              A pass proposes what's missing — vendor from actual purchase history, category and
              copy from each part's own text. Nothing reaches the catalog until you accept it.
              {!modelAvailable && ' No model key is configured, so only the vendor backfill will run.'}
            </div>

            <div style={{ display: 'flex', gap: '7px', flexWrap: 'wrap', marginBottom: '9px' }}>
              <button
                onClick={() => runPass(false)} disabled={running}
                style={{ padding: '6px 12px', borderRadius: '8px', border: '1px solid rgba(96,165,250,0.35)', background: 'rgba(96,165,250,0.12)', color: '#60a5fa', fontSize: '11px', fontWeight: 800, cursor: running ? 'wait' : 'pointer', opacity: running ? 0.7 : 1 }}
              >
                {running ? 'Running…' : 'Run a pass (25 parts)'}
              </button>
              <button
                onClick={() => runPass(true)} disabled={running}
                title="Deterministic: who we actually bought each part from, off the PO mirror. No model call."
                style={{ padding: '6px 12px', borderRadius: '8px', border: `1px solid ${theme.border}`, background: 'transparent', color: theme.textSecondary, fontSize: '11px', fontWeight: 700, cursor: running ? 'wait' : 'pointer' }}
              >
                Vendor backfill only
              </button>
              {lastRun?.at && (
                <span style={{ fontSize: '10.5px', color: theme.textMuted, alignSelf: 'center' }}>
                  Last pass {new Date(lastRun.at).toLocaleString()}
                </span>
              )}
            </div>

            {runNote && <div style={{ fontSize: '11px', color: theme.textSecondary, marginBottom: '9px' }}>{runNote}</div>}

            {pendingCount === 0 ? (
              <div style={{ fontSize: '11.5px', color: theme.textMuted }}>Nothing waiting for review.</div>
            ) : (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: '9px', marginBottom: '7px' }}>
                  <div style={{ fontSize: '11.5px', color: theme.textSecondary, flex: 1 }}>
                    {pendingCount} proposal{pendingCount !== 1 ? 's' : ''} to review
                  </div>
                  <button
                    onClick={() => decide(proposals.filter(p => p.source === 'purchase_history' && p.confidence === 'high').map(p => p.id), 'accept')}
                    disabled={deciding || !proposals.some(p => p.source === 'purchase_history' && p.confidence === 'high')}
                    title="Only the deterministic, near-unanimous vendor backfills — never a model judgement"
                    style={{ padding: '5px 10px', borderRadius: '7px', border: '1px solid rgba(52,211,153,0.35)', background: 'rgba(52,211,153,0.1)', color: '#34d399', fontSize: '10.5px', fontWeight: 800, cursor: deciding ? 'wait' : 'pointer' }}
                  >
                    Accept all high-confidence vendors
                  </button>
                </div>

                <div style={{ maxHeight: 'calc(52vh / var(--ts))', overflowY: 'auto' }}>
                  {proposals.map(p => (
                    <div
                      key={p.id}
                      style={{
                        display: 'flex', alignItems: 'flex-start', gap: '9px', padding: '8px 9px',
                        borderRadius: '9px', marginBottom: '4px',
                        background: 'var(--subtle-bg)', border: `1px solid ${theme.border}`,
                      }}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: '11.5px', fontWeight: 800, color: theme.textPrimary }}>
                          {p.item_number}
                          <span style={{ fontWeight: 600, color: theme.textMuted, marginLeft: '7px' }}>
                            {FIELD_LABEL[p.field] || p.field}
                          </span>
                          <span style={{
                            marginLeft: '7px', fontSize: '9.5px', fontWeight: 800, padding: '1px 5px', borderRadius: '5px',
                            background: p.confidence === 'high' ? 'rgba(52,211,153,0.15)' : p.confidence === 'medium' ? 'rgba(245,158,11,0.15)' : 'rgba(148,163,184,0.15)',
                            color: p.confidence === 'high' ? '#34d399' : p.confidence === 'medium' ? '#f59e0b' : theme.textMuted,
                          }}>
                            {p.confidence}
                          </span>
                          {p.source === 'purchase_history' && (
                            <span title="Deterministic — read off the PO mirror, not proposed by a model" style={{ marginLeft: '5px', fontSize: '9.5px', color: '#60a5fa', fontWeight: 700 }}>from POs</span>
                          )}
                        </div>
                        <div style={{ fontSize: '12px', color: 'var(--text-body)', marginTop: '2px' }}>
                          {p.field === 'misfile' ? '⚑ ' : '→ '}{p.proposed_label || p.proposed_value || '—'}
                          {p.current_value && p.field !== 'misfile' && (
                            <span style={{ color: theme.textMuted }}> (was {p.current_value})</span>
                          )}
                        </div>
                        {p.evidence && (
                          <div style={{ fontSize: '10.5px', color: theme.textMuted, marginTop: '2px' }}>{p.evidence}</div>
                        )}
                      </div>
                      <div style={{ display: 'flex', gap: '5px', flexShrink: 0 }}>
                        <button
                          onClick={() => decide([p.id], 'accept')} disabled={deciding}
                          style={{ padding: '4px 9px', borderRadius: '6px', border: '1px solid rgba(52,211,153,0.35)', background: 'rgba(52,211,153,0.1)', color: '#34d399', fontSize: '10.5px', fontWeight: 800, cursor: deciding ? 'wait' : 'pointer' }}
                        >
                          {p.field === 'misfile' ? 'Noted' : 'Accept'}
                        </button>
                        <button
                          onClick={() => decide([p.id], 'reject')} disabled={deciding}
                          style={{ padding: '4px 9px', borderRadius: '6px', border: `1px solid ${theme.border}`, background: 'transparent', color: theme.textMuted, fontSize: '10.5px', fontWeight: 700, cursor: deciding ? 'wait' : 'pointer' }}
                        >
                          Reject
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
