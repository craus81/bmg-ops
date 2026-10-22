'use client';

/**
 * The two FleetSuite folders in a customer's Client Files (Craig,
 * 2026-10-22, thread "Approval email pictures on the estimate"): "From
 * Estimates" (pictures and files added on the customer's estimates, one
 * folder per estimate) and "Completion Photos" (one folder per job). They
 * come from FleetSuite's own storage, so every customer has them, Dropbox
 * folder or not. Tap a folder to go in, a picture to see it full size.
 *
 * Shown above the Dropbox folders on the customer page (ClientFilesSection)
 * and on More → Client Files when a customer is picked.
 * Reads GET /api/client-files/fleetsuite.
 */

import { useEffect, useState, type CSSProperties } from 'react';
import { apiFetch } from '@/lib/api-client';
import { formatBytes } from '@/lib/client-files';
import { FLEETSUITE_FOLDER_NAMES, type FleetSuiteFolderKey, type FsFile, type FsSubFolder } from '@/lib/client-files-fleetsuite';
import { fmtFileDate } from '@/components/ClientFileRow';
import PhotoLightbox from '@/components/PhotoLightbox';

interface Summary {
  estimates: { folders: number; files: number };
  completion: { folders: number; files: number } | null;
}

interface Loc { folder: FleetSuiteFolderKey | null; sub: FsSubFolder | null }

const crumbBtn: CSSProperties = {
  background: 'none', border: 'none', padding: '3px 4px', borderRadius: '6px', cursor: 'pointer',
  color: '#60a5fa', fontWeight: 700, fontSize: 'inherit',
};

const smallBtn: CSSProperties = {
  padding: '4px 9px', borderRadius: '8px', fontSize: '12px', fontWeight: 800, whiteSpace: 'nowrap',
  background: 'transparent', color: 'var(--text-primary)', border: '1px solid var(--border-strong)', textDecoration: 'none',
};

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

export default function FleetSuiteClientFolders({ customerId, compact = true }: { customerId: string; compact?: boolean }) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loc, setLoc] = useState<Loc>({ folder: null, sub: null });
  const [folders, setFolders] = useState<FsSubFolder[] | null>(null);
  const [files, setFiles] = useState<FsFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<number | null>(null);

  useEffect(() => { setLoc({ folder: null, sub: null }); }, [customerId]);

  useEffect(() => {
    let live = true;
    setError(null);
    setFolders(null);
    setFiles(null);
    (async () => {
      try {
        const p = new URLSearchParams({ customer: customerId });
        if (loc.folder) p.set('folder', loc.folder);
        if (loc.sub) p.set('sub', loc.sub.key);
        const res = await apiFetch(`/api/client-files/fleetsuite?${p.toString()}`);
        const json = await res.json();
        if (!live) return;
        if (!res.ok) throw new Error(json.error || 'Could not load the FleetSuite folders');
        if (!loc.folder) setSummary(json);
        else if (!loc.sub) setFolders(json.folders || []);
        else setFiles(json.files || []);
      } catch (e: any) {
        if (live) setError(e.message);
      }
    })();
    return () => { live = false; };
  }, [customerId, loc]);

  const row = (key: string, name: string, meta: string, open: () => void) => (
    <div
      key={key} role="button" tabIndex={0} onClick={open}
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
      <span aria-hidden style={{ color: 'var(--text-muted)', fontSize: '18px', flexShrink: 0 }}>›</span>
    </div>
  );

  const crumbs: { label: string; to: Loc | null }[] = [];
  if (loc.folder) {
    crumbs.push({ label: 'FleetSuite', to: { folder: null, sub: null } });
    crumbs.push({ label: FLEETSUITE_FOLDER_NAMES[loc.folder], to: loc.sub ? { folder: loc.folder, sub: null } : null });
    if (loc.sub) crumbs.push({ label: loc.sub.name, to: null });
  }

  const photos = (files || []).filter(f => f.isImage);

  return (
    <div style={{ marginBottom: '10px' }}>
      {crumbs.length > 0 && (
        <nav aria-label="Folder path" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '2px', fontSize: compact ? '12.5px' : '13.5px', marginBottom: '6px', minWidth: 0 }}>
          {crumbs.map((c, i) => (
            <span key={i} style={{ display: 'inline-flex', alignItems: 'center', minWidth: 0 }}>
              {i > 0 && <span style={{ color: 'var(--text-muted)', padding: '0 2px' }}>›</span>}
              {c.to
                ? <button onClick={() => setLoc(c.to!)} style={crumbBtn}>{i === 0 ? '📁 ' : ''}{c.label}</button>
                : <span style={{ fontWeight: 800, color: 'var(--text-primary)', padding: '3px 4px', overflowWrap: 'anywhere' }}>{c.label}</span>}
            </span>
          ))}
        </nav>
      )}

      {!loc.folder ? (
        summary ? (
          <>
            {row('estimates', FLEETSUITE_FOLDER_NAMES.estimates,
              summary.estimates.files
                ? `FleetSuite · ${plural(summary.estimates.folders, 'estimate')} · ${plural(summary.estimates.files, 'file')}`
                : 'FleetSuite · nothing added on an estimate yet',
              () => setLoc({ folder: 'estimates', sub: null }))}
            {summary.completion && row('completion', FLEETSUITE_FOLDER_NAMES.completion,
              summary.completion.files
                ? `FleetSuite · ${plural(summary.completion.folders, 'job')} · ${plural(summary.completion.files, 'photo')}`
                : 'FleetSuite · no completion photos yet',
              () => setLoc({ folder: 'completion', sub: null }))}
          </>
        ) : !error && <div style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '8px 0' }}>Loading…</div>
      ) : !loc.sub ? (
        folders === null ? (
          !error && <div style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '8px 0' }}>Loading…</div>
        ) : folders.length === 0 ? (
          <div style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '8px 0' }}>Nothing in this folder yet.</div>
        ) : folders.map(f => row(
          f.key, f.name,
          [plural(f.files, loc.folder === 'completion' ? 'photo' : 'file'), f.bytes ? formatBytes(f.bytes) : '', fmtFileDate(f.latest)].filter(Boolean).join(' · '),
          () => setLoc({ folder: loc.folder, sub: f }),
        ))
      ) : files === null ? (
        !error && <div style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '8px 0' }}>Loading…</div>
      ) : files.length === 0 ? (
        <div style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '8px 0' }}>Nothing in this folder yet.</div>
      ) : (
        <>
          {files[0]?.link && (
            <a href={files[0].link} style={{ display: 'inline-block', fontSize: '12px', fontWeight: 700, color: '#60a5fa', textDecoration: 'none', marginBottom: '8px' }}>
              {loc.folder === 'estimates' ? 'Open the estimate →' : 'Open the job →'}
            </a>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: '10px' }}>
            {files.map(f => (
              <div key={f.id} style={{ display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 }}>
                {f.isImage ? (
                  <button
                    onClick={() => setViewing(photos.findIndex(p => p.id === f.id))}
                    aria-label={`View ${f.name}`}
                    style={{ padding: 0, border: '1px solid var(--border)', borderRadius: '8px', overflow: 'hidden', aspectRatio: '4 / 3', background: 'var(--card)', cursor: 'zoom-in' }}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={f.url} alt="" loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                  </button>
                ) : (
                  <a
                    href={f.url} target="_blank" rel="noopener noreferrer"
                    style={{ aspectRatio: '4 / 3', borderRadius: '8px', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: '13px', color: 'var(--text-secondary)', background: 'var(--card)', textDecoration: 'none' }}
                  >{(f.name.split('.').pop() || 'FILE').toUpperCase().slice(0, 4)}</a>
                )}
                <div style={{ fontSize: '11.5px', fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={f.name}>{f.name}</div>
                <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                  <a href={f.downloadUrl} style={smallBtn}>⬇ Download</a>
                </div>
              </div>
            ))}
          </div>
          <PhotoLightbox
            photos={photos.map(p => ({ id: p.id, url: p.url, downloadUrl: p.downloadUrl, title: p.name, subtitle: p.subtitle }))}
            index={viewing}
            onClose={() => setViewing(null)}
            onIndex={setViewing}
            printHeading={loc.sub.name}
          />
        </>
      )}
      {error && <div style={{ fontSize: '12px', color: 'var(--error)', marginTop: '6px' }}>{error}</div>}
    </div>
  );
}
