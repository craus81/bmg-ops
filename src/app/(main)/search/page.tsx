'use client';

/**
 * Search everything (owner ask 2026-10-08): the full results page behind the
 * top bar's "See all results". Same /api/search as the top bar with
 * ?full=1, which returns more rows for memos and notes and adds QuickBooks
 * bills for the ledger readers. Bills stay off the top bar so it stays quick.
 * Every other group shows what the top bar does, with its "View all" link.
 *
 * URL: ?q=<words>
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { pathFor, type PopoutType } from '@/components/Popout';
import QuickBooksRecordModal from '@/components/QuickBooksRecordModal';
import {
  GROUP_CONFIG, VIEW_ALL, DEEP_GROUPS, renderResult, deepResultUrl, searchAllUrl,
} from '@/components/UniversalSearch';
import { buildRecent, pushRecent } from '@/lib/command-palette';
import { deepLinks } from '@/lib/deep-links';
import { INTERNAL_STAFF_ROLES } from '@/lib/features';

/** Memos and notes first: they're why someone came to this page. */
const ORDER = ['qb_history', 'ns_transactions', 'notes', 'bills'];

export default function SearchPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, loading, hasRole, canSeeMoney } = useAuth();
  const urlQ = (searchParams.get('q') || '').trim();

  const [input, setInput] = useState(urlQ);
  const [results, setResults] = useState<Record<string, any[]>>({});
  const [totals, setTotals] = useState<Record<string, number>>({});
  const [more, setMore] = useState<Record<string, boolean>>({});
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const [qbRecordId, setQbRecordId] = useState<string | null>(null);
  const seq = useRef(0);

  // Same wall as the search box: /api/search is staff-only.
  const isStaff = INTERNAL_STAFF_ROLES.some(r => hasRole(r));
  useEffect(() => {
    if (loading || !user) return;
    if (!isStaff) router.replace('/home');
  }, [loading, user, isStaff, router]);

  useEffect(() => { setInput(urlQ); }, [urlQ]);

  useEffect(() => {
    if (!user || !isStaff) return;
    if (urlQ.length < 2) { setResults({}); setTotals({}); setMore({}); return; }
    const mine = ++seq.current;
    setSearching(true);
    setError('');
    (async () => {
      try {
        const res = await fetch(`/api/search?full=1&q=${encodeURIComponent(urlQ)}`);
        const data = await res.json().catch(() => ({}));
        if (mine !== seq.current) return;
        if (!res.ok) throw new Error(data.error || 'Search failed');
        setResults(data.results || {});
        setTotals(data.totals || {});
        setMore(data.more || {});
      } catch (e: any) {
        if (mine !== seq.current) return;
        setResults({}); setTotals({}); setMore({});
        setError(e?.message || 'Search failed');
      } finally {
        if (mine === seq.current) setSearching(false);
      }
    })();
  }, [urlQ, user, isStaff]);

  const submit = () => {
    const q = input.trim();
    if (q && q !== urlQ) router.replace(searchAllUrl(q));
  };

  const open = useCallback((group: string, item: any) => {
    if (group === 'qb_history') { setQbRecordId(item.id); return; }
    if (DEEP_GROUPS.has(group)) {
      const url = deepResultUrl(group, item, searchAllUrl(urlQ));
      if (url) router.push(url);
      return;
    }
    if (group === 'cni_companies' || group === 'cni_installers') {
      router.push(group === 'cni_companies' ? deepLinks.cniCompany(item.id) : deepLinks.cniInstaller(item.id));
      return;
    }
    const path = pathFor(group as PopoutType, item);
    pushRecent(buildRecent(group, item, path));
    router.push(path);
  }, [router, urlQ]);

  const groups = Object.keys(results)
    .filter(g => (results[g] || []).length > 0)
    .sort((a, b) => {
      const ia = ORDER.indexOf(a), ib = ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });

  if (loading || !user || !isStaff) return null;

  return (
    <div style={{ maxWidth: '760px', margin: '0 auto', padding: '16px' }}>
      <h1 style={{ fontSize: '20px', fontWeight: 800, color: 'var(--text-primary)', margin: '0 0 4px' }}>Search everything</h1>
      <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '12px' }}>
        Records, plus the words inside QuickBooks and NetSuite memos, QuickBooks lines and notes.
      </div>

      <form onSubmit={e => { e.preventDefault(); submit(); }} style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
        <input
          autoFocus
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder="Search memos, notes, POs, invoices, vehicles…"
          style={{
            flex: 1, padding: '10px 12px', borderRadius: '9px', fontSize: '16px',
            border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-primary)',
          }}
        />
        <button type="submit" style={{
          padding: '10px 16px', borderRadius: '9px', fontSize: '13px', fontWeight: 800,
          background: '#3b82f6', color: '#fff', border: 'none', cursor: 'pointer',
        }}>Search</button>
      </form>

      {searching && <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-label)', fontSize: '13px' }}>Searching…</div>}
      {error && <div style={{ padding: '12px', color: '#ef4444', fontSize: '13px' }}>{error}</div>}
      {!searching && !error && urlQ.length >= 2 && groups.length === 0 && (
        <div style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--text-label)', fontSize: '14px', fontWeight: 700 }}>
          No results for &ldquo;{urlQ}&rdquo;
        </div>
      )}
      {!searching && urlQ.length > 0 && urlQ.length < 3 && (
        <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '10px' }}>
          Memos and notes are searched from three letters.
        </div>
      )}

      {!searching && groups.map(group => {
        const config = GROUP_CONFIG[group] || { label: group, color: 'var(--text-body)' };
        const items = results[group];
        const total = totals[group] ?? items.length;
        const moreFlag = !!more[group];
        const viewAll = !DEEP_GROUPS.has(group) && total > items.length && VIEW_ALL[group] ? VIEW_ALL[group](urlQ) : null;
        return (
          <section key={group} style={{ marginBottom: '16px', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', overflow: 'hidden' }}>
            <div style={{ padding: '10px 14px 6px', display: 'flex', alignItems: 'center', gap: '6px', borderBottom: '1px solid var(--border)' }}>
              <span style={{ fontSize: '11px', fontWeight: 800, color: config.color, textTransform: 'uppercase', letterSpacing: '0.5px' }}>{config.label}</span>
              <span style={{ fontSize: '10px', color: 'var(--text-label)', fontWeight: 600 }}>
                ({moreFlag ? `${items.length}+` : total}{!moreFlag && total > items.length ? `, showing ${items.length}` : ''})
              </span>
              {viewAll && (
                <button onClick={() => router.push(viewAll)} style={{
                  marginLeft: 'auto', background: 'transparent', border: 'none', color: config.color,
                  fontSize: '11px', fontWeight: 800, cursor: 'pointer', padding: '2px 4px',
                }}>View all {total} →</button>
              )}
            </div>
            {items.map((item: any) => (
              <div key={`row-${item.id}`} style={{ borderBottom: '1px solid rgba(var(--border-rgb),0.5)' }}>
                {renderResult(group, item, open, canSeeMoney)}
              </div>
            ))}
            {DEEP_GROUPS.has(group) && (moreFlag || total > items.length) && (
              <div style={{ padding: '8px 14px', fontSize: '11px', color: 'var(--text-muted)' }}>
                Showing the newest {items.length}. Add another word to narrow it down.
              </div>
            )}
          </section>
        );
      })}

      {qbRecordId && (
        <QuickBooksRecordModal
          recordId={qbRecordId}
          onClose={() => setQbRecordId(null)}
          backHref={searchAllUrl(urlQ)}
          backLabel="Search"
        />
      )}
    </div>
  );
}
