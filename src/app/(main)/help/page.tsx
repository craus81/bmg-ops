'use client';

/**
 * In-App Help Center (R6-13, audit line 431).
 *
 * The guides existed in docs/help/**, and an admin route already loaded
 * them into knowledge_docs — but there was nowhere to READ them. The
 * knowledge base's own page is an upload console gated to admin/sales/
 * production, so the guide written for shop techs was unreadable by shop
 * techs. This page is open to every staff role.
 *
 * Role filtering ORDERS, it never hides: your guides come first, the rest
 * of the library follows under its own heading. Hiding them would be
 * paternalistic about content that isn't sensitive, and would silently
 * make search lie about what exists.
 */

import { useState, useEffect, useMemo, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import Markdown from '@/components/Markdown';
import {
  partitionForRoles, searchGuides, snippetFor, sectionsOf,
  type HelpDoc,
} from '@/lib/help-center';
import { ROLE_DEFAULT_FEATURES } from '@/lib/features';

/** Every role the app defines, so the filter can't miss one by omission. */
const ALL_ROLES = Object.keys(ROLE_DEFAULT_FEATURES);

function HelpCenter() {
  const router = useRouter();
  const params = useSearchParams();
  const { hasRole } = useAuth();

  const [docs, setDocs] = useState<HelpDoc[]>([]);
  const [synced, setSynced] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const openSlug = params.get('doc');
  // Derived from hasRole rather than the raw profile, so an admin using
  // "View As" sees the library the role they're previewing would see.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- hasRole is rebuilt every AuthProvider render; the roles it answers for are what matter
  const roles = useMemo(() => ALL_ROLES.filter(r => hasRole(r)), [hasRole]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/help');
        const body = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (res.status === 403) {
          // A customer or external installer account. Say what it is rather
          // than showing them a server error for a page they simply aren't for.
          setError('The guides are for BMG staff accounts. Your account does not have access to them.');
          return;
        }
        if (!res.ok) { setError(body?.error || 'Could not load the guides.'); return; }
        setDocs(body.docs || []);
        setSynced(!!body.synced);
      } catch (e: any) {
        if (!cancelled) setError(e?.message || 'Could not reach the server.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const open = openSlug ? docs.find(d => d.slug === openSlug) : null;
  const { mine, others } = useMemo(() => partitionForRoles(docs, roles), [docs, roles]);
  const hits = useMemo(() => searchGuides(docs, query), [docs, query]);
  const sections = useMemo(() => (open ? sectionsOf(open.content) : []), [open]);

  const go = (slug: string | null) => {
    router.push(slug ? `/help?doc=${encodeURIComponent(slug)}` : '/help');
  };

  const card = (d: HelpDoc, note?: string | null) => (
    <button
      key={d.id}
      onClick={() => go(d.slug)}
      style={{
        display: 'block', width: '100%', textAlign: 'left', cursor: 'pointer',
        background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '10px',
        padding: '12px 14px', marginBottom: '8px',
      }}
    >
      <div style={{ fontSize: '13.5px', fontWeight: 800, color: 'var(--text-primary)' }}>{d.title}</div>
      {note && <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '4px', lineHeight: 1.5 }}>{note}</div>}
      <div style={{ fontSize: '10.5px', color: 'var(--text-muted)', marginTop: '4px' }}>{d.slug}</div>
    </button>
  );

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginBottom: '12px' }}>
        <h1 style={{ fontSize: '20px', fontWeight: 800, color: 'var(--text-primary)', margin: 0 }}>
          {open ? open.title : 'Help'}
        </h1>
        {open && (
          <button onClick={() => go(null)} style={{
            background: 'transparent', border: '1px solid var(--border)', borderRadius: '8px',
            padding: '5px 10px', fontSize: '11px', fontWeight: 700, color: 'var(--text-body)', cursor: 'pointer',
          }}>← All guides</button>
        )}
      </div>

      {!open && (
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search the guides…"
          style={{
            width: '100%', boxSizing: 'border-box', padding: '10px 12px', borderRadius: '10px',
            border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-primary)',
            fontSize: '14px', marginBottom: '14px',
          }}
        />
      )}

      {loading && <div style={{ padding: '30px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>Loading…</div>}

      {!loading && error && (
        <div style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.35)', color: '#ef4444', borderRadius: '9px', padding: '11px 12px', fontSize: '12.5px', fontWeight: 600 }}>
          {error}
        </div>
      )}

      {/* An empty library and an empty search are different problems, and
          saying "no results" for the first one sends people looking for a
          guide that was never loaded. */}
      {!loading && !error && !synced && (
        <div style={{ padding: '30px 20px', textAlign: 'center', background: 'var(--card)', borderRadius: '12px', border: '1px solid var(--border)' }}>
          <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-label)' }}>No guides have been loaded yet</div>
          <div style={{ fontSize: '12.5px', color: 'var(--text-secondary)', marginTop: '6px', lineHeight: 1.55 }}>
            The guides live in the repository under <code>docs/help/</code>. An admin loads them into the app
            from the Knowledge Base page — until then this library is empty. Nothing is missing from your account.
          </div>
        </div>
      )}

      {!loading && !error && synced && !open && query.trim() && (
        <div>
          <div style={{ fontSize: '11px', fontWeight: 800, color: 'var(--text-label)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' }}>
            {hits.length} {hits.length === 1 ? 'guide' : 'guides'} matching “{query.trim()}”
          </div>
          {hits.length === 0 && (
            <div style={{ fontSize: '12.5px', color: 'var(--text-secondary)', padding: '10px 0' }}>
              Nothing in the {docs.length} loaded {docs.length === 1 ? 'guide' : 'guides'} mentions that.
            </div>
          )}
          {hits.map(d => card(d, snippetFor(d, query)))}
        </div>
      )}

      {!loading && !error && synced && !open && !query.trim() && (
        <div>
          {mine.length > 0 && (
            <>
              <div style={{ fontSize: '11px', fontWeight: 800, color: 'var(--text-label)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' }}>
                Written for your role
              </div>
              {mine.map(d => card(d))}
            </>
          )}
          <div style={{ fontSize: '11px', fontWeight: 800, color: 'var(--text-label)', textTransform: 'uppercase', letterSpacing: '0.5px', margin: '16px 0 8px' }}>
            {mine.length > 0 ? 'The rest of the library' : 'All guides'}
          </div>
          <div style={{ fontSize: '11.5px', color: 'var(--text-muted)', marginBottom: '8px', lineHeight: 1.5 }}>
            Nothing here is restricted — read any of it.
          </div>
          {others.map(d => card(d))}
        </div>
      )}

      {!loading && !error && open && (
        <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', padding: '16px' }}>
          {sections.length > 3 && (
            <details style={{ marginBottom: '12px' }}>
              <summary style={{ cursor: 'pointer', fontSize: '11px', fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                On this page
              </summary>
              <div style={{ marginTop: '8px' }}>
                {sections.filter(s => s.level <= 3).map(s => (
                  <a key={s.id} href={`#${s.id}`} style={{
                    display: 'block', fontSize: '12.5px', color: '#60a5fa',
                    padding: '3px 0', paddingLeft: `${(s.level - 1) * 12}px`, textDecoration: 'none',
                  }}>{s.heading}</a>
                ))}
              </div>
            </details>
          )}
          <Markdown content={open.content} />
        </div>
      )}

      {/* A "?" can point at a guide that has since been renamed in the repo
          and re-synced. Say so instead of showing a blank page. */}
      {!loading && !error && synced && openSlug && !open && (
        <div style={{ background: 'rgba(251,191,36,0.1)', border: '1px solid rgba(251,191,36,0.35)', color: '#fbbf24', borderRadius: '9px', padding: '11px 12px', fontSize: '12.5px', fontWeight: 600 }}>
          There is no guide called “{openSlug}” in the library.{' '}
          <button onClick={() => go(null)} style={{ background: 'transparent', border: 'none', color: '#fbbf24', fontWeight: 800, cursor: 'pointer', textDecoration: 'underline' }}>
            See what there is
          </button>
        </div>
      )}
    </div>
  );
}

export default function HelpPage() {
  return (
    <Suspense fallback={null}>
      <HelpCenter />
    </Suspense>
  );
}
