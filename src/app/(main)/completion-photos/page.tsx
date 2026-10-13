'use client';

/**
 * Completion Photos — finished-work photos from every job, in one place.
 *
 * Shop completion photos, outside-installer (CNI) photos and scan photos
 * used to be reachable one vehicle or job at a time, so "grab a few good
 * shots of the Orkin vans to send them" meant knowing which jobs to open.
 * This is the cross-job view (owner ask 2026-10-13): search by customer,
 * job / SO / PO number or VIN, filter by where the photo came from and
 * when, then tick photos and download them as a zip, copy one link the
 * customer can open without logging in, or (on a phone) share them.
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import JSZip from 'jszip';
import { useAuth } from '@/components/AuthProvider';
import PhotoLightbox, { type LightboxPhoto } from '@/components/PhotoLightbox';
import { apiFetch } from '@/lib/api-client';
import { INTERNAL_STAFF_ROLES } from '@/lib/features';
import {
  COMPLETION_PHOTO_SOURCES, SOURCE_LABELS, numberedFileNames,
  type CompletionPhotoSource,
} from '@/lib/completion-photos';

const PAGE_SIZE = 60;

interface Photo {
  id: string;
  source: CompletionPhotoSource;
  url: string;
  downloadName: string;
  takenAt: string | null;
  customerName: string | null;
  vin: string | null;
  vehicle: string | null;
  jobLabel: string | null;
  link: string | null;
}

const SOURCE_COLORS: Record<CompletionPhotoSource, string> = {
  shop: '#2563eb',
  installer: '#8b5cf6',
  scan: '#f97316',
};

const fmtDate = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

const inputStyle: React.CSSProperties = {
  padding: '9px 10px', borderRadius: '8px', fontSize: '16px',
  background: 'var(--input-bg)', border: '1px solid var(--border-strong)', color: 'var(--text-primary)',
  minWidth: 0,
};

const barBtn = (primary = false): React.CSSProperties => ({
  padding: '9px 14px', borderRadius: '8px', fontSize: '13px', fontWeight: 800, cursor: 'pointer',
  background: primary ? 'var(--accent, #2563eb)' : 'transparent',
  color: primary ? '#fff' : 'var(--text-primary)',
  border: primary ? '1px solid var(--accent, #2563eb)' : '1px solid var(--border-strong)',
  whiteSpace: 'nowrap',
});

/** Fetch one photo's bytes through the staff download route. */
async function fetchPhotoBlob(p: Photo): Promise<Blob | null> {
  try {
    const res = await apiFetch(`${p.url}&format=json`);
    if (!res.ok) return null;
    const { url } = await res.json();
    // credentials omitted so R2's `*` CORS rule applies.
    const file = await fetch(url, { credentials: 'omit' });
    return file.ok ? await file.blob() : null;
  } catch {
    return null;
  }
}

export default function CompletionPhotosPage() {
  const router = useRouter();
  const { hasRole, loading: authLoading } = useAuth();
  const isStaff = INTERNAL_STAFF_ROLES.some(r => hasRole(r));

  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');
  const [source, setSource] = useState<CompletionPhotoSource | ''>('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const [photos, setPhotos] = useState<Photo[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);

  // Picked photos, kept across filter changes so you can pick from two
  // searches and send them together.
  const [selected, setSelected] = useState<Map<string, Photo>>(new Map());
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [shareLink, setShareLink] = useState<string | null>(null);
  const [readyFiles, setReadyFiles] = useState<File[] | null>(null);
  const reqId = useRef(0);

  // The search box is debounced: it is the only free-text filter.
  useEffect(() => {
    const t = setTimeout(() => setQ(qInput.trim()), 300);
    return () => clearTimeout(t);
  }, [qInput]);

  const buildQuery = useCallback((offset: number) => {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
    if (q) params.set('q', q);
    if (source) params.set('source', source);
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    return params.toString();
  }, [q, source, from, to]);

  useEffect(() => {
    if (authLoading || !isStaff) return;
    const id = ++reqId.current;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const res = await apiFetch(`/api/completion-photos?${buildQuery(0)}`);
        const json = await res.json();
        if (id !== reqId.current) return;
        if (!res.ok) throw new Error(json.error || 'Could not load photos');
        setPhotos(json.photos || []);
        setTotal(json.total ?? null);
        setHasMore(!!json.hasMore);
      } catch (e: any) {
        if (id === reqId.current) { setError(e.message); setPhotos([]); setTotal(null); setHasMore(false); }
      } finally {
        if (id === reqId.current) setLoading(false);
      }
    })();
  }, [buildQuery, authLoading, isStaff]);

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const res = await apiFetch(`/api/completion-photos?${buildQuery(photos.length)}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Could not load photos');
      setPhotos(prev => {
        const seen = new Set(prev.map(p => p.id));
        return [...prev, ...(json.photos || []).filter((p: Photo) => !seen.has(p.id))];
      });
      setHasMore(!!json.hasMore);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoadingMore(false);
    }
  };

  const toggle = (p: Photo) => {
    setReadyFiles(null);
    setShareLink(null);
    setSelected(prev => {
      const next = new Map(prev);
      if (next.has(p.id)) next.delete(p.id); else next.set(p.id, p);
      return next;
    });
  };
  const selectAllShown = () => {
    setReadyFiles(null);
    setShareLink(null);
    setSelected(prev => {
      const next = new Map(prev);
      for (const p of photos) next.set(p.id, p);
      return next;
    });
  };
  const clearSelection = () => { setSelected(new Map()); setShareLink(null); setReadyFiles(null); setNotice(null); };

  const picked = useMemo(() => [...selected.values()], [selected]);
  const pickedNames = useMemo(() => numberedFileNames(picked.map(p => ({
    customer_name: p.customerName, job_label: p.jobLabel, vin: p.vin,
    storage_path: p.downloadName,
  }))), [picked]);
  /** One customer's name when every picked photo is theirs — the zip's and the link's heading. */
  const pickedCustomer = useMemo(() => {
    const names = new Set(picked.map(p => (p.customerName || '').trim()).filter(Boolean));
    return names.size === 1 ? [...names][0] : null;
  }, [picked]);

  const fetchAll = async (): Promise<{ blob: Blob; name: string }[]> => {
    const out: { blob: Blob; name: string }[] = [];
    for (let i = 0; i < picked.length; i++) {
      setBusy(`Getting photo ${i + 1} of ${picked.length}…`);
      const blob = await fetchPhotoBlob(picked[i]);
      if (blob) out.push({ blob, name: pickedNames[i] });
    }
    return out;
  };

  const downloadZip = async () => {
    setNotice(null);
    const files = await fetchAll();
    if (files.length === 0) { setBusy(null); setNotice('Those photos could not be downloaded. Try again in a moment.'); return; }
    setBusy('Making the zip…');
    const zip = new JSZip();
    for (const f of files) zip.file(f.name, f.blob);
    const blob = await zip.generateAsync({ type: 'blob' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(pickedCustomer || 'Completion photos').replace(/[\\/:*?"<>|]+/g, ' ').trim()} – ${new Date().toISOString().slice(0, 10)}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    setBusy(null);
    setNotice(files.length < picked.length
      ? `Downloaded ${files.length} of ${picked.length}; ${picked.length - files.length} could not be fetched.`
      : `Downloaded ${files.length} photo${files.length !== 1 ? 's' : ''}.`);
  };

  const copyLink = async () => {
    setNotice(null);
    setBusy('Making the link…');
    try {
      const res = await apiFetch('/api/completion-photos/share', {
        method: 'POST',
        body: JSON.stringify({ ids: picked.map(p => p.id), title: pickedCustomer ? `${pickedCustomer} — vehicle photos` : undefined }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Could not make the link');
      setShareLink(json.url);
      try {
        await navigator.clipboard.writeText(json.url);
        setNotice('Link copied. Paste it into your email or text; the customer can view and download these photos without logging in.');
      } catch {
        setNotice('Link ready. Tap Copy to copy it.');
      }
    } catch (e: any) {
      setNotice(e.message);
    } finally {
      setBusy(null);
    }
  };

  const shareFiles = async (files: File[]) => {
    try {
      await navigator.share({ files, title: pickedCustomer ? `${pickedCustomer} photos` : 'Photos' });
      setReadyFiles(null);
    } catch (e: any) {
      // Safari wants a fresh tap after a slow download; offer one.
      if (e?.name === 'NotAllowedError') { setReadyFiles(files); setNotice('Photos ready. Tap Share again.'); }
    }
  };

  const share = async () => {
    setNotice(null);
    if (readyFiles) { await shareFiles(readyFiles); return; }
    const fetched = await fetchAll();
    setBusy(null);
    const files = fetched.map(f => new File([f.blob], f.name, { type: f.blob.type || 'image/jpeg' }));
    if (files.length === 0) { setNotice('Those photos could not be fetched. Try again in a moment.'); return; }
    if (navigator.canShare?.({ files })) { await shareFiles(files); return; }
    // No file sharing here (most desktops): fall back to the link.
    await copyLink();
  };

  const canShareFiles = typeof navigator !== 'undefined' && typeof navigator.canShare === 'function'
    && typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches;

  const anyFilter = !!(qInput || source || from || to);
  const clearFilters = () => { setQInput(''); setQ(''); setSource(''); setFrom(''); setTo(''); };

  const lightboxPhotos: LightboxPhoto[] = photos.map(p => ({
    id: p.id,
    url: p.url,
    title: [p.customerName, p.vehicle, p.vin ? `…${p.vin.slice(-6)}` : null].filter(Boolean).join(' · ') || 'Photo',
    subtitle: [SOURCE_LABELS[p.source], p.jobLabel, fmtDate(p.takenAt)].filter(Boolean).join(' · '),
  }));

  if (!authLoading && !isStaff) {
    return (
      <div style={{ padding: '40px 16px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '14px' }}>
        Completion Photos is for BMG staff.
      </div>
    );
  }

  return (
    <div style={{ padding: '16px', maxWidth: '1400px', margin: '0 auto', paddingBottom: selected.size > 0 ? '170px' : '40px' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '14px' }}>
        <button onClick={() => router.push('/more')} aria-label="Back" style={{ fontSize: '20px', color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer' }}>←</button>
        <div>
          <div style={{ fontSize: '18px', fontWeight: 800, color: 'var(--text-primary)' }}>Completion Photos</div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            Shop, installer and scan photos from every job{total != null ? ` · ${total.toLocaleString()} photo${total !== 1 ? 's' : ''}${anyFilter ? ' matching' : ''}` : ''}
          </div>
        </div>
      </div>

      {/* Filters */}
      <div style={{
        display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center',
        padding: '12px', borderRadius: '12px', marginBottom: '14px',
        background: 'var(--card)', border: '1px solid var(--border)',
      }}>
        <input
          type="search" value={qInput} onChange={e => setQInput(e.target.value)}
          placeholder="🔍 Customer, job, SO / PO # or VIN"
          style={{ ...inputStyle, flex: '2 1 240px' }}
        />
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
          {(['', ...COMPLETION_PHOTO_SOURCES] as const).map(s => {
            const on = source === s;
            return (
              <button
                key={s || 'all'}
                onClick={() => setSource(s)}
                style={{
                  padding: '7px 12px', borderRadius: '999px', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
                  background: on ? 'var(--accent, #2563eb)' : 'transparent',
                  color: on ? '#fff' : 'var(--text-secondary)',
                  border: `1px solid ${on ? 'var(--accent, #2563eb)' : 'var(--border-strong)'}`,
                }}
              >{s ? SOURCE_LABELS[s] : 'All'}</button>
            );
          })}
        </div>
        <input type="date" value={from} onChange={e => setFrom(e.target.value)} title="From" aria-label="From" style={{ ...inputStyle, flex: '1 1 140px' }} />
        <input type="date" value={to} onChange={e => setTo(e.target.value)} title="To" aria-label="To" style={{ ...inputStyle, flex: '1 1 140px' }} />
        {anyFilter && (
          <button onClick={clearFilters} style={{ ...inputStyle, fontSize: '13px', fontWeight: 700, color: 'var(--text-muted)', cursor: 'pointer' }}>✕ Clear</button>
        )}
      </div>

      {error && (
        <div style={{
          padding: '12px 14px', borderRadius: '10px', marginBottom: '12px',
          background: 'var(--error-bg)', border: '1px solid var(--error-border)',
          color: 'var(--error)', fontSize: '13px', fontWeight: 600,
        }}>Could not load photos: {error}</div>
      )}

      {/* Grid */}
      {loading ? (
        <div style={{ padding: '30px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>Loading…</div>
      ) : photos.length === 0 && !error ? (
        <div style={{ padding: '30px', textAlign: 'center', borderRadius: '14px', background: 'var(--card)', border: '1px solid var(--border)', fontSize: '13px', color: 'var(--text-muted)' }}>
          {anyFilter ? 'No photos match these filters' : 'No completion photos yet'}
        </div>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: '10px' }}>
            {photos.map((p, i) => {
              const on = selected.has(p.id);
              return (
                <div key={p.id} style={{
                  borderRadius: '12px', overflow: 'hidden', background: 'var(--card)',
                  border: '1px solid var(--border)',
                  outline: on ? '2px solid var(--accent, #2563eb)' : 'none', outlineOffset: '-1px',
                }}>
                  <div style={{ position: 'relative', height: '130px', background: 'var(--input-bg)' }}>
                    <button
                      onClick={() => setLightboxIdx(i)}
                      title="View full screen"
                      style={{ display: 'block', width: '100%', height: '100%', padding: 0, border: 'none', background: 'none', cursor: 'zoom-in' }}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={p.url}
                        alt={[p.customerName, p.vin].filter(Boolean).join(' ') || 'Completion photo'}
                        loading="lazy"
                        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                        onError={e => { (e.target as HTMLImageElement).style.visibility = 'hidden'; }}
                      />
                    </button>
                    <button
                      onClick={() => toggle(p)}
                      aria-label={on ? 'Unselect photo' : 'Select photo'}
                      aria-pressed={on}
                      style={{
                        position: 'absolute', top: '6px', left: '6px', width: '28px', height: '28px', borderRadius: '7px',
                        border: `2px solid ${on ? 'var(--accent, #2563eb)' : '#fff'}`,
                        background: on ? 'var(--accent, #2563eb)' : 'rgba(0,0,0,0.3)',
                        color: '#fff', fontSize: '15px', fontWeight: 900, cursor: 'pointer', padding: 0,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                      }}
                    >{on ? '✓' : ''}</button>
                    <span style={{
                      position: 'absolute', top: '8px', right: '8px', fontSize: '10px', fontWeight: 800,
                      padding: '2px 7px', borderRadius: '999px', color: '#fff', background: SOURCE_COLORS[p.source],
                    }}>{SOURCE_LABELS[p.source]}</span>
                  </div>
                  <div style={{ padding: '8px 10px' }}>
                    <div style={{ fontSize: '12px', fontWeight: 800, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {p.customerName || 'No customer'}
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {[p.vehicle, p.vin ? `…${p.vin.slice(-6)}` : null].filter(Boolean).join(' · ') || '—'}
                    </div>
                    <div style={{ fontSize: '10px', color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {p.jobLabel && p.link ? (
                        <a href={p.link} style={{ color: 'var(--orange)', fontWeight: 700, textDecoration: 'none' }}>{p.jobLabel} →</a>
                      ) : p.jobLabel ? (
                        <span style={{ fontWeight: 700 }}>{p.jobLabel}</span>
                      ) : p.link ? (
                        <a href={p.link} style={{ color: 'var(--orange)', fontWeight: 700, textDecoration: 'none' }}>Open →</a>
                      ) : null}
                      {(p.jobLabel || p.link) && p.takenAt ? ' · ' : ''}{fmtDate(p.takenAt)}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {hasMore && (
            <div style={{ textAlign: 'center', marginTop: '14px' }}>
              <button onClick={loadMore} disabled={loadingMore} style={barBtn()}>
                {loadingMore ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
        </>
      )}

      {/* Selection bar */}
      {selected.size > 0 && (
        <div style={{
          position: 'fixed', left: '12px', right: '12px', bottom: 'calc(76px + env(safe-area-inset-bottom, 0px))', zIndex: 50,
          maxWidth: '1100px', margin: '0 auto',
          padding: '12px 14px', borderRadius: '12px',
          background: 'var(--card)', border: '1px solid var(--accent, #2563eb)',
          boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 140px', fontSize: '14px', fontWeight: 800, color: 'var(--text-primary)' }}>
              {busy || `${selected.size} photo${selected.size !== 1 ? 's' : ''} selected`}
            </div>
            <button onClick={selectAllShown} disabled={!!busy} style={barBtn()}>Select all shown</button>
            <button onClick={copyLink} disabled={!!busy} style={barBtn()}>🔗 Copy link</button>
            {canShareFiles && (
              <button onClick={share} disabled={!!busy} style={barBtn()}>📤 Share</button>
            )}
            <button onClick={downloadZip} disabled={!!busy} style={barBtn(true)}>⬇ Download zip</button>
            <button onClick={clearSelection} disabled={!!busy} aria-label="Clear selection" style={barBtn()}>✕</button>
          </div>
          {(notice || shareLink) && (
            <div style={{ marginTop: '8px', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              {shareLink && (
                <>
                  <input readOnly value={shareLink} onFocus={e => e.target.select()} style={{ ...inputStyle, fontSize: '12px', flex: '1 1 220px', padding: '6px 8px' }} />
                  <button
                    onClick={async () => {
                      try { await navigator.clipboard.writeText(shareLink); setNotice('Link copied.'); } catch { setNotice('Select the link and copy it.'); }
                    }}
                    style={barBtn()}
                  >Copy</button>
                </>
              )}
              {notice && <div style={{ flexBasis: '100%', fontSize: '12px', color: 'var(--text-muted)' }}>{notice}</div>}
            </div>
          )}
        </div>
      )}

      <PhotoLightbox
        photos={lightboxPhotos}
        index={lightboxIdx}
        onClose={() => setLightboxIdx(null)}
        onIndex={setLightboxIdx}
      />
    </div>
  );
}
