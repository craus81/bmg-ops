'use client';

import { useState, useEffect, useRef, type CSSProperties } from 'react';
import { useRouter } from 'next/navigation';
import { useRequireFeature } from '@/components/AuthProvider';
import { theme } from '@/lib/theme';
import ProofThumbnail from '@/components/ProofThumbnail';

/**
 * K12 proof sweep — bulk front-end for /api/parts/proof-sweep. Scope the
 * parts (open-PO seed list by default, or a pasted list), sweep Gmail in
 * small batches with live progress, then work the approve/reject queue
 * for anything the sweep wasn't sure about. High-confidence hits (part
 * number in the filename, or in the subject of a single-attachment email)
 * attach automatically; nothing else ever does.
 */

interface ScopedPart { partId: string; partNumber: string }
interface RunResult { partNumber: string; attached: number; queued: number; skipped: number; error?: string }
interface QueueRow {
  id: string; part_id: string; part_number: string; message_id: string;
  filename: string; mime_type: string | null; size_bytes: number | null;
  subject: string | null; from_addr: string | null; email_date: string | null; created_at: string;
}

const BATCH = 5;

// Extensions a browser can render directly in an <img>. heic/heif/tif and
// design-source files (ai/eps/psd) can't be previewed, so they get a badge.
const IMG_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg']);

// Same-origin URL that streams the attachment's bytes (cookie-authed). The
// queue stores no attachment id — Gmail ids aren't stable across fetches — so
// the endpoint re-resolves by filename, same as the queue's attach action.
const queueFileUrl = (row: QueueRow) =>
  `/api/gmail/attachment?messageId=${encodeURIComponent(row.message_id)}&filename=${encodeURIComponent(row.filename)}`;

/**
 * Thumbnail for a review-queue row, so you can tell an actual proof from a
 * signature logo or an unrelated PDF without opening anything. Images render
 * directly, PDFs render page 1 (pdfjs); ai/eps/psd/tif/heic can't be previewed
 * in a browser and keep the type badge. Lazy-mounted via IntersectionObserver
 * so a long queue doesn't fetch hundreds of Gmail attachments on page load.
 */
function QueueThumb({ row }: { row: QueueRow }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  const ext = (row.filename.split('.').pop() || '').toLowerCase();
  const isImg = IMG_EXT.has(ext) || (row.mime_type || '').startsWith('image/');
  const isPdf = ext === 'pdf' || row.mime_type === 'application/pdf';
  const previewable = isPdf || (isImg && !['heic', 'heif', 'tif', 'tiff'].includes(ext));

  useEffect(() => {
    if (!previewable) return;
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) { setVisible(true); obs.disconnect(); }
    }, { rootMargin: '200px' });
    obs.observe(el);
    return () => obs.disconnect();
  }, [previewable]);

  const badge = (
    <div style={{
      width: 56, height: 56, borderRadius: 6, background: theme.inputBg, border: `1px solid ${theme.border}`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: 10, fontWeight: 700, color: theme.textMuted, textTransform: 'uppercase',
    }}>{ext || 'file'}</div>
  );

  return (
    <div ref={ref} style={{ flexShrink: 0 }}>
      {!previewable || !visible ? badge : isPdf
        ? <ProofThumbnail pdfUrl={queueFileUrl(row)} label={row.filename} thumbSize={56} expandedSize={300} />
        : <ProofThumbnail imageUrl={queueFileUrl(row)} label={row.filename} thumbSize={56} expandedSize={300} />}
    </div>
  );
}

export default function ProofSweepPage() {
  const router = useRouter();
  const { allowed: canSweep } = useRequireFeature('proof_admin');

  const [pasted, setPasted] = useState('');
  const [days, setDays] = useState(365);
  const [scoping, setScoping] = useState(false);
  const [parts, setParts] = useState<ScopedPart[]>([]);
  const [unmatched, setUnmatched] = useState<string[]>([]);
  const [scopeError, setScopeError] = useState('');
  const [scopeSource, setScopeSource] = useState<'pos' | 'pasted' | ''>('');

  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [results, setResults] = useState<RunResult[]>([]);
  const [runError, setRunError] = useState('');

  const [queue, setQueue] = useState<QueueRow[]>([]);
  const [queueBusy, setQueueBusy] = useState<string | null>(null);

  const loadQueue = async () => {
    try {
      const res = await fetch('/api/parts/proof-sweep');
      const d = await res.json();
      if (res.ok) setQueue(d.queue || []);
    } catch { /* queue stays as-is */ }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- load once on mount
  useEffect(() => { loadQueue(); }, []);

  if (!canSweep) return null;

  const post = async (body: unknown) => {
    const res = await fetch('/api/parts/proof-sweep', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await res.json().catch(() => null);
    if (!res.ok || !d) throw new Error(d?.needsAuth ? 'Gmail is not connected for your account — open Gmail settings and connect it first.' : (d?.error || `HTTP ${res.status}`));
    return d;
  };

  const doScope = async (source: 'pos' | 'pasted') => {
    setScoping(true);
    setScopeError('');
    setParts([]);
    setUnmatched([]);
    setResults([]);
    try {
      const partNumbers = source === 'pasted'
        ? pasted.split(/[\n,;]+/).map(s => s.trim()).filter(Boolean).slice(0, 500)
        : undefined;
      if (source === 'pasted' && (!partNumbers || partNumbers.length === 0)) {
        setScopeError('Paste at least one part number first.');
        return;
      }
      const d = await post({ mode: 'scope', partNumbers });
      setParts(d.parts || []);
      setUnmatched(d.unmatched || []);
      setScopeSource(source);
      if ((d.parts || []).length === 0) {
        setScopeError(source === 'pos' ? 'No open-PO part numbers matched active catalog parts.' : 'None of the pasted numbers matched active catalog parts.');
      }
    } catch (e: any) {
      setScopeError(e?.message || 'Scope failed');
    } finally {
      setScoping(false);
    }
  };

  const doRun = async () => {
    if (parts.length === 0) return;
    setRunning(true);
    setRunError('');
    setResults([]);
    setProgress({ done: 0, total: parts.length });
    const all: RunResult[] = [];
    try {
      for (let i = 0; i < parts.length; i += BATCH) {
        const chunk = parts.slice(i, i + BATCH);
        const d = await post({ mode: 'run', parts: chunk, days });
        all.push(...(d.results || []));
        setResults([...all]);
        setProgress({ done: Math.min(i + BATCH, parts.length), total: parts.length });
      }
    } catch (e: any) {
      setRunError(e?.message || 'Sweep failed');
    } finally {
      setRunning(false);
      setProgress(null);
      loadQueue();
    }
  };

  const resolve = async (row: QueueRow, action: 'attach' | 'dismiss') => {
    setQueueBusy(row.id);
    try {
      await post({ mode: 'resolve', queueId: row.id, action });
      setQueue(prev => prev.filter(q => q.id !== row.id));
    } catch (e: any) {
      setRunError(e?.message || 'Action failed');
      loadQueue();
    } finally {
      setQueueBusy(null);
    }
  };

  const totals = results.reduce(
    (t, r) => ({ attached: t.attached + r.attached, queued: t.queued + r.queued, skipped: t.skipped + r.skipped }),
    { attached: 0, queued: 0, skipped: 0 },
  );
  const errors = results.filter(r => r.error);

  const card: CSSProperties = { background: theme.card, border: `1px solid ${theme.border}`, borderRadius: 12, padding: 16, marginBottom: 16 };
  const btn: CSSProperties = { background: theme.orange, color: '#fff', border: 'none', borderRadius: 8, padding: '10px 18px', fontWeight: 600, fontSize: 14, cursor: 'pointer' };
  const ghostBtn: CSSProperties = { ...btn, background: theme.card, color: theme.textPrimary, border: `1px solid ${theme.border}` };
  const input: CSSProperties = { width: '100%', background: theme.inputBg, color: theme.textPrimary, border: `1px solid ${theme.border}`, borderRadius: 8, padding: '8px 10px', fontSize: 13 };

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', padding: 16, color: theme.textPrimary }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>Proof Sweep</h1>
      <p style={{ color: theme.textSecondary, fontSize: 14, marginBottom: 16 }}>
        Searches Gmail for each part number and attaches proof files to the part records. Only <strong>high-confidence</strong> hits
        attach automatically (part number in the file name, or in the subject of a single-attachment email) — everything else waits
        in the review queue below. Re-running is safe: anything already attached or dismissed is skipped.
      </p>

      {/* 1 · Scope */}
      <div style={card}>
        <div style={{ fontWeight: 700, marginBottom: 6 }}>1 · Which parts?</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
          <button style={{ ...btn, opacity: scoping ? 0.6 : 1 }} onClick={() => doScope('pos')} disabled={scoping}>
            {scoping ? 'Loading…' : 'Parts on open POs'}
          </button>
          <span style={{ fontSize: 12, color: theme.textMuted }}>or paste part numbers (one per line):</span>
          <label style={{ marginLeft: 'auto', fontSize: 12, color: theme.textSecondary, display: 'flex', alignItems: 'center', gap: 6 }}>
            Search back
            <select value={days} onChange={e => setDays(parseInt(e.target.value, 10))} style={{ ...input, width: 'auto', padding: '6px 8px' }}>
              <option value={90}>90 days</option>
              <option value={180}>6 months</option>
              <option value={365}>1 year</option>
              <option value={730}>2 years</option>
            </select>
          </label>
        </div>
        <textarea
          value={pasted}
          onChange={e => setPasted(e.target.value)}
          placeholder={'02T408KP\nN4-RA36-3\n…'}
          style={{ ...input, minHeight: 64, fontFamily: 'monospace', fontSize: 12, resize: 'vertical', marginBottom: 8 }}
        />
        <button style={{ ...ghostBtn, opacity: scoping ? 0.6 : 1, padding: '8px 14px', fontSize: 12 }} onClick={() => doScope('pasted')} disabled={scoping}>
          Use pasted list
        </button>
        {scopeError && <div style={{ marginTop: 8, fontSize: 12, color: theme.warning }}>{scopeError}</div>}
        {parts.length > 0 && (
          <div style={{ marginTop: 10, fontSize: 13 }}>
            <strong>{parts.length}</strong> part{parts.length !== 1 ? 's' : ''} in scope
            <span style={{ color: theme.textMuted, fontSize: 11 }}> · {scopeSource === 'pos' ? 'from open POs' : 'pasted list'}</span>
            {unmatched.length > 0 && (
              <span style={{ color: theme.textMuted, fontSize: 11 }}> · {unmatched.length} number{unmatched.length !== 1 ? 's' : ''} not in the active catalog (skipped)</span>
            )}
            <div style={{ marginTop: 4, fontSize: 11, fontFamily: 'monospace', color: theme.textMuted, maxHeight: 72, overflow: 'auto' }}>
              {parts.slice(0, 30).map(p => p.partNumber).join(', ')}{parts.length > 30 ? ` … +${parts.length - 30} more` : ''}
            </div>
          </div>
        )}
      </div>

      {/* 2 · Sweep */}
      <div style={card}>
        <div style={{ fontWeight: 700, marginBottom: 6 }}>2 · Sweep the inbox</div>
        <div style={{ fontSize: 12, color: theme.textSecondary, marginBottom: 10 }}>
          One Gmail search per part ({parts.length > 0 ? `${parts.length} searches` : 'scope first'}), a few seconds each.
        </div>
        <button style={{ ...btn, background: '#22c55e', opacity: running || parts.length === 0 ? 0.5 : 1 }} onClick={doRun} disabled={running || parts.length === 0}>
          {running ? 'Sweeping…' : parts.length > 0 ? `Sweep ${parts.length} part${parts.length !== 1 ? 's' : ''}` : 'Scope parts first'}
        </button>
        {progress && (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 12, marginBottom: 6 }}>
              {progress.done} / {progress.total} parts · {totals.attached} attached · {totals.queued} for review · {totals.skipped} already handled
            </div>
            <div style={{ height: 8, background: theme.progressTrack, borderRadius: 4, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${(progress.done / progress.total) * 100}%`, background: theme.orange }} />
            </div>
          </div>
        )}
        {runError && <div style={{ marginTop: 8, fontSize: 12, color: theme.warning }}>{runError}</div>}
        {!running && results.length > 0 && (
          <div style={{ marginTop: 12, fontSize: 14 }}>
            Done — <strong>{totals.attached}</strong> proof{totals.attached !== 1 ? 's' : ''} attached automatically ·{' '}
            <strong>{totals.queued}</strong> queued for review · {totals.skipped} already handled.
            {errors.length > 0 && (
              <details style={{ marginTop: 6 }}>
                <summary style={{ fontSize: 12, cursor: 'pointer', color: theme.textSecondary }}>{errors.length} part{errors.length !== 1 ? 's' : ''} hit errors</summary>
                <div style={{ marginTop: 4, fontSize: 11, fontFamily: 'monospace', color: theme.textMuted }}>
                  {errors.map(r => <div key={r.partNumber}>{r.partNumber} — {r.error}</div>)}
                </div>
              </details>
            )}
          </div>
        )}
      </div>

      {/* 3 · Review queue */}
      <div style={card}>
        <div style={{ fontWeight: 700, marginBottom: 6 }}>
          3 · Review queue {queue.length > 0 && <span style={{ fontSize: 12, color: theme.textMuted }}>({queue.length} waiting)</span>}
        </div>
        {queue.length === 0 ? (
          <div style={{ fontSize: 12, color: theme.textMuted }}>Nothing waiting — sweep results that need a human land here.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {queue.map(row => (
              <div key={row.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 8, border: `1px solid ${theme.border}`, flexWrap: 'wrap', opacity: queueBusy === row.id ? 0.5 : 1 }}>
                <QueueThumb row={row} />
                <span style={{ fontFamily: 'monospace', fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap' }}>{row.part_number}</span>
                <div style={{ flex: 1, minWidth: 220 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, wordBreak: 'break-all' }}>
                    <a href={queueFileUrl(row)} target="_blank" rel="noreferrer" style={{ color: theme.textPrimary }}>{row.filename}</a>
                  </div>
                  <div style={{ fontSize: 11, color: theme.textMuted }}>
                    {row.subject || '(no subject)'} · {row.from_addr || 'unknown sender'}{row.email_date ? ` · ${new Date(row.email_date).toLocaleDateString()}` : ''}
                  </div>
                </div>
                <button style={{ ...btn, background: '#22c55e', padding: '7px 14px', fontSize: 12 }} disabled={queueBusy === row.id} onClick={() => resolve(row, 'attach')}>
                  Attach
                </button>
                <button style={{ ...ghostBtn, padding: '7px 14px', fontSize: 12 }} disabled={queueBusy === row.id} onClick={() => resolve(row, 'dismiss')}>
                  Dismiss
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
