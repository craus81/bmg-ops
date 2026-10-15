'use client';

/**
 * Check matches: Dropbox client folders and the customer each belongs to
 * (migration 379). The sync links a folder by itself only when its name is
 * exactly one customer's; the close calls land here with the matcher's best
 * few guesses, and an admin picks one, searches for another, or marks the
 * folder as no customer. A person's choice sticks. Staff can look; only
 * admins can change (POST /api/client-files/folders is admin-only).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import { createClient } from '@/lib/supabase-browser';
import { looseOrFilter } from '@/lib/loose-search';
import { deepLinks } from '@/lib/deep-links';
import { formatBytes } from '@/lib/client-files';

export interface ClientFolder {
  id: string;
  name: string;
  status: 'auto' | 'confirmed' | 'suggested' | 'unmatched' | 'none';
  score: number | null;
  candidates: { customer_id: string; name: string; score: number }[];
  fileCount: number;
  totalBytes: number;
  latestModified: string | null;
  customer: { id: string; name: string; link: string | null } | null;
}

type Show = 'review' | 'unlinked' | 'linked' | 'all';

const SHOW_LABELS: Record<Show, string> = {
  review: 'To check',
  unlinked: 'Not linked',
  linked: 'Linked',
  all: 'All',
};

const STATUS_TEXT: Record<ClientFolder['status'], string> = {
  auto: 'Linked automatically',
  confirmed: 'Linked by a person',
  suggested: 'Close call',
  unmatched: 'No close customer',
  none: 'Not a customer',
};

const chip = (on: boolean): React.CSSProperties => ({
  padding: '7px 12px', borderRadius: '999px', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
  background: on ? 'var(--accent, #2563eb)' : 'transparent',
  color: on ? '#fff' : 'var(--text-secondary)',
  border: `1px solid ${on ? 'var(--accent, #2563eb)' : 'var(--border-strong)'}`,
  whiteSpace: 'nowrap',
});

const smallBtn = (primary = false): React.CSSProperties => ({
  padding: '6px 10px', borderRadius: '8px', fontSize: '12px', fontWeight: 800, cursor: 'pointer',
  background: primary ? 'var(--accent, #2563eb)' : 'transparent',
  color: primary ? '#fff' : 'var(--text-primary)',
  border: primary ? '1px solid var(--accent, #2563eb)' : '1px solid var(--border-strong)',
  whiteSpace: 'nowrap',
});

/** Send one admin decision; returns the folder as saved. */
export async function setFolderMatch(folderId: string, action: 'link' | 'none' | 'reset', customerId?: string): Promise<ClientFolder> {
  const res = await apiFetch('/api/client-files/folders', {
    method: 'POST',
    body: JSON.stringify({ folderId, action, ...(customerId ? { customerId } : {}) }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'Could not save');
  return json.folder;
}

/** Typeahead over the customers table; calls back with the picked customer. */
export function CustomerSearch({ onPick, autoFocus }: { onPick: (c: { id: string; name: string }) => void; autoFocus?: boolean }) {
  const supabase = createClient();
  const [value, setValue] = useState('');
  const [results, setResults] = useState<{ id: string; company_name: string }[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    const filter = looseOrFilter(['company_name', 'entity_id'], value.trim());
    if (value.trim().length < 2 || !filter) { setResults([]); return; }
    timer.current = setTimeout(async () => {
      const { data } = await supabase.from('customers').select('id, company_name').or(filter).order('company_name').limit(8);
      setResults(data || []);
    }, 250);
    return () => { if (timer.current) clearTimeout(timer.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- supabase client is stable across renders
  }, [value]);

  return (
    <div style={{ position: 'relative', flex: '1 1 220px', minWidth: 0 }}>
      <input
        value={value} onChange={e => setValue(e.target.value)} autoFocus={autoFocus}
        placeholder="Search customers…"
        style={{
          width: '100%', padding: '7px 9px', borderRadius: '8px', fontSize: '16px',
          background: 'var(--input-bg)', border: '1px solid var(--border-strong)', color: 'var(--text-primary)',
        }}
      />
      {results.length > 0 && (
        <div style={{
          position: 'absolute', left: 0, right: 0, top: '100%', zIndex: 20, marginTop: '4px',
          background: 'var(--card)', border: '1px solid var(--border-strong)', borderRadius: '8px', overflow: 'hidden',
          boxShadow: 'var(--shadow-md)',
        }}>
          {results.map(r => (
            <button
              key={r.id}
              onClick={() => { onPick({ id: r.id, name: r.company_name }); setValue(''); setResults([]); }}
              style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 10px', background: 'none', border: 'none', borderTop: '1px solid var(--border)', color: 'var(--text-primary)', fontSize: '13px', cursor: 'pointer' }}
            >{r.company_name}</button>
          ))}
        </div>
      )}
    </div>
  );
}

function FolderCard({ folder, canEdit, onSaved }: { folder: ClientFolder; canEdit: boolean; onSaved: (f: ClientFolder) => void }) {
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const act = async (action: 'link' | 'none' | 'reset', customerId?: string) => {
    setBusy(true);
    setErr(null);
    try {
      onSaved(await setFolderMatch(folder.id, action, customerId));
      setPicking(false);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', padding: '12px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' }}>
        <a href={deepLinks.clientFiles({ folder: folder.id })} style={{ fontSize: '14px', fontWeight: 800, color: 'var(--text-primary)', textDecoration: 'none' }}>
          📁 {folder.name}
        </a>
        <span style={{ fontSize: '11.5px', color: 'var(--text-muted)' }}>
          {folder.fileCount.toLocaleString()} file{folder.fileCount !== 1 ? 's' : ''} · {formatBytes(folder.totalBytes)}
        </span>
        <span style={{ marginLeft: 'auto', fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)' }}>{STATUS_TEXT[folder.status]}</span>
      </div>

      {folder.customer ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '8px', flexWrap: 'wrap', fontSize: '13px' }}>
          <span style={{ color: 'var(--text-secondary)' }}>Customer:</span>
          {folder.customer.link
            ? <a href={folder.customer.link} style={{ color: 'var(--orange)', fontWeight: 700, textDecoration: 'none' }}>{folder.customer.name} →</a>
            : <b style={{ color: 'var(--text-primary)' }}>{folder.customer.name}</b>}
          {canEdit && (
            <span style={{ marginLeft: 'auto', display: 'flex', gap: '6px' }}>
              <button disabled={busy} onClick={() => setPicking(p => !p)} style={smallBtn()}>{picking ? 'Cancel' : 'Change'}</button>
              <button disabled={busy} onClick={() => act('none')} style={smallBtn()}>Unlink</button>
            </span>
          )}
        </div>
      ) : (
        <div style={{ marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {folder.candidates.length > 0 && (
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
              <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{canEdit ? 'Link to:' : 'Might be:'}</span>
              {folder.candidates.map(c => canEdit ? (
                <button key={c.customer_id} disabled={busy} onClick={() => act('link', c.customer_id)} style={smallBtn(true)}>
                  {c.name} <span style={{ opacity: 0.75, fontWeight: 600 }}>{Math.round(c.score * 100)}%</span>
                </button>
              ) : (
                <span key={c.customer_id} style={{ fontSize: '12px', color: 'var(--text-primary)' }}>{c.name} ({Math.round(c.score * 100)}%)</span>
              ))}
            </div>
          )}
          {canEdit && (
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              <button disabled={busy} onClick={() => setPicking(p => !p)} style={smallBtn()}>{picking ? 'Cancel' : 'Pick another customer'}</button>
              {folder.status !== 'none' && <button disabled={busy} onClick={() => act('none')} style={smallBtn()}>Not a customer</button>}
              {(folder.status === 'none' || folder.status === 'confirmed') && <button disabled={busy} onClick={() => act('reset')} style={smallBtn()}>Match again</button>}
            </div>
          )}
        </div>
      )}

      {picking && canEdit && (
        <div style={{ display: 'flex', gap: '6px', marginTop: '8px' }}>
          <CustomerSearch autoFocus onPick={c => act('link', c.id)} />
        </div>
      )}
      {err && <div style={{ fontSize: '12px', color: 'var(--error)', marginTop: '6px' }}>{err}</div>}
    </div>
  );
}

export default function ClientFolderMatches({ canEdit, onChanged }: { canEdit: boolean; onChanged?: (toCheck: number) => void }) {
  const [show, setShow] = useState<Show>('review');
  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');
  const [folders, setFolders] = useState<ClientFolder[] | null>(null);
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setQ(qInput.trim()), 300);
    return () => clearTimeout(t);
  }, [qInput]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const p = new URLSearchParams({ show });
      if (q) p.set('q', q);
      const res = await apiFetch(`/api/client-files/folders?${p.toString()}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Could not load folders');
      setFolders(json.folders || []);
      setCounts(json.counts || null);
      onChanged?.(json.counts?.suggested ?? 0);
    } catch (e: any) {
      setError(e.message);
      setFolders([]);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- onChanged is a setter from the parent
  }, [show, q]);

  useEffect(() => { setFolders(null); load(); }, [load]);

  const saved = (f: ClientFolder) => {
    // Keep the card in place until the list reloads, so the person sees what happened.
    setFolders(prev => (prev || []).map(x => (x.id === f.id ? f : x)));
    if (counts) {
      const next = { ...counts };
      const before = folders?.find(x => x.id === f.id)?.status;
      if (before) next[before] = Math.max(0, (next[before] || 0) - 1);
      next[f.status] = (next[f.status] || 0) + 1;
      setCounts(next);
      onChanged?.(next.suggested ?? 0);
    }
  };

  const linked = counts ? (counts.auto || 0) + (counts.confirmed || 0) : null;

  return (
    <div>
      {counts && (
        <div style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '10px' }}>
          <b style={{ color: 'var(--text-primary)' }}>{linked}</b> folder{linked !== 1 ? 's' : ''} linked to customers
          {' '}({counts.auto || 0} automatically, {counts.confirmed || 0} by a person) ·
          {' '}<b style={{ color: 'var(--text-primary)' }}>{counts.suggested || 0}</b> to check ·
          {' '}{counts.unmatched || 0} with no close customer · {counts.none || 0} not customers
        </div>
      )}
      {!canEdit && (
        <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '10px' }}>An admin links folders to customers; you can see the matches here.</div>
      )}
      <div style={{
        display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center',
        padding: '12px', borderRadius: '12px', marginBottom: '12px',
        background: 'var(--card)', border: '1px solid var(--border)',
      }}>
        <input
          type="search" value={qInput} onChange={e => setQInput(e.target.value)} placeholder="🔍 Folder name"
          style={{ flex: '1 1 200px', minWidth: 0, padding: '9px 10px', borderRadius: '8px', fontSize: '16px', background: 'var(--input-bg)', border: '1px solid var(--border-strong)', color: 'var(--text-primary)' }}
        />
        {(Object.keys(SHOW_LABELS) as Show[]).map(s => (
          <button key={s} onClick={() => setShow(s)} style={chip(show === s)}>{SHOW_LABELS[s]}</button>
        ))}
      </div>

      {error && <div style={{ fontSize: '13px', color: 'var(--error)', marginBottom: '10px' }}>{error}</div>}
      {folders === null ? (
        <div style={{ padding: '30px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>Loading…</div>
      ) : folders.length === 0 ? (
        <div style={{ padding: '30px', textAlign: 'center', borderRadius: '14px', background: 'var(--card)', border: '1px solid var(--border)', fontSize: '13px', color: 'var(--text-muted)' }}>
          {show === 'review' ? 'Nothing to check right now.' : 'No folders here.'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {folders.map(f => <FolderCard key={f.id} folder={f} canEdit={canEdit} onSaved={saved} />)}
        </div>
      )}
    </div>
  );
}
