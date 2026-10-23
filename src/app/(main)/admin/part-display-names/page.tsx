'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';
import { isRealNetsuiteId, type DisplayNameProposal } from '@/lib/part-display-names';

// One-time display-name fill (src/lib/part-display-names.ts has the rule).
// Loads every proposed change first; nothing is written until Run. Run sends
// small batches so a long catalog doesn't hit the request time limit, and a
// Stop or a closed tab just leaves the rest — reloading lists only what is
// still left, since a filled name no longer matches the rule.

const BATCH = 10;

const card: React.CSSProperties = {
  background: 'var(--card)', border: '1px solid var(--border)',
  borderRadius: '12px', padding: '14px',
};
const label: React.CSSProperties = {
  fontSize: '10px', fontWeight: 800, textTransform: 'uppercase',
  letterSpacing: '.5px', color: 'var(--text-muted)',
};
const input: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: '8px',
  border: '1px solid var(--border)', background: 'var(--input-bg)',
  color: 'var(--text-primary)', fontSize: '14px', fontFamily: 'inherit',
};
const red = '#dc2626';

const SOURCE_LABEL = { graphic_package: 'Graphic package', description: 'Description' } as const;

export default function PartDisplayNamesPage() {
  const router = useRouter();
  const dialog = useDialog();
  const { isAdmin, user, loading: authLoading } = useAuth();

  const [proposals, setProposals] = useState<DisplayNameProposal[]>([]);
  const [totalParts, setTotalParts] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [shown, setShown] = useState(100);

  const [running, setRunning] = useState(false);
  const stopRef = useRef(false);
  const [done, setDone] = useState<Set<string>>(new Set());
  const [failed, setFailed] = useState<Record<string, string>>({});
  const [finished, setFinished] = useState<null | 'done' | 'stopped'>(null);

  useEffect(() => {
    if (authLoading || !user) return;
    if (!isAdmin) router.push('/home');
  }, [authLoading, user, isAdmin, router]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch('/api/admin/part-display-names');
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
      setProposals(d.proposals || []);
      setTotalParts(d.totalParts || 0);
      setDone(new Set());
      setFailed({});
      setFinished(null);
    } catch (e: any) {
      setLoadError(e.message || 'Could not load the parts catalog');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (isAdmin) load(); }, [isAdmin, load]);

  const fromPkg = proposals.filter(p => p.source === 'graphic_package').length;
  const remaining = proposals.filter(p => !done.has(p.id));
  const failedCount = Object.keys(failed).length;

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = needle
      ? proposals.filter(p => `${p.item_number} ${p.proposed}`.toLowerCase().includes(needle))
      : proposals;
    // Failures first so they're never buried under 2,000 green rows.
    return [...list].sort((a, b) => Number(!!failed[b.id]) - Number(!!failed[a.id]));
  }, [proposals, q, failed]);

  const run = async () => {
    const todo = proposals.filter(p => !done.has(p.id));
    if (todo.length === 0) return;
    const ok = await dialog.confirm(
      `Change ${todo.length} display name${todo.length !== 1 ? 's' : ''} in NetSuite and FleetSuite?\n\nKeep this page open until it finishes. You can stop at any time.`,
      { title: 'Update display names', confirmLabel: 'Run' },
    );
    if (!ok) return;

    stopRef.current = false;
    setRunning(true);
    setFinished(null);
    setFailed({});
    for (let i = 0; i < todo.length; i += BATCH) {
      if (stopRef.current) break;
      const batch = todo.slice(i, i + BATCH);
      try {
        const res = await fetch('/api/admin/part-display-names', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: batch.map(p => p.id) }),
        });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
        const results: { id: string; ok: boolean; error?: string }[] = d.results || [];
        setDone(prev => {
          const next = new Set(prev);
          for (const r of results) if (r.ok) next.add(r.id);
          return next;
        });
        setFailed(prev => {
          const next = { ...prev };
          for (const r of results) if (!r.ok) next[r.id] = r.error || 'Failed';
          return next;
        });
      } catch (e: any) {
        const msg = e.message || 'Request failed';
        setFailed(prev => {
          const next = { ...prev };
          for (const p of batch) next[p.id] = msg;
          return next;
        });
      }
    }
    setFinished(stopRef.current ? 'stopped' : 'done');
    setRunning(false);
  };

  if (authLoading || !isAdmin) return null;

  const progress = proposals.length ? Math.round((done.size / proposals.length) * 100) : 0;

  return (
    <div style={{ maxWidth: '960px', margin: '0 auto', padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div>
        <h1 style={{ fontSize: '20px', fontWeight: 800, margin: 0, color: 'var(--text-primary)' }}>Fill in part display names</h1>
        <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '4px', lineHeight: 1.5 }}>
          Parts whose display name is blank or just the part number get the Graphic Package, or the Description when there's no
          graphic package. Names someone already typed are left alone. NetSuite parts are changed in NetSuite too, so the parts
          sync keeps the new name.
        </div>
      </div>

      {loadError && (
        <div style={{ ...card, borderColor: red, color: red, fontSize: '14px', fontWeight: 600 }}>
          {loadError} <button onClick={load} style={{ marginLeft: '8px' }}>Try again</button>
        </div>
      )}

      {loading ? (
        <div style={{ ...card, color: 'var(--text-muted)', fontSize: '14px' }}>Checking every part in the catalog…</div>
      ) : !loadError && (
        <>
          <div style={{ ...card, display: 'flex', flexWrap: 'wrap', gap: '18px', alignItems: 'center' }}>
            <div><div style={label}>Parts checked</div><div style={{ fontSize: '20px', fontWeight: 800 }}>{totalParts.toLocaleString()}</div></div>
            <div><div style={label}>Will change</div><div style={{ fontSize: '20px', fontWeight: 800 }}>{proposals.length.toLocaleString()}</div></div>
            <div><div style={label}>From graphic package</div><div style={{ fontSize: '20px', fontWeight: 800 }}>{fromPkg.toLocaleString()}</div></div>
            <div><div style={label}>From description</div><div style={{ fontSize: '20px', fontWeight: 800 }}>{(proposals.length - fromPkg).toLocaleString()}</div></div>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: '8px' }}>
              {running ? (
                <button onClick={() => { stopRef.current = true; }}
                  style={{ padding: '10px 18px', borderRadius: '10px', border: `1px solid ${red}`, background: 'transparent', color: red, fontWeight: 800, fontSize: '14px', cursor: 'pointer' }}>
                  Stop
                </button>
              ) : (
                <button onClick={run} disabled={remaining.length === 0}
                  style={{ padding: '10px 18px', borderRadius: '10px', border: 'none', background: remaining.length ? 'var(--orange)' : 'var(--border)', color: '#fff', fontWeight: 800, fontSize: '14px', cursor: remaining.length ? 'pointer' : 'default' }}>
                  {failedCount > 0 && finished ? `Retry ${remaining.length}` : `Run: update ${remaining.length.toLocaleString()}`}
                </button>
              )}
            </div>
          </div>

          {(running || finished) && (
            <div style={card}>
              <div style={{ height: '8px', background: 'var(--border)', borderRadius: '4px', overflow: 'hidden' }}>
                <div style={{ width: `${progress}%`, height: '100%', background: '#16a34a', transition: 'width .3s' }} />
              </div>
              <div style={{ fontSize: '13px', marginTop: '8px', color: 'var(--text-primary)' }}>
                {done.size.toLocaleString()} of {proposals.length.toLocaleString()} updated
                {running && ' · keep this page open'}
                {finished === 'stopped' && ' · stopped'}
                {finished === 'done' && failedCount === 0 && ' · all done'}
              </div>
              {failedCount > 0 && (
                <div style={{ fontSize: '13px', marginTop: '6px', color: red, fontWeight: 700 }}>
                  {failedCount} part{failedCount !== 1 ? 's' : ''} could not be changed. They're at the top of the list with the reason.
                </div>
              )}
            </div>
          )}

          {proposals.length === 0 ? (
            <div style={{ ...card, fontSize: '14px', color: 'var(--text-muted)' }}>Nothing to change. Every part already has a display name of its own.</div>
          ) : (
            <div style={card}>
              <input style={input} value={q} onChange={e => { setQ(e.target.value); setShown(100); }} placeholder="Search part number or new name" />
              <div style={{ display: 'flex', flexDirection: 'column', marginTop: '10px' }}>
                {filtered.slice(0, shown).map(p => {
                  const err = failed[p.id];
                  const ok = done.has(p.id);
                  return (
                    <div key={p.id} style={{ padding: '10px 0', borderTop: '1px solid var(--border)', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: '2px' }}>
                      <div style={{ display: 'flex', gap: '8px', alignItems: 'baseline', flexWrap: 'wrap' }}>
                        <span style={{ fontWeight: 800, fontSize: '14px', color: 'var(--text-primary)' }}>{p.item_number}</span>
                        <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                          from {SOURCE_LABEL[p.source]}{isRealNetsuiteId(p.netsuite_id) ? '' : ' · FleetSuite only'}
                        </span>
                        {ok && <span style={{ fontSize: '12px', color: '#16a34a', fontWeight: 800 }}>✓ Updated</span>}
                      </div>
                      <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
                        Now: <span style={{ textDecoration: ok ? 'line-through' : 'none' }}>{p.current || '(blank)'}</span>
                      </div>
                      <div style={{ fontSize: '14px', color: 'var(--text-primary)', fontWeight: 600, overflowWrap: 'anywhere' }}>New: {p.proposed}</div>
                      {err && <div style={{ fontSize: '13px', color: red, fontWeight: 700 }}>{err}</div>}
                    </div>
                  );
                })}
              </div>
              {filtered.length > shown && (
                <button onClick={() => setShown(s => s + 200)} style={{ marginTop: '10px', padding: '8px 14px', borderRadius: '8px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-primary)', cursor: 'pointer' }}>
                  Show more ({(filtered.length - shown).toLocaleString()} left)
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
