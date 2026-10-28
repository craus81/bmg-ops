'use client';

/**
 * Client Files laid out the way Dropbox shows them (Craig, 2026-10-21: "can
 * we use the same file structure that dropbox does? Like subfolders and
 * stuff?"; he picked opening on folders, no uploads for now). Folders first,
 * A to Z, then the files sitting in the folder; tap a folder to go in, as deep
 * as Dropbox goes, and the path at the top goes back up. Each folder has its
 * own Zip, and the search box looks inside the folder you're in and
 * everything below it; tapping a result's folder path opens that folder.
 *
 * Several client folders (Masterack plus the end customers filed in their own
 * folders) start one level up, with each folder as a row.
 *
 * Used on the customer page (ClientFilesSection), on More → Client Files once
 * a client is picked, and in the graphics job picker (ClientFilePicker), which
 * passes `pick` to tick files for the job instead of zipping them.
 * Reads GET /api/client-files/tree?browse=1 and /api/client-files?sub=.
 *
 * Outside the picker, ⬆ Upload, or pictures and PDFs dragged in from Files,
 * Finder or Photos, put files into the folder that's open (Craig,
 * 2026-10-28; src/components/useClientFileUploads.ts).
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type ReactNode } from 'react';
import { apiFetch } from '@/lib/api-client';
import { formatBytes } from '@/lib/client-files';
import { MAX_ZIP_BYTES, MAX_ZIP_FILES, type ZipEntry } from '@/lib/client-files-zip';
import type { LevelFolder } from '@/lib/client-files-tree';
import ClientFileRow, { type ClientFile } from '@/components/ClientFileRow';
import { ZipBar, useZipDownload } from '@/components/ClientFilesDownload';
import { dragHasFiles, useClientFileUploads } from '@/components/useClientFileUploads';

export interface BrowserRoot {
  /** dropbox_client_folders.id */
  id: string;
  name: string;
  fileCount?: number;
}

interface Loc { folderId: string | null; sub: string }

interface Level {
  total: { files: number; bytes: number };
  folders: LevelFolder[];
  files: ClientFile[];
}

const PAGE = 50;

interface Props {
  roots: BrowserRoot[];
  /** Name of the top level when there are several roots ("Masterack's folders"). */
  rootLabel: string;
  /** Query added to a search at the top level of several roots (e.g. "customer=<id>"). */
  rootSearch?: string;
  /** Open here first (a folder link from a search result). */
  start?: Loc | null;
  compact?: boolean;
  /** Graphics job picker: tick files for the job; hides the zip buttons. */
  pick?: { checked: (id: string) => boolean; toggle: (f: ClientFile) => void };
  /** Wide screens on Client Files: tap a row to show it in the preview panel. */
  selectedId?: string | null;
  onSelect?: (f: ClientFile) => void;
  /** Files on screen right now (for the preview panel's default). */
  onShown?: (files: ClientFile[]) => void;
  /** Files dropped on the page before a folder was open: upload them into the first folder that opens. */
  pendingUpload?: { files: File[]; nonce: number } | null;
}

const btn = (disabled = false): CSSProperties => ({
  padding: '5px 10px', borderRadius: '8px', fontSize: '12px', fontWeight: 800,
  cursor: disabled ? 'default' : 'pointer', whiteSpace: 'nowrap', flexShrink: 0,
  background: 'transparent', color: 'var(--text-primary)', border: '1px solid var(--border-strong)',
  opacity: disabled ? 0.5 : 1,
});

const crumbBtn: CSSProperties = {
  background: 'none', border: 'none', padding: '3px 4px', borderRadius: '6px', cursor: 'pointer',
  color: '#60a5fa', fontWeight: 700, fontSize: 'inherit',
};

export default function ClientFolderBrowser({ roots, rootLabel, rootSearch, start, compact, pick, selectedId, onSelect, onShown, pendingUpload }: Props) {
  const single = roots.length === 1;
  const [loc, setLoc] = useState<Loc>(() => start ?? { folderId: single ? roots[0].id : null, sub: '' });
  const [level, setLevel] = useState<Level | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<ClientFile[] | null>(null);
  const [hitTotal, setHitTotal] = useState(0);
  const [limit, setLimit] = useState(PAGE);
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<Map<string, ClientFile>>(new Map());
  const [zipping, setZipping] = useState<string | null>(null);
  const { busy, notice, run } = useZipDownload();
  // Bumped after an upload, to show the new files.
  const [reload, setReload] = useState(0);
  const uploads = useClientFileUploads(useCallback(() => setReload(n => n + 1), []));
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const canUpload = !pick;

  // A new set of roots (another customer, or a folder picked in the filter) starts over.
  const rootKey = roots.map(r => r.id).join(',');
  useEffect(() => {
    setLoc(start ?? { folderId: roots.length === 1 ? roots[0].id : null, sub: '' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootKey, start?.folderId, start?.sub]);

  useEffect(() => {
    const t = setTimeout(() => { setQ(qInput.trim()); setLimit(PAGE); }, 300);
    return () => clearTimeout(t);
  }, [qInput]);

  // The level on screen.
  useEffect(() => {
    if (!loc.folderId) { setLevel(null); setError(null); return; }
    let live = true;
    setLevel(null);
    setError(null);
    (async () => {
      try {
        const p = new URLSearchParams({ folder: loc.folderId!, browse: '1' });
        if (loc.sub) p.set('sub', loc.sub);
        const res = await apiFetch(`/api/client-files/tree?${p.toString()}`);
        const json = await res.json();
        if (!live) return;
        if (!res.ok) throw new Error(json.error || 'Could not open the folder');
        setLevel({ total: json.total, folders: json.folders || [], files: json.files || [] });
      } catch (e: any) {
        if (live) setError(e.message);
      }
    })();
    return () => { live = false; };
  }, [loc, reload]);

  // Search inside the folder on screen and everything below it.
  useEffect(() => {
    if (!q) { setHits(null); return; }
    let live = true;
    (async () => {
      try {
        const p = new URLSearchParams({ q, limit: String(limit) });
        let extra = '';
        if (loc.folderId) {
          p.set('folder', loc.folderId);
          if (loc.sub) p.set('sub', loc.sub);
        } else if (rootSearch) {
          extra = `&${rootSearch}`;
        }
        const res = await apiFetch(`/api/client-files?${p.toString()}${extra}`);
        const json = await res.json();
        if (!live) return;
        if (!res.ok) throw new Error(json.error || 'Could not search');
        setHits(json.files || []);
        setHitTotal(json.total ?? 0);
        setError(null);
      } catch (e: any) {
        if (live) { setError(e.message); setHits([]); }
      }
    })();
    return () => { live = false; };
  }, [q, limit, loc, rootSearch]);

  const shown = useMemo(() => hits ?? level?.files ?? [], [hits, level]);
  useEffect(() => { onShown?.(shown); }, [shown, onShown]);

  const go = (next: Loc) => { setLoc(next); setQInput(''); setQ(''); uploads.clear(); };
  const rootName = (id: string | null) => roots.find(r => r.id === id)?.name ?? 'Client files';

  const uploadHere = (files: File[]) => {
    if (!files.length || uploads.status.busy) return;
    if (!loc.folderId) { setError('Open one of the folders first, then put the files in it.'); return; }
    setError(null);
    const segs = loc.sub ? loc.sub.split('/') : [];
    uploads.upload(files, loc.folderId, loc.sub, segs.length ? segs[segs.length - 1] : rootName(loc.folderId));
  };
  const uploadHereRef = useRef(uploadHere);
  uploadHereRef.current = uploadHere;
  // Dropped on Client Files before a client was picked: the folder that opens takes them.
  const pendingDone = useRef<number | null>(null);
  useEffect(() => {
    if (!pendingUpload || !loc.folderId || pendingDone.current === pendingUpload.nonce) return;
    pendingDone.current = pendingUpload.nonce;
    uploadHereRef.current(pendingUpload.files);
  }, [pendingUpload, loc.folderId]);

  const zip = async (folderId: string, sub: string, label: string) => {
    setZipping(`${folderId}/${sub}`);
    setError(null);
    try {
      const p = new URLSearchParams({ folder: folderId, files: '1' });
      if (sub) p.set('sub', sub);
      const res = await apiFetch(`/api/client-files/tree?${p.toString()}`);
      const json: { files?: ZipEntry[]; error?: string } = await res.json();
      if (!res.ok) throw new Error(json.error || 'Could not list the files');
      await run(json.files || [], label);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setZipping(null);
    }
  };

  const tooBig = (n: { files: number; bytes: number }) => n.files > MAX_ZIP_FILES || n.bytes > MAX_ZIP_BYTES;

  const zipButton = (folderId: string, sub: string, label: string, n: { files: number; bytes: number } | null) => {
    if (pick) return null;
    if (n && tooBig(n)) {
      return <span title="Too big for one zip; zip a folder inside it instead" style={{ fontSize: '11px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>Too big to zip</span>;
    }
    const mine = zipping === `${folderId}/${sub}`;
    return (
      <button
        disabled={!!busy || (n?.files === 0)}
        onClick={e => { e.stopPropagation(); zip(folderId, sub, label); }}
        style={btn(!!busy || n?.files === 0)}
      >{busy && mine ? busy : '⬇ Zip'}</button>
    );
  };

  const folderRow = (key: string, name: string, meta: string, open: () => void, zipEl: ReactNode) => (
    <div
      key={key} role="button" tabIndex={0}
      onClick={e => { if ((e.target as Element).closest?.('button')) return; open(); }}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } }}
      style={{
        display: 'flex', alignItems: 'center', gap: '10px', padding: compact ? '8px 0' : '10px 12px', cursor: 'pointer',
        borderTop: compact ? '1px solid var(--border)' : undefined,
        borderRadius: compact ? 0 : '12px', background: compact ? 'transparent' : 'var(--card)',
        border: compact ? undefined : '1px solid var(--border)',
      }}
    >
      <span style={{ fontSize: compact ? '22px' : '26px', width: compact ? '52px' : '73px', textAlign: 'center', flexShrink: 0 }}>📁</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: compact ? '12.5px' : '14px', fontWeight: 700, color: 'var(--text-primary)', overflowWrap: 'anywhere' }}>{name}</div>
        <div style={{ fontSize: '11.5px', color: 'var(--text-muted)', marginTop: '2px' }}>{meta}</div>
      </div>
      {zipEl}
      <span aria-hidden style={{ color: 'var(--text-muted)', fontSize: '18px', flexShrink: 0 }}>›</span>
    </div>
  );

  const levelMeta = (n: LevelFolder) => [
    n.folders ? `${n.folders} folder${n.folders === 1 ? '' : 's'}` : '',
    `${n.files.toLocaleString()} file${n.files === 1 ? '' : 's'}`,
    formatBytes(n.bytes),
  ].filter(Boolean).join(' · ');

  // The path at the top: (several roots) › client folder › sub › folders.
  const segs = loc.sub ? loc.sub.split('/') : [];
  const crumbs: { label: string; to: Loc | null }[] = [];
  if (!single) crumbs.push({ label: rootLabel, to: { folderId: null, sub: '' } });
  if (loc.folderId) {
    crumbs.push({ label: rootName(loc.folderId), to: { folderId: loc.folderId, sub: '' } });
    segs.forEach((s, i) => crumbs.push({ label: s, to: { folderId: loc.folderId, sub: segs.slice(0, i + 1).join('/') } }));
  }
  const here = crumbs.length ? crumbs[crumbs.length - 1].label : rootLabel;

  const isChecked = (id: string) => (pick ? pick.checked(id) : picked.has(id));
  const toggle = (f: ClientFile) => {
    if (pick) { pick.toggle(f); return; }
    setPicked(prev => {
      const next = new Map(prev);
      if (next.has(f.id)) next.delete(f.id); else next.set(f.id, f);
      return next;
    });
  };
  const checking = !!pick || picking;

  const fileRow = (f: ClientFile, inSearch: boolean) => (
    <ClientFileRow
      key={f.id} file={f} compact={compact}
      hideClient={!inSearch || single || !!loc.folderId}
      onFolder={inSearch ? (folderId, sub) => go({ folderId, sub }) : undefined}
      selected={!!onSelect && f.id === selectedId}
      onSelect={onSelect ? () => onSelect(f) : undefined}
      checked={isChecked(f.id)}
      onCheck={checking ? () => toggle(f) : undefined}
    />
  );

  const dropProps = canUpload ? {
    onDragOver: (e: DragEvent) => { if (!dragHasFiles(e)) return; e.preventDefault(); e.stopPropagation(); setDragOver(true); },
    onDragLeave: (e: DragEvent) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false); },
    onDrop: (e: DragEvent) => {
      if (!dragHasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      setDragOver(false);
      uploadHere(Array.from(e.dataTransfer.files));
    },
  } : {};

  return (
    <div {...dropProps} style={{ position: 'relative' }}>
      {dragOver && (
        <div style={{
          position: 'absolute', inset: 0, zIndex: 5, pointerEvents: 'none', borderRadius: '12px',
          border: '2px dashed var(--accent, #2563eb)', background: 'rgba(37,99,235,0.08)',
          display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: '60px',
          fontSize: '14px', fontWeight: 800, color: 'var(--accent, #2563eb)',
        }}>
          {loc.folderId ? `Drop to upload into ${here}` : 'Open a folder first, then drop the files in it'}
        </div>
      )}
      <nav aria-label="Folder path" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '2px', fontSize: compact ? '12.5px' : '13.5px', marginBottom: '6px', minWidth: 0 }}>
        {crumbs.map((c, i) => (
          <span key={i} style={{ display: 'inline-flex', alignItems: 'center', minWidth: 0 }}>
            {i > 0 && <span style={{ color: 'var(--text-muted)', padding: '0 2px' }}>›</span>}
            {i === crumbs.length - 1
              ? <span style={{ fontWeight: 800, color: 'var(--text-primary)', padding: '3px 4px', overflowWrap: 'anywhere' }}>{i === 0 ? '📁 ' : ''}{c.label}</span>
              : <button onClick={() => go(c.to!)} style={crumbBtn}>{i === 0 ? '📁 ' : ''}{c.label}</button>}
          </span>
        ))}
        {level && (
          <span style={{ color: 'var(--text-muted)', fontSize: '11.5px', marginLeft: '6px' }}>
            {level.total.files.toLocaleString()} file{level.total.files === 1 ? '' : 's'} · {formatBytes(level.total.bytes)}
          </span>
        )}
      </nav>

      <input
        type="search" value={qInput} onChange={e => setQInput(e.target.value)}
        placeholder={`🔍 Search ${here} and everything in it`}
        style={{ width: '100%', padding: '7px 9px', borderRadius: '8px', fontSize: '16px', background: 'var(--input-bg)', border: '1px solid var(--border-strong)', color: 'var(--text-primary)', marginBottom: compact ? '4px' : '10px' }}
      />

      {!pick && (
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: compact ? '4px' : '10px' }}>
          {loc.folderId && level && zipButton(loc.folderId, loc.sub, segs.length ? `${rootName(loc.folderId)} – ${segs[segs.length - 1]}` : rootName(loc.folderId), level.total)}
          <button onClick={() => setPicking(p => !p)} style={{ ...btn(), ...(picking ? { borderColor: 'var(--accent, #2563eb)', color: 'var(--accent, #2563eb)' } : {}) }}>☑ Pick files</button>
          {canUpload && loc.folderId && (
            <>
              <button
                onClick={() => fileInput.current?.click()}
                disabled={!!uploads.status.busy}
                title={`Put files into ${here} in Dropbox. You can also drag them in from Files, Finder or Photos.`}
                style={btn(!!uploads.status.busy)}
              >⬆ Upload</button>
              <input
                ref={fileInput} type="file" multiple hidden
                onChange={e => { const files = Array.from(e.target.files || []); e.target.value = ''; uploadHere(files); }}
              />
            </>
          )}
        </div>
      )}
      {(uploads.status.busy || uploads.status.done || uploads.status.error) && (
        <div role="status" style={{
          fontSize: '12.5px', fontWeight: 700, marginBottom: compact ? '4px' : '10px',
          color: uploads.status.error ? 'var(--error, #ef4444)' : uploads.status.busy ? 'var(--text-muted)' : 'var(--success, #16a34a)',
        }}>
          {uploads.status.busy || (uploads.status.error ? uploads.status.error : `✓ ${uploads.status.done}`)}
          {uploads.status.error && uploads.status.done && <div style={{ color: 'var(--success, #16a34a)' }}>✓ {uploads.status.done}</div>}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: compact ? 0 : '8px' }}>
        {hits !== null ? (
          hits.length === 0
            ? <div style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '8px 0' }}>No files in {here} match &quot;{q}&quot;.</div>
            : hits.map(f => fileRow(f, true))
        ) : !loc.folderId ? (
          [...roots].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })).map(r => folderRow(
            r.id, r.name,
            r.fileCount != null ? `${r.fileCount.toLocaleString()} file${r.fileCount === 1 ? '' : 's'}` : '',
            () => go({ folderId: r.id, sub: '' }),
            zipButton(r.id, '', r.name, r.fileCount != null ? { files: r.fileCount, bytes: 0 } : null),
          ))
        ) : level === null ? (
          !error && <div style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '8px 0' }}>Loading…</div>
        ) : level.folders.length === 0 && level.files.length === 0 ? (
          <div style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '8px 0' }}>No files in this folder yet.</div>
        ) : (
          <>
            {level.folders.map(n => folderRow(
              n.path, n.name, levelMeta(n),
              () => go({ folderId: loc.folderId, sub: n.path }),
              zipButton(loc.folderId!, n.path, `${rootName(loc.folderId)} – ${n.name}`, n),
            ))}
            {level.files.map(f => fileRow(f, false))}
          </>
        )}
      </div>

      {hits && hits.length < hitTotal && limit < 100 && (
        <button onClick={() => setLimit(100)} style={{ ...btn(), marginTop: '6px', color: 'var(--text-secondary)' }}>
          Show more ({(hitTotal - hits.length).toLocaleString()} left)
        </button>
      )}
      {hits && hits.length < hitTotal && limit >= 100 && (
        <div style={{ fontSize: '11.5px', color: 'var(--text-muted)', marginTop: '6px' }}>
          Showing the newest 100 of {hitTotal.toLocaleString()}. Type more words to narrow it down.
        </div>
      )}

      {picking && !pick && (
        <ZipBar
          picked={[...picked.values()]}
          label={here}
          total={shown.length}
          onSelectAll={() => setPicked(prev => { const next = new Map(prev); for (const f of shown) next.set(f.id, f); return next; })}
          onClear={() => setPicked(new Map())}
        />
      )}
      {(error || notice) && (
        <div style={{ fontSize: '12px', color: error ? 'var(--error)' : 'var(--text-muted)', marginTop: '6px' }}>{error || notice}</div>
      )}
    </div>
  );
}
