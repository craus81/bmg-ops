'use client';

/**
 * Client Files — every file in Dropbox › OFFICE › Clients, searchable here
 * (owner ask 2026-10-15, migration 379). The sync (src/lib/client-files-sync.ts)
 * keeps the list current every 10 minutes and copies PDFs and photos so they
 * open instantly; print files open from Dropbox. All internal staff.
 *
 * Two views: Files (search, type chips, client filter, a preview panel on
 * wide screens) and, for admins, Check matches, where the Dropbox client
 * folders the matcher wasn't sure about get linked to the right customer.
 *
 * Once a client (or a customer's folders) is picked it opens on the folders,
 * laid out as in Dropbox (ClientFolderBrowser; Craig, 2026-10-21), with
 * "Newest files" one tap away for the flat list.
 *
 * URL params (deepLinks.clientFiles): q, folder, customer (+ customerName,
 * every folder linked to that customer), matches=1.
 */

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { apiFetch } from '@/lib/api-client';
import { CLIENT_FILE_KINDS, KIND_LABELS, formatBytes, opensInGraphicsBuilder, type ClientFileKind } from '@/lib/client-files';
import { deepLinks } from '@/lib/deep-links';
import ClientFileRow, { FileTile, CopiedBadge, clientFileUrl, fmtFileDate, type ClientFile } from '@/components/ClientFileRow';
import ClientFolderMatches from '@/components/ClientFolderMatches';
import { ZipBar, FolderZipList } from '@/components/ClientFilesDownload';
import ClientFolderBrowser, { type BrowserRoot } from '@/components/ClientFolderBrowser';
import FleetSuiteClientFolders from '@/components/FleetSuiteClientFolders';

const PAGE_SIZE = 50;

const inputStyle: React.CSSProperties = {
  padding: '9px 10px', borderRadius: '8px', fontSize: '16px',
  background: 'var(--input-bg)', border: '1px solid var(--border-strong)', color: 'var(--text-primary)',
  minWidth: 0,
};

const chip = (on: boolean): React.CSSProperties => ({
  padding: '7px 12px', borderRadius: '999px', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
  background: on ? 'var(--accent, #2563eb)' : 'transparent',
  color: on ? '#fff' : 'var(--text-secondary)',
  border: `1px solid ${on ? 'var(--accent, #2563eb)' : 'var(--border-strong)'}`,
  whiteSpace: 'nowrap',
});

const btn = (primary = false): React.CSSProperties => ({
  padding: '8px 12px', borderRadius: '8px', fontSize: '13px', fontWeight: 800, cursor: 'pointer',
  background: primary ? 'var(--accent, #2563eb)' : 'transparent',
  color: primary ? '#fff' : 'var(--text-primary)',
  border: primary ? '1px solid var(--accent, #2563eb)' : '1px solid var(--border-strong)',
  textDecoration: 'none', whiteSpace: 'nowrap', display: 'inline-block',
});

function minutesAgo(iso: string | null): string {
  if (!iso) return 'not synced yet';
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'synced just now';
  if (m < 60) return `synced ${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `synced ${h} h ago` : `synced ${Math.round(h / 24)} days ago`;
}

function useWide(): boolean {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 900px)');
    const on = () => setWide(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return wide;
}

interface FolderOption { id: string; name: string }

function ClientFilesInner() {
  const router = useRouter();
  const params = useSearchParams();
  const { isAdmin, loading: authLoading, hasFeature } = useAuth();
  const isStaff = hasFeature('client_files');
  const wide = useWide();

  const [view, setView] = useState<'files' | 'matches'>(params.get('matches') ? 'matches' : 'files');
  const [qInput, setQInput] = useState(params.get('q') || '');
  const [q, setQ] = useState(qInput.trim());
  const [kind, setKind] = useState<ClientFileKind | ''>('');
  const [folder, setFolder] = useState<FolderOption | null>(params.get('folder') ? { id: params.get('folder')!, name: '' } : null);
  const [folders, setFolders] = useState<FolderOption[]>([]);
  // Every folder linked to one customer, from the customer page's "See all".
  const [customer, setCustomer] = useState<FolderOption | null>(params.get('customer') ? { id: params.get('customer')!, name: params.get('customerName') || 'This customer' } : null);

  const [files, setFiles] = useState<ClientFile[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sync, setSync] = useState<{ lastRunAt: string | null; walking: boolean; error: string | null } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reviewCount, setReviewCount] = useState<number | null>(null);
  // Several files as one zip (Craig, 2026-10-16): tick files, or zip a folder.
  const [mode, setMode] = useState<'pick' | 'folders' | null>(null);
  const [picked, setPicked] = useState<Map<string, ClientFile>>(new Map());
  const reqId = useRef(0);
  // A picked client opens on its folders (Craig, 2026-10-21); 'newest' is the flat list.
  const [layout, setLayout] = useState<'folders' | 'newest'>('folders');
  const [customerRoots, setCustomerRoots] = useState<BrowserRoot[] | null>(null);
  const [browserFiles, setBrowserFiles] = useState<ClientFile[]>([]);

  useEffect(() => {
    const t = setTimeout(() => setQ(qInput.trim()), 300);
    return () => clearTimeout(t);
  }, [qInput]);

  // Client folder names for the filter, and how many matches wait for a person.
  useEffect(() => {
    if (authLoading || !isStaff) return;
    (async () => {
      try {
        const res = await apiFetch('/api/client-files/folders?show=all');
        const json = await res.json();
        if (!res.ok) return;
        const list: FolderOption[] = (json.folders || []).map((f: any) => ({ id: f.id, name: f.name }));
        setFolders(list);
        setReviewCount(json.counts?.suggested ?? null);
        setFolder(prev => (prev && !prev.name ? list.find(f => f.id === prev.id) || prev : prev));
      } catch { /* the filter just stays empty */ }
    })();
  }, [authLoading, isStaff, view]);

  const buildQuery = useCallback((offset: number) => {
    const p = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
    if (q) p.set('q', q);
    if (kind) p.set('kind', kind);
    if (folder) p.set('folder', folder.id);
    else if (customer) p.set('customer', customer.id);
    return p.toString();
  }, [q, kind, folder, customer]);

  useEffect(() => {
    if (authLoading || !isStaff || view !== 'files') return;
    const id = ++reqId.current;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const res = await apiFetch(`/api/client-files?${buildQuery(0)}`);
        const json = await res.json();
        if (id !== reqId.current) return;
        if (!res.ok) throw new Error(json.error || 'Could not load files');
        setFiles(json.files || []);
        setTotal(json.total ?? null);
        setHasMore(!!json.hasMore);
        if (json.sync) setSync(json.sync);
        setSelectedId(prev => (prev && (json.files || []).some((f: ClientFile) => f.id === prev) ? prev : (json.files?.[0]?.id ?? null)));
      } catch (e: any) {
        if (id === reqId.current) { setError(e.message); setFiles([]); setTotal(null); setHasMore(false); }
      } finally {
        if (id === reqId.current) setLoading(false);
      }
    })();
  }, [buildQuery, authLoading, isStaff, view]);

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const res = await apiFetch(`/api/client-files?${buildQuery(files.length)}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Could not load files');
      setFiles(prev => {
        const seen = new Set(prev.map(f => f.id));
        return [...prev, ...(json.files || []).filter((f: ClientFile) => !seen.has(f.id))];
      });
      setHasMore(!!json.hasMore);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoadingMore(false);
    }
  };

  // Every folder linked to the customer, as the browser's top level.
  useEffect(() => {
    if (!customer || folder) { setCustomerRoots(null); return; }
    let live = true;
    (async () => {
      try {
        const res = await apiFetch(`/api/client-files/folders?customer=${customer.id}`);
        const json = await res.json();
        if (live) setCustomerRoots(res.ok ? (json.linked || []).map((f: any) => ({ id: f.id, name: f.name, fileCount: f.fileCount })) : []);
      } catch {
        if (live) setCustomerRoots([]);
      }
    })();
    return () => { live = false; };
  }, [customer, folder]);

  const browserRoots: BrowserRoot[] | null = folder
    ? [{ id: folder.id, name: folder.name || 'This client' }]
    : customer ? customerRoots : null;
  const browsing = layout === 'folders' && !!browserRoots && browserRoots.length > 0;
  const onBrowserShown = useCallback((list: ClientFile[]) => {
    setBrowserFiles(list);
    setSelectedId(prev => (prev && list.some(f => f.id === prev) ? prev : (list[0]?.id ?? null)));
  }, []);

  const selected = useMemo(
    () => (browsing ? browserFiles : files).find(f => f.id === selectedId) || null,
    [browsing, browserFiles, files, selectedId],
  );

  const copyLink = async (f: ClientFile) => {
    const url = `${window.location.origin}${clientFileUrl(f)}`;
    try {
      await navigator.clipboard.writeText(url);
      setNotice('Link copied. It opens the file for anyone signed in to FleetSuite.');
    } catch {
      setNotice(url);
    }
  };

  const anyFilter = !!(qInput || kind || folder || customer);
  const clearFilters = () => { setQInput(''); setQ(''); setKind(''); setFolder(null); setCustomer(null); };

  if (!authLoading && !isStaff) {
    return (
      <div style={{ padding: '40px 16px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '14px' }}>
        Client Files is for BMG staff.
      </div>
    );
  }

  const header = (
    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '14px', flexWrap: 'wrap' }}>
      <button onClick={() => router.push('/more')} aria-label="Back" style={{ fontSize: '20px', color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer' }}>←</button>
      <div style={{ flex: '1 1 220px', minWidth: 0 }}>
        <div style={{ fontSize: '18px', fontWeight: 800, color: 'var(--text-primary)' }}>Client Files</div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
          Dropbox › OFFICE › Clients
          {view === 'files' && total != null ? ` · ${total.toLocaleString()} file${total !== 1 ? 's' : ''}${anyFilter ? ' match' : ''}` : ''}
          {sync ? ` · ${sync.walking ? 'first copy in progress' : minutesAgo(sync.lastRunAt)}` : ''}
        </div>
      </div>
      <div style={{ display: 'flex', gap: '6px' }}>
        <button onClick={() => setView('files')} style={chip(view === 'files')}>Files</button>
        <button onClick={() => setView('matches')} style={chip(view === 'matches')}>
          Check matches{reviewCount ? ` (${reviewCount})` : ''}
        </button>
      </div>
    </div>
  );

  if (view === 'matches') {
    return (
      <div style={{ padding: '16px', maxWidth: '1100px', margin: '0 auto', paddingBottom: '40px' }}>
        {header}
        <ClientFolderMatches canEdit={isAdmin} onChanged={n => setReviewCount(n)} />
      </div>
    );
  }

  const preview = selected && (
    <div style={{
      background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', padding: '14px',
      position: 'sticky', top: '12px', alignSelf: 'start',
    }}>
      {selected.thumbUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={selected.thumbUrl} alt="" style={{ width: '100%', maxHeight: '260px', objectFit: 'contain', borderRadius: '8px', background: '#fff' }} />
      ) : (
        <div style={{ display: 'flex', justifyContent: 'center' }}><FileTile file={selected} size={120} /></div>
      )}
      <div style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text-primary)', marginTop: '12px', overflowWrap: 'anywhere' }}>{selected.name}</div>
      <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '8px', lineHeight: 1.7 }}>
        {selected.client && <div>Client <b style={{ color: 'var(--text-primary)' }}>{selected.client.name}</b></div>}
        {selected.folderPath && <div>Folder <b style={{ color: 'var(--text-primary)' }}>{selected.folderPath}</b></div>}
        <div>Changed <b style={{ color: 'var(--text-primary)' }}>{fmtFileDate(selected.modified) || '—'}</b> · <b style={{ color: 'var(--text-primary)' }}>{formatBytes(selected.size)}</b></div>
        <div>Customer {selected.customer ? (
          selected.customer.link
            ? <a href={selected.customer.link} style={{ color: 'var(--orange)', fontWeight: 700, textDecoration: 'none' }}>{selected.customer.name} →</a>
            : <b style={{ color: 'var(--text-primary)' }}>{selected.customer.name}</b>
        ) : <span>not linked yet</span>}</div>
      </div>
      <div style={{ display: 'flex', gap: '8px', marginTop: '12px', flexWrap: 'wrap' }}>
        <a href={clientFileUrl(selected)} target="_blank" rel="noopener noreferrer" style={btn(true)}>Open</a>
        {hasFeature('graphics_builder') && opensInGraphicsBuilder(selected) && (
          <a href={deepLinks.graphicsBuilderFromClientFile(selected.id)} style={btn()} title="Measure this proof, then make the estimate and the graphics job">🎨 Open in Graphics Builder</a>
        )}
        <a href={clientFileUrl(selected, true)} download={selected.name} style={btn()}>⬇ Download</a>
        <button onClick={() => copyLink(selected)} style={btn()}>🔗 Copy link</button>
      </div>
      <div style={{ marginTop: '10px' }}><CopiedBadge copied={selected.copied} /></div>
      <div style={{ fontSize: '11.5px', color: 'var(--text-muted)', marginTop: '8px' }}>
        {selected.copied
          ? 'This file is copied into FleetSuite, so it opens instantly.'
          : selected.kind === 'print'
            ? 'Print files stay in Dropbox; opening one fetches it from there.'
            : 'Not copied yet (or too big), so it is fetched from Dropbox.'}
      </div>
    </div>
  );

  return (
    <div style={{ padding: '16px', maxWidth: '1400px', margin: '0 auto', paddingBottom: '40px' }}>
      {header}

      {sync?.error && isAdmin && (
        <div style={{
          padding: '10px 12px', borderRadius: '10px', marginBottom: '12px', fontSize: '12.5px',
          background: 'var(--warning-bg)', border: '1px solid var(--warning-border)', color: 'var(--warning)',
        }}>The last Dropbox sync had a problem: {sync.error}</div>
      )}

      {/* Filters */}
      <div style={{
        display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center',
        padding: '12px', borderRadius: '12px', marginBottom: '14px',
        background: 'var(--card)', border: '1px solid var(--border)',
      }}>
        {!browsing && (
          <input
            type="search" value={qInput} onChange={e => setQInput(e.target.value)}
            placeholder="🔍 Client, folder or file name"
            style={{ ...inputStyle, flex: '2 1 260px' }}
          />
        )}
        <select
          value={folder?.id || ''}
          onChange={e => {
            const f = folders.find(x => x.id === e.target.value);
            setFolder(f || null);
          }}
          aria-label="Client"
          style={{ ...inputStyle, flex: '1 1 180px', maxWidth: '280px' }}
        >
          <option value="">All clients</option>
          {folder && !folders.some(f => f.id === folder.id) && <option value={folder.id}>{folder.name || 'This client'}</option>}
          {folders.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
        {customer && !folder && (
          <button onClick={() => setCustomer(null)} title="Show every client" style={chip(true)}>{customer.name}'s folders ✕</button>
        )}
        {browserRoots && browserRoots.length > 0 && (
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
            <button onClick={() => setLayout('folders')} style={chip(layout === 'folders')}>📁 Folders</button>
            <button onClick={() => setLayout('newest')} style={chip(layout === 'newest')}>🕑 Newest files</button>
          </div>
        )}
        {!browsing && <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
          <button onClick={() => setKind('')} style={chip(kind === '')}>All</button>
          {CLIENT_FILE_KINDS.filter(k => k !== 'other').map(k => (
            <button key={k} onClick={() => setKind(k)} style={chip(kind === k)}>{KIND_LABELS[k]}</button>
          ))}
        </div>}
        {anyFilter && (
          <button onClick={clearFilters} style={{ ...inputStyle, fontSize: '13px', fontWeight: 700, color: 'var(--text-muted)', cursor: 'pointer' }}>✕ Clear</button>
        )}
      </div>

      {notice && (
        <div style={{ fontSize: '12.5px', color: 'var(--text-muted)', marginBottom: '10px', overflowWrap: 'anywhere' }}>
          {notice} <button onClick={() => setNotice(null)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}>✕</button>
        </div>
      )}

      {error && (
        <div style={{
          padding: '12px 14px', borderRadius: '10px', marginBottom: '12px',
          background: 'var(--error-bg)', border: '1px solid var(--error-border)',
          color: 'var(--error)', fontSize: '13px', fontWeight: 600,
        }}>Could not load files: {error}</div>
      )}

      {/* FleetSuite's own folders for the customer (Craig, 2026-10-22). */}
      {customer && !folder && <FleetSuiteClientFolders customerId={customer.id} compact={false} />}

      {browsing && browserRoots ? (
        <div style={{ display: 'grid', gridTemplateColumns: wide && preview ? 'minmax(0, 1fr) 360px' : 'minmax(0, 1fr)', gap: '16px' }}>
          <div style={{ minWidth: 0 }}>
            <ClientFolderBrowser
              roots={browserRoots}
              rootLabel={customer ? `${customer.name}'s folders` : 'Client files'}
              rootSearch={customer ? `customer=${customer.id}` : undefined}
              selectedId={wide ? selectedId : null}
              onSelect={wide ? f => setSelectedId(f.id) : undefined}
              onShown={onBrowserShown}
            />
          </div>
          {wide && preview}
        </div>
      ) : (<>
      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '10px' }}>
        <button onClick={() => setMode(m => (m === 'pick' ? null : 'pick'))} style={chip(mode === 'pick')}>☑ Pick files to zip</button>
        <button
          onClick={() => setMode(m => (m === 'folders' ? null : 'folders'))}
          disabled={!folder}
          title={folder ? undefined : 'Pick a client first'}
          style={{ ...chip(mode === 'folders' && !!folder), opacity: folder ? 1 : 0.5 }}
        >📁 Zip a folder{folder ? '' : ' (pick a client first)'}</button>
      </div>
      {mode === 'folders' && folder && (
        <div style={{ padding: '10px 12px', borderRadius: '12px', marginBottom: '12px', background: 'var(--card)', border: '1px solid var(--border)' }}>
          <FolderZipList folderId={folder.id} folderName={folder.name || 'Client files'} />
        </div>
      )}

      {loading ? (
        <div style={{ padding: '30px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>Loading…</div>
      ) : files.length === 0 && !error ? (
        <div style={{ padding: '30px', textAlign: 'center', borderRadius: '14px', background: 'var(--card)', border: '1px solid var(--border)', fontSize: '13px', color: 'var(--text-muted)' }}>
          {anyFilter ? 'No files match.' : sync?.walking ? 'The first copy from Dropbox is still running. Files appear here as it goes.' : 'No files yet.'}
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: wide && preview ? 'minmax(0, 1fr) 360px' : 'minmax(0, 1fr)', gap: '16px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', minWidth: 0 }}>
            {files.map(f => (
              <ClientFileRow
                key={f.id}
                file={f}
                selected={wide && f.id === selectedId}
                onSelect={wide ? () => setSelectedId(f.id) : undefined}
                onClient={mode === 'pick' ? undefined : (id, name) => setFolder({ id, name })}
                checked={picked.has(f.id)}
                onCheck={mode === 'pick' ? () => setPicked(prev => {
                  const next = new Map(prev);
                  if (next.has(f.id)) next.delete(f.id); else next.set(f.id, f);
                  return next;
                }) : undefined}
              />
            ))}
            {hasMore && (
              <div style={{ textAlign: 'center', marginTop: '6px' }}>
                <button onClick={loadMore} disabled={loadingMore} style={btn()}>{loadingMore ? 'Loading…' : 'Load more'}</button>
              </div>
            )}
            {mode === 'pick' && (
              <ZipBar
                picked={[...picked.values()]}
                label={folder?.name || q || 'Client files'}
                total={files.length}
                onSelectAll={() => setPicked(prev => { const next = new Map(prev); for (const f of files) next.set(f.id, f); return next; })}
                onClear={() => setPicked(new Map())}
              />
            )}
          </div>
          {wide && preview}
        </div>
      )}
      </>)}
    </div>
  );
}

export default function ClientFilesPage() {
  return (
    <Suspense fallback={<div style={{ padding: '30px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>Loading…</div>}>
      <ClientFilesInner />
    </Suspense>
  );
}
