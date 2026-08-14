'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';
import { storage } from '@/lib/storage';
import { DropZone } from '@/components/DropZone';
import { getInstallerPreview } from '@/lib/installer-preview';

interface MyInvoiceLine { id: string; vin: string; part_number: string | null; amount: number | null }
interface MyInvoice {
  id: string;
  invoice_number: string | null;
  invoice_date: string | null;
  vendor_name: string;
  total_amount: number | null;
  file_name: string | null;
  storage_path: string | null;
  status: string;
  submitted_at: string | null;
  approved_at: string | null;
  rejected_at: string | null;
  rejection_reason: string | null;
  billed_at: string | null;
  paid_at: string | null;
  created_at: string;
  lines: MyInvoiceLine[];
}

interface DraftLine { key: number; vin: string; partNumber: string; amount: string }
interface Draft {
  invoiceNumber: string;
  invoiceDate: string;
  totalAmount: string;
  notes: string;
  lines: DraftLine[];
}

// Installer-facing status labels — payment progress in their words, not
// BMG's internal pipeline stages.
const STATUS_CHIP: Record<string, { label: string; color: string; bg: string }> = {
  recorded: { label: 'Recorded by BMG', color: '#94a3b8', bg: 'rgba(148,163,184,0.12)' },
  submitted: { label: 'Under Review', color: '#fbbf24', bg: 'rgba(251,191,36,0.12)' },
  approved: { label: 'Approved', color: '#60a5fa', bg: 'rgba(96,165,250,0.12)' },
  billed: { label: 'Payment Processing', color: '#a78bfa', bg: 'rgba(167,139,250,0.12)' },
  paid: { label: 'Paid', color: '#4ade80', bg: 'rgba(74,222,128,0.12)' },
  rejected: { label: 'Rejected', color: '#ef4444', bg: 'rgba(239,68,68,0.12)' },
};

const fmtMoney = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDate = (d: string | null) => d ? new Date(d).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : null;

// Files beyond Vercel's ~4.5MB request-body ceiling can't reach the
// extract endpoint at all — skip the call instead of letting it fail.
const MAX_EXTRACT_BYTES = 3.5 * 1024 * 1024;

export default function InstallerInvoicesPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, isInstaller, isAdmin, loading: authLoading } = useAuth();
  const dialog = useDialog();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lineKeyRef = useRef(0);

  const [loading, setLoading] = useState(true);
  const [invoices, setInvoices] = useState<MyInvoice[]>([]);
  const [companyName, setCompanyName] = useState('');
  const [noCompany, setNoCompany] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const [extracting, setExtracting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [stagedFile, setStagedFile] = useState<{ storagePath: string; fileName: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [resubmitting, setResubmitting] = useState<string | null>(null);

  // Admins land here via the portal's preview mode — read-only.
  const preview = isAdmin && !isInstaller ? getInstallerPreview() : null;
  const readOnly = isAdmin && !isInstaller;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = preview?.companyId ? `?companyId=${preview.companyId}` : '';
      const res = await fetch(`/api/cni/my-invoices${qs}`);
      const data = await res.json();
      if (res.ok) {
        setInvoices(data.invoices || []);
        setCompanyName(data.companyName || '');
        setNoCompany(!!data.noCompany);
      }
    } catch { /* surfaced via empty list */ }
    setLoading(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- preview comes from localStorage, stable per mount
  }, []);

  useEffect(() => {
    if (!user) return;
    if (authLoading) return; // role flags aren't resolved until auth finishes loading
    if (!isInstaller && !isAdmin) { router.push('/home'); return; }
    load();
  }, [authLoading, user, isInstaller, isAdmin, router, load]);

  // ?invoice=<id> deep link (AP decision notifications): expand that
  // invoice's card and scroll it into view once the list is loaded.
  // One-shot PER ID — a later notification tapped while this page is
  // already open (same-route push, no remount) still focuses its invoice.
  const focusedDeepLinks = useRef<Set<string>>(new Set());
  useEffect(() => {
    const target = searchParams?.get('invoice');
    if (!target || loading || focusedDeepLinks.current.has(target)) return;
    const focus = () => {
      focusedDeepLinks.current.add(target);
      setExpanded(prev => new Set(prev).add(target));
      requestAnimationFrame(() => {
        document.getElementById(`inv-${target}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    };
    if (invoices.some(inv => inv.id === target)) { focus(); return; }
    // Older than the 100-invoice window the list loads — fetch the single
    // (still company-scoped) row and merge it in so the link lands anyway.
    (async () => {
      try {
        const qs = preview?.companyId ? `&companyId=${preview.companyId}` : '';
        const res = await fetch(`/api/cni/my-invoices?id=${target}${qs}`);
        const data = await res.json();
        const fetched = (data.invoices || [])[0] as MyInvoice | undefined;
        if (!res.ok || !fetched) return;
        setInvoices(prev => prev.some(i => i.id === fetched.id) ? prev : [fetched, ...prev]);
        focus();
      } catch { /* deep link degrades to the plain list */ }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- preview is stable per mount
  }, [searchParams, loading, invoices]);

  const blankLine = (): DraftLine => ({ key: ++lineKeyRef.current, vin: '', partNumber: '', amount: '' });
  const vinOk = (l: DraftLine) => l.vin.trim().replace(/[^A-Za-z0-9]/g, '').length >= 5;

  const handleInvoiceFile = async (file: File) => {
    setNotice(null);
    setExtracting(true);
    try {
      const mediaType = file.type || (file.name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'image/jpeg');

      // Stage the original invoice in R2 — the file is required for
      // submission (it's BMG's payment record), so an upload failure blocks.
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
      const storagePath = `vendor-invoices/cni/${Date.now()}-${safeName}`;
      const uploadPromise = storage.from('invoices').upload(storagePath, file, { contentType: mediaType });

      let extracted: any = null;
      let extractError: string | null = null;
      if (file.size > MAX_EXTRACT_BYTES) {
        extractError = `This file is too large for automatic reading (${(file.size / 1048576).toFixed(1)}MB, limit ~3.5MB). It still attaches — enter the details below.`;
      } else {
        try {
          const base64 = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve((reader.result as string).split(',')[1]);
            reader.onerror = () => reject(new Error('Failed to read file'));
            reader.readAsDataURL(file);
          });
          const res = await fetch('/api/vendor-invoices/extract', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fileBase64: base64, mediaType }),
          });
          const result = await res.json().catch(() => ({}));
          if (!res.ok || !result.data) extractError = result.error || `Automatic reading failed (${res.status})`;
          else extracted = result.data;
        } catch (err: any) {
          extractError = err.message || 'Automatic reading failed';
        }
      }

      const { error: upErr } = await uploadPromise;
      if (upErr) {
        setNotice(`The invoice file could not be uploaded (${upErr.message}). Please try again — the file is required.`);
        setExtracting(false);
        return;
      }
      setStagedFile({ storagePath, fileName: file.name });

      if (!extracted) {
        setNotice(extractError ? `We couldn't read the invoice automatically: ${extractError}` : null);
        setDraft({ invoiceNumber: '', invoiceDate: '', totalAmount: '', notes: '', lines: [blankLine()] });
      } else {
        let lines: DraftLine[] = (extracted.lines || []).map((l: any) => ({
          key: ++lineKeyRef.current,
          vin: l.vin || '',
          partNumber: l.part_number || '',
          amount: l.amount != null ? String(l.amount) : '',
        }));
        if (lines.length === 0) lines = [blankLine()];
        setDraft({
          invoiceNumber: extracted.invoice_number || '',
          invoiceDate: extracted.invoice_date || '',
          totalAmount: extracted.total_amount != null ? String(extracted.total_amount) : '',
          notes: '',
          lines,
        });
        setNotice('We read the invoice automatically — please double-check the VINs and amounts before submitting.');
      }
    } finally {
      setExtracting(false);
    }
  };

  const submit = async () => {
    if (!draft || !stagedFile) return;
    const validLines = draft.lines.filter(vinOk);
    if (validLines.length === 0) {
      await dialog.alert('Add at least one VIN (5+ characters).');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/cni/my-invoices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          invoiceNumber: draft.invoiceNumber.trim() || null,
          invoiceDate: draft.invoiceDate || null,
          totalAmount: draft.totalAmount.trim() !== '' && !isNaN(Number(draft.totalAmount)) ? Number(draft.totalAmount) : null,
          notes: draft.notes.trim() || null,
          file: stagedFile,
          lines: validLines.map(l => ({
            vin: l.vin.trim(),
            partNumber: l.partNumber.trim() || null,
            amount: l.amount.trim() !== '' && !isNaN(Number(l.amount)) ? Number(l.amount) : null,
          })),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) {
        await dialog.alert(data.error || 'Submission failed — please try again.');
      } else {
        setDraft(null);
        setStagedFile(null);
        setNotice(`Invoice submitted — BMG's payment team has been notified. You'll get a notification when it's approved and when payment goes out.`);
        await load();
      }
    } catch (err: any) {
      await dialog.alert(err.message || 'Submission failed — please try again.');
    }
    setSubmitting(false);
  };

  const resubmit = async (inv: MyInvoice) => {
    if (!(await dialog.confirm(`Resubmit invoice${inv.invoice_number ? ` #${inv.invoice_number}` : ''} for review? Use this when the issue was resolved without changing the invoice — a corrected invoice should be submitted as a new upload with a new number.`))) return;
    setResubmitting(inv.id);
    try {
      const res = await fetch('/api/cni/my-invoices', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: inv.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) await dialog.alert(data.error || 'Resubmit failed');
      else await load();
    } catch (err: any) {
      await dialog.alert(err.message || 'Resubmit failed');
    }
    setResubmitting(null);
  };

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '10px', borderRadius: '8px', border: '1px solid var(--border)',
    background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '13px',
  };
  const labelStyle: React.CSSProperties = {
    fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '4px',
  };
  const sectionStyle: React.CSSProperties = {
    padding: '14px 16px', borderRadius: '14px', marginBottom: '14px',
    background: 'var(--card)', border: '1px solid var(--border)',
  };

  if (loading) {
    return <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)' }}>Loading...</div>;
  }

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
        <button onClick={() => router.push('/installer')} style={{ fontSize: '20px', color: 'var(--text-muted)' }}>←</button>
        <div>
          <div style={{ fontSize: '18px', fontWeight: 800, color: 'var(--text-primary)' }}>My Invoices</div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            {companyName || 'Submit invoices & track payment'}
          </div>
        </div>
      </div>

      {noCompany && (
        <div style={{ ...sectionStyle, background: 'var(--warning-bg)', border: '1px solid var(--warning-border)' }}>
          <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--warning)' }}>
            {readOnly ? 'No installer selected' : 'Account not linked to a company'}
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>
            {readOnly
              ? 'Pick an installer to preview from the Installer Portal home page to see their invoices.'
              : "Your account isn't linked to an installer company yet, so invoices can't be submitted. Contact BMG to get it linked."}
          </div>
        </div>
      )}

      {notice && (
        <div style={{ ...sectionStyle, fontSize: '12px', color: 'var(--text-secondary)', whiteSpace: 'pre-line' }}>
          {notice}
        </div>
      )}

      {/* Submit flow */}
      {!noCompany && !readOnly && !draft && (
        <DropZone onFiles={files => handleInvoiceFile(files[0])} accept=".pdf,.png,.jpg,.jpeg" multiple={false} disabled={extracting} style={sectionStyle}>
          <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: '8px' }}>
            Submit an Invoice
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '12px', lineHeight: 1.5 }}>
            Upload your invoice (PDF or photo). We&apos;ll read the VINs and amounts automatically — you review everything before it&apos;s submitted to BMG for payment.
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.png,.jpg,.jpeg"
            onChange={e => { const f = e.target.files?.[0]; if (f) handleInvoiceFile(f); if (fileInputRef.current) fileInputRef.current.value = ''; }}
            style={{ display: 'none' }}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={extracting}
            style={{
              width: '100%', padding: '14px', borderRadius: '10px', fontSize: '14px', fontWeight: 700,
              background: extracting ? 'var(--text-muted)' : 'var(--orange)', color: '#fff', border: 'none',
            }}
          >
            {extracting ? 'Reading invoice…' : 'Upload Invoice'}
          </button>
        </DropZone>
      )}

      {/* Review & submit */}
      {draft && stagedFile && (
        <div style={sectionStyle}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
            <div style={{ fontSize: '13px', fontWeight: 800, color: 'var(--text-primary)' }}>Review &amp; Submit</div>
            <button onClick={() => { setDraft(null); setStagedFile(null); setNotice(null); }} style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer' }}>
              ✕ Cancel
            </button>
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '10px' }}>{stagedFile.fileName}</div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '10px' }}>
            <div>
              <div style={labelStyle}>Invoice #</div>
              <input style={inputStyle} value={draft.invoiceNumber} onChange={e => setDraft({ ...draft, invoiceNumber: e.target.value })} placeholder="e.g. 1042" />
            </div>
            <div>
              <div style={labelStyle}>Invoice Date</div>
              <input style={inputStyle} type="date" value={draft.invoiceDate} onChange={e => setDraft({ ...draft, invoiceDate: e.target.value })} />
            </div>
          </div>
          <div style={{ marginBottom: '10px' }}>
            <div style={labelStyle}>Invoice Total ($)</div>
            <input style={inputStyle} inputMode="decimal" value={draft.totalAmount} onChange={e => setDraft({ ...draft, totalAmount: e.target.value })} placeholder="0.00" />
          </div>

          <div style={labelStyle}>Vehicles (VIN + amount per vehicle)</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '8px' }}>
            {draft.lines.map((l, idx) => (
              <div key={l.key} style={{ display: 'grid', gridTemplateColumns: '1fr 90px 32px', gap: '6px' }}>
                <input
                  style={{ ...inputStyle, fontFamily: 'monospace' }}
                  value={l.vin}
                  onChange={e => setDraft(d => d ? { ...d, lines: d.lines.map(x => x.key === l.key ? { ...x, vin: e.target.value.toUpperCase() } : x) } : d)}
                  placeholder={`VIN ${idx + 1}`}
                />
                <input
                  style={inputStyle}
                  inputMode="decimal"
                  value={l.amount}
                  onChange={e => setDraft(d => d ? { ...d, lines: d.lines.map(x => x.key === l.key ? { ...x, amount: e.target.value } : x) } : d)}
                  placeholder="$"
                />
                <button
                  onClick={() => setDraft(d => d ? { ...d, lines: d.lines.length > 1 ? d.lines.filter(x => x.key !== l.key) : d.lines } : d)}
                  style={{ borderRadius: '8px', border: '1px solid rgba(239,68,68,0.25)', background: 'rgba(239,68,68,0.06)', color: '#ef4444', fontSize: '12px', fontWeight: 700, cursor: 'pointer' }}
                >✕</button>
              </div>
            ))}
          </div>
          <button
            onClick={() => setDraft(d => d ? { ...d, lines: [...d.lines, blankLine()] } : d)}
            style={{ fontSize: '12px', fontWeight: 700, color: 'var(--orange)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, marginBottom: '10px' }}
          >
            + Add VIN
          </button>

          <div style={{ marginBottom: '12px' }}>
            <div style={labelStyle}>Notes (optional)</div>
            <input style={inputStyle} value={draft.notes} onChange={e => setDraft({ ...draft, notes: e.target.value })} placeholder="Anything BMG should know" />
          </div>

          <button
            onClick={submit}
            disabled={submitting || draft.lines.filter(vinOk).length === 0}
            style={{
              width: '100%', padding: '14px', borderRadius: '10px', fontSize: '14px', fontWeight: 800,
              background: submitting ? 'var(--text-muted)' : '#22c55e', color: '#fff', border: 'none',
            }}
          >
            {submitting ? 'Submitting…' : `Submit for Payment (${draft.lines.filter(vinOk).length} VIN${draft.lines.filter(vinOk).length !== 1 ? 's' : ''})`}
          </button>
        </div>
      )}

      {/* History */}
      <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.8px', margin: '18px 0 8px' }}>
        Invoice History ({invoices.length})
      </div>
      {invoices.length === 0 && !noCompany && (
        <div style={{ textAlign: 'center', padding: '24px 0', color: 'var(--text-muted)', fontSize: '12px', fontWeight: 600 }}>
          No invoices yet — upload your first one above
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '80px' }}>
        {invoices.map(inv => {
          const chip = STATUS_CHIP[inv.status] || STATUS_CHIP.submitted;
          const amount = inv.total_amount != null
            ? Number(inv.total_amount)
            : inv.lines.reduce((s, l) => s + (l.amount != null ? Number(l.amount) : 0), 0);
          const isExpanded = expanded.has(inv.id);
          return (
            <div key={inv.id} id={`inv-${inv.id}`} style={{ background: 'var(--card)', border: `1px solid ${inv.status === 'rejected' ? 'rgba(239,68,68,0.35)' : 'var(--border)'}`, borderRadius: '12px', overflow: 'hidden' }}>
              <div
                onClick={() => setExpanded(prev => { const n = new Set(prev); if (n.has(inv.id)) n.delete(inv.id); else n.add(inv.id); return n; })}
                style={{ padding: '12px 14px', cursor: 'pointer' }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '13px', fontWeight: 800, color: 'var(--text-primary)' }}>
                    {inv.invoice_number ? `Invoice #${inv.invoice_number}` : 'Invoice'}
                  </span>
                  <span style={{ fontSize: '10px', fontWeight: 700, padding: '2px 8px', borderRadius: '6px', background: chip.bg, color: chip.color }}>{chip.label}</span>
                  <span style={{ flex: 1 }} />
                  <span style={{ fontSize: '13px', fontWeight: 800, color: '#f472b6' }}>{fmtMoney(amount)}</span>
                </div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '3px' }}>
                  {inv.lines.length} vehicle{inv.lines.length !== 1 ? 's' : ''}
                  {inv.invoice_date ? ` · dated ${fmtDate(inv.invoice_date)}` : ''}
                  {inv.status === 'paid' && inv.paid_at ? ` · paid ${fmtDate(inv.paid_at)}` : ''}
                  {inv.status !== 'paid' && inv.submitted_at ? ` · submitted ${fmtDate(inv.submitted_at)}` : ''}
                </div>
                {inv.status === 'rejected' && inv.rejection_reason && (
                  <div style={{ fontSize: '11px', color: '#ef4444', marginTop: '4px', fontWeight: 600 }}>
                    Reason: {inv.rejection_reason}
                  </div>
                )}
              </div>
              {(inv.status === 'rejected' || inv.storage_path) && (
                <div style={{ display: 'flex', gap: '6px', padding: '0 14px 10px', flexWrap: 'wrap' }}>
                  {inv.storage_path && (
                    <a
                      href={storage.from('invoices').getPublicUrl(inv.storage_path).data.publicUrl}
                      target="_blank" rel="noreferrer"
                      onClick={e => e.stopPropagation()}
                      style={{ padding: '5px 10px', borderRadius: '7px', fontSize: '11px', fontWeight: 700, background: 'rgba(96,165,250,0.1)', border: '1px solid rgba(96,165,250,0.25)', color: '#60a5fa', textDecoration: 'none' }}
                    >View File</a>
                  )}
                  {inv.status === 'rejected' && !readOnly && (
                    <button
                      onClick={() => resubmit(inv)}
                      disabled={resubmitting === inv.id}
                      style={{ padding: '5px 10px', borderRadius: '7px', fontSize: '11px', fontWeight: 700, background: 'rgba(251,191,36,0.1)', border: '1px solid rgba(251,191,36,0.3)', color: '#fbbf24', cursor: 'pointer' }}
                    >
                      {resubmitting === inv.id ? '…' : 'Resubmit for Review'}
                    </button>
                  )}
                </div>
              )}
              {isExpanded && inv.lines.length > 0 && (
                <div style={{ borderTop: '1px solid var(--border)', padding: '8px 14px' }}>
                  {inv.lines.map(l => (
                    <div key={l.id} style={{ display: 'flex', gap: '8px', fontSize: '11px', padding: '2px 0', color: 'var(--text-secondary)' }}>
                      <span style={{ fontFamily: 'monospace', fontWeight: 700 }}>{l.vin}</span>
                      {l.part_number && <span style={{ color: 'var(--text-muted)' }}>{l.part_number}</span>}
                      <span style={{ flex: 1 }} />
                      <span style={{ fontWeight: 700, color: '#f472b6' }}>{l.amount != null ? fmtMoney(Number(l.amount)) : '—'}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
