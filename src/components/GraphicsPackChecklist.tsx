'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/components/AuthProvider';
import { apiFetch } from '@/lib/api-client';
import { storage, storageDownloadUrl } from '@/lib/storage';
import {
  blockedFromChecking, lineState, packProgress, quantityFlag, type PackItem,
} from '@/lib/pack-checklist';

/**
 * The pack & ship bench (R6-4). Replaces the printed sheet somebody ticked
 * with a pen: per-line pack + verify stamps by two different people, a
 * quantity confirm that surfaces short counts instead of swallowing them,
 * and a photo per line — the evidence that settles "a piece was missing"
 * a week later.
 *
 * The camera capture attribute means a phone opens the camera directly, so
 * the packer shoots the carton where they're standing.
 */

interface Props { jobId: string; jobNumber?: string | null }

export default function GraphicsPackChecklist({ jobId, jobNumber }: Props) {
  const { user } = useAuth();
  const [items, setItems] = useState<PackItem[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const apply = (body: any) => {
    setItems(body.items || []);
    setNames(body.names || {});
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch(`/api/graphics/pack-checklist?jobId=${jobId}`);
      if (res.ok) apply(await res.json());
    } catch { /* the card shows its empty state */ } finally {
      setLoading(false);
    }
  }, [jobId]);

  useEffect(() => { if (open && items.length === 0 && !loading) load(); },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one load when the card opens
    [open]);

  const build = async () => {
    setBusyId('build');
    setMsg(null);
    try {
      const res = await apiFetch('/api/graphics/pack-checklist', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId }),
      });
      const body = await res.json();
      if (!res.ok) { setMsg(body?.error || 'Could not build the checklist.'); return; }
      apply(body);
    } finally { setBusyId(null); }
  };

  const patch = async (itemId: string, payload: Record<string, unknown>) => {
    setBusyId(itemId);
    setMsg(null);
    try {
      const res = await apiFetch('/api/graphics/pack-checklist', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemId, ...payload }),
      });
      const body = await res.json();
      if (!res.ok) { setMsg(body?.error || 'Update failed.'); return; }
      apply(body);
    } finally { setBusyId(null); }
  };

  const attachPhoto = async (item: PackItem, file: File) => {
    setBusyId(item.id);
    setMsg(null);
    try {
      const safe = file.name.replace(/[^\w.\-]+/g, '_');
      const path = `pack/${jobId}/${item.id}/${Date.now()}-${safe}`;
      const { error } = await storage.from('photos').upload(path, file, { contentType: file.type });
      if (error) { setMsg(`Photo upload failed: ${error.message}`); return; }
      await patch(item.id, { action: 'photo', photoPath: path });
    } finally { setBusyId(null); }
  };

  const progress = useMemo(() => packProgress(items), [items]);
  const who = (id: string | null) => (id ? names[id] || 'Someone' : '');

  const btn = (bg: string, color: string, border: string): React.CSSProperties => ({
    padding: '5px 10px', borderRadius: '7px', fontSize: '11px', fontWeight: 700,
    background: bg, color, border: `1px solid ${border}`, cursor: 'pointer', whiteSpace: 'nowrap',
  });

  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '14px', padding: '14px', marginBottom: '16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
        <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.8px' }}>
          Pack &amp; Ship
        </div>
        {items.length > 0 && (
          <span style={{
            fontSize: '10.5px', fontWeight: 700, padding: '2px 8px', borderRadius: '999px',
            background: progress.complete ? 'rgba(34,197,94,0.12)' : 'rgba(245,158,11,0.12)',
            color: progress.complete ? '#22c55e' : '#f59e0b',
          }}>
            {progress.verified}/{progress.total} verified
            {progress.shortLines > 0 ? ` · ${progress.shortLines} short` : ''}
            {progress.withPhoto > 0 ? ` · ${progress.withPhoto} 📷` : ''}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <button onClick={() => setOpen(o => !o)} style={btn('transparent', 'var(--text-primary)', 'var(--border)')}>
          {open ? 'Hide' : 'Open checklist'}
        </button>
      </div>

      {open && (
        <div style={{ marginTop: '10px' }}>
          {msg && <div style={{ fontSize: '11.5px', color: '#ef4444', marginBottom: '8px' }}>{msg}</div>}

          {items.length === 0 ? (
            <div>
              <div style={{ fontSize: '11.5px', color: 'var(--text-muted)', marginBottom: '8px' }}>
                No checklist yet. Building one pulls this job&apos;s packing-list lines — the same lines the printed sheet uses.
              </div>
              <button onClick={build} disabled={busyId === 'build'} style={btn('rgba(34,197,94,0.1)', '#22c55e', 'rgba(34,197,94,0.35)')}>
                {busyId === 'build' ? 'Building…' : 'Build checklist'}
              </button>
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {items.map(item => {
                  const state = lineState(item);
                  const flag = quantityFlag(item);
                  const blocked = user ? blockedFromChecking(item, user.id) : 'Sign in to verify.';
                  const busy = busyId === item.id;
                  return (
                    <div key={item.id} style={{
                      border: '1px solid var(--border)', borderRadius: '10px', padding: '9px 11px',
                      background: state === 'verified' ? 'rgba(34,197,94,0.05)' : 'var(--subtle-bg)',
                      opacity: busy ? 0.6 : 1,
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                        <span style={{ fontSize: '12.5px', fontWeight: 700, color: 'var(--text-primary)' }}>
                          {item.partNumber || item.description || `Line ${item.lineIndex + 1}`}
                        </span>
                        {item.partNumber && item.description && (
                          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{item.description}</span>
                        )}
                        <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                          qty {item.quantityPacked ?? '—'}/{item.quantityExpected ?? '?'}
                        </span>
                        {flag && (
                          <span style={{ fontSize: '10px', fontWeight: 800, color: flag === 'short' ? '#ef4444' : '#f59e0b' }}>
                            {flag === 'short' ? 'SHORT' : 'OVER'}
                          </span>
                        )}
                        <span style={{ flex: 1 }} />

                        {state === 'open' && (
                          <button
                            onClick={() => {
                              const v = window.prompt('How many are in the box?', String(item.quantityExpected ?? ''));
                              if (v == null) return;
                              patch(item.id, { action: 'pack', quantityPacked: v.trim() === '' ? null : parseFloat(v) });
                            }}
                            disabled={busy}
                            style={btn('rgba(59,130,246,0.1)', '#60a5fa', 'rgba(59,130,246,0.35)')}
                          >Pack</button>
                        )}

                        {state !== 'open' && (
                          <label style={{ ...btn('transparent', 'var(--text-muted)', 'var(--border)'), display: 'inline-block' }}>
                            {item.photoPath ? 'Retake' : '📷 Photo'}
                            <input
                              type="file" accept="image/*" capture="environment" style={{ display: 'none' }}
                              onChange={e => { const f = e.target.files?.[0]; if (f) attachPhoto(item, f); e.target.value = ''; }}
                            />
                          </label>
                        )}

                        {state === 'packed' && (
                          <button
                            onClick={() => patch(item.id, { action: 'check' })}
                            disabled={busy || !!blocked}
                            title={blocked || 'Verify this line'}
                            style={{
                              ...btn(blocked ? 'transparent' : 'rgba(34,197,94,0.1)', blocked ? 'var(--text-muted)' : '#22c55e', blocked ? 'var(--border)' : 'rgba(34,197,94,0.35)'),
                              cursor: blocked ? 'not-allowed' : 'pointer',
                            }}
                          >Verify</button>
                        )}

                        {state !== 'open' && (
                          <button onClick={() => patch(item.id, { action: 'unpack' })} disabled={busy}
                            style={btn('transparent', 'var(--text-muted)', 'var(--border)')}>Undo</button>
                        )}
                      </div>

                      {(state !== 'open' || item.photoPath) && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '5px', flexWrap: 'wrap' }}>
                          {item.packedBy && (
                            <span style={{ fontSize: '10.5px', color: 'var(--text-muted)' }}>
                              Packed by {who(item.packedBy)}
                            </span>
                          )}
                          {item.checkedBy && (
                            <span style={{ fontSize: '10.5px', color: '#22c55e', fontWeight: 700 }}>
                              ✓ Verified by {who(item.checkedBy)}
                            </span>
                          )}
                          {item.photoPath && (
                            <a href={storageDownloadUrl('photos', item.photoPath, 'pack-photo.jpg')} target="_blank" rel="noopener noreferrer"
                              style={{ fontSize: '10.5px', color: '#60a5fa', fontWeight: 700 }}>
                              View photo
                            </a>
                          )}
                          {state === 'packed' && blocked && (
                            <span style={{ fontSize: '10.5px', color: 'var(--text-muted)', fontStyle: 'italic' }}>{blocked}</span>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '10px', flexWrap: 'wrap' }}>
                <button onClick={build} disabled={busyId === 'build'} style={btn('transparent', 'var(--text-muted)', 'var(--border)')}>
                  Sync lines from the job
                </button>
                <a href={`/api/graphics/packing-list?jobId=${jobId}&print=1`} target="_blank" rel="noopener noreferrer"
                  style={{ ...btn('transparent', '#60a5fa', 'var(--border)'), textDecoration: 'none' }}>
                  Printable sheet
                </a>
                {progress.complete && (
                  <span style={{ fontSize: '11.5px', fontWeight: 700, color: '#22c55e' }}>
                    Every line packed and verified{jobNumber ? ` for ${jobNumber}` : ''} — logged to the job history.
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
