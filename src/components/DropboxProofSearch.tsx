'use client';

import { useEffect, useState } from 'react';
import ProofThumbnail from '@/components/ProofThumbnail';

// Result row shape returned by /api/dropbox/search.
export interface DropboxProofFile {
  id: string;
  name: string;
  path: string;
  size: number;
  modified: string;
  folder: string;
}

interface Props {
  /** Pre-populated search query (customer name, part number, etc.). */
  defaultQuery?: string;
  /** Run the initial search automatically when defaultQuery is set. */
  autoSearch?: boolean;
  /** If provided, each result shows a "Use This" action that calls back
   *  with the file. Without it, results render as open-in-Dropbox links
   *  only (read-only browse). */
  onUse?: (file: DropboxProofFile) => Promise<void> | void;
  /** Label for the action button when onUse is provided. */
  useLabel?: string;
  /** Compact rendering (no padding/border around the wrapper). */
  embedded?: boolean;
}

// Search the BMG Dropbox for proof artwork from anywhere in the app —
// quotes, prospects, graphics jobs, etc. Reuses the existing /api/dropbox
// endpoints; per-surface attach behavior is plugged in via onUse.
export default function DropboxProofSearch({
  defaultQuery,
  autoSearch,
  onUse,
  useLabel = 'Use This',
  embedded,
}: Props) {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [term, setTerm] = useState(defaultQuery || '');
  const [results, setResults] = useState<DropboxProofFile[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [usedIds, setUsedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/dropbox/status');
        const data = await res.json();
        setConnected(!!data?.connected);
      } catch {
        setConnected(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (autoSearch && defaultQuery && connected) {
      runSearch(defaultQuery);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot on mount
  }, [connected]);

  const runSearch = async (q?: string) => {
    const value = (q ?? term).trim();
    if (!value) return;
    setSearching(true);
    setError(null);
    try {
      const res = await fetch(`/api/dropbox/search?q=${encodeURIComponent(value)}`);
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error || `HTTP ${res.status}`);
        setResults([]);
      } else {
        setResults((data.files || data.results || []) as DropboxProofFile[]);
      }
    } catch (err: any) {
      setError(err?.message || 'Search failed');
      setResults([]);
    }
    setSearching(false);
  };

  const connectDropbox = () => {
    window.location.href = '/api/dropbox/auth';
  };

  const wrapperStyle: React.CSSProperties = embedded ? {} : {
    padding: '12px',
    borderRadius: '10px',
    background: 'var(--subtle-bg)',
    border: '1px solid var(--border)',
  };

  return (
    <div style={wrapperStyle}>
      <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '6px' }}>
        Find Proof in Dropbox
      </div>

      {connected === false && (
        <div style={{ textAlign: 'center', padding: '12px 0' }}>
          <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '8px' }}>Dropbox is not connected.</div>
          <button onClick={connectDropbox} style={{
            padding: '10px 20px', borderRadius: '8px', fontSize: '13px', fontWeight: 700,
            background: '#0061fe', color: '#fff', border: 'none', cursor: 'pointer',
          }}>Connect Dropbox</button>
        </div>
      )}

      {connected !== false && (
        <>
          <div style={{ display: 'flex', gap: '6px', marginBottom: '8px' }}>
            <input
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') runSearch(); }}
              placeholder="Customer, part number, or file name…"
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
                background: '#0061fe', color: '#fff', border: 'none',
                opacity: searching || !term.trim() ? 0.5 : 1,
                cursor: searching || !term.trim() ? 'default' : 'pointer',
              }}
            >{searching ? '…' : 'Search'}</button>
          </div>

          {error && (
            <div style={{ fontSize: '11px', color: '#ef4444', padding: '6px 0' }}>{error}</div>
          )}

          {searching && results.length === 0 && (
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', padding: '8px 0' }}>Searching Dropbox…</div>
          )}

          {!searching && !error && term.trim().length >= 2 && results.length === 0 && (
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', padding: '8px 0' }}>No files found in Dropbox.</div>
          )}

          {results.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '280px', overflowY: 'auto' }}>
              {results.map((file) => {
                const isUsed = usedIds.has(file.id);
                const isPending = pendingId === file.id;
                return (
                  <div key={file.id} style={{
                    display: 'flex', alignItems: 'center', gap: '8px',
                    padding: '8px 10px', borderRadius: '8px',
                    background: 'var(--card)', border: '1px solid var(--border)',
                    opacity: isUsed ? 0.6 : 1,
                  }}>
                    <ProofThumbnail dropboxPath={file.path} label={file.name} thumbSize={48} expandedSize={280} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file.name}</div>
                      <div style={{ fontSize: '10px', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {file.folder || file.path} · {(file.size / 1024).toFixed(0)} KB
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
                      <a
                        href={`https://www.dropbox.com/home${file.path.split('/').slice(0, -1).join('/')}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{
                          padding: '5px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
                          background: 'transparent', border: '1px solid var(--border)',
                          color: 'var(--text-muted)', textDecoration: 'none', whiteSpace: 'nowrap',
                        }}
                      >Open in Dropbox</a>
                      {onUse ? (
                        <button
                          onClick={async () => {
                            if (isUsed || isPending) return;
                            setPendingId(file.id);
                            try {
                              await onUse(file);
                              setUsedIds(prev => { const n = new Set(prev); n.add(file.id); return n; });
                            } finally {
                              setPendingId(null);
                            }
                          }}
                          disabled={isUsed || isPending}
                          style={{
                            padding: '5px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
                            background: isUsed ? 'rgba(34,197,94,0.12)' : 'rgba(0,97,254,0.1)',
                            border: `1px solid ${isUsed ? 'rgba(34,197,94,0.3)' : 'rgba(0,97,254,0.3)'}`,
                            color: isUsed ? '#22c55e' : '#0061fe',
                            cursor: isUsed || isPending ? 'default' : 'pointer',
                            whiteSpace: 'nowrap',
                          }}
                        >{isUsed ? '✓ Used' : isPending ? '…' : useLabel}</button>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
