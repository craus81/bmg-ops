'use client';

/**
 * A customer's own Dropbox client folder, on their record page (owner ask
 * 2026-10-15: "client files should try to match to customer records so they
 * can be seen right there"). Shows the newest files from every folder
 * linked to this customer (migration 379), with a search box across them
 * and a link to the full Client Files page.
 *
 * With no folder linked yet it says so, shows any folder the matcher thinks
 * might be this customer, and lets an admin link one.
 */

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import { useAuth } from '@/components/AuthProvider';
import { deepLinks } from '@/lib/deep-links';
import ClientFileRow, { type ClientFile } from '@/components/ClientFileRow';
import { setFolderMatch, type ClientFolder } from '@/components/ClientFolderMatches';

const SHOW = 8;

interface Props {
  /** customers.id (the NetSuite mirror row). */
  customerId: string;
  customerName: string;
}

export default function ClientFilesSection({ customerId, customerName }: Props) {
  const { isAdmin } = useAuth();
  const [linked, setLinked] = useState<ClientFolder[] | null>(null);
  const [suggested, setSuggested] = useState<ClientFolder[]>([]);
  const [files, setFiles] = useState<ClientFile[] | null>(null);
  const [total, setTotal] = useState(0);
  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [folderQuery, setFolderQuery] = useState('');
  const [folderHits, setFolderHits] = useState<ClientFolder[]>([]);

  useEffect(() => {
    const t = setTimeout(() => setQ(qInput.trim()), 300);
    return () => clearTimeout(t);
  }, [qInput]);

  const loadFolders = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/client-files/folders?customer=${customerId}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Could not load client files');
      setLinked(json.linked || []);
      setSuggested(json.suggested || []);
    } catch (e: any) {
      setError(e.message);
      setLinked([]);
    }
  }, [customerId]);

  useEffect(() => { loadFolders(); }, [loadFolders]);

  useEffect(() => {
    if (!linked || linked.length === 0) { setFiles([]); return; }
    let live = true;
    (async () => {
      try {
        const p = new URLSearchParams({ customer: customerId, limit: String(SHOW) });
        if (q) p.set('q', q);
        const res = await apiFetch(`/api/client-files?${p.toString()}`);
        const json = await res.json();
        if (!live) return;
        if (!res.ok) throw new Error(json.error || 'Could not load files');
        setFiles(json.files || []);
        setTotal(json.total ?? 0);
      } catch (e: any) {
        if (live) { setError(e.message); setFiles([]); }
      }
    })();
    return () => { live = false; };
  }, [linked, q, customerId]);

  // Admin: find an unlinked folder to link here.
  useEffect(() => {
    const term = folderQuery.trim();
    if (term.length < 2) { setFolderHits([]); return; }
    const t = setTimeout(async () => {
      const res = await apiFetch(`/api/client-files/folders?show=unlinked&q=${encodeURIComponent(term)}`);
      const json = await res.json().catch(() => ({}));
      setFolderHits(res.ok ? (json.folders || []).slice(0, 8) : []);
    }, 300);
    return () => clearTimeout(t);
  }, [folderQuery]);

  const link = async (folderId: string) => {
    setBusy(true);
    setError(null);
    try {
      await setFolderMatch(folderId, 'link', customerId);
      setFolderQuery('');
      setFolderHits([]);
      await loadFolders();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const allHref = linked && linked.length === 1
    ? deepLinks.clientFiles({ folder: linked[0].id })
    : deepLinks.clientFiles({ q: customerName });

  return (
    <div>
      {linked === null ? (
        <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Loading…</div>
      ) : linked.length > 0 ? (
        <>
          <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '6px' }}>
            {linked.map(f => `📁 ${f.name}`).join(' · ')} · {linked.reduce((n, f) => n + f.fileCount, 0).toLocaleString()} files
          </div>
          <input
            type="search" value={qInput} onChange={e => setQInput(e.target.value)} placeholder="🔍 Search this customer's files"
            style={{ width: '100%', padding: '7px 9px', borderRadius: '8px', fontSize: '16px', background: 'var(--input-bg)', border: '1px solid var(--border-strong)', color: 'var(--text-primary)', marginBottom: '4px' }}
          />
          {files === null ? (
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '6px' }}>Loading…</div>
          ) : files.length === 0 ? (
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '6px' }}>{q ? 'No files match.' : 'No files in this folder yet.'}</div>
          ) : (
            files.map(f => <ClientFileRow key={f.id} file={f} compact hideClient={linked.length === 1} />)
          )}
          <a href={allHref} style={{ display: 'inline-block', marginTop: '8px', fontSize: '12px', fontWeight: 700, color: '#60a5fa', textDecoration: 'none' }}>
            {total > SHOW ? `See all ${total.toLocaleString()} in Client Files →` : 'Open in Client Files →'}
          </a>
        </>
      ) : (
        <>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>No Dropbox client folder is linked to this customer yet.</div>
          {suggested.length > 0 && (
            <div style={{ marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {suggested.map(f => (
                <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12.5px', flexWrap: 'wrap' }}>
                  <span style={{ color: 'var(--text-secondary)' }}>Might be</span>
                  <a href={deepLinks.clientFiles({ folder: f.id })} style={{ fontWeight: 700, color: 'var(--text-primary)', textDecoration: 'none' }}>📁 {f.name}</a>
                  <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>{f.fileCount.toLocaleString()} files</span>
                  {isAdmin && (
                    <button disabled={busy} onClick={() => link(f.id)} style={{ marginLeft: 'auto', padding: '4px 10px', borderRadius: '8px', fontSize: '12px', fontWeight: 800, cursor: 'pointer', background: 'var(--accent, #2563eb)', color: '#fff', border: 'none' }}>Link</button>
                  )}
                </div>
              ))}
            </div>
          )}
          {isAdmin && (
            <div style={{ marginTop: '8px', position: 'relative' }}>
              <input
                value={folderQuery} onChange={e => setFolderQuery(e.target.value)} placeholder="Link a Dropbox folder: type its name"
                style={{ width: '100%', padding: '7px 9px', borderRadius: '8px', fontSize: '16px', background: 'var(--input-bg)', border: '1px solid var(--border-strong)', color: 'var(--text-primary)' }}
              />
              {folderHits.map(f => (
                <button
                  key={f.id} disabled={busy} onClick={() => link(f.id)}
                  style={{ display: 'block', width: '100%', textAlign: 'left', padding: '7px 9px', background: 'none', border: 'none', borderTop: '1px solid var(--border)', color: 'var(--text-primary)', fontSize: '12.5px', cursor: 'pointer' }}
                >📁 {f.name} <span style={{ color: 'var(--text-muted)' }}>· {f.fileCount.toLocaleString()} files</span></button>
              ))}
            </div>
          )}
        </>
      )}
      {error && <div style={{ fontSize: '12px', color: 'var(--error)', marginTop: '6px' }}>{error}</div>}
    </div>
  );
}
