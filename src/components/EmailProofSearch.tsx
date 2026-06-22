'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase-browser';
import ProofThumbnail from '@/components/ProofThumbnail';

// Extensions a browser can render directly in an <img>. heic/heif/tif and
// design-source files (ai/eps/psd) can't be previewed, so they get a badge.
const IMG_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg']);

// Result row shape returned by /api/gmail/search-proofs — one per attachment.
export interface EmailProofFile {
  id: string;
  messageId: string;
  attachmentId: string;
  filename: string;
  size: number;
  mimeType: string;
  subject: string;
  from: string;
  date: string;
}

interface Props {
  /** Pre-populated search query (customer name, part number, etc.). */
  defaultQuery?: string;
  /** Run the initial search automatically when defaultQuery is set. */
  autoSearch?: boolean;
  /** Called when the user picks a result. Should download + attach the file. */
  onUse: (file: EmailProofFile) => Promise<void> | void;
  /** Label for the action button. */
  useLabel?: string;
  /** Compact rendering (no padding/border around the wrapper). */
  embedded?: boolean;
}

function senderName(from: string): string {
  const m = /"?([^"<]+)"?\s*</.exec(from);
  return (m ? m[1] : from).trim();
}

// A small preview of a result so you can see the proof before attaching.
// Images render directly; PDFs render their first page (pdfjs); anything that
// can't be previewed (ai/eps/psd/tif/heic) shows its file-type badge.
function ResultThumbnail({ file }: { file: EmailProofFile }) {
  const ext = (file.filename.split('.').pop() || '').toLowerCase();
  const url = `/api/gmail/attachment?messageId=${encodeURIComponent(file.messageId)}&attachmentId=${encodeURIComponent(file.attachmentId)}&filename=${encodeURIComponent(file.filename)}`;

  if (IMG_EXT.has(ext)) {
    return <ProofThumbnail imageUrl={url} label={file.filename} thumbSize={48} expandedSize={280} />;
  }
  if (ext === 'pdf') {
    return <ProofThumbnail pdfUrl={url} label={file.filename} thumbSize={48} expandedSize={280} />;
  }
  return (
    <div style={{
      width: 48, height: 48, flexShrink: 0, borderRadius: '6px',
      background: 'var(--subtle-bg)', border: '1px solid var(--border)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase',
    }}>{ext || 'file'}</div>
  );
}

// Search the Gmail inbox for proof attachments (PDFs + photo/design files) and
// attach a chosen one to the current surface (e.g. a catalog part). Mirrors
// DropboxProofSearch so the two proof sources feel the same; the per-surface
// attach behavior is plugged in via onUse.
export default function EmailProofSearch({
  defaultQuery,
  autoSearch,
  onUse,
  useLabel = 'Attach',
  embedded,
}: Props) {
  const [term, setTerm] = useState(defaultQuery || '');
  const [results, setResults] = useState<EmailProofFile[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsAuth, setNeedsAuth] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [usedIds, setUsedIds] = useState<Set<string>>(new Set());

  const runSearch = async (q?: string) => {
    const value = (q ?? term).trim();
    if (!value) return;
    setSearching(true);
    setError(null);
    setNeedsAuth(false);
    try {
      const supabase = createClient();
      const { data } = await supabase.auth.getSession();
      const token = data?.session?.access_token;
      const res = await fetch(`/api/gmail/search-proofs?q=${encodeURIComponent(value)}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const body = await res.json();
      if (!res.ok) {
        if (body?.needsAuth) setNeedsAuth(true);
        setError(body?.error || `HTTP ${res.status}`);
        setResults([]);
      } else {
        setResults((body.files || []) as EmailProofFile[]);
      }
    } catch (err: any) {
      setError(err?.message || 'Search failed');
      setResults([]);
    }
    setSearching(false);
    setSearched(true);
  };

  useEffect(() => {
    if (autoSearch && defaultQuery) runSearch(defaultQuery);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot on mount
  }, []);

  const wrapperStyle: React.CSSProperties = embedded ? {} : {
    padding: '12px',
    borderRadius: '10px',
    background: 'var(--subtle-bg)',
    border: '1px solid var(--border)',
  };

  return (
    <div style={wrapperStyle}>
      <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '6px' }}>
        Find Proof in Email
      </div>

      <div style={{ display: 'flex', gap: '6px', marginBottom: '8px' }}>
        <input
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') runSearch(); }}
          placeholder="Customer, part number, file name, or from:vendor.com…"
          style={{
            flex: 1, padding: '8px 10px', borderRadius: '8px',
            background: 'var(--input-bg)', border: '1px solid var(--border)',
            color: 'var(--text-primary)', fontSize: '13px',
          }}
        />
        <button
          onClick={() => runSearch()}
          disabled={searching || !term.trim()}
          style={{
            padding: '8px 14px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
            background: '#ea4335', color: '#fff', border: 'none',
            opacity: searching || !term.trim() ? 0.5 : 1,
            cursor: searching || !term.trim() ? 'default' : 'pointer',
          }}
        >{searching ? '…' : 'Search'}</button>
      </div>

      {needsAuth && (
        <div style={{ textAlign: 'center', padding: '8px 0' }}>
          <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '8px' }}>Gmail is not connected.</div>
          <a href="/api/auth/google" style={{
            display: 'inline-block', padding: '8px 16px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
            background: '#ea4335', color: '#fff', textDecoration: 'none',
          }}>Connect Gmail</a>
        </div>
      )}

      {error && !needsAuth && (
        <div style={{ fontSize: '11px', color: '#ef4444', padding: '6px 0' }}>{error}</div>
      )}

      {searching && results.length === 0 && (
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', padding: '8px 0' }}>Searching email…</div>
      )}

      {!searching && !error && searched && results.length === 0 && (
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', padding: '8px 0' }}>No proof attachments found.</div>
      )}

      {results.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '280px', overflowY: 'auto' }}>
          {results.map((file) => {
            const isUsed = usedIds.has(file.id);
            const isPending = pendingId === file.id;
            const dateStr = file.date ? new Date(file.date).toLocaleDateString() : '';
            return (
              <div key={file.id} style={{
                display: 'flex', alignItems: 'center', gap: '8px',
                padding: '8px 10px', borderRadius: '8px',
                background: 'var(--card)', border: '1px solid var(--border)',
                opacity: isUsed ? 0.6 : 1,
              }}>
                <ResultThumbnail file={file} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file.filename}</div>
                  <div style={{ fontSize: '10px', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {senderName(file.from)}{dateStr ? ` · ${dateStr}` : ''} · {(file.size / 1024).toFixed(0)} KB
                  </div>
                  <div style={{ fontSize: '10px', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {file.subject}
                  </div>
                </div>
                <button
                  onClick={async () => {
                    if (isUsed || isPending) return;
                    setPendingId(file.id);
                    try {
                      await onUse(file);
                      setUsedIds((prev) => { const n = new Set(prev); n.add(file.id); return n; });
                    } catch (err: any) {
                      setError(err?.message || 'Attach failed');
                    } finally {
                      setPendingId(null);
                    }
                  }}
                  disabled={isUsed || isPending}
                  style={{
                    padding: '5px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700, flexShrink: 0,
                    background: isUsed ? 'rgba(34,197,94,0.12)' : 'rgba(234,67,53,0.1)',
                    border: `1px solid ${isUsed ? 'rgba(34,197,94,0.3)' : 'rgba(234,67,53,0.3)'}`,
                    color: isUsed ? '#22c55e' : '#ea4335',
                    cursor: isUsed || isPending ? 'default' : 'pointer',
                    whiteSpace: 'nowrap',
                  }}
                >{isUsed ? '✓ Attached' : isPending ? '…' : useLabel}</button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
