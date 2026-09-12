'use client';

/**
 * Installer photos across every job.
 *
 * CNI photos used to be reachable one job at a time, so "show me everything
 * this crew shot last week" meant knowing which jobs to open first. This is
 * the cross-job view: filter by company, installer, VIN, angle and date,
 * click any thumbnail to page through the results full-screen.
 */

import { useState, useEffect, useCallback, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import PhotoLightbox, { type LightboxPhoto } from '@/components/PhotoLightbox';
import { deepLinks } from '@/lib/deep-links';

const TYPE_LABELS: Record<string, string> = {
  front: 'Front',
  back: 'Back',
  driver_side: 'Driver Side',
  passenger_side: 'Passenger Side',
  vin_plate: 'VIN Plate',
  detail: 'Detail / Close-up',
  other: 'Other',
};

const PAGE_SIZE = 60;

interface GalleryPhoto {
  id: string;
  url: string;
  photoType: string;
  uploadedAt: string;
  uploadedByName: string | null;
  jobId: string;
  jobNumber: string | null;
  jobTitle: string | null;
  companyName: string | null;
  vin: string | null;
  vehicle: string | null;
  prescreenVerdict: string | null;
  prescreenNotes: string | null;
}

function PhotoGallery() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { hasFeature, loading: authLoading } = useAuth();
  const supabase = createClient();

  const [photos, setPhotos] = useState<GalleryPhoto[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);

  // Filters. Company/installer seed from the query string so a record page
  // can link straight to "this crew's photos" (deepLinks.cniPhotos).
  const [companyId, setCompanyId] = useState(searchParams.get('company') || '');
  const [installerId, setInstallerId] = useState(searchParams.get('installer') || '');
  // The VIN box is debounced: it is the only free-text filter, and querying
  // per keystroke would fire a request (and a full count) for every letter
  // of a 17-character VIN.
  const [vinInput, setVinInput] = useState('');
  const [vin, setVin] = useState('');
  const [photoType, setPhotoType] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  // Filter dropdown sources.
  const [companies, setCompanies] = useState<{ id: string; name: string }[]>([]);
  const [installers, setInstallers] = useState<{ id: string; name: string }[]>([]);

  useEffect(() => {
    if (authLoading) return;
    if (!hasFeature('cni_admin')) { router.push('/home'); return; }
    loadFilterSources();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- once after auth
  }, [authLoading]);

  useEffect(() => {
    const t = setTimeout(() => setVin(vinInput), 350);
    return () => clearTimeout(t);
  }, [vinInput]);

  const loadFilterSources = async () => {
    const [{ data: companyRows }, { data: installerRows }] = await Promise.all([
      supabase.from('companies').select('id, name').order('name'),
      supabase.from('profiles').select('id, full_name, email')
        .or('role.eq.installer,roles.cs.{installer}').order('full_name'),
    ]);
    setCompanies((companyRows || []).map((c: any) => ({ id: c.id, name: c.name })));
    setInstallers((installerRows || []).map((p: any) => ({
      id: p.id, name: p.full_name || p.email || 'Installer',
    })));
  };

  const buildQuery = useCallback((offset: number) => {
    const params = new URLSearchParams();
    if (companyId) params.set('companyId', companyId);
    if (installerId) params.set('installerId', installerId);
    if (vin.trim()) params.set('vin', vin.trim());
    if (photoType) params.set('photoType', photoType);
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    params.set('limit', String(PAGE_SIZE));
    params.set('offset', String(offset));
    return params.toString();
  }, [companyId, installerId, vin, photoType, from, to]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/cni/photos?${buildQuery(0)}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
      setPhotos(body.photos || []);
      setTotal(body.total ?? null);
      setHasMore(!!body.hasMore);
    } catch (e: any) {
      // Say what broke: an empty grid reads as "no photos exist", which is
      // the wrong conclusion to draw from a failed request.
      setError(e?.message || 'Could not load photos');
      setPhotos([]);
      setTotal(null);
      setHasMore(false);
    }
    setLoading(false);
  }, [buildQuery]);

  useEffect(() => {
    if (authLoading || !hasFeature('cni_admin')) return;
    load();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- re-runs when a filter changes
  }, [authLoading, load]);

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const res = await fetch(`/api/cni/photos?${buildQuery(photos.length)}`);
      const body = await res.json();
      if (res.ok) {
        setPhotos(prev => [...prev, ...(body.photos || [])]);
        setHasMore(!!body.hasMore);
      }
    } catch { /* the page keeps what it already has */ }
    setLoadingMore(false);
  };

  const clearFilters = () => {
    setCompanyId(''); setInstallerId(''); setVinInput(''); setVin(''); setPhotoType(''); setFrom(''); setTo('');
  };
  const anyFilter = !!(companyId || installerId || vinInput.trim() || photoType || from || to);

  const shots: LightboxPhoto[] = photos.map(p => ({
    id: p.id,
    url: p.url,
    title: [p.vin, TYPE_LABELS[p.photoType] || p.photoType].filter(Boolean).join(' · '),
    subtitle: [
      p.jobNumber ? `${p.jobNumber}${p.jobTitle ? ` — ${p.jobTitle}` : ''}` : null,
      p.companyName,
      p.uploadedByName,
      new Date(p.uploadedAt).toLocaleString(),
    ].filter(Boolean).join(' · '),
  }));

  const inputStyle: React.CSSProperties = {
    padding: '8px 10px', borderRadius: '8px', fontSize: '12px',
    border: '1px solid var(--border)', background: 'var(--input-bg)',
    color: 'var(--text-body)', minWidth: 0,
  };

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
        <button onClick={() => router.push('/admin/cni')} style={{ fontSize: '20px', color: 'var(--text-muted)' }}>←</button>
        <div>
          <div style={{ fontSize: '18px', fontWeight: 800, color: 'var(--text-primary)' }}>Installer Photos</div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            Every job{total != null ? ` • ${total} photo${total !== 1 ? 's' : ''}${anyFilter ? ' matching' : ''}` : ''}
          </div>
        </div>
      </div>

      {/* Filters */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '8px',
        padding: '12px', borderRadius: '12px', marginBottom: '14px',
        background: 'var(--card)', border: '1px solid var(--border)',
      }}>
        <select value={companyId} onChange={e => setCompanyId(e.target.value)} style={inputStyle}>
          <option value="">All companies</option>
          {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select value={installerId} onChange={e => setInstallerId(e.target.value)} style={inputStyle}>
          <option value="">All installers</option>
          {installers.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}
        </select>
        <select value={photoType} onChange={e => setPhotoType(e.target.value)} style={inputStyle}>
          <option value="">All angles</option>
          {Object.entries(TYPE_LABELS).map(([v, label]) => <option key={v} value={v}>{label}</option>)}
        </select>
        <input
          type="search" value={vinInput} onChange={e => setVinInput(e.target.value)}
          placeholder="VIN (or last 6)" style={inputStyle}
        />
        <input type="date" value={from} onChange={e => setFrom(e.target.value)} title="From" style={inputStyle} />
        <input type="date" value={to} onChange={e => setTo(e.target.value)} title="To" style={inputStyle} />
        {anyFilter && (
          <button
            onClick={clearFilters}
            style={{ ...inputStyle, fontWeight: 700, color: 'var(--text-muted)', cursor: 'pointer' }}
          >✕ Clear filters</button>
        )}
      </div>

      {error && (
        <div style={{
          padding: '12px 14px', borderRadius: '10px', marginBottom: '12px',
          background: 'var(--error-bg)', border: '1px solid var(--error-border)',
          color: 'var(--error)', fontSize: '13px', fontWeight: 600,
        }}>
          Could not load photos: {error}
        </div>
      )}

      {/* Grid */}
      {loading ? (
        <div style={{ padding: '30px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>Loading…</div>
      ) : photos.length === 0 && !error ? (
        <div style={{
          padding: '30px', textAlign: 'center', borderRadius: '14px',
          background: 'var(--card)', border: '1px solid var(--border)',
        }}>
          <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: '8px', color: 'var(--text-muted)' }}>No Photos</div>
          <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
            {anyFilter ? 'No photos match these filters' : 'No installer photos have been uploaded yet'}
          </div>
        </div>
      ) : (
        <>
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '10px',
          }}>
            {photos.map((p, i) => (
              <div key={p.id} style={{
                borderRadius: '12px', overflow: 'hidden',
                background: 'var(--card)', border: '1px solid var(--border)',
              }}>
                <button
                  onClick={() => setLightboxIdx(i)}
                  title="View full screen"
                  style={{
                    display: 'block', width: '100%', height: '130px', padding: 0,
                    border: 'none', background: 'var(--input-bg)', cursor: 'zoom-in',
                  }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={p.url}
                    alt={`${p.vin || 'Vehicle'} ${TYPE_LABELS[p.photoType] || p.photoType}`}
                    loading="lazy"
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                    onError={e => { (e.target as HTMLImageElement).style.visibility = 'hidden'; }}
                  />
                </button>
                <div style={{ padding: '8px 10px' }}>
                  <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {p.vin ? (
                      <a
                        href={deepLinks.vehicleRecord(p.vin)}
                        title="Open this vehicle's record"
                        style={{ color: 'var(--text-primary)', textDecoration: 'underline', textDecorationStyle: 'dotted' }}
                      >…{p.vin.slice(-6)}</a>
                    ) : 'Job photo'} · {TYPE_LABELS[p.photoType] || p.photoType}
                  </div>
                  <div style={{ fontSize: '10px', color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {[p.companyName || p.uploadedByName, new Date(p.uploadedAt).toLocaleDateString()].filter(Boolean).join(' · ')}
                  </div>
                  {p.jobNumber && (
                    <button
                      onClick={() => router.push(`/admin/cni/jobs/${p.jobId}/photos`)}
                      style={{
                        marginTop: '4px', padding: 0, background: 'transparent', border: 'none',
                        fontSize: '10px', fontWeight: 700, color: 'var(--orange)', cursor: 'pointer',
                      }}
                    >{p.jobNumber} →</button>
                  )}
                </div>
              </div>
            ))}
          </div>

          {hasMore && (
            <button
              onClick={loadMore}
              disabled={loadingMore}
              style={{
                width: '100%', padding: '12px', borderRadius: '10px', marginTop: '14px',
                fontSize: '13px', fontWeight: 700, cursor: 'pointer',
                background: 'var(--card)', border: '1px solid var(--border)', color: 'var(--text-primary)',
              }}
            >{loadingMore ? 'Loading…' : `Load more (${photos.length}${total != null ? ` of ${total}` : ''})`}</button>
          )}
        </>
      )}

      <PhotoLightbox
        photos={shots}
        index={lightboxIdx}
        onClose={() => setLightboxIdx(null)}
        onIndex={setLightboxIdx}
      />

      <div style={{ height: '80px' }} />
    </div>
  );
}

export default function CniPhotosPage() {
  // useSearchParams needs a Suspense boundary in the app router.
  return (
    <Suspense fallback={<div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)' }}>Loading…</div>}>
      <PhotoGallery />
    </Suspense>
  );
}
