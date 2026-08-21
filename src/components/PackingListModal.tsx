'use client';

/**
 * Packing-list review step — shown before the PDF prints, everywhere a
 * packing list is generated (job page, board invoice flow, invoice review
 * modal). The print used to be fire-and-forget: whatever happened to be on
 * the job record went out, and since specs are only captured on
 * production-category creation and day-to-day notes live in the comment
 * feed, most slips printed with neither ("we cannot print notes and job
 * specs on the packing list"). Now the notes and specs are on screen,
 * editable, extendable with custom rows, and savable back to the job.
 */

import { useState } from 'react';
import { createClient } from '@/lib/supabase-browser';
import type { GraphicsJob } from '@/lib/types';
import { exportPackingListPDF, packingListFromJob, type PackingListLine } from '@/lib/packing-list-pdf';

// The six named spec fields, in packing-list order — label shown on the
// slip, column saved back to graphics_jobs.
const SPEC_FIELDS: { key: keyof GraphicsJob & string; label: string }[] = [
  { key: 'vinyl_type', label: 'Vinyl' },
  { key: 'vinyl_color', label: 'Color' },
  { key: 'laminate', label: 'Laminate' },
  { key: 'print_method', label: 'Print' },
  { key: 'cut_method', label: 'Cut' },
  { key: 'premask', label: 'Premask' },
];

interface Props {
  job: GraphicsJob;
  /** Field overrides (e.g. the just-created invoice number). */
  overrides?: Partial<GraphicsJob>;
  /** Verified invoice lines — used verbatim when present. */
  lines?: PackingListLine[];
  onClose: () => void;
}

export default function PackingListModal({ job, overrides, lines, onClose }: Props) {
  const supabase = createClient();
  const effective = { ...job, ...(overrides || {}) } as GraphicsJob;

  const [notes, setNotes] = useState(effective.notes || '');
  const [specs, setSpecs] = useState<Record<string, string>>(
    Object.fromEntries(SPEC_FIELDS.map(f => [f.key, (effective as any)[f.key] || ''])),
  );
  // Free-form extra rows — print on the slip, not saved to the job.
  const [extraSpecs, setExtraSpecs] = useState<{ label: string; value: string }[]>([]);
  const [saveBack, setSaveBack] = useState(true);
  const [working, setWorking] = useState(false);

  const previewLines = (lines && lines.length > 0)
    ? lines
    : packingListFromJob(effective).lines;

  const doPrint = async () => {
    setWorking(true);
    try {
      const data = packingListFromJob(effective, lines && lines.length > 0 ? { lines } : undefined);
      data.notes = notes.trim() || null;
      data.specs = [
        ...SPEC_FIELDS.filter(f => specs[f.key]?.trim()).map(f => ({ label: f.label, value: specs[f.key].trim() })),
        ...extraSpecs.filter(s => s.label.trim() && s.value.trim()).map(s => ({ label: s.label.trim(), value: s.value.trim() })),
      ];
      // Save the edits back so the next print (and the job card) has them.
      // Best-effort — a failed save never blocks the print.
      if (saveBack) {
        const patch: Record<string, string | null> = { notes: notes.trim() || null };
        for (const f of SPEC_FIELDS) patch[f.key] = specs[f.key]?.trim() || null;
        await supabase.from('graphics_jobs').update(patch).eq('id', job.id);
      }
      exportPackingListPDF(data, { print: true });
      onClose();
    } finally {
      setWorking(false);
    }
  };

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '7px 9px', borderRadius: '8px', boxSizing: 'border-box',
    border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text-body)', fontSize: '12px',
  };
  const labelStyle: React.CSSProperties = {
    fontSize: '9px', fontWeight: 700, color: 'var(--text-label)',
    textTransform: 'uppercase', letterSpacing: '0.3px', marginBottom: '3px',
  };

  return (
    <div onClick={() => !working && onClose()}
      style={{ position: 'fixed', inset: 0, zIndex: 1400, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' }}>
      <div onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Packing list"
        style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '14px', padding: '16px', width: 'min(560px, 100%)', maxHeight: 'calc(100vh / var(--ts) - 40px)', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontSize: '14px', fontWeight: 800, color: 'var(--text-primary)' }}>
            Packing List{effective.job_number ? ` — ${effective.job_number}` : ''}
          </div>
          <button onClick={() => !working && onClose()} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '16px', cursor: 'pointer', padding: 0 }}>✕</button>
        </div>

        {/* What ships — read-only; comes from the verified invoice lines or
            the job's part numbers. */}
        <div>
          <div style={labelStyle}>Shipping</div>
          <div style={{ fontSize: '11px', color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: '2px' }}>
            {previewLines.map((l, i) => (
              <div key={i}>{l.quantity} × {l.partNumber || '—'}{l.description ? ` — ${l.description}` : ''}</div>
            ))}
          </div>
        </div>

        {/* Job specs — editable, six named fields + free-form extras. */}
        <div>
          <div style={labelStyle}>Job Specifications — printed on the slip</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
            {SPEC_FIELDS.map(f => (
              <div key={f.key}>
                <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '2px' }}>{f.label}</div>
                <input value={specs[f.key]} onChange={e => setSpecs(prev => ({ ...prev, [f.key]: e.target.value }))} style={inputStyle} />
              </div>
            ))}
          </div>
          {extraSpecs.map((s, i) => (
            <div key={i} style={{ display: 'flex', gap: '6px', marginTop: '6px' }}>
              <input value={s.label} placeholder="Label" onChange={e => setExtraSpecs(prev => prev.map((x, j) => j === i ? { ...x, label: e.target.value } : x))} style={{ ...inputStyle, width: '140px' }} />
              <input value={s.value} placeholder="Value" onChange={e => setExtraSpecs(prev => prev.map((x, j) => j === i ? { ...x, value: e.target.value } : x))} style={{ ...inputStyle, flex: 1 }} />
              <button onClick={() => setExtraSpecs(prev => prev.filter((_, j) => j !== i))} title="Remove"
                style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '13px', padding: '0 4px' }}>✕</button>
            </div>
          ))}
          <button onClick={() => setExtraSpecs(prev => [...prev, { label: '', value: '' }])} style={{
            marginTop: '6px', padding: '4px 10px', borderRadius: '8px', fontSize: '11px', fontWeight: 700, cursor: 'pointer',
            background: 'var(--subtle-bg)', border: '1px solid var(--border)', color: 'var(--text-secondary)',
          }}>+ Add spec line</button>
        </div>

        {/* Notes — editable, prints in the NOTES block. */}
        <div>
          <div style={labelStyle}>Notes — printed on the slip</div>
          <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3}
            placeholder="Anything the receiver should know — handling, install order, missing pieces to follow…"
            style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }} />
        </div>

        <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--text-secondary)', cursor: 'pointer', width: 'fit-content' }}>
          <input type="checkbox" checked={saveBack} onChange={e => setSaveBack(e.target.checked)} style={{ accentColor: '#3b82f6' }} />
          Save notes &amp; specs back to the job
        </label>

        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          <button onClick={() => !working && onClose()} style={{
            padding: '8px 14px', borderRadius: '8px', border: '1px solid var(--border)', background: 'transparent',
            color: 'var(--text-body)', fontWeight: 700, fontSize: '12px', cursor: 'pointer',
          }}>Cancel</button>
          <button onClick={doPrint} disabled={working} style={{
            padding: '8px 16px', borderRadius: '8px', border: 'none', background: '#22c55e', color: '#fff',
            fontWeight: 800, fontSize: '12px', cursor: 'pointer', opacity: working ? 0.6 : 1,
          }}>{working ? 'Printing…' : 'Print Packing List'}</button>
        </div>
      </div>
    </div>
  );
}
