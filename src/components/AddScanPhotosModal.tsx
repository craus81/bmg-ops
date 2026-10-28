'use client';

/**
 * "+ Photo" on a Scans list row: put photos onto a VIN that was already
 * scanned. Craig, 2026-10-28: install photos get texted and emailed to BMG,
 * so they live on a computer or in Files, not in the phone camera. Drag them
 * in, ⬆ Choose photos, or paste (Cmd+V). Pictures only (HEIC becomes JPEG),
 * since the photo viewer can't show PDFs. Each one uploads as it's added.
 */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { closeOnEscape } from '@/lib/modal-escape';
import { imageFiles, useImagesDrop } from '@/lib/use-image-drop';
import { uploadScanPhoto, type ScanPhotoRow } from '@/lib/scan-photo-upload';

interface Item { key: string; name: string; url: string; state: 'uploading' | 'done' | 'error'; error?: string }

export default function AddScanPhotosModal({ scanId, vin, label, initialFiles, onAdded, onClose }: {
  scanId: string;
  vin: string;
  /** "2025 Ford Transit · ACX-1" — shown under the title. */
  label?: string;
  /** Files dropped straight onto the row: start on these. */
  initialFiles?: File[];
  onAdded: (rows: ScanPhotoRow[]) => void;
  onClose: () => void;
}) {
  const [items, setItems] = useState<Item[]>([]);
  const [skipped, setSkipped] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const onAddedRef = useRef(onAdded);
  onAddedRef.current = onAdded;
  const urls = useRef<string[]>([]);

  const add = (picked: File[]) => {
    const imgs = imageFiles(picked);
    if (imgs.length < picked.length) setSkipped(n => n + picked.length - imgs.length);
    for (const f of imgs) {
      const key = `${Date.now()}-${Math.random()}`;
      const url = URL.createObjectURL(f);
      urls.current.push(url);
      setItems(prev => [...prev, { key, name: f.name, url, state: 'uploading' }]);
      // One at a time, in the order they were added.
      queue.current = queue.current.then(async () => {
        const r = await uploadScanPhoto(f, [scanId]).catch((e: any) => ({ ok: false as const, error: e?.message || 'Upload failed' }));
        setItems(prev => prev.map(i => i.key !== key ? i : r.ok ? { ...i, state: 'done' } : { ...i, state: 'error', error: r.error }));
        if (r.ok) onAddedRef.current(r.rows);
      });
    }
  };

  const started = useRef(false);
  useEffect(() => {
    if (started.current || !initialFiles?.length) return;
    started.current = true;
    add(initialFiles);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => { urls.current.forEach(u => URL.revokeObjectURL(u)); }, []);

  const { dragging, dropProps } = useImagesDrop(add);
  const busy = items.some(i => i.state === 'uploading');
  const done = items.filter(i => i.state === 'done').length;
  const failed = items.filter(i => i.state === 'error');

  const btn = (primary: boolean): React.CSSProperties => ({
    padding: '10px 16px', borderRadius: '8px', fontSize: '13px', fontWeight: 800, cursor: 'pointer',
    border: primary ? 'none' : '1px solid var(--border)',
    background: primary ? '#22c55e' : 'var(--subtle-bg)', color: primary ? '#fff' : 'var(--text-primary)',
  });

  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      ref={closeOnEscape(busy ? undefined : onClose)}
      onClick={() => { if (!busy) onClose(); }}
      style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{ width: '100%', maxWidth: '520px', maxHeight: '100%', overflowY: 'auto', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', padding: '18px' }}
      >
        <div style={{ fontSize: '16px', fontWeight: 800, color: 'var(--text-primary)' }}>Add photos</div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px', fontFamily: 'monospace' }}>{vin}</div>
        {label && <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '1px' }}>{label}</div>}

        <div
          {...dropProps}
          onClick={() => fileRef.current?.click()}
          style={{
            marginTop: '14px', padding: '26px 14px', borderRadius: '10px', textAlign: 'center', cursor: 'pointer',
            border: `2px dashed ${dragging ? '#22c55e' : 'var(--border-strong, var(--border))'}`,
            background: dragging ? 'rgba(34,197,94,0.1)' : 'var(--subtle-bg)',
          }}
        >
          <div style={{ fontSize: '14px', fontWeight: 800, color: dragging ? '#22c55e' : 'var(--text-primary)' }}>
            {dragging ? 'Drop to add' : '⬆ Choose photos'}
          </div>
          <div className="drop-hint" style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>
            or drag them here from Finder, Photos, Messages or Mail, or paste (Cmd+V)
          </div>
        </div>
        <input
          ref={fileRef} type="file" accept="image/*,.heic,.heif" multiple hidden
          onChange={e => { const files = Array.from(e.target.files || []); e.target.value = ''; add(files); }}
        />

        {items.length > 0 && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))', gap: '8px', marginTop: '14px' }}>
            {items.map(i => (
              <div key={i.key} title={i.error || i.name} style={{ position: 'relative', aspectRatio: '1', borderRadius: '8px', overflow: 'hidden', background: '#fff', border: `1px solid ${i.state === 'error' ? '#ef4444' : 'var(--border)'}` }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={i.url} alt={i.name} style={{ width: '100%', height: '100%', objectFit: 'contain', opacity: i.state === 'uploading' ? 0.5 : 1 }} />
                <div style={{
                  position: 'absolute', left: 0, right: 0, bottom: 0, padding: '2px 4px', fontSize: '10px', fontWeight: 800, textAlign: 'center',
                  background: i.state === 'error' ? '#ef4444' : i.state === 'done' ? '#22c55e' : 'rgba(0,0,0,0.6)', color: '#fff',
                }}>
                  {i.state === 'uploading' ? 'Uploading…' : i.state === 'done' ? '✓ Added' : 'Failed'}
                </div>
              </div>
            ))}
          </div>
        )}

        {failed.length > 0 && (
          <div style={{ marginTop: '10px', color: '#ef4444', fontSize: '12px', fontWeight: 700 }}>
            {failed.length} photo{failed.length !== 1 ? 's' : ''} didn&apos;t upload: {failed[0].error}
          </div>
        )}
        {skipped > 0 && (
          <div style={{ marginTop: '6px', color: '#ef4444', fontSize: '12px', fontWeight: 700 }}>
            {skipped} file{skipped !== 1 ? 's were' : ' was'} skipped. Only photos can go on a scan.
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', marginTop: '16px' }}>
          <span style={{ fontSize: '12px', fontWeight: 700, color: busy ? 'var(--text-muted)' : '#22c55e' }}>
            {busy ? 'Uploading…' : done > 0 ? `✓ ${done} photo${done !== 1 ? 's' : ''} added` : ''}
          </span>
          <button onClick={onClose} disabled={busy} style={{ ...btn(true), opacity: busy ? 0.6 : 1 }}>Done</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
