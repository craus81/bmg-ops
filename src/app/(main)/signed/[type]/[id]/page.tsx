'use client';

/**
 * Signed-document viewer (audit Round 2 item 11) — the read side of the
 * E-SIGN record. Every magic-link approval froze an HTML snapshot with a
 * sha256; this page shows it exactly as the customer saw it, with an
 * integrity verdict from /api/signed-documents (bytes re-hashed against
 * the hash stored at approval time).
 *
 * The snapshot renders inside a sandboxed iframe — it is historical
 * captured markup, never a live page — and can be downloaded as the .html
 * file for a dispute.
 */

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useRequireFeature } from '@/components/AuthProvider';
import { theme } from '@/lib/theme';

interface SignedDoc {
  label: string;
  approvedAt: string | null;
  storagePath: string;
  hash: string | null;
  verified: boolean;
  html: string;
}

// Same keys as the API route's per-type gates.
const TYPE_FEATURE: Record<string, 'estimates' | 'graphics'> = {
  estimate: 'estimates',
  wrap_quote: 'estimates',
  proof: 'graphics',
};

export default function SignedDocumentPage() {
  const params = useParams<{ type: string; id: string }>();
  const router = useRouter();
  const type = String(params?.type || '');
  const id = String(params?.id || '');
  useRequireFeature(TYPE_FEATURE[type] || 'estimates');

  const [doc, setDoc] = useState<SignedDoc | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!type || !id) return;
    (async () => {
      try {
        const res = await fetch(`/api/signed-documents?type=${encodeURIComponent(type)}&id=${encodeURIComponent(id)}`);
        const body = await res.json().catch(() => ({}));
        if (!res.ok || !body.success) throw new Error(body?.error || `HTTP ${res.status}`);
        setDoc(body);
      } catch (e: any) {
        setError(e?.message || 'Could not load the signed document.');
      }
      setLoading(false);
    })();
  }, [type, id]);

  const download = () => {
    if (!doc) return;
    const blob = new Blob([doc.html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = doc.storagePath.split('/').pop() || 'signed-document.html';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div style={{ maxWidth: '1000px', margin: '0 auto', padding: '20px 16px 60px' }}>
      <button onClick={() => router.back()} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', padding: 0, marginBottom: '10px' }}>‹ Back</button>

      {loading && <div style={{ color: 'var(--text-muted)', fontSize: '13px' }}>Loading signed document…</div>}
      {error && (
        <div style={{ padding: '14px 16px', borderRadius: '10px', background: 'var(--error-bg)', border: '1px solid var(--error-border)', color: 'var(--error)', fontSize: '13px', fontWeight: 600 }}>
          {error}
        </div>
      )}

      {doc && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginBottom: '10px' }}>
            <div style={{ fontSize: '18px', fontWeight: 800, color: 'var(--text-primary)' }}>{doc.label}</div>
            {doc.verified ? (
              <span title={`sha256 verified: ${doc.hash}`} style={{ fontSize: '10px', fontWeight: 800, padding: '3px 9px', borderRadius: '999px', background: 'var(--success-bg)', color: 'var(--success)' }}>✓ Integrity verified</span>
            ) : (
              <span title="The stored bytes no longer match the sha256 recorded at approval time — treat this copy as unreliable evidence" style={{ fontSize: '10px', fontWeight: 800, padding: '3px 9px', borderRadius: '999px', background: 'var(--error-bg)', color: 'var(--error)' }}>✗ Hash mismatch</span>
            )}
            <button onClick={download} style={{ marginLeft: 'auto', padding: '6px 12px', borderRadius: '8px', fontSize: '12px', fontWeight: 700, background: 'rgba(96,165,250,0.1)', border: '1px solid rgba(96,165,250,0.25)', color: '#60a5fa', cursor: 'pointer' }}>Download .html</button>
          </div>
          <div style={{ fontSize: '12px', color: theme.textSecondary, marginBottom: '14px' }}>
            {doc.approvedAt ? `Accepted ${new Date(doc.approvedAt).toLocaleString()}` : 'Acceptance date not recorded'}
            {doc.hash && <span style={{ marginLeft: '10px', fontFamily: 'monospace', fontSize: '10px', color: 'var(--text-muted)' }}>sha256 {doc.hash.slice(0, 16)}…</span>}
          </div>
          {/* Historical captured markup — sandboxed, no scripts, no navigation. */}
          <iframe
            sandbox=""
            srcDoc={doc.html}
            title={doc.label}
            style={{ width: '100%', height: 'calc(80vh / var(--ts))', border: '1px solid var(--border)', borderRadius: '10px', background: '#fff' }}
          />
        </>
      )}
    </div>
  );
}
