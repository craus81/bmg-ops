'use client';

/**
 * A customer's own Dropbox client folder, on their record page (owner ask
 * 2026-10-15: "client files should try to match to customer records so they
 * can be seen right there"). Shows the newest files from every folder
 * linked to this customer (migration 379), with a search box across them
 * and a link to the full Client Files page.
 *
 * A customer can own several folders: Masterack's own, plus ATCO and the
 * other end customers BMG prints for through Masterack (Craig, 2026-10-15).
 * With more than one linked, a chip per folder narrows the list to one end
 * customer, and "See all" follows the chip.
 *
 * Several files come down as one zip (Craig, 2026-10-16): "Pick files" ticks
 * rows for a zip, "Zip a folder" zips the whole folder or a sub-folder.
 *
 * It opens on the folders, laid out as in Dropbox (ClientFolderBrowser;
 * Craig, 2026-10-21), with "Newest files" one tap away for the old list.
 *
 * With no folder linked yet it says so, shows any folder the matcher thinks
 * might be this customer, and lets an admin link one.
 */

import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { apiFetch } from '@/lib/api-client';
import { useAuth } from '@/components/AuthProvider';
import { deepLinks } from '@/lib/deep-links';
import ClientFileRow, { type ClientFile } from '@/components/ClientFileRow';
import { setFolderMatch, type ClientFolder } from '@/components/ClientFolderMatches';
import { ZipBar, FolderZipList } from '@/components/ClientFilesDownload';
import ClientFolderBrowser from '@/components/ClientFolderBrowser';

const SHOW = 8;
/** Rows added by "Show more" (and shown at once when picking files for a zip). */
const MORE = 50;

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
  /** One linked folder picked by its chip; null = all of them. */
  const [onlyFolder, setOnlyFolder] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [folderQuery, setFolderQuery] = useState('');
  const [folderHits, setFolderHits] = useState<ClientFolder[]>([]);
  const [limit, setLimit] = useState(SHOW);
  const [mode, setMode] = useState<'pick' | 'folders' | null>(null);
  const [picked, setPicked] = useState<Map<string, ClientFile>>(new Map());
  const [layout, setLayout] = useState<'folders' | 'newest'>('folders');

  useEffect(() => {
    const t = setTimeout(() => setQ(qInput.trim()), 300);
    return () => clearTimeout(t);
  }, [qInput]);

  const loadFolders = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/client-files/folders?customer=${customerId}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Could not load client files');
      const list: ClientFolder[] = json.linked || [];
      setLinked(list);
      setOnlyFolder(prev => (prev && list.some(f => f.id === prev) ? prev : null));
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
        const p = new URLSearchParams({ limit: String(limit) });
        if (onlyFolder) p.set('folder', onlyFolder);
        else p.set('customer', customerId);
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
  }, [linked, q, customerId, onlyFolder, limit]);

  const startPicking = () => {
    setMode(m => (m === 'pick' ? null : 'pick'));
    setLimit(l => Math.max(l, MORE));
  };
  const togglePick = (f: ClientFile) => setPicked(prev => {
    const next = new Map(prev);
    if (next.has(f.id)) next.delete(f.id); else next.set(f.id, f);
    return next;
  });

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

  const many = !!linked && linked.length > 1;
  const chipFolder = onlyFolder ?? (linked && linked.length === 1 ? linked[0].id : null);
  const allHref = chipFolder
    ? deepLinks.clientFiles({ folder: chipFolder, q: q || null })
    : deepLinks.clientFiles({ customer: { id: customerId, name: customerName }, q: q || null });

  const chip = (active: boolean): CSSProperties => ({
    padding: '4px 10px', borderRadius: '999px', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
    border: `1px solid ${active ? 'var(--orange, #fb923c)' : 'var(--border-strong)'}`,
    background: active ? 'rgba(251,146,60,0.15)' : 'transparent',
    color: active ? 'var(--orange, #fb923c)' : 'var(--text-secondary)',
  });

  return (
    <div>
      {linked === null ? (
        <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Loading…</div>
      ) : linked.length > 0 ? (
        <>
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '8px' }}>
            <button onClick={() => setLayout('folders')} style={chip(layout === 'folders')}>📁 Folders</button>
            <button onClick={() => setLayout('newest')} style={chip(layout === 'newest')}>🕑 Newest files</button>
          </div>
          {layout === 'folders' ? (
            <ClientFolderBrowser
              compact
              roots={linked.map(f => ({ id: f.id, name: f.name, fileCount: f.fileCount }))}
              rootLabel={customerName}
              rootSearch={`customer=${customerId}`}
            />
          ) : (<>
          {many ? (
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '8px' }}>
              <button onClick={() => setOnlyFolder(null)} style={chip(!onlyFolder)}>
                All · {linked.reduce((n, f) => n + f.fileCount, 0).toLocaleString()}
              </button>
              {[...linked].sort((a, b) => a.name.localeCompare(b.name)).map(f => (
                <button key={f.id} onClick={() => setOnlyFolder(f.id)} style={chip(onlyFolder === f.id)}>
                  📁 {f.name} · {f.fileCount.toLocaleString()}
                </button>
              ))}
            </div>
          ) : (
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '6px' }}>
              📁 {linked[0].name} · {linked[0].fileCount.toLocaleString()} files
            </div>
          )}
          <input
            type="search" value={qInput} onChange={e => setQInput(e.target.value)} placeholder={onlyFolder ? `🔍 Search ${linked.find(f => f.id === onlyFolder)?.name ?? 'this folder'}` : "🔍 Search this customer's files"}
            style={{ width: '100%', padding: '7px 9px', borderRadius: '8px', fontSize: '16px', background: 'var(--input-bg)', border: '1px solid var(--border-strong)', color: 'var(--text-primary)', marginBottom: '4px' }}
          />
          {files === null ? (
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '6px' }}>Loading…</div>
          ) : files.length === 0 ? (
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '6px' }}>{q ? 'No files match.' : 'No files in this folder yet.'}</div>
          ) : (
            files.map(f => (
              <ClientFileRow
                key={f.id} file={f} compact hideClient={!many || !!onlyFolder}
                onClient={many && mode !== 'pick' ? folderId => setOnlyFolder(folderId) : undefined}
                checked={picked.has(f.id)}
                onCheck={mode === 'pick' ? () => togglePick(f) : undefined}
              />
            ))
          )}
          {files && files.length < total && (
            <button onClick={() => setLimit(l => l + MORE)} style={{ display: 'block', marginTop: '6px', padding: '6px 10px', borderRadius: '8px', fontSize: '12px', fontWeight: 700, cursor: 'pointer', background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border-strong)' }}>
              Show more ({(total - files.length).toLocaleString()} left)
            </button>
          )}
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '10px' }}>
            <button onClick={startPicking} style={chip(mode === 'pick')}>☑ Pick files to zip</button>
            <button onClick={() => setMode(m => (m === 'folders' ? null : 'folders'))} style={chip(mode === 'folders')}>📁 Zip a folder</button>
          </div>
          {mode === 'pick' && files && (
            <ZipBar
              picked={[...picked.values()]}
              label={chipFolder ? linked.find(f => f.id === chipFolder)?.name || customerName : customerName}
              total={files.length}
              onSelectAll={() => setPicked(prev => { const next = new Map(prev); for (const f of files) next.set(f.id, f); return next; })}
              onClear={() => setPicked(new Map())}
            />
          )}
          {mode === 'folders' && (
            <div style={{ marginTop: '8px' }}>
              {(chipFolder ? linked.filter(f => f.id === chipFolder) : linked).map(f => (
                <FolderZipList key={f.id} folderId={f.id} folderName={f.name} />
              ))}
            </div>
          )}
          </>)}
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
        </>
      )}
      {isAdmin && linked !== null && (
        <div style={{ marginTop: '8px', position: 'relative' }}>
          <input
            value={folderQuery} onChange={e => setFolderQuery(e.target.value)} placeholder={linked.length > 0 ? 'Link another Dropbox folder (an end customer): type its name' : 'Link a Dropbox folder: type its name'}
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
      {error && <div style={{ fontSize: '12px', color: 'var(--error)', marginTop: '6px' }}>{error}</div>}
    </div>
  );
}
