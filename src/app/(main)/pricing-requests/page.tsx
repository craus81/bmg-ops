'use client';

/**
 * Pricing Requests (owner ask 2026-10-08 from Ashley O., migration 352).
 *
 * Masterack emails a pricing request: an end company's name and a picture
 * or proof. Someone logs it here, and FleetSuite starts its price sheet, an
 * ordinary estimate (graphic line + install line) that is sent through the
 * normal Send for Approval and never pushed to NetSuite. The pictures live on
 * that estimate, so they are in the send's attachment picker. Internal notes
 * stay here. When Masterack's PO arrives with the new 02 / 06 numbers, an
 * admin links it on the PO page and the numbers join the parts catalog at
 * the quoted prices.
 *
 * URL: ?new=1 opens the form, ?id=<request> opens one request.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';
import { apiFetch } from '@/lib/api-client';
import { deepLinks } from '@/lib/deep-links';
import { theme } from '@/lib/theme';
import { uploadRecordFile } from '@/lib/record-file-upload';
import { toJpegIfHeic } from '@/lib/heic';
import {
  DEFAULT_PRICING_REQUEST_CUSTOMER, PRICING_REQUEST_CUSTOMERS, STAGE_META, STAGE_ORDER,
  defaultPriceSheetLines, quotedPrices,
  type PriceSheetSummary, type PricingRequest, type PricingRequestStage,
} from '@/lib/pricing-request';

type Row = PricingRequest & { stage: PricingRequestStage; sheet: PriceSheetSummary | null; po_number: string | null };
interface Detail {
  request: Row;
  customer_id: string | null;
  customer_tax_exempt: boolean;
  parts: { id: string; item_number: string; netsuite_id: string | null; sales_price: number | null }[];
  notes: { id: string; body: string; created_at: string; author_name: string | null }[];
}
interface SheetFile { id: string; file_name: string; content_type: string | null; public_url: string }

const fmtDate = (d: string | null | undefined) => {
  if (!d) return '';
  const m = String(d).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${Number(m[2])}/${Number(m[3])}/${m[1]}` : String(d);
};
const fmtWhen = (iso: string) =>
  new Date(iso).toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const fmtMoney = (n: number | null | undefined) =>
  n == null ? '' : '$' + Number(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });

const EMPTY_FORM = {
  customer_name: DEFAULT_PRICING_REQUEST_CUSTOMER as string,
  company_name: '', contact_name: '', contact_email: '', received_date: '', vehicle: '', description: '',
};

function StageBadge({ stage }: { stage: PricingRequestStage }) {
  const m = STAGE_META[stage];
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: '999px', fontSize: '10px', fontWeight: 800,
      color: m.color, background: `${m.color}1f`, border: `1px solid ${m.color}55`, whiteSpace: 'nowrap',
    }}>{m.label}</span>
  );
}

export default function PricingRequestsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const dialog = useDialog();
  const { user, hasFeature, loading } = useAuth();

  const [requests, setRequests] = useState<Row[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [search, setSearch] = useState('');
  const [stageFilter, setStageFilter] = useState<PricingRequestStage | 'active' | 'all'>('active');

  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [formFiles, setFormFiles] = useState<File[]>([]);
  const [saving, setSaving] = useState(false);

  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailError, setDetailError] = useState('');
  const [files, setFiles] = useState<SheetFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [noteText, setNoteText] = useState('');
  const [postingNote, setPostingNote] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState({ ...EMPTY_FORM });
  const [busy, setBusy] = useState(false);

  const isNew = searchParams.get('new') === '1';
  const openId = searchParams.get('id');

  useEffect(() => {
    if (loading || !user) return;
    if (!hasFeature('estimates')) router.replace('/home');
  }, [loading, user, hasFeature, router]);

  const load = useCallback(async () => {
    setLoadError('');
    try {
      const res = await apiFetch('/api/pricing-requests');
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Could not load pricing requests');
      setRequests(json.requests || []);
    } catch (err: any) {
      setLoadError(err?.message || 'Could not load pricing requests');
    }
    setLoadingList(false);
  }, []);

  useEffect(() => { if (user) void load(); }, [user, load]);

  const loadFiles = useCallback(async (sheetId: string | null | undefined) => {
    if (!sheetId) { setFiles([]); return; }
    try {
      const res = await fetch(`/api/estimates/${sheetId}/files`);
      const json = await res.json().catch(() => ({}));
      setFiles(res.ok && json.success ? json.files || [] : []);
    } catch {
      setFiles([]);
    }
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    setDetailError('');
    try {
      const res = await apiFetch(`/api/pricing-requests/${id}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Could not load the request');
      setDetail(json);
      void loadFiles(json.request?.sheet?.id);
      return json as Detail;
    } catch (err: any) {
      setDetailError(err?.message || 'Could not load the request');
      return null;
    }
  }, [loadFiles]);

  useEffect(() => {
    if (!user || !openId) { setDetail(null); setFiles([]); return; }
    setEditing(false);
    void loadDetail(openId);
  }, [user, openId, loadDetail]);

  const go = (params: Record<string, string> | null) => {
    const qs = params ? `?${new URLSearchParams(params).toString()}` : '';
    router.push(`${deepLinks.pricingRequests()}${qs}`);
  };

  // ── Price sheet: an ordinary draft estimate marked with the request ──
  const startPriceSheet = async (d: Detail): Promise<string | null> => {
    const r = d.request;
    const res = await apiFetch('/api/estimates', {
      method: 'POST',
      body: JSON.stringify({
        customer_id: d.customer_id,
        customer_name: r.customer_name,
        customer_netsuite_id: r.customer_netsuite_id,
        title: `${r.request_number}: ${r.company_name} graphics`.slice(0, 300),
        status: 'draft',
        tax_exempt: d.customer_tax_exempt,
        vehicle_other: r.vehicle ? r.vehicle.slice(0, 120) : null,
        line_items: defaultPriceSheetLines(r.company_name),
        created_by: user?.id || null,
      }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.id) throw new Error(json.error || 'Could not start the price sheet');
    const link = await apiFetch(`/api/pricing-requests/${r.id}`, { method: 'PATCH', body: JSON.stringify({ estimate_id: json.id }) });
    if (!link.ok) {
      const j = await link.json().catch(() => ({}));
      throw new Error(j.error || 'The price sheet was created but could not be tied to the request');
    }
    return json.id as string;
  };

  const uploadToSheet = async (sheetId: string, list: File[]): Promise<string[]> => {
    const errors: string[] = [];
    for (const raw of list) {
      const f = await toJpegIfHeic(raw).catch(() => raw);
      const up = await uploadRecordFile(`/api/estimates/${sheetId}/files`, {}, f);
      if (up.error) errors.push(`${raw.name}: ${up.error}`);
    }
    return errors;
  };

  const createRequest = async () => {
    if (!form.company_name.trim()) { await dialog.alert('Enter the company the graphics are for.'); return; }
    setSaving(true);
    try {
      const res = await apiFetch('/api/pricing-requests', {
        method: 'POST',
        body: JSON.stringify({ ...form, received_date: form.received_date || today() }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.request) throw new Error(json.error || 'Could not save the request');
      const id = json.request.id as string;

      const problems: string[] = [];
      const d = await loadDetail(id);
      if (d) {
        try {
          const sheetId = await startPriceSheet(d);
          if (sheetId && formFiles.length > 0) problems.push(...await uploadToSheet(sheetId, formFiles));
        } catch (err: any) {
          problems.push(`${err?.message || 'Could not start the price sheet'}. Use "Start price sheet" on the request.`);
        }
      }
      setForm({ ...EMPTY_FORM });
      setFormFiles([]);
      await load();
      go({ id });
      if (problems.length > 0) await dialog.alert(`The request was saved, but:\n\n${problems.join('\n')}`);
    } catch (err: any) {
      await dialog.alert(err?.message || 'Could not save the request');
    }
    setSaving(false);
  };

  const refresh = async (id: string) => {
    await loadDetail(id);
    void load();
  };

  const patch = async (id: string, body: Record<string, unknown>) => {
    setBusy(true);
    try {
      const res = await apiFetch(`/api/pricing-requests/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Could not save');
      await refresh(id);
      setEditing(false);
    } catch (err: any) {
      await dialog.alert(err?.message || 'Could not save');
    }
    setBusy(false);
  };

  const addFiles = async (list: FileList | null) => {
    const sheetId = detail?.request.sheet?.id;
    if (!list || list.length === 0 || !sheetId) return;
    setUploading(true);
    const errors = await uploadToSheet(sheetId, Array.from(list));
    await loadFiles(sheetId);
    setUploading(false);
    if (errors.length > 0) await dialog.alert(`Some files didn't upload:\n\n${errors.join('\n')}`);
  };

  const removeFile = async (f: SheetFile) => {
    const sheetId = detail?.request.sheet?.id;
    if (!sheetId) return;
    const ok = await dialog.confirm(`Remove ${f.file_name}?`, { title: 'Remove picture', confirmLabel: 'Remove', destructive: true });
    if (!ok) return;
    const res = await fetch(`/api/estimates/${sheetId}/files?fileId=${encodeURIComponent(f.id)}`, { method: 'DELETE' });
    if (!res.ok) { const j = await res.json().catch(() => ({})); await dialog.alert(j.error || 'Could not remove the file.'); return; }
    setFiles(prev => prev.filter(p => p.id !== f.id));
  };

  const postNote = async () => {
    if (!detail || !noteText.trim()) return;
    setPostingNote(true);
    try {
      const res = await apiFetch(`/api/pricing-requests/${detail.request.id}/notes`, { method: 'POST', body: JSON.stringify({ body: noteText.trim() }) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.note) throw new Error(json.error || 'Could not save the note');
      setDetail(prev => prev ? { ...prev, notes: [...prev.notes, json.note] } : prev);
      setNoteText('');
    } catch (err: any) {
      await dialog.alert(err?.message || 'Could not save the note');
    }
    setPostingNote(false);
  };

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const r of requests) c[r.stage] = (c[r.stage] || 0) + 1;
    return c;
  }, [requests]);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return requests.filter(r => {
      if (stageFilter === 'active' && (r.stage === 'declined' || r.stage === 'closed')) return false;
      if (stageFilter !== 'active' && stageFilter !== 'all' && r.stage !== stageFilter) return false;
      if (!q) return true;
      return [r.request_number, r.company_name, r.customer_name, r.contact_name || '', r.vehicle || '', r.part_number || '', r.install_part_number || '', r.po_number || '', r.sheet?.estimate_number || '']
        .some(v => v.toLowerCase().includes(q));
    });
  }, [requests, search, stageFilter]);

  const card: React.CSSProperties = { background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '14px', padding: '14px', marginBottom: '14px' };
  const btn: React.CSSProperties = { padding: '9px 14px', borderRadius: '10px', fontSize: '13px', fontWeight: 700, border: `1px solid ${theme.border}`, background: 'transparent', color: theme.textPrimary, cursor: 'pointer', textDecoration: 'none', display: 'inline-block' };
  const primaryBtn: React.CSSProperties = { ...btn, background: '#2563eb', border: 'none', color: '#fff' };
  const label: React.CSSProperties = { display: 'block', fontSize: '11px', fontWeight: 800, letterSpacing: '0.4px', textTransform: 'uppercase', color: theme.textMuted, marginBottom: '4px' };
  const input: React.CSSProperties = { width: '100%', padding: '9px 10px', borderRadius: '8px', border: `1px solid ${theme.border}`, background: theme.inputBg, color: theme.textPrimary, fontSize: '16px', boxSizing: 'border-box' };
  const grid2: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '10px' };

  const header = (title: string, sub?: string, back?: boolean) => (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', marginBottom: '14px', flexWrap: 'wrap' }}>
      <div style={{ minWidth: 0 }}>
        {back && <button onClick={() => go(null)} style={{ background: 'none', border: 'none', color: '#60a5fa', fontSize: '13px', fontWeight: 700, cursor: 'pointer', padding: 0, marginBottom: '4px' }}>← Pricing requests</button>}
        <h1 style={{ margin: 0, fontSize: '20px', fontWeight: 800, color: theme.textPrimary }}>{title}</h1>
        {sub && <div style={{ fontSize: '12px', color: theme.textMuted, marginTop: '2px' }}>{sub}</div>}
      </div>
      {!back && <button style={primaryBtn} onClick={() => go({ new: '1' })}>+ New request</button>}
    </div>
  );

  const fields = (f: typeof EMPTY_FORM, set: (next: typeof EMPTY_FORM) => void, withCustomer: boolean) => (
    <div style={grid2}>
      {withCustomer && (
        <div>
          <label style={label}>From</label>
          <select value={f.customer_name} onChange={e => set({ ...f, customer_name: e.target.value })} style={input}>
            {PRICING_REQUEST_CUSTOMERS.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
      )}
      <div>
        <label style={label}>Company the graphics are for *</label>
        <input value={f.company_name} onChange={e => set({ ...f, company_name: e.target.value })} placeholder="e.g. Orkin" style={input} />
      </div>
      <div>
        <label style={label}>Requested by</label>
        <input value={f.contact_name} onChange={e => set({ ...f, contact_name: e.target.value })} placeholder="Masterack contact" style={input} />
      </div>
      <div>
        <label style={label}>Their email (gets the pricing)</label>
        <input type="email" value={f.contact_email} onChange={e => set({ ...f, contact_email: e.target.value })} placeholder="name@masterack.com" style={input} />
      </div>
      <div>
        <label style={label}>Received</label>
        <input type="date" value={f.received_date || today()} onChange={e => set({ ...f, received_date: e.target.value })} style={input} />
      </div>
      <div>
        <label style={label}>Vehicle</label>
        <input value={f.vehicle} onChange={e => set({ ...f, vehicle: e.target.value })} placeholder="e.g. 2025 Transit 148 high roof" style={input} />
      </div>
      <div style={{ gridColumn: '1 / -1' }}>
        <label style={label}>What they asked for</label>
        <textarea value={f.description} onChange={e => set({ ...f, description: e.target.value })} rows={3} placeholder="Paste or summarize the request email" style={{ ...input, resize: 'vertical' }} />
      </div>
    </div>
  );

  if (loading || !user) return null;

  // ═══════════ NEW REQUEST ═══════════
  if (isNew) {
    return (
      <div style={{ maxWidth: '900px', margin: '0 auto', padding: '16px' }}>
        {header('New pricing request', 'Log the request; FleetSuite starts its price sheet for you.', true)}
        <div style={card}>
          {fields(form, setForm, true)}
          <div style={{ marginTop: '12px' }}>
            <label style={label}>Pictures or proofs</label>
            <input type="file" multiple accept="image/*,application/pdf,.heic,.heif,.ai,.eps" onChange={e => setFormFiles(Array.from(e.target.files || []))} style={{ fontSize: '13px', color: theme.textSecondary }} />
            {formFiles.length > 0 && <div style={{ fontSize: '12px', color: theme.textMuted, marginTop: '4px' }}>{formFiles.length} file{formFiles.length !== 1 ? 's' : ''} ready to attach</div>}
          </div>
          <div style={{ display: 'flex', gap: '8px', marginTop: '14px', justifyContent: 'flex-end' }}>
            <button style={btn} onClick={() => go(null)} disabled={saving}>Cancel</button>
            <button style={{ ...primaryBtn, opacity: saving ? 0.6 : 1 }} onClick={createRequest} disabled={saving}>{saving ? 'Saving…' : 'Save request'}</button>
          </div>
        </div>
      </div>
    );
  }

  // ═══════════ ONE REQUEST ═══════════
  if (openId) {
    if (detailError) {
      return (
        <div style={{ maxWidth: '900px', margin: '0 auto', padding: '16px' }}>
          {header('Pricing request', undefined, true)}
          <div style={{ ...card, color: '#f87171' }}>{detailError}</div>
        </div>
      );
    }
    if (!detail || detail.request.id !== openId) {
      return <div style={{ padding: '24px', color: theme.textMuted }}>Loading…</div>;
    }
    const r = detail.request;
    const sheet = r.sheet;
    const quoted = quotedPrices(sheet?.lines || []);
    const isOpen = r.status === 'open';
    const imageFiles = files.filter(f => (f.content_type || '').startsWith('image/'));
    const otherFiles = files.filter(f => !(f.content_type || '').startsWith('image/'));

    return (
      <div style={{ maxWidth: '900px', margin: '0 auto', padding: '16px' }}>
        {header(`${r.company_name}`, `${r.request_number} · from ${r.customer_name}${r.contact_name ? ` (${r.contact_name})` : ''} · received ${fmtDate(r.received_date)}`, true)}

        <div style={{ ...card, display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          <StageBadge stage={r.stage} />
          <div style={{ flex: 1, fontSize: '13px', color: theme.textSecondary, minWidth: '200px' }}>
            {r.stage === 'new' && 'No price sheet yet.'}
            {r.stage === 'pricing' && 'Set the prices on the price sheet, then Send for Approval from there.'}
            {r.stage === 'sent' && 'Pricing sent. Waiting on Masterack to approve or ask for changes.'}
            {r.stage === 'changes_requested' && `Masterack asked for changes${sheet?.customer_rejection_reason ? `: "${sheet.customer_rejection_reason}"` : '.'}`}
            {r.stage === 'approved' && 'Approved. When their PO arrives, link it on the PO page to add the 02 / 06 numbers to the catalog.'}
            {r.stage === 'on_po' && `On PO ${r.po_number || ''}.`}
            {r.stage === 'declined' && 'Declined.'}
            {r.stage === 'closed' && 'Closed.'}
          </div>
          {isOpen && !r.po_id && (
            <button style={btn} disabled={busy} onClick={async () => {
              const ok = await dialog.confirm('Mark this request declined? It drops out of the active list. You can reopen it later.', { title: 'Decline request', confirmLabel: 'Decline' });
              if (ok) await patch(r.id, { status: 'declined' });
            }}>Declined</button>
          )}
          {isOpen && r.po_id && <button style={btn} disabled={busy} onClick={() => patch(r.id, { status: 'closed' })}>Close</button>}
          {!isOpen && <button style={btn} disabled={busy} onClick={() => patch(r.id, { status: 'open' })}>Reopen</button>}
        </div>

        {/* Request details */}
        <div style={card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
            <div style={label}>Request</div>
            {!editing && (
              <button style={{ ...btn, padding: '5px 10px', fontSize: '12px' }} onClick={() => {
                setEditForm({
                  customer_name: r.customer_name, company_name: r.company_name, contact_name: r.contact_name || '',
                  contact_email: r.contact_email || '', received_date: r.received_date, vehicle: r.vehicle || '', description: r.description || '',
                });
                setEditing(true);
              }}>Edit</button>
            )}
          </div>
          {editing ? (
            <>
              {fields(editForm, setEditForm, false)}
              <div style={{ display: 'flex', gap: '8px', marginTop: '12px', justifyContent: 'flex-end' }}>
                <button style={btn} onClick={() => setEditing(false)} disabled={busy}>Cancel</button>
                <button style={primaryBtn} disabled={busy} onClick={() => {
                  const { customer_name: _c, ...rest } = editForm;
                  void patch(r.id, rest);
                }}>Save</button>
              </div>
            </>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '8px 16px', fontSize: '13px', color: theme.textSecondary }}>
              <div><b>Requested by:</b> {r.contact_name || '—'}{r.contact_email ? ` · ${r.contact_email}` : ''}</div>
              <div><b>Vehicle:</b> {r.vehicle || '—'}</div>
              <div style={{ gridColumn: '1 / -1', whiteSpace: 'pre-wrap' }}><b>Asked for:</b> {r.description || '—'}</div>
            </div>
          )}
        </div>

        {/* Pictures and proofs (the price sheet's files) */}
        <div style={card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px', gap: '8px' }}>
            <div style={label}>Pictures & proofs</div>
            {sheet && (
              <label style={{ ...btn, padding: '5px 10px', fontSize: '12px', opacity: uploading ? 0.6 : 1 }}>
                {uploading ? 'Uploading…' : '+ Add'}
                <input type="file" multiple hidden accept="image/*,application/pdf,.heic,.heif,.ai,.eps" disabled={uploading} onChange={e => { void addFiles(e.target.files); e.target.value = ''; }} />
              </label>
            )}
          </div>
          {!sheet ? (
            <div style={{ fontSize: '13px', color: theme.textMuted }}>Start the price sheet first; pictures are kept on it so they can ride along when you send the pricing.</div>
          ) : files.length === 0 ? (
            <div style={{ fontSize: '13px', color: theme.textMuted }}>No pictures yet. They are offered as attachments when you send the pricing.</div>
          ) : (
            <>
              {imageFiles.length > 0 && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: '8px' }}>
                  {imageFiles.map(f => (
                    <div key={f.id} style={{ position: 'relative', border: `1px solid ${theme.border}`, borderRadius: '10px', overflow: 'hidden', background: theme.bg }}>
                      <a href={f.public_url} target="_blank" rel="noreferrer">
                        {/* eslint-disable-next-line @next/next/no-img-element -- presigned R2 URL */}
                        <img src={f.public_url} alt={f.file_name} style={{ width: '100%', height: '120px', objectFit: 'cover', display: 'block' }} />
                      </a>
                      <button onClick={() => removeFile(f)} title="Remove" style={{ position: 'absolute', top: '4px', right: '4px', background: 'rgba(0,0,0,0.6)', color: '#fff', border: 'none', borderRadius: '6px', padding: '2px 7px', cursor: 'pointer', fontSize: '12px' }}>×</button>
                    </div>
                  ))}
                </div>
              )}
              {otherFiles.map(f => (
                <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '8px', fontSize: '13px' }}>
                  <a href={f.public_url} target="_blank" rel="noreferrer" style={{ color: '#60a5fa', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.file_name}</a>
                  <button onClick={() => removeFile(f)} style={{ ...btn, padding: '3px 8px', fontSize: '11px' }}>Remove</button>
                </div>
              ))}
            </>
          )}
        </div>

        {/* Price sheet */}
        <div style={card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px', gap: '8px', flexWrap: 'wrap' }}>
            <div style={label}>Pricing{sheet?.estimate_number ? ` · ${sheet.estimate_number}` : ''}</div>
            {sheet ? (
              <a href={deepLinks.estimate(sheet.id)} style={{ ...primaryBtn, padding: '7px 12px', fontSize: '12px' }}>
                {r.stage === 'pricing' || r.stage === 'changes_requested' ? 'Set prices & send →' : 'Open price sheet →'}
              </a>
            ) : (
              <button style={{ ...primaryBtn, padding: '7px 12px', fontSize: '12px', opacity: busy ? 0.6 : 1 }} disabled={busy} onClick={async () => {
                setBusy(true);
                try { await startPriceSheet(detail); await refresh(r.id); } catch (err: any) { await dialog.alert(err?.message || 'Could not start the price sheet'); }
                setBusy(false);
              }}>Start price sheet</button>
            )}
          </div>
          {sheet ? (
            <>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                <tbody>
                  {sheet.lines.map((l, i) => (
                    <tr key={i}>
                      <td style={{ padding: '5px 0', color: theme.textSecondary }}>{l.description || l.item_number || 'Line'}{l.quantity !== 1 ? ` × ${l.quantity}` : ''}</td>
                      <td style={{ padding: '5px 0', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: l.unit_price > 0 ? theme.textPrimary : '#fbbf24' }}>{l.unit_price > 0 ? fmtMoney(l.unit_price * l.quantity) : 'not priced'}</td>
                    </tr>
                  ))}
                  <tr>
                    <td style={{ padding: '6px 0', fontWeight: 800, borderTop: `1px solid ${theme.border}` }}>Total</td>
                    <td style={{ padding: '6px 0', fontWeight: 800, textAlign: 'right', borderTop: `1px solid ${theme.border}`, fontVariantNumeric: 'tabular-nums' }}>{fmtMoney(sheet.grand_total)}</td>
                  </tr>
                </tbody>
              </table>
              <div style={{ fontSize: '11px', color: theme.textMuted, marginTop: '6px' }}>
                Lines that say "install" become the 06 price; the rest is the 02 graphic price. This price sheet is never pushed to NetSuite.
              </div>
            </>
          ) : (
            <div style={{ fontSize: '13px', color: theme.textMuted }}>The price sheet is a draft estimate with a graphic line and an install line.</div>
          )}
        </div>

        {/* PO and catalog */}
        <div style={card}>
          <div style={label}>PO & catalog</div>
          {r.po_id ? (
            <div style={{ fontSize: '13px', color: theme.textSecondary, display: 'grid', gap: '6px', marginTop: '6px' }}>
              <div><b>PO:</b> <a href={deepLinks.po(r.po_id)} style={{ color: '#60a5fa' }}>{r.po_number || 'Open PO'}</a>{r.linked_at ? ` · linked ${fmtWhen(r.linked_at)}` : ''}</div>
              {r.part_number && <div><b>Graphic:</b> {r.part_number} at {fmtMoney(r.part_price)}</div>}
              {r.install_part_number && <div><b>Install:</b> {r.install_part_number} at {fmtMoney(r.install_price)}</div>}
              {detail.parts.some(p => !p.netsuite_id || /^(LOCAL-|bmg-)/i.test(p.netsuite_id)) && (
                <div style={{ color: '#fbbf24' }}>One of these parts isn't in NetSuite yet. Add it from the Parts Catalog.</div>
              )}
            </div>
          ) : (
            <div style={{ fontSize: '13px', color: theme.textMuted, marginTop: '6px' }}>
              Not on a PO yet. When Masterack's PO comes in with the new 02 / 06 numbers, an admin opens it and uses <b>Link pricing request</b>. Both numbers are added to the catalog and NetSuite at {quoted.part || quoted.install ? `the quoted ${fmtMoney(quoted.part)} / ${fmtMoney(quoted.install)}` : 'the quoted prices'}.
            </div>
          )}
        </div>

        {/* Internal notes */}
        <div style={card}>
          <div style={label}>Internal notes</div>
          {detail.notes.length === 0 && <div style={{ fontSize: '13px', color: theme.textMuted, marginBottom: '8px' }}>No notes yet. Only staff see these.</div>}
          {detail.notes.map(n => (
            <div key={n.id} style={{ padding: '8px 0', borderBottom: `1px solid ${theme.border}` }}>
              <div style={{ fontSize: '11px', color: theme.textMuted }}>{n.author_name || 'Someone'} · {fmtWhen(n.created_at)}</div>
              <div style={{ fontSize: '13px', color: theme.textSecondary, whiteSpace: 'pre-wrap', marginTop: '2px' }}>{n.body}</div>
            </div>
          ))}
          <textarea value={noteText} onChange={e => setNoteText(e.target.value)} rows={2} placeholder="Add an internal note" style={{ ...input, marginTop: '10px', resize: 'vertical' }} />
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '8px' }}>
            <button style={{ ...primaryBtn, opacity: postingNote || !noteText.trim() ? 0.6 : 1 }} disabled={postingNote || !noteText.trim()} onClick={postNote}>{postingNote ? 'Saving…' : 'Add note'}</button>
          </div>
        </div>
      </div>
    );
  }

  // ═══════════ LIST ═══════════
  const chip = (key: PricingRequestStage | 'active' | 'all', text: string, n?: number) => (
    <button key={key} onClick={() => setStageFilter(key)} style={{
      padding: '5px 10px', borderRadius: '999px', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
      border: `1px solid ${stageFilter === key ? '#2563eb' : theme.border}`,
      background: stageFilter === key ? 'rgba(37,99,235,0.12)' : 'transparent',
      color: stageFilter === key ? '#60a5fa' : theme.textSecondary,
    }}>{text}{n ? ` ${n}` : ''}</button>
  );

  return (
    <div style={{ maxWidth: '1000px', margin: '0 auto', padding: '16px' }}>
      {header('Pricing Requests', 'Masterack pricing requests, from the email to the PO')}
      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '10px' }}>
        {chip('active', 'Active')}
        {STAGE_ORDER.map(s => chip(s, STAGE_META[s].label, counts[s]))}
        {chip('all', 'All')}
      </div>
      <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search company, number, part #, PO…" style={{ ...input, marginBottom: '12px' }} />
      {loadError && <div style={{ ...card, color: '#f87171' }}>{loadError}</div>}
      {loadingList ? (
        <div style={{ color: theme.textMuted, fontSize: '13px' }}>Loading…</div>
      ) : shown.length === 0 ? (
        <div style={{ ...card, color: theme.textMuted, fontSize: '13px' }}>
          {requests.length === 0 ? 'No pricing requests yet. Use + New request when Masterack emails one.' : 'Nothing matches.'}
        </div>
      ) : (
        <div style={{ display: 'grid', gap: '8px' }}>
          {shown.map(r => (
            <button key={r.id} onClick={() => go({ id: r.id })} style={{ ...card, marginBottom: 0, textAlign: 'left', cursor: 'pointer', width: '100%', display: 'flex', gap: '12px', alignItems: 'center' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '14px', fontWeight: 800, color: theme.textPrimary }}>{r.company_name}</span>
                  <StageBadge stage={r.stage} />
                </div>
                <div style={{ fontSize: '12px', color: theme.textMuted, marginTop: '3px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {[r.request_number, r.customer_name, fmtDate(r.received_date), r.vehicle, r.po_number ? `PO ${r.po_number}` : null, [r.part_number, r.install_part_number].filter(Boolean).join(' / ') || null].filter(Boolean).join(' · ')}
                </div>
              </div>
              <div style={{ fontSize: '14px', fontWeight: 800, color: theme.textPrimary, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                {r.sheet?.grand_total ? fmtMoney(r.sheet.grand_total) : ''}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
