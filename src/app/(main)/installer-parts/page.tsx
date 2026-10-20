'use client';

/**
 * Installer Parts — the parts list for techs and outside installers, with
 * no money in it (Craig, 2026-10-20: "a parts catalog for installers with no
 * pricing information").
 *
 * The full Parts Catalog hides prices on screen, but the price is still in
 * the data the page downloads. This page reads /api/parts/installer, which
 * never selects a price, cost, margin, vendor or pay column, so there is
 * nothing to find. Each part shows its number, name, catalog photo,
 * description and labor hours; opening one adds its install files and the
 * installed photos from past jobs (in the shared viewer: arrows, zoom,
 * print).
 */

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useRequireFeature } from '@/components/AuthProvider';
import InstalledPhotosGrid from '@/components/InstalledPhotosGrid';
import ProofViewer from '@/components/ProofViewer';
import { apiFetch } from '@/lib/api-client';
import { storage } from '@/lib/storage';
import { theme } from '@/lib/theme';
import { matchesPartSearch } from '@/lib/installer-parts';

interface InstallerPart {
  id: string;
  item_number: string;
  display_name: string | null;
  description: string | null;
  catalog: 'upfit' | 'graphics' | null;
  labor_hours: number | null;
  image_path: string | null;
  marketing_description: string | null;
}

interface PartFile {
  id: string;
  name: string;
  fileName: string;
  fileType: string | null;
  url: string;
}

const SHOW_MAX = 100;

function laborLabel(h: number | null): string {
  if (h == null) return '';
  if (h === 0) return 'No labor';
  return `${h}h`;
}

export default function InstallerPartsPage() {
  const router = useRouter();
  const { loading: gateLoading, allowed } = useRequireFeature('installer_parts');
  const [parts, setParts] = useState<InstallerPart[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [catalog, setCatalog] = useState<'upfit' | 'graphics'>('upfit');
  const [openId, setOpenId] = useState<string | null>(null);
  const [files, setFiles] = useState<Record<string, PartFile[] | 'loading' | { error: string }>>({});
  const [viewing, setViewing] = useState<PartFile | null>(null);

  useEffect(() => {
    if (!allowed) return;
    (async () => {
      try {
        const res = await apiFetch('/api/parts/installer');
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
        setParts(body.parts || []);
      } catch (e: any) {
        setError(`Could not load parts: ${e?.message || 'unknown error'}. Reopen this page to try again.`);
      }
      setLoading(false);
    })();
  }, [allowed]);

  const shown = useMemo(() => {
    return parts.filter(p => (p.catalog || 'upfit') === catalog && matchesPartSearch(p, q));
  }, [parts, catalog, q]);

  const openPart = async (p: InstallerPart) => {
    if (openId === p.id) { setOpenId(null); return; }
    setOpenId(p.id);
    if (files[p.id] && files[p.id] !== 'loading' && !('error' in (files[p.id] as any))) return;
    setFiles(f => ({ ...f, [p.id]: 'loading' }));
    try {
      const res = await apiFetch(`/api/parts/installer?partId=${encodeURIComponent(p.id)}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
      setFiles(f => ({ ...f, [p.id]: body.files || [] }));
    } catch (e: any) {
      setFiles(f => ({ ...f, [p.id]: { error: `Could not load files: ${e?.message || 'unknown error'}` } }));
    }
  };

  if (gateLoading || !allowed) return null;

  const tab = (id: 'upfit' | 'graphics', label: string) => (
    <button
      type="button"
      onClick={() => { setCatalog(id); setOpenId(null); }}
      style={{
        padding: '6px 14px', borderRadius: '8px', fontSize: '13px', fontWeight: 700, cursor: 'pointer',
        background: catalog === id ? theme.accent : 'transparent',
        color: catalog === id ? '#fff' : theme.textMuted,
        border: `1px solid ${catalog === id ? theme.accent : theme.border}`,
      }}
    >{label}</button>
  );

  return (
    <div style={{ padding: '16px', maxWidth: '900px', margin: '0 auto', paddingBottom: '80px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '14px' }}>
        <button onClick={() => router.push('/more')} aria-label="Back" style={{ fontSize: '20px', color: theme.textMuted, background: 'none', border: 'none', cursor: 'pointer' }}>←</button>
        <div>
          <div style={{ fontSize: '18px', fontWeight: 800, color: theme.textPrimary }}>Parts</div>
          <div style={{ fontSize: '12px', color: theme.textMuted }}>Part photos, install files and labor hours</div>
        </div>
      </div>

      <input
        id="installer-parts-search"
        type="search"
        value={q}
        onChange={e => setQ(e.target.value)}
        placeholder="Search part number or name…"
        style={{
          width: '100%', boxSizing: 'border-box', padding: '10px 12px', borderRadius: '10px', fontSize: '16px',
          background: theme.inputBg, border: `1px solid ${theme.border}`, color: theme.textPrimary, marginBottom: '10px',
        }}
      />
      <div style={{ display: 'flex', gap: '6px', marginBottom: '12px' }}>
        {tab('upfit', 'Upfit')}
        {tab('graphics', 'Graphics')}
      </div>

      {error && (
        <div style={{ padding: '10px 12px', borderRadius: '8px', background: theme.errorBg, border: `1px solid ${theme.errorBorder}`, color: theme.error, fontSize: '13px', fontWeight: 600, marginBottom: '12px' }}>
          {error}
        </div>
      )}
      {loading && !error && <div style={{ fontSize: '13px', color: theme.textMuted }}>Loading parts…</div>}
      {!loading && !error && shown.length === 0 && (
        <div style={{ fontSize: '13px', color: theme.textMuted }}>
          {q.trim() ? `No ${catalog} parts match "${q.trim()}".` : `No ${catalog} parts.`}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {shown.slice(0, SHOW_MAX).map(p => {
          const isOpen = openId === p.id;
          const img = p.image_path ? storage.from('photos').getPublicUrl(p.image_path).data.publicUrl : null;
          const fileState = files[p.id];
          return (
            <div key={p.id} style={{ borderTop: `1px solid ${theme.border}` }}>
              <button
                type="button"
                onClick={() => openPart(p)}
                aria-expanded={isOpen}
                style={{
                  width: '100%', display: 'grid', gridTemplateColumns: '52px 1fr auto', gap: '10px', alignItems: 'center',
                  padding: '10px 0', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left',
                }}
              >
                {img ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={img} alt="" style={{ width: '52px', height: '52px', objectFit: 'cover', borderRadius: '8px', background: 'var(--subtle-bg)' }} />
                ) : (
                  <div style={{ width: '52px', height: '52px', borderRadius: '8px', background: 'var(--subtle-bg)' }} />
                )}
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: '14px', fontWeight: 800, color: theme.textPrimary, overflowWrap: 'anywhere' }}>{p.item_number}</div>
                  <div style={{ fontSize: '12px', color: theme.textSecondary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {p.display_name || p.description || ''}
                  </div>
                </div>
                <span style={{ fontSize: '12px', fontWeight: 700, color: '#a78bfa' }}>{laborLabel(p.labor_hours)}</span>
              </button>

              {isOpen && (
                <div style={{ padding: '0 0 14px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  {img && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={img} alt={p.item_number} style={{ maxWidth: '100%', maxHeight: '320px', objectFit: 'contain', borderRadius: '10px', alignSelf: 'flex-start', background: 'var(--subtle-bg)' }} />
                  )}
                  {(p.marketing_description || p.description) && (
                    <div style={{ fontSize: '13px', color: theme.textSecondary, whiteSpace: 'pre-wrap' }}>
                      {p.marketing_description || p.description}
                    </div>
                  )}
                  <div>
                    <div style={{ fontSize: '10px', fontWeight: 700, color: theme.textMuted, textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: '6px' }}>Install files</div>
                    {fileState === 'loading' || fileState === undefined ? (
                      <div style={{ fontSize: '12px', color: theme.textMuted }}>Loading…</div>
                    ) : 'error' in (fileState as any) ? (
                      <div style={{ fontSize: '12px', color: theme.error }}>{(fileState as { error: string }).error}</div>
                    ) : (fileState as PartFile[]).length === 0 ? (
                      <div style={{ fontSize: '12px', color: theme.textMuted }}>No files on this part.</div>
                    ) : (
                      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                        {(fileState as PartFile[]).map(f => (
                          <button
                            key={f.id}
                            type="button"
                            onClick={() => setViewing(f)}
                            style={{
                              padding: '7px 10px', borderRadius: '8px', fontSize: '12px', fontWeight: 600, cursor: 'pointer',
                              background: 'var(--subtle-bg)', border: `1px solid ${theme.border}`, color: '#60a5fa',
                              maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                            }}
                          >{f.name}</button>
                        ))}
                      </div>
                    )}
                  </div>
                  <InstalledPhotosGrid partNumber={p.item_number} />
                </div>
              )}
            </div>
          );
        })}
      </div>
      {shown.length > SHOW_MAX && (
        <div style={{ fontSize: '12px', color: theme.textMuted, padding: '10px 0' }}>
          Showing the first {SHOW_MAX} of {shown.length.toLocaleString()}. Type more of the part number or name to narrow it down.
        </div>
      )}

      {viewing && (
        <ProofViewer url={viewing.url} filename={viewing.fileName} noun="file" onClose={() => setViewing(null)} />
      )}
    </div>
  );
}
