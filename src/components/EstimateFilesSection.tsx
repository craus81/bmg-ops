'use client';

/**
 * Pictures & files on the estimate (Craig, 2026-10-22, thread "Approval
 * email pictures on the estimate"): Valarie sent an approval email with
 * pictures and they were nowhere on the estimate. They were kept
 * (estimate_files) but only the email screens showed them.
 *
 * Thumbnails of everything added on the estimate, from here or from any of
 * its email screens; tap a picture to see it full size (zoom, Print,
 * Download). Each file says which emails it went out on and whether its
 * copy reached the customer's Dropbox folder (src/lib/estimate-file-dropbox.ts).
 * The same files are in the customer's Client Files under From Estimates.
 * Files added here show on the email screens too, unticked.
 */

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { useDialog } from '@/components/DialogProvider';
import PhotoLightbox from '@/components/PhotoLightbox';
import { uploadRecordFile } from '@/lib/record-file-upload';
import { formatBytes } from '@/lib/client-files';
import { sentTags, shortDate, type FileSend } from '@/lib/estimate-file-tags';

interface EstimateFile {
  id: string;
  file_name: string;
  content_type: string | null;
  size_bytes: number | null;
  public_url: string | null;
  download_url?: string;
  created_at: string | null;
  sent_on?: FileSend[] | null;
  dropbox_path?: string | null;
  dropbox_error?: string | null;
  uploader?: { full_name: string | null } | null;
}

const IMAGE_RE = /\.(jpe?g|png|gif|webp|heic|heif)$/i;
const isImage = (f: EstimateFile) => IMAGE_RE.test(f.file_name) || (f.content_type || '').startsWith('image/');
const tag = (tone: 'blue' | 'green' | 'grey'): CSSProperties => ({
  fontSize: '10.5px', fontWeight: 700, borderRadius: '4px', padding: '1px 6px', whiteSpace: 'nowrap',
  background: tone === 'blue' ? 'rgba(59,130,246,0.15)' : tone === 'green' ? 'rgba(22,163,74,0.15)' : 'rgba(148,163,184,0.18)',
  color: tone === 'blue' ? '#60a5fa' : tone === 'green' ? 'var(--success, #16a34a)' : 'var(--text-muted)',
});

const smallBtn: CSSProperties = {
  padding: '3px 8px', borderRadius: '6px', fontSize: '11px', fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap',
  background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border-strong)', textDecoration: 'none',
};

export default function EstimateFilesSection({ estimateId, labelStyle }: { estimateId: string; labelStyle?: CSSProperties }) {
  const dialog = useDialog();
  const [files, setFiles] = useState<EstimateFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const [viewing, setViewing] = useState<number | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/estimates/${estimateId}/files`);
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Could not load the files');
      setFiles(data.files || []);
      setError(null);
    } catch (e: any) {
      setError(e.message);
      setFiles(prev => prev ?? []);
    }
  }, [estimateId]);

  useEffect(() => { setFiles(null); load(); }, [load]);

  const add = async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    setError(null);
    const failed: string[] = [];
    for (const file of Array.from(list)) {
      setUploading(file.name);
      const res = await uploadRecordFile(`/api/estimates/${estimateId}/files`, {}, file);
      if (res.error || !res.file) failed.push(`${file.name}: ${res.error || 'upload failed'}`);
    }
    setUploading(null);
    if (input.current) input.current.value = '';
    await load();
    if (failed.length) setError(`Could not add ${failed.join('; ')}`);
  };

  const remove = async (f: EstimateFile) => {
    const ok = await dialog.confirm(
      `Remove ${f.file_name} from the estimate? It won't be offered on future emails, and it leaves From Estimates in Client Files. A copy already in Dropbox stays there.`,
      { destructive: true, confirmLabel: 'Remove' },
    );
    if (!ok) return;
    try {
      const res = await fetch(`/api/estimates/${estimateId}/files?fileId=${f.id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'unknown error');
      setViewing(null);
      await load();
    } catch (e: any) {
      setError(`Could not remove ${f.file_name}: ${e.message}`);
    }
  };

  const photos = (files || []).filter(isImage);

  return (
    <div id="est-files" style={{ marginBottom: '12px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: '6px' }}>
        <div style={labelStyle}>Pictures &amp; Files{files && files.length ? ` (${files.length})` : ''}</div>
        <button
          type="button" disabled={!!uploading} onClick={() => input.current?.click()}
          style={{ padding: '4px 10px', borderRadius: '6px', fontSize: '11px', fontWeight: 800, cursor: uploading ? 'default' : 'pointer', background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.3)', color: '#60a5fa', opacity: uploading ? 0.6 : 1 }}
        >{uploading ? `Adding ${uploading}…` : '+ Add pictures'}</button>
        <input ref={input} type="file" multiple hidden onChange={e => add(e.target.files)} />
      </div>

      {files === null ? (
        <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Loading…</div>
      ) : files.length === 0 ? (
        <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
          No pictures or files yet. Anything added here or on Send for Approval, Email PDF or Follow Up shows up here.
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: '10px' }}>
          {files.map(f => {
            const sent = sentTags(f.sent_on);
            const meta = [shortDate(f.created_at) && `Added ${shortDate(f.created_at)}`, f.uploader?.full_name ? `by ${f.uploader.full_name.split(' ')[0]}` : '', f.size_bytes ? formatBytes(f.size_bytes) : '']
              .filter(Boolean).join(' ');
            return (
              <div key={f.id} style={{ display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 }}>
                {isImage(f) && f.public_url ? (
                  <button
                    type="button" onClick={() => setViewing(photos.findIndex(p => p.id === f.id))} aria-label={`View ${f.file_name}`}
                    style={{ padding: 0, border: '1px solid var(--border)', borderRadius: '8px', overflow: 'hidden', aspectRatio: '4 / 3', background: 'var(--card)', cursor: 'zoom-in' }}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={f.public_url} alt="" loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                  </button>
                ) : (
                  <a
                    href={f.public_url || f.download_url || '#'} target="_blank" rel="noopener noreferrer"
                    style={{ aspectRatio: '4 / 3', borderRadius: '8px', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: '13px', color: 'var(--text-secondary)', background: 'var(--card)', textDecoration: 'none' }}
                  >{(f.file_name.split('.').pop() || 'FILE').toUpperCase().slice(0, 4)}</a>
                )}
                <div title={f.file_name} style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.file_name}</div>
                {meta && <div style={{ fontSize: '10.5px', color: 'var(--text-muted)' }}>{meta}</div>}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '3px' }}>
                  {sent.map(t => <span key={t} style={tag('blue')}>{t}</span>)}
                  {f.dropbox_path
                    ? <span style={tag('green')} title={f.dropbox_path}>In Dropbox</span>
                    : !f.dropbox_error && <span style={tag('grey')} title="Copied once the customer has a Dropbox client folder linked. It's in Client Files under From Estimates either way.">Not in Dropbox yet</span>}
                </div>
                {f.dropbox_error && !f.dropbox_path && (
                  <div style={{ fontSize: '10.5px', color: 'var(--error)', fontWeight: 600 }}>Not copied to Dropbox: {f.dropbox_error}</div>
                )}
                <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                  {f.download_url && <a href={f.download_url} style={smallBtn}>⬇ Download</a>}
                  <button type="button" onClick={() => remove(f)} style={{ ...smallBtn, color: 'var(--error)' }}>Remove</button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {error && <div style={{ fontSize: '12px', color: 'var(--error)', marginTop: '6px', fontWeight: 600 }}>{error}</div>}

      <PhotoLightbox
        photos={photos.map(p => ({
          id: p.id, url: p.public_url!, downloadUrl: p.download_url,
          title: p.file_name, subtitle: sentTags(p.sent_on).join(' · ') || null,
        }))}
        index={viewing}
        onClose={() => setViewing(null)}
        onIndex={setViewing}
        printHeading="Estimate pictures"
      />
    </div>
  );
}
