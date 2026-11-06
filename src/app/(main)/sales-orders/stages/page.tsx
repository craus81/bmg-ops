'use client';

/**
 * Job stages (Sales menu; Valarie's "pull up everything that's in each
 * department/stage", Craig 2026-11-06). Every open approved order counted by
 * the step it's on; tap a step to list those orders, oldest first, with how
 * long each has sat there. Same steps as the bar on the order
 * (src/lib/job-progress.ts).
 */

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { apiFetch } from '@/lib/api-client';
import { useAuth } from '@/components/AuthProvider';
import { theme } from '@/lib/theme';
import { deepLinks } from '@/lib/deep-links';
import { JOB_STAGES, isJobStageKey, type JobStageKey } from '@/lib/job-progress';

interface Row {
  estimateId: string;
  estimateNumber: string | null;
  title: string | null;
  customer: string | null;
  soNumber: string | null;
  stage: JobStageKey;
  stageLabel: string;
  detail: string;
  heldUp: string[];
  since: string | null;
  repId: string | null;
  rep: string | null;
}

const BLUE = '#2563eb';
const GREEN = '#16a34a';
const AMBER = '#d97706';

const CSS = `
.js-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;scrollbar-width:none}
.js-scroll::-webkit-scrollbar{display:none}
.js-bar{display:flex;gap:3px;min-width:100%}
.js-seg{flex:1 1 0;min-width:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;text-align:center;cursor:pointer;
  padding:8px 4px 8px 14px;min-height:66px;border:0;font:inherit;color:var(--text-secondary);background:var(--subtle-bg);box-shadow:inset 0 0 0 999px rgba(127,127,127,.10);
  clip-path:polygon(0 0,calc(100% - 11px) 0,100% 50%,calc(100% - 11px) 100%,0 100%,11px 50%)}
.js-seg:first-child{clip-path:polygon(0 0,calc(100% - 11px) 0,100% 50%,calc(100% - 11px) 100%,0 100%);border-radius:10px 0 0 10px;padding-left:6px}
.js-seg:last-child{clip-path:polygon(0 0,100% 0,100% 100%,0 100%,11px 50%);border-radius:0 10px 10px 0}
.js-seg[aria-pressed="true"]{background:${BLUE};color:#fff;box-shadow:none}
.js-seg.js-complete{background:${GREEN};color:#fff;box-shadow:none}
.js-seg.js-complete[aria-pressed="true"]{outline:3px solid var(--text-primary);outline-offset:-3px}
.js-seg:focus-visible{outline:2px solid ${BLUE};outline-offset:2px}
.js-cnt{font-weight:800;font-size:19px;line-height:1}
.js-nm{font-weight:800;font-size:12px;line-height:1.1}
.js-swipe{display:none;font-size:11px;color:var(--text-muted);text-align:right}
@media (max-width:640px){.js-bar{min-width:640px}.js-swipe{display:block}}
`;

function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso.length === 10 ? `${iso}T12:00:00Z` : iso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 86400000));
}

function StagesBoard() {
  const router = useRouter();
  const params = useSearchParams();
  const { user } = useAuth();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const first = params.get('stage');
  const [stage, setStage] = useState<JobStageKey>(isJobStageKey(first) ? first : 'parts_ordered');
  const [mine, setMine] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/api/job-progress/board');
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Couldn't load the job stages (${res.status}).`);
      setRows(body.rows || []);
    } catch (e: any) {
      setError(e?.message || "Couldn't load the job stages.");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const shown = useMemo(() => rows.filter(r => !mine || r.repId === user?.id), [rows, mine, user?.id]);
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const r of shown) c[r.stage] = (c[r.stage] || 0) + 1;
    return c;
  }, [shown]);
  const list = shown.filter(r => r.stage === stage);
  const stageName = JOB_STAGES.find(s => s.key === stage)!.boardLabel;

  // Keep the picked step in view when the bar scrolls (phones).
  useEffect(() => {
    const sc = scrollRef.current;
    const el = sc?.querySelector('[aria-pressed="true"]') as HTMLElement | null;
    if (sc && el && sc.scrollWidth > sc.clientWidth) sc.scrollLeft = el.offsetLeft - sc.clientWidth / 2 + el.offsetWidth / 2;
  }, [stage, rows]);

  const pick = (k: JobStageKey) => {
    setStage(k);
    router.replace(`/sales-orders/stages?stage=${k}`, { scroll: false });
  };

  const chip = (on: boolean): React.CSSProperties => ({
    padding: '6px 12px', borderRadius: '999px', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
    background: on ? 'var(--tab-active-bg)' : 'transparent',
    border: on ? '1px solid var(--tab-active-border)' : `1px solid ${theme.border}`,
    color: on ? 'var(--tab-active-color)' : theme.textMuted,
  });

  return (
    <div style={{ maxWidth: '960px', margin: '0 auto', padding: '16px', display: 'grid', gap: '12px', color: theme.textPrimary }}>
      <style>{CSS}</style>
      <div style={{ minWidth: 0 }}>
        <h1 style={{ margin: 0, fontSize: '22px', fontWeight: 800 }}>Job stages</h1>
        <div style={{ fontSize: '13px', color: theme.textMuted }}>Every open order by the step it&apos;s on. Tap a step to see its orders.</div>
      </div>

      <div style={{ display: 'grid', gap: '4px' }}>
        <div className="js-scroll" ref={scrollRef}>
          <div className="js-bar">
            {JOB_STAGES.map(s => (
              <button key={s.key} type="button" aria-pressed={s.key === stage} onClick={() => pick(s.key)}
                className={`js-seg${s.key === 'complete' ? ' js-complete' : ''}`}>
                <span className="js-cnt">{loading ? '–' : counts[s.key] || 0}</span>
                <span className="js-nm">{s.boardLabel}</span>
              </button>
            ))}
          </div>
        </div>
        <span className="js-swipe">Swipe for all 8 steps →</span>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
        <div style={{ fontSize: '17px', fontWeight: 800 }}>{stageName} · {list.length} order{list.length === 1 ? '' : 's'}</div>
        <div style={{ display: 'flex', gap: '6px' }}>
          <button type="button" style={chip(!mine)} onClick={() => setMine(false)}>Everyone</button>
          <button type="button" style={chip(mine)} onClick={() => setMine(true)}>Mine</button>
        </div>
      </div>
      {stage === 'complete' && <div style={{ fontSize: '12px', color: theme.textMuted }}>Finished in the last 7 days.</div>}

      {error && <div style={{ color: theme.error, fontWeight: 600, fontSize: '14px' }}>{error}</div>}

      <div style={{ background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '12px', overflow: 'hidden' }}>
        {loading && <div style={{ padding: '14px', color: theme.textMuted, fontSize: '14px' }}>Loading…</div>}
        {!loading && list.length === 0 && (
          <div style={{ padding: '14px', color: theme.textMuted, fontSize: '14px' }}>Nothing in {stageName} right now.</div>
        )}
        {!loading && list.map((r, i) => {
          const days = daysSince(r.since);
          const late = days != null && days >= 7 && stage !== 'complete';
          return (
            <a key={r.estimateId} href={deepLinks.estimate(r.estimateId)} style={{
              display: 'grid', gridTemplateColumns: '1fr auto', gap: '2px 10px', padding: '12px 14px', textDecoration: 'none',
              color: theme.textPrimary, borderTop: i === 0 ? 'none' : `1px solid ${theme.border}`,
            }}>
              <span style={{ fontWeight: 700, minWidth: 0 }}>
                {r.customer || 'Customer'}
                {r.stageLabel === 'Design in revision' && (
                  <span style={{ marginLeft: '6px', fontSize: '11px', fontWeight: 700, padding: '2px 7px', borderRadius: '999px', background: 'rgba(217,119,6,.14)', color: AMBER }}>In revision</span>
                )}
              </span>
              <span style={{ fontSize: '12.5px', fontWeight: 700, color: late ? theme.error : theme.textMuted, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                {days == null ? '' : days === 0 ? 'today' : `${days} day${days === 1 ? '' : 's'}`}
              </span>
              <span style={{ fontSize: '12.5px', color: theme.textMuted, minWidth: 0 }}>
                {[r.soNumber || (r.estimateNumber ? `Estimate #${r.estimateNumber}` : null), r.title, r.rep].filter(Boolean).join(' · ')}
              </span>
              <span style={{ fontSize: '12px', color: theme.textMuted, textAlign: 'right' }}>{days == null ? '' : 'in stage'}</span>
              <span style={{ gridColumn: '1 / -1', fontSize: '12.5px', color: theme.textSecondary, minWidth: 0 }}>
                {r.detail}
                {r.heldUp.length > 0 && <span style={{ color: AMBER, fontWeight: 700 }}> · Still open: {r.heldUp.join(', ')}</span>}
              </span>
            </a>
          );
        })}
      </div>
    </div>
  );
}

export default function JobStagesPage() {
  return <Suspense fallback={null}><StagesBoard /></Suspense>;
}
