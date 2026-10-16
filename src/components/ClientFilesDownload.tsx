'use client';

/**
 * Downloading several Client Files at once (Craig, 2026-10-16, "both
 * options"): a bar for the files ticked in a list, and a folder list with a
 * Zip button for the whole client folder and each sub-folder. Used on the
 * customer page (ClientFilesSection) and on More → Client Files.
 */

import { useEffect, useState, type CSSProperties } from 'react';
import { apiFetch } from '@/lib/api-client';
import { formatBytes } from '@/lib/client-files';
import { downloadClientFilesZip, zipLimitProblem, MAX_ZIP_BYTES, MAX_ZIP_FILES, type ZipEntry } from '@/lib/client-files-zip';
import type { TreeNode } from '@/lib/client-files-tree';

/** One zip at a time per screen, with its progress and outcome line. */
export function useZipDownload() {
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const run = async (files: ZipEntry[], label: string): Promise<boolean> => {
    setNotice(null);
    setBusy('Starting…');
    try {
      const { added, skipped } = await downloadClientFilesZip(files, label, setBusy);
      setNotice(skipped.length
        ? `Zipped ${added} of ${files.length}. Couldn't get: ${skipped.slice(0, 3).join(', ')}${skipped.length > 3 ? ` and ${skipped.length - 3} more` : ''}.`
        : `Zipped ${added} file${added !== 1 ? 's' : ''}.`);
      return true;
    } catch (e: any) {
      setNotice(e?.message || 'Could not make the zip');
      return false;
    } finally {
      setBusy(null);
    }
  };

  return { busy, notice, setNotice, run };
}

const btn = (primary = false, disabled = false): CSSProperties => ({
  padding: primary ? '7px 12px' : '5px 10px', borderRadius: '8px', fontSize: primary ? '13px' : '12px', fontWeight: 800,
  cursor: disabled ? 'default' : 'pointer', whiteSpace: 'nowrap', flexShrink: 0,
  background: primary ? 'var(--accent, #2563eb)' : 'transparent',
  color: primary ? '#fff' : 'var(--text-primary)',
  border: primary ? 'none' : '1px solid var(--border-strong)',
  opacity: disabled ? 0.5 : 1,
});

/** "3 files · 17.4 MB  [⬇ Download zip]" under a list in pick mode. */
export function ZipBar({ picked, label, onDone, onClear, total, onSelectAll }: {
  picked: { id: string; name: string; size: number }[];
  label: string;
  onDone?: () => void;
  onClear: () => void;
  /** Files in the list right now, for "Select all". */
  total: number;
  onSelectAll: () => void;
}) {
  const { busy, notice, run } = useZipDownload();
  const bytes = picked.reduce((n, f) => n + (f.size || 0), 0);
  const problem = picked.length ? zipLimitProblem(picked) : null;
  return (
    <div style={{ position: 'sticky', bottom: '8px', zIndex: 5, marginTop: '10px', padding: '10px 12px', borderRadius: '10px', background: 'var(--card)', border: '1px solid var(--accent, #2563eb)', boxShadow: '0 4px 16px rgba(0,0,0,0.25)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', fontSize: '13px' }}>
        <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>
          {picked.length ? `${picked.length} file${picked.length !== 1 ? 's' : ''} · ${formatBytes(bytes)}` : 'Tap files to pick them'}
        </span>
        {picked.length < total && <button onClick={onSelectAll} disabled={!!busy} style={btn()}>Select all {total}</button>}
        {picked.length > 0 && <button onClick={onClear} disabled={!!busy} style={btn()}>Clear</button>}
        <button
          disabled={!!busy || !picked.length || !!problem}
          onClick={async () => { if (await run(picked.map(f => ({ id: f.id, name: f.name, size: f.size })), label)) onDone?.(); }}
          style={{ ...btn(true, !!busy || !picked.length || !!problem), marginLeft: 'auto' }}
        >{busy || '⬇ Download zip'}</button>
      </div>
      {(problem || notice) && <div style={{ fontSize: '12px', color: problem ? 'var(--error)' : 'var(--text-muted)', marginTop: '6px' }}>{problem || notice}</div>}
    </div>
  );
}

interface TreeResponse {
  folder: { id: string; name: string };
  total: { files: number; bytes: number };
  folders: TreeNode[];
  files?: ZipEntry[];
}

/** A client folder and its sub-folders, each with a Zip button. */
export function FolderZipList({ folderId, folderName }: { folderId: string; folderName: string }) {
  const [tree, setTree] = useState<TreeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const { busy, notice, run } = useZipDownload();

  useEffect(() => {
    let live = true;
    setTree(null);
    setError(null);
    (async () => {
      try {
        const res = await apiFetch(`/api/client-files/tree?folder=${folderId}`);
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || 'Could not load the folders');
        if (live) setTree(json);
      } catch (e: any) {
        if (live) setError(e.message);
      }
    })();
    return () => { live = false; };
  }, [folderId]);

  const zip = async (sub: string | null, label: string) => {
    setRunning(sub ?? '');
    setError(null);
    try {
      const p = new URLSearchParams({ folder: folderId, files: '1' });
      if (sub) p.set('sub', sub);
      const res = await apiFetch(`/api/client-files/tree?${p.toString()}`);
      const json: TreeResponse & { error?: string } = await res.json();
      if (!res.ok) throw new Error(json.error || 'Could not list the files');
      await run(json.files || [], label);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setRunning(null);
    }
  };

  const tooBig = (n: { files: number; bytes: number }) => n.files > MAX_ZIP_FILES || n.bytes > MAX_ZIP_BYTES;

  const row = (key: string, sub: string | null, name: string, depth: number, n: { files: number; bytes: number }, bold = false) => (
    <div key={key} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '7px 0', paddingLeft: `${depth * 16}px`, borderTop: '1px solid var(--border)', fontSize: '12.5px' }}>
      <span>📁</span>
      <span style={{ fontWeight: bold ? 800 : 600, color: 'var(--text-primary)', minWidth: 0, overflowWrap: 'anywhere' }}>{name}</span>
      <span style={{ color: 'var(--text-muted)', fontSize: '11.5px', whiteSpace: 'nowrap' }}>{n.files.toLocaleString()} files · {formatBytes(n.bytes)}</span>
      {tooBig(n) ? (
        <span title="Too big for one zip; zip a sub-folder instead" style={{ marginLeft: 'auto', fontSize: '11px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>Too big to zip</span>
      ) : (
        <button
          disabled={!!busy || n.files === 0}
          onClick={() => zip(sub, sub ? `${folderName} – ${name}` : folderName)}
          style={{ ...btn(false, !!busy || n.files === 0), marginLeft: 'auto' }}
        >{busy && running === (sub ?? '') ? busy : '⬇ Zip'}</button>
      )}
    </div>
  );

  if (error && !tree) return <div style={{ fontSize: '12px', color: 'var(--error)' }}>{error}</div>;
  if (!tree) return <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Loading folders…</div>;
  return (
    <div>
      {row('__all', null, `All of ${tree.folder.name}`, 0, tree.total, true)}
      {tree.folders.map(n => row(n.path, n.path, n.name, n.depth, n, n.depth === 1))}
      {(notice || error) && <div style={{ fontSize: '12px', color: error ? 'var(--error)' : 'var(--text-muted)', marginTop: '6px' }}>{error || notice}</div>}
    </div>
  );
}
