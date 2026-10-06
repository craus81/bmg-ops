'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import { deepLinks } from '@/lib/deep-links';
import { storage } from '@/lib/storage';
import ProofViewer from '@/components/ProofViewer';

interface Sources {
  salesRep: { id: string; name: string } | null;
  estimate: {
    id: string;
    number: string;
    soNumber: string | null;
    poNumber: string | null;
    vehicle: string | null;
  } | null;
  wrapQuote: {
    id: string;
    number: string;
    vehicle: string | null;
    proofs: { path: string; caption: string | null }[];
    files: { name: string; path: string; size: number; type: string | null }[];
  } | null;
}

// Wrap quote proofs and attachments live in the vehicle-templates bucket —
// the same URL the wrap quote screen builds for them.
const quoteFileUrl = (path: string) => storage.from('vehicle-templates').getPublicUrl(path).data.publicUrl;

const fmtSize = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

const linkStyle: React.CSSProperties = { fontSize: '10px', fontWeight: 700, color: '#60a5fa', textDecoration: 'none', flexShrink: 0 };

/**
 * "From the estimate & quote" on the graphics job page: the sales rep, the
 * estimate/SO (with the vehicle and customer PO) and the wrap quote's
 * coverage proofs and files. Linked, not copied — a proof redrawn on the
 * quote shows up here the next time the job is opened.
 */
export default function GraphicsJobSources({ jobId, estimateId, wrapQuoteId, cardStyle, labelStyle }: {
  jobId: string;
  /** Re-read when the job gains a link (e.g. Create Estimate on this page). */
  estimateId: string | null;
  wrapQuoteId: string | null;
  cardStyle: React.CSSProperties;
  labelStyle: React.CSSProperties;
}) {
  const [sources, setSources] = useState<Sources | null>(null);
  const [viewing, setViewing] = useState<{ path: string; caption: string | null } | null>(null);

  useEffect(() => {
    if (!estimateId && !wrapQuoteId) { setSources(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch(`/api/graphics-jobs/${encodeURIComponent(jobId)}/sources`);
        const data = res.ok ? await res.json() : null;
        if (!cancelled) setSources(data);
      } catch {
        if (!cancelled) setSources(null);
      }
    })();
    return () => { cancelled = true; };
  }, [jobId, estimateId, wrapQuoteId]);

  if (!sources || (!sources.estimate && !sources.wrapQuote)) return null;
  const { salesRep, estimate, wrapQuote } = sources;

  const row = (label: string, value: React.ReactNode) => (
    <div style={{ display: 'flex', gap: '8px', fontSize: '12px', marginBottom: '4px', minWidth: 0 }}>
      <span style={{ color: 'var(--text-muted)', width: '72px', flexShrink: 0 }}>{label}</span>
      <span style={{ flex: 1, minWidth: 0, color: 'var(--text-body)', fontWeight: 600, overflowWrap: 'anywhere' }}>{value}</span>
    </div>
  );

  return (
    <div style={cardStyle}>
      <div style={labelStyle}>From the {estimate && wrapQuote ? 'estimate & wrap quote' : estimate ? 'estimate' : 'wrap quote'}</div>

      {salesRep && row('Sales rep', salesRep.name)}

      {estimate && row(
        estimate.soNumber ? 'Sales order' : 'Estimate',
        <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ flex: 1, minWidth: 0 }}>
            {estimate.soNumber ? `SO #${estimate.soNumber} · ` : ''}{estimate.number}
          </span>
          <a href={deepLinks.estimate(estimate.id)} style={linkStyle}>Open</a>
        </span>,
      )}
      {estimate?.poNumber && row('Customer PO', estimate.poNumber)}
      {estimate?.vehicle && row('Vehicle', estimate.vehicle)}

      {wrapQuote && row(
        'Wrap quote',
        <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ flex: 1, minWidth: 0 }}>
            {wrapQuote.number}{!estimate?.vehicle && wrapQuote.vehicle ? ` · ${wrapQuote.vehicle}` : ''}
          </span>
          <a href={deepLinks.wrapQuote(wrapQuote.id)} style={linkStyle}>Open</a>
        </span>,
      )}

      {wrapQuote && wrapQuote.proofs.length > 0 && (
        <div style={{ marginTop: '8px' }}>
          <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '4px' }}>
            Coverage proof{wrapQuote.proofs.length !== 1 ? 's' : ''} · tap to view or print
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
            {wrapQuote.proofs.map((p, i) => (
              <button
                key={p.path}
                type="button"
                onClick={() => setViewing(p)}
                title={p.caption || `Proof ${i + 1}`}
                style={{ padding: 0, border: '1px solid var(--border)', borderRadius: '8px', background: 'var(--subtle-bg)', cursor: 'pointer', overflow: 'hidden', width: '96px' }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- stored proof render, no Next image loader for R2 */}
                <img src={quoteFileUrl(p.path)} alt={p.caption || `Proof ${i + 1}`} style={{ display: 'block', width: '96px', height: '64px', objectFit: 'contain', background: '#fff' }} />
                {p.caption && (
                  <div style={{ fontSize: '10px', padding: '2px 4px', color: 'var(--text-body)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.caption}</div>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      {wrapQuote && wrapQuote.files.length > 0 && (
        <div style={{ marginTop: '8px' }}>
          <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '4px' }}>Files on the wrap quote</div>
          {wrapQuote.files.map(f => (
            <div key={f.path} style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
              <a
                href={quoteFileUrl(f.path)}
                target="_blank"
                rel="noopener noreferrer"
                style={{ flex: 1, minWidth: 0, fontSize: '12px', fontWeight: 700, color: '#22c55e', textDecoration: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              >{f.name}</a>
              {f.size > 0 && <span style={{ fontSize: '10px', color: 'var(--text-muted)', flexShrink: 0 }}>{fmtSize(f.size)}</span>}
            </div>
          ))}
        </div>
      )}

      {viewing && (
        <ProofViewer
          url={quoteFileUrl(viewing.path)}
          filename={viewing.caption || 'Coverage proof'}
          onClose={() => setViewing(null)}
        />
      )}
    </div>
  );
}
