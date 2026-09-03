'use client';

/**
 * The Purchase Order record — one PO on its own page. The PO list is a thin
 * table that links here: everything its old expand-in-place card could do
 * lives on this page instead — header facts, Edit PO (customer resolution,
 * ship-to, dates, status), NetSuite sales order creation, invoicing open
 * quantities, print / CSV export, line items (edit / add / delete, per-line
 * graphics jobs and add-to-catalog), invoices with the billing check
 * verdict, PDF attachments, and @mention notes.
 *
 * Route: /admin/pos/<uuid>
 */

import { useState, useEffect, useRef } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';
import { storage, storageDownloadUrl } from '@/lib/storage';
import { resolvePoCustomer } from '@/lib/customer-match';
import { formatShipTo, shipToCityLabel } from '@/lib/graphics-job-from-po';
import { openNetSuitePdf } from '@/lib/netsuite-pdf-client';
import CustomerPicker from '@/components/CustomerPicker';
import MentionTextArea, { reportMentions } from '@/components/MentionTextArea';
import { PartLabel } from '@/components/PartLabel';
import { DropZone } from '@/components/DropZone';
import EmailInvoicesModal, { type EmailableInvoice } from '@/components/EmailInvoicesModal';
import { printPo, downloadPoCsv } from '@/lib/po-print';
import { findOrCreateManualPart } from '@/lib/parts-catalog';
import { deepLinks } from '@/lib/deep-links';
import type { PurchaseOrder, POLineItem, PoLocation, GraphicsJobStatus } from '@/lib/types';
import { GRAPHICS_STATUS_LABELS, GRAPHICS_STATUS_COLORS } from '@/lib/types';
import NumberInput from '@/components/NumberInput';

type ShipTo = NonNullable<PurchaseOrder['ship_to']>;

interface PoInvoiceRow {
  id?: string;
  netsuite_invoice_id: string;
  netsuite_invoice_number: string | null;
  ns_status?: string | null;
  due_date?: string | null;
  memo: string | null;
  total_qty: number | null;
  line_count: number | null;
  created_at: string | null;
}

interface PoNoteRow {
  id: string;
  po_id: string;
  author_id: string | null;
  body: string;
  mentions: string[];
  created_at: string;
}

interface PoFileRow {
  id: string;
  po_id: string;
  file_name: string;
  file_type: string | null;
  file_size: number | null;
  storage_path: string;
  source: 'pdf_upload' | 'email_import' | null;
  uploaded_at: string;
}

// A graphics job linked back to this PO (whole-PO jobs have a null line item id)
interface PoGfxJob {
  id: string;
  job_number: string | null;
  title: string | null;
  status: GraphicsJobStatus;
  po_id: string;
  po_line_item_id: string | null;
}

type PoRecord = PurchaseOrder & {
  line_items: POLineItem[];
  po_invoices: PoInvoiceRow[];
  netsuite_invoice_id?: string | null;
  netsuite_invoice_number?: string | null;
  netsuite_so_id?: string | null;
  netsuite_so_number?: string | null;
};

// A netsuite_parts row matched to one of this PO's lines — powers the
// per-line "in catalog / add to catalog" state without loading the whole
// (unbounded) catalog client-side.
interface CatalogPartRow { id: string; item_number: string; catalog: string | null }

const STATUS_META: Record<string, { label: string; color: string }> = {
  open: { label: 'Open', color: '#60a5fa' },
  complete: { label: 'Fulfilled', color: '#4ade80' },
  closed: { label: 'Closed', color: '#94a3b8' },
  cancelled: { label: 'Cancelled', color: '#9ca3af' },
};

const fmt = (n: number) => '$' + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const fmtDate = (d: string | null | undefined) => {
  if (!d) return '—';
  const m = String(d).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${Number(m[2])}/${Number(m[3])}/${m[1]}`;
  return String(d);
};

const card: React.CSSProperties = { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '14px', padding: '14px 16px' };
const eyebrow: React.CSSProperties = { fontSize: '10px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.6px', color: 'var(--text-muted)', marginBottom: '8px' };
const btnSm: React.CSSProperties = { padding: '6px 12px', borderRadius: '8px', fontSize: '11px', fontWeight: 700, cursor: 'pointer', background: 'var(--subtle-bg)', border: '1px solid var(--border)', color: 'var(--text-secondary)', whiteSpace: 'nowrap', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '5px' };
const labelStyle: React.CSSProperties = { display: 'block', fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '4px' };
const inputStyle: React.CSSProperties = { width: '100%', padding: '8px 10px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '12.5px' };
const th: React.CSSProperties = { fontSize: '10px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--text-muted)', padding: '7px 8px', borderBottom: '1px solid var(--border)', textAlign: 'left', whiteSpace: 'nowrap' };
const td: React.CSSProperties = { fontSize: '12.5px', color: 'var(--text-secondary)', padding: '7px 8px', borderBottom: '1px solid var(--border)', verticalAlign: 'middle' };
const num: React.CSSProperties = { textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };

// Debounced server-side part search (netsuite_parts is unbounded — never
// load it whole client-side; a limited ilike query sidesteps the 1000-row
// PostgREST cap entirely). Pick a hit to prefill part number + price.
interface PartHit { id: string; item_number: string; display_name: string | null; sales_price: number | null }
function PartSearchInput({ onPick }: { onPick: (p: PartHit) => void }) {
  const supabase = createClient();
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<PartHit[]>([]);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    // Strip PostgREST .or() syntax chars so free text can't break the filter.
    const query = q.trim().replace(/[,%_()]/g, ' ').replace(/\s+/g, ' ').trim();
    if (query.length < 2) { setHits([]); return; }
    debounceRef.current = setTimeout(async () => {
      const { data } = await supabase
        .from('netsuite_parts')
        .select('id, item_number, display_name, sales_price')
        .eq('is_active', true)
        .or(`item_number.ilike.%${query}%,display_name.ilike.%${query}%`)
        .order('item_number')
        .limit(15);
      setHits((data as PartHit[]) || []);
    }, 250);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- supabase client is stable across renders
  }, [q]);

  return (
    <div>
      <input
        value={q}
        onChange={e => setQ(e.target.value)}
        placeholder="Search catalog by part # or name…"
        style={inputStyle}
      />
      {hits.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '6px', maxHeight: '200px', overflowY: 'auto' }}>
          {hits.map(h => (
            <button
              key={h.id}
              type="button"
              onClick={() => { onPick(h); setQ(''); setHits([]); }}
              style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px',
                padding: '7px 9px', borderRadius: '8px', textAlign: 'left', width: '100%',
                background: 'var(--input-bg)', border: '1px solid var(--border)', cursor: 'pointer',
              }}
            >
              <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)' }}>
                {h.item_number}
                {h.display_name && <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}> — {h.display_name}</span>}
              </span>
              <span style={{ fontSize: '11px', color: 'var(--text-muted)', flexShrink: 0 }}>{fmt(Number(h.sales_price) || 0)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Inline equivalent of the PO list's local ShipToPicker: pick a saved
// location or type a one-off address, with a save-as-location shortcut.
function ShipToFields({
  locations, selectedId, shipTo, onSelect, onChange, onSaveLocation,
}: {
  locations: PoLocation[];
  selectedId: string;
  shipTo: ShipTo;
  onSelect: (id: string) => void;
  onChange: (next: ShipTo) => void;
  onSaveLocation: () => void;
}) {
  const hasAddress = !!(shipTo.name || shipTo.address || shipTo.city);
  const matchesExisting = locations.some(l =>
    (l.name || '').trim() === (shipTo.name || '').trim() &&
    (l.address || '') === (shipTo.address || '') &&
    (l.city || '') === (shipTo.city || '') &&
    (l.state || '') === (shipTo.state || '') &&
    (l.zip || '') === (shipTo.zip || '')
  );
  const showSave = !selectedId && hasAddress && !matchesExisting;
  return (
    <div>
      <label style={labelStyle}>Ship To</label>
      <select value={selectedId} onChange={e => onSelect(e.target.value)} style={{ ...inputStyle, marginBottom: '6px' }}>
        <option value="">— Select a saved location or enter custom below —</option>
        {locations.map(l => (
          <option key={l.id} value={l.id}>
            {l.name}{l.city ? ` (${l.city}${l.state ? `, ${l.state}` : ''})` : ''}
          </option>
        ))}
      </select>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '6px' }}>
        <input placeholder="Name" value={shipTo.name || ''} onChange={e => onChange({ ...shipTo, name: e.target.value })} style={inputStyle} />
        <input placeholder="Street address" value={shipTo.address || ''} onChange={e => onChange({ ...shipTo, address: e.target.value })} style={inputStyle} />
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: '6px' }}>
          <input placeholder="City" value={shipTo.city || ''} onChange={e => onChange({ ...shipTo, city: e.target.value })} style={inputStyle} />
          <input placeholder="State" value={shipTo.state || ''} onChange={e => onChange({ ...shipTo, state: e.target.value })} style={inputStyle} />
          <input placeholder="ZIP" value={shipTo.zip || ''} onChange={e => onChange({ ...shipTo, zip: e.target.value })} style={inputStyle} />
        </div>
      </div>
      {showSave && (
        <button
          type="button"
          onClick={onSaveLocation}
          style={{ marginTop: '6px', padding: '6px 10px', borderRadius: '6px', background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.3)', color: '#22c55e', fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}
        >
          + Save this address as a location
        </button>
      )}
    </div>
  );
}

export default function PoRecordPage() {
  const router = useRouter();
  const params = useParams();
  const { user, profile, isAdmin, loading: authLoading } = useAuth();
  const supabase = createClient();
  const dialog = useDialog();

  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [po, setPo] = useState<PoRecord | null>(null);
  const [gfxJobs, setGfxJobs] = useState<PoGfxJob[]>([]);
  const [poFiles, setPoFiles] = useState<PoFileRow[]>([]);
  const [poNotes, setPoNotes] = useState<PoNoteRow[]>([]);
  const [locations, setLocations] = useState<PoLocation[]>([]);
  const [teamProfiles, setTeamProfiles] = useState<{ id: string; full_name: string | null; email: string }[]>([]);

  // ── Edit PO ──────────────────────────────────────────────────────────────
  const [editingPo, setEditingPo] = useState(false);
  const [editPoForm, setEditPoForm] = useState({ po_number: '', customer: '', customer_netsuite_id: null as string | null, status: '' as string, ordered_date: '', requested_delivery_date: '', notes: '' });
  const [editShipToId, setEditShipToId] = useState('');
  const [editShipTo, setEditShipTo] = useState<ShipTo>({});
  const [savingPo, setSavingPo] = useState(false);

  // ── Line items ───────────────────────────────────────────────────────────
  const [editLineId, setEditLineId] = useState<string | null>(null);
  const [editLineForm, setEditLineForm] = useState({ part_number: '', quantity: '', unit_price: '', installed: '' });
  const [addLineOpen, setAddLineOpen] = useState(false);
  const [addLineForm, setAddLineForm] = useState({ part_number: '', quantity: '1', unit_price: '' });
  const [addingLine, setAddingLine] = useState(false);

  // ── Notes ────────────────────────────────────────────────────────────────
  const [noteText, setNoteText] = useState('');
  const [noteTags, setNoteTags] = useState<Set<string>>(new Set());
  const [postingNote, setPostingNote] = useState(false);

  // ── Files ────────────────────────────────────────────────────────────────
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadingPdf, setUploadingPdf] = useState(false);
  const [pdfPreview, setPdfPreview] = useState<{ url: string; name: string } | null>(null);
  const [extractingShipTo, setExtractingShipTo] = useState(false);

  // ── Invoices ─────────────────────────────────────────────────────────────
  const [rechecking, setRechecking] = useState(false);

  // ── NetSuite sales order (ported from the PO list's expanded card) ───────
  const [creatingSO, setCreatingSO] = useState(false);
  const [soResult, setSoResult] = useState<any | null>(null);

  // ── Invoice from OPEN quantities (ported from the PO list) ───────────────
  // Lines not yet complete, prefilled with quantity − installed, editable
  // before the invoice is created. Completed lines never enter this invoice.
  const [invoiceOpenVisible, setInvoiceOpenVisible] = useState(false);
  const [invoiceOpenQtys, setInvoiceOpenQtys] = useState<Record<string, number>>({});
  const [creatingOpenInvoice, setCreatingOpenInvoice] = useState(false);
  // Fresh invoice → straight into the shared email screen (same modal the
  // Invoicing hub and Scans page use).
  const [emailTarget, setEmailTarget] = useState<{ customerName: string; invoices: EmailableInvoice[] } | null>(null);

  // ── Per-line catalog state (ported from the PO list) ─────────────────────
  const [catalogParts, setCatalogParts] = useState<CatalogPartRow[]>([]);
  const [addingToCatalog, setAddingToCatalog] = useState<string | null>(null); // part_number being added
  const [catalogAddResults, setCatalogAddResults] = useState<Record<string, 'added' | 'error'>>({});

  const shapePo = (row: any): PoRecord => ({
    ...row,
    line_items: row.po_line_items || [],
    po_invoices: ((row.po_invoices || []) as PoInvoiceRow[]).slice().sort((a, b) =>
      new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime()
    ),
  });

  const loadStarted = useRef(false);
  useEffect(() => {
    if (authLoading) return;
    // Cold boot in a fresh tab: auth can briefly report "done" with a user
    // but no profile row (roles) yet — wait for it so a legitimate admin
    // deep link isn't bounced to /home. Re-runs when the profile lands.
    if (user && !profile) return;
    if (!isAdmin) { router.push('/home'); return; }
    if (loadStarted.current) return;
    loadStarted.current = true;
    load();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once when auth + profile resolve
  }, [authLoading, user, profile]);

  const load = async () => {
    const id = String(params?.id || '');
    if (!id) { setNotFound(true); setLoading(false); return; }

    const { data } = await supabase
      .from('purchase_orders')
      .select('*, po_line_items(*), po_invoices(*)')
      .eq('id', id)
      .maybeSingle();
    if (!data) { setNotFound(true); setLoading(false); return; }
    setPo(shapePo(data));
    setLoading(false);

    // Children load after the record renders — each card degrades to empty.
    const [gfxRes, filesRes, notesRes, locRes, profRes] = await Promise.all([
      supabase.from('graphics_jobs')
        .select('id, job_number, title, status, po_id, po_line_item_id')
        .eq('po_id', id).neq('status', 'cancelled'),
      supabase.from('po_files').select('*').eq('po_id', id).order('uploaded_at', { ascending: false }),
      supabase.from('po_notes').select('*').eq('po_id', id).order('created_at', { ascending: true }),
      supabase.from('po_locations').select('*').eq('archived', false).order('name'),
      supabase.from('profiles').select('id, full_name, email, role, roles, status').eq('status', 'approved'),
    ]);
    setGfxJobs((gfxRes.data || []) as PoGfxJob[]);
    setPoFiles((filesRes.data || []) as PoFileRow[]);
    setPoNotes((notesRes.data || []) as PoNoteRow[]);
    setLocations((locRes.data || []) as PoLocation[]);
    // Only ADMINS are taggable on PO notes — never CNI installers or other
    // roles (roles may live in the legacy `role` column or the `roles` array).
    setTeamProfiles(
      ((profRes.data || []) as any[]).filter(p => p.role === 'admin' || (Array.isArray(p.roles) && p.roles.includes('admin'))),
    );

    // Catalog matches for the per-line "Add to Catalog" state: linked part
    // ids plus exact item-number matches for unlinked lines. A rare
    // case-insensitive miss just shows the Add button — clicking it goes
    // through findOrCreateManualPart, which dedupes case-insensitively.
    const lineRows = (data.po_line_items || []) as POLineItem[];
    const partIds = [...new Set(lineRows.map(l => l.part_id).filter((v): v is string => !!v))];
    const partNums = [...new Set(lineRows.map(l => l.part_number).filter(Boolean))];
    const [byIdRes, byNumRes] = await Promise.all([
      partIds.length > 0
        ? supabase.from('netsuite_parts').select('id, item_number, catalog').in('id', partIds)
        : Promise.resolve({ data: [] as any[] }),
      partNums.length > 0
        ? supabase.from('netsuite_parts').select('id, item_number, catalog').eq('is_active', true).in('item_number', partNums)
        : Promise.resolve({ data: [] as any[] }),
    ]);
    const partRows = new Map<string, CatalogPartRow>();
    for (const p of ([...(byIdRes.data || []), ...(byNumRes.data || [])] as CatalogPartRow[])) partRows.set(p.id, p);
    setCatalogParts([...partRows.values()]);
  };

  const loadPoFiles = async (poId: string) => {
    const { data } = await supabase.from('po_files').select('*').eq('po_id', poId).order('uploaded_at', { ascending: false });
    setPoFiles((data || []) as PoFileRow[]);
  };

  const profileName = (id: string | null): string => {
    if (!id) return 'Someone';
    const p = teamProfiles.find(t => t.id === id);
    return p?.full_name || p?.email || 'Someone';
  };

  // ── Edit PO (same writes as the list's saveEditPO) ───────────────────────
  const startEditPO = () => {
    if (!po) return;
    setEditPoForm({
      po_number: po.po_number,
      customer: po.customer,
      customer_netsuite_id: po.customer_netsuite_id || null,
      status: po.status,
      ordered_date: po.ordered_date ? po.ordered_date.slice(0, 10) : '',
      requested_delivery_date: po.requested_delivery_date ? po.requested_delivery_date.slice(0, 10) : '',
      notes: po.notes || '',
    });
    const ship = po.ship_to || {};
    setEditShipTo({ ...ship });
    const match = locations.find(l =>
      (l.name || '').trim() === (ship.name || '').trim() &&
      (l.address || '') === (ship.address || '') &&
      (l.city || '') === (ship.city || '') &&
      (l.state || '') === (ship.state || '') &&
      (l.zip || '') === (ship.zip || '')
    );
    setEditShipToId(match ? match.id : '');
    setEditingPo(true);
  };

  const applyLocationToShipTo = (locId: string) => {
    setEditShipToId(locId);
    if (!locId) return;
    const loc = locations.find(l => l.id === locId);
    if (!loc) return;
    setEditShipTo({ name: loc.name, address: loc.address || '', city: loc.city || '', state: loc.state || '', zip: loc.zip || '' });
  };

  const saveShipToAsLocation = async () => {
    const defaultName = (editShipTo.name || editShipTo.address || '').trim();
    const name = await dialog.prompt('Name this location (e.g., "St. Louis Branch"):', defaultName);
    if (!name?.trim()) return;
    try {
      const { data, error } = await supabase.from('po_locations').insert({
        name: name.trim(),
        address: (editShipTo.address || '').trim() || null,
        city: (editShipTo.city || '').trim() || null,
        state: (editShipTo.state || '').trim() || null,
        zip: (editShipTo.zip || '').trim() || null,
        created_by: user?.id,
      }).select().single();
      if (error) throw error;
      const loc = data as PoLocation;
      setLocations(prev => [...prev, loc].sort((a, b) => a.name.localeCompare(b.name)));
      setEditShipToId(loc.id);
    } catch (err: any) {
      await dialog.alert('Failed to save location: ' + (err?.message || 'unknown error'));
    }
  };

  const saveEditPO = async () => {
    if (!po || savingPo) return;
    setSavingPo(true);
    const hasShipTo = Object.values(editShipTo).some(v => (v || '').toString().trim());
    // The picker resolves as the user types/picks/creates; fall back to
    // re-resolving free text typed without clicking a suggestion — either
    // way customer_netsuite_id is always written alongside the name.
    const { customer, customerNetsuiteId } = editPoForm.customer_netsuite_id
      ? { customer: editPoForm.customer, customerNetsuiteId: editPoForm.customer_netsuite_id }
      : await resolvePoCustomer(supabase, editPoForm.customer);
    const update = {
      po_number: editPoForm.po_number,
      customer,
      customer_netsuite_id: customerNetsuiteId,
      status: editPoForm.status as PurchaseOrder['status'],
      ship_to: hasShipTo ? editShipTo : null,
      ordered_date: editPoForm.ordered_date || null,
      requested_delivery_date: editPoForm.requested_delivery_date || null,
      notes: editPoForm.notes.trim() || null,
    };
    const { error } = await supabase.from('purchase_orders').update(update).eq('id', po.id);
    setSavingPo(false);
    if (error) { await dialog.alert(`Could not save: ${error.message}`); return; }
    setPo(prev => (prev ? { ...prev, ...update } : prev));
    setEditingPo(false);
  };

  const closePO = async () => {
    if (!po) return;
    const { error } = await supabase.from('purchase_orders').update({ status: 'closed' }).eq('id', po.id);
    if (error) { await dialog.alert(`Could not close the PO: ${error.message}`); return; }
    setPo(prev => (prev ? { ...prev, status: 'closed' } : prev));
  };

  const reopenPO = async () => {
    if (!po) return;
    const { error } = await supabase.from('purchase_orders').update({ status: 'open' }).eq('id', po.id);
    if (error) { await dialog.alert(`Could not reopen the PO: ${error.message}`); return; }
    setPo(prev => (prev ? { ...prev, status: 'open' } : prev));
  };

  const deletePO = async () => {
    if (!po) return;
    if (!(await dialog.confirm(`Delete PO #${po.po_number} and all its line items? This cannot be undone.`, { destructive: true, confirmLabel: 'Delete' }))) return;
    try {
      const res = await fetch('/api/pos/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ poIds: [po.id] }),
      });
      const data = await res.json();
      if (data.success) router.push('/admin/pos');
      else await dialog.alert(`Failed to delete PO: ${data.results?.[0]?.error || data.error || 'Unknown error'}`);
    } catch {
      await dialog.alert('Delete failed — please try again');
    }
  };

  // ── Graphics jobs (same deep link as the list's openCreateGfxJob) ────────
  const openCreateGfxJob = (lineItemId?: string) => {
    if (!po) return;
    router.push(`/graphics?new=1&fromPo=${po.id}${lineItemId ? `&poLine=${lineItemId}` : ''}`);
  };

  // ── Line items ───────────────────────────────────────────────────────────
  const startEditLine = (li: POLineItem) => {
    setEditLineId(li.id);
    setEditLineForm({ part_number: li.part_number || '', quantity: li.quantity.toString(), unit_price: li.unit_price.toString(), installed: li.installed.toString() });
  };

  const saveEditLine = async () => {
    if (!po || !editLineId) return;
    const partNum = editLineForm.part_number.trim();
    const qty = parseInt(editLineForm.quantity) || 1;
    const price = parseFloat(editLineForm.unit_price) || 0;
    const installed = parseInt(editLineForm.installed) || 0;
    const { error } = await supabase
      .from('po_line_items')
      .update({ part_number: partNum, quantity: qty, unit_price: price, installed })
      .eq('id', editLineId);
    if (error) { await dialog.alert(`Could not save the line: ${error.message}`); return; }
    setPo(prev => (prev ? {
      ...prev,
      line_items: prev.line_items.map(li => li.id === editLineId ? { ...li, part_number: partNum, quantity: qty, unit_price: price, installed } : li),
    } : prev));
    setEditLineId(null);
  };

  const saveAddLine = async () => {
    if (!po || addingLine) return;
    const partNum = addLineForm.part_number.trim();
    if (!partNum) { await dialog.alert('Enter or pick a part number'); return; }
    const qty = parseInt(addLineForm.quantity) || 1;
    const price = parseFloat(addLineForm.unit_price) || 0;
    setAddingLine(true);
    // Link the catalog part when the number matches, mirroring the list's
    // add-line: ilike fetches a case-insensitive superset, exact match in JS.
    let partId: string | null = null;
    try {
      const { data: candidates } = await supabase
        .from('netsuite_parts')
        .select('id, item_number')
        .ilike('item_number', partNum);
      const exact = ((candidates as any[]) || []).find(c => (c.item_number || '').toUpperCase() === partNum.toUpperCase());
      partId = exact?.id || null;
    } catch { /* part link is best-effort */ }
    const { data, error } = await supabase
      .from('po_line_items')
      .insert({
        po_id: po.id,
        ...(partId ? { part_id: partId } : {}),
        part_number: partNum,
        quantity: qty,
        unit_price: price,
      })
      .select()
      .single();
    setAddingLine(false);
    if (error || !data) { await dialog.alert('Error adding line: ' + (error?.message || 'unknown')); return; }
    setPo(prev => (prev ? { ...prev, line_items: [...prev.line_items, data as POLineItem] } : prev));
    // Keep the form open with cleared fields so several parts can be added
    // back-to-back. Done closes it.
    setAddLineForm({ part_number: '', quantity: '1', unit_price: '' });
  };

  const deleteLine = async (li: POLineItem) => {
    if (!po) return;
    if (!(await dialog.confirm(`Remove ${li.part_number} from this PO?`, { destructive: true, confirmLabel: 'Remove' }))) return;
    try {
      const res = await fetch('/api/pos/delete-line', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lineId: li.id }),
      });
      const data = await res.json();
      if (data.success) {
        setPo(prev => (prev ? { ...prev, line_items: prev.line_items.filter(x => x.id !== li.id) } : prev));
      } else {
        await dialog.alert(`Failed to delete line item: ${data.error || 'unknown error'}`);
      }
    } catch {
      await dialog.alert('Failed to delete line item');
    }
  };

  // ── Files (same storage flow as the list's manual PDF backfill) ──────────
  // Served through the download route so a save keeps the recorded file name;
  // the iframe preview and viewer tab follow its redirect the same as a raw
  // public URL.
  const fileUrl = (storagePath: string, name?: string | null) =>
    storageDownloadUrl('graphics-proofs', storagePath, name || '');

  // "Open in new tab" goes through the in-app viewer rather than at the raw
  // file: a bare PDF tab has no app chrome and no working Back button, which
  // left people stranded in it. The viewer's ← closes the tab back into this
  // record (or navigates here when the tab can't close itself).
  const pdfTabUrl = (url: string, name: string) =>
    deepLinks.pdfViewer(url, {
      name,
      back: po ? deepLinks.po(po.id) : '/admin/pos',
      backLabel: 'the PO',
    });

  // window.open (not a plain target="_blank") so the viewer tab keeps an
  // opener and may close itself; modifier-clicks keep native behavior.
  const openPdfTab = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    const href = e.currentTarget.href;
    e.preventDefault();
    // A blocked popup would leave the click doing nothing at all, so fall
    // back to a plain new tab (no opener — the viewer's ← navigates instead).
    if (!window.open(href, '_blank')) {
      const a = document.createElement('a');
      a.href = href; a.target = '_blank'; a.rel = 'noreferrer';
      a.click();
    }
  };

  const uploadPoPdfs = async (files: File[]) => {
    if (!po || files.length === 0 || !user || uploadingPdf) return;
    setUploadingPdf(true);
    let lastUpload: { path: string; name: string } | null = null;
    for (const file of files) {
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const path = `po-pdfs/${po.id}/${Date.now()}-${safeName}`;
      const { error: upErr } = await storage.from('graphics-proofs').upload(path, file, { contentType: file.type || 'application/pdf' });
      if (upErr) {
        await dialog.alert(`Could not upload ${file.name}: ${upErr.message}`);
        continue;
      }
      await supabase.from('po_files').insert({
        po_id: po.id,
        file_name: file.name,
        file_type: file.type || 'application/pdf',
        file_size: file.size,
        storage_path: path,
        source: 'pdf_upload',
        uploaded_by: user.id,
      });
      lastUpload = { path, name: file.name };
    }
    await loadPoFiles(po.id);
    setUploadingPdf(false);
    if (lastUpload) {
      // Pop the fresh upload into the preview, then mirror the Gmail import:
      // run the ship-to extraction so the PO's location fills itself in.
      setPdfPreview({ url: fileUrl(lastUpload.path, lastUpload.name), name: lastUpload.name });
      setExtractingShipTo(true);
      try {
        const res = await fetch('/api/pos/extract-ship-to', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ poId: po.id, storagePath: lastUpload.path }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.ship_to) {
          setPo(prev => (prev ? { ...prev, ship_to: data.ship_to } : prev));
        }
      } catch { /* best-effort — the PDF itself is already saved */ }
      setExtractingShipTo(false);
    }
  };

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (files.length > 0) uploadPoPdfs(files);
  };

  // ── Notes (same po_notes insert + mentions pipeline as the list) ─────────
  const postNote = async () => {
    if (!po) return;
    const body = noteText.trim();
    if (!body || postingNote) return;
    setPostingNote(true);
    const mentions = [...noteTags];
    const { data, error } = await supabase
      .from('po_notes')
      .insert({ po_id: po.id, author_id: user?.id || null, body, mentions })
      .select()
      .single();
    if (error || !data) {
      await dialog.alert(`Failed to post note: ${error?.message || 'no row returned'}`);
    } else {
      setPoNotes(prev => [...prev, data as PoNoteRow]);
      setNoteText('');
      setNoteTags(new Set());
      // Tag chips + any @names in the text both go through the mentions
      // pipeline: push/in-app notification plus a Mentions-inbox entry.
      reportMentions({
        text: body,
        sourceType: 'po_note',
        sourceId: po.id,
        contextLabel: `PO #${po.po_number}`,
        contextUrl: deepLinks.po(po.id),
        userIds: mentions,
      });
    }
    setPostingNote(false);
  };

  // ── Billing recheck (same endpoint as the list's per-PO recheck) ─────────
  const recheckBilling = async () => {
    if (!po || rechecking) return;
    setRechecking(true);
    try {
      const res = await fetch('/api/pos/verify-invoices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ poId: po.id }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        await dialog.alert(`Recheck failed: ${data.error || `request failed (${res.status})`}`);
      } else if (data.po) {
        setPo(shapePo(data.po));
        const links = data.links || {};
        const bits: string[] = [];
        if (links.linked) bits.push(`${links.linked} new invoice${links.linked !== 1 ? 's' : ''} linked`);
        if (links.unlinked) bits.push(`${links.unlinked} removed (no longer in NetSuite)`);
        const status = data.po.invoice_check_status;
        const verdict = status === 'attention'
          ? '⚠ Billing still needs attention — see the flagged lines.'
          : status === 'no_invoices'
            ? 'No invoices are linked to this PO now.'
            : '✓ Billed quantities match this PO now.';
        await dialog.alert(`Rechecked PO #${po.po_number}. ${bits.length ? bits.join(', ') + '. ' : ''}${verdict}`);
      }
    } catch (err: any) {
      await dialog.alert(`Recheck failed: ${err?.message || 'network error'}`);
    }
    setRechecking(false);
  };

  // ── NetSuite sales order (same endpoint as the list's expanded card) ─────
  const createNetSuiteSO = async () => {
    if (!po || creatingSO) return;
    setCreatingSO(true);
    try {
      const res = await fetch('/api/netsuite/create-sales-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ poId: po.id }),
      });
      const data = await res.json();

      if (!res.ok || data.error) {
        setSoResult({ status: 'error', error: data.error || 'Failed' });
      } else {
        setSoResult(data);
        // Update the local PO with the NetSuite SO info
        if (data.salesOrderId) {
          setPo(prev => (prev
            ? { ...prev, netsuite_so_id: data.salesOrderId, netsuite_so_number: data.salesOrderNumber }
            : prev));
        }
      }
    } catch (err: any) {
      setSoResult({ status: 'error', error: err.message || 'Network error' });
    }
    setCreatingSO(false);
  };

  // ── Invoice from open quantities (same endpoint as the list had) ─────────
  const openInvoiceModal = () => {
    if (!po) return;
    const qtys: Record<string, number> = {};
    for (const li of po.line_items) {
      const open = li.quantity - (li.installed || 0);
      if (open > 0) qtys[li.id] = open;
    }
    setInvoiceOpenQtys(qtys);
    setInvoiceOpenVisible(true);
  };

  const createOpenQtyInvoice = async () => {
    if (!po) return;
    // Key by PO line id, not part number: a part can be on several lines and
    // the server validates/bills each line against its own open quantity.
    const quantities: Record<string, number> = {};
    for (const li of po.line_items) {
      const q = invoiceOpenQtys[li.id];
      if (q && q > 0) quantities[li.id] = q;
    }
    if (Object.keys(quantities).length === 0) {
      await dialog.alert('Every line is at 0 — nothing to invoice.');
      return;
    }
    setCreatingOpenInvoice(true);
    try {
      // Direct NetSuite invoice — deliberately NOT via a sales order;
      // FleetSuite bypasses SO creation entirely.
      const res = await fetch('/api/pos/invoice-open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ poId: po.id, quantities }),
      });
      const data = await res.json();
      const result = res.ok && data.success
        ? { invoiceId: data.invoiceId, invoiceNumber: data.invoiceNumber }
        : null;
      if (!result) {
        await dialog.alert(`Failed to create invoice: ${data.error || `request failed (${res.status})`}`);
      } else {
        const totalUnits = Object.values(quantities).reduce((a, b) => a + b, 0);
        // Invoice lines collapse by part+price on the server; mirror that here
        // so the optimistic line count matches what a reload shows.
        const billedLineCount = new Set(
          po.line_items
            .filter(li => (invoiceOpenQtys[li.id] || 0) > 0)
            .map(li => `${li.part_number.toUpperCase()}|${li.unit_price}`),
        ).size;
        setPo(prev => {
          if (!prev) return prev;
          const newInvoice: PoInvoiceRow = {
            netsuite_invoice_id: result.invoiceId != null ? String(result.invoiceId) : '',
            netsuite_invoice_number: result.invoiceNumber || null,
            created_at: new Date().toISOString(),
            total_qty: totalUnits,
            line_count: billedLineCount,
            memo: `PO #${prev.po_number} — open quantities`,
          };
          // Mirror the server: billed units consume the open quantity, and a
          // fully billed PO reads as fulfilled without a reload.
          const line_items = prev.line_items.map(li => {
            const billed = invoiceOpenQtys[li.id] || 0;
            return billed > 0
              ? { ...li, installed: Math.min((li.installed || 0) + billed, li.quantity) }
              : li;
          });
          const fulfilled = line_items.length > 0 && line_items.every(li => (li.installed || 0) >= li.quantity);
          return {
            ...prev,
            line_items,
            status: fulfilled && prev.status === 'open' ? 'complete' : prev.status,
            netsuite_invoice_id: result.invoiceId != null ? String(result.invoiceId) : prev.netsuite_invoice_id,
            netsuite_invoice_number: result.invoiceNumber || prev.netsuite_invoice_number,
            po_invoices: [newInvoice, ...prev.po_invoices],
          };
        });
        setInvoiceOpenVisible(false);
        if (result.invoiceNumber) {
          setEmailTarget({
            customerName: po.customer,
            invoices: [{
              invoiceId: result.invoiceId != null ? String(result.invoiceId) : undefined,
              invoiceNumber: result.invoiceNumber,
              po: po.po_number,
            }],
          });
        } else {
          // No invoice number back from NetSuite — nothing to attach, so the
          // email screen can't help; fall back to the plain confirmation.
          await dialog.alert(`Invoice created for PO #${po.po_number} (${totalUnits} unit${totalUnits !== 1 ? 's' : ''}).`);
        }
      }
    } catch (err: any) {
      await dialog.alert(`Failed to create invoice: ${err.message || 'network error'}`);
    }
    setCreatingOpenInvoice(false);
  };

  // ── Add a PO line item's part to the catalog (same flow as the list) ─────
  const addLineToCatalog = async (li: POLineItem) => {
    if (!po) return;
    setAddingToCatalog(li.part_number);
    try {
      const created = await findOrCreateManualPart(supabase, {
        partNumber: li.part_number,
        description: li.description || null,
        price: li.unit_price,
        customer: po.customer || null,
        graphicPackage: li.description || null,
      });
      if (!created) {
        setCatalogAddResults(prev => ({ ...prev, [li.part_number]: 'error' }));
      } else {
        setCatalogAddResults(prev => ({ ...prev, [li.part_number]: 'added' }));
        setCatalogParts(prev => prev.some(p => p.id === created.id)
          ? prev
          : [...prev, { id: created.id, item_number: created.part_number, catalog: created.catalog || null }]);
      }
    } catch {
      setCatalogAddResults(prev => ({ ...prev, [li.part_number]: 'error' }));
    }
    setAddingToCatalog(null);
  };

  // ── Render ───────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: '60px 0' }}>
        <div style={{ width: '32px', height: '32px', border: '3px solid var(--border)', borderTopColor: 'var(--navy)', borderRadius: '50%', margin: '0 auto', animation: 'spin 1s linear infinite' }} />
        <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '12px' }}>Loading purchase order…</div>
      </div>
    );
  }

  if (notFound || !po) {
    return (
      <div style={{ ...card, textAlign: 'center', padding: '40px 16px' }}>
        <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-secondary)' }}>Purchase order not found</div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '6px' }}>No purchase order matches this link.</div>
        <button onClick={() => router.push('/admin/pos')} style={{ ...btnSm, marginTop: '14px' }}>‹ Back to POs</button>
      </div>
    );
  }

  const statusMeta = STATUS_META[po.status] || { label: po.status, color: '#94a3b8' };
  const totalQty = po.line_items.reduce((s, li) => s + li.quantity, 0);
  const totalInstalled = po.line_items.reduce((s, li) => s + li.installed, 0);
  const totalValue = po.line_items.reduce((s, li) => s + li.quantity * li.unit_price, 0);
  const pct = totalQty > 0 ? (totalInstalled / totalQty) * 100 : 0;
  const cityLabel = shipToCityLabel(po.ship_to);
  const shipToText = formatShipTo(po.ship_to);
  const displayDate = new Date(po.ordered_date || po.created_at);

  // po_invoices carries counts/status, not dollar amounts — billed here is
  // invoice count + total invoiced units. Legacy single-invoice POs fall
  // back to the old netsuite_invoice_* fields, like the list card.
  const invoiceList: PoInvoiceRow[] = po.po_invoices.length > 0
    ? po.po_invoices
    : po.netsuite_invoice_id
      ? [{ netsuite_invoice_id: po.netsuite_invoice_id, netsuite_invoice_number: po.netsuite_invoice_number || null, created_at: null, total_qty: null, line_count: null, memo: null }]
      : [];
  const billedUnits = invoiceList.reduce((s, inv) => s + (inv.total_qty || 0), 0);
  const checkStatus = po.invoice_check_status;
  const check = po.invoice_check;
  const sortedLines = [...po.line_items].sort((a, b) => a.part_number.localeCompare(b.part_number, undefined, { numeric: true }) || a.id.localeCompare(b.id));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>

      {/* Hidden file input used by the Upload PDF buttons */}
      <input ref={fileInputRef} type="file" accept=".pdf,application/pdf" multiple onChange={handleFileInput} style={{ display: 'none' }} />

      {/* Header */}
      <div style={card}>
        <button onClick={() => router.push('/admin/pos')} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', padding: 0, marginBottom: '8px' }}>‹ POs</button>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          <div style={{ fontSize: '24px', fontWeight: 800, letterSpacing: '-0.5px', color: 'var(--text-primary)' }}>PO #{po.po_number}</div>
          <span style={{ fontSize: '10px', fontWeight: 800, padding: '3px 9px', borderRadius: '999px', background: `${statusMeta.color}1f`, color: statusMeta.color }}>
            {statusMeta.label}
          </span>
          {cityLabel && (
            <span title={shipToText || undefined} style={{ fontSize: '11px', fontWeight: 800, color: '#22d3ee', background: 'rgba(34,211,238,0.1)', border: '1px solid rgba(34,211,238,0.3)', padding: '1px 8px', borderRadius: '10px', whiteSpace: 'nowrap', maxWidth: '260px', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {cityLabel}
            </span>
          )}
          {gfxJobs.length > 0 && (
            <span
              onClick={() => router.push(`/graphics?editJob=${gfxJobs[0].id}`)}
              title={gfxJobs.map(j => `${j.job_number || j.id.slice(0, 8)} — ${GRAPHICS_STATUS_LABELS[j.status] || j.status}`).join('\n')}
              style={{ fontSize: '11px', fontWeight: 800, color: '#a78bfa', background: 'rgba(167,139,250,0.1)', border: '1px solid rgba(167,139,250,0.3)', padding: '1px 8px', borderRadius: '10px', whiteSpace: 'nowrap', cursor: 'pointer' }}
            >
              GFX{gfxJobs.length > 1 ? ` ×${gfxJobs.length}` : ''}
            </span>
          )}
        </div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>
          {po.customer}
          {po.customer_netsuite_id && (
            <span title="Matched to a NetSuite customer" style={{ color: '#4ade80', fontWeight: 700, marginLeft: '6px' }}>✓ NetSuite</span>
          )}
          {' '}· <span title={po.ordered_date ? 'PO date' : 'Imported date (no PO date on record)'}>{displayDate.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}</span>
          {' '}· {po.line_items.length} item{po.line_items.length !== 1 ? 's' : ''}
          {po.netsuite_so_number && <span style={{ color: '#a78bfa', marginLeft: '6px' }}>NS SO #{po.netsuite_so_number}</span>}
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '12px' }}>
          <button onClick={startEditPO} style={btnSm}>✎ Edit PO</button>
          {po.status === 'closed' ? (
            <button onClick={reopenPO} style={{ ...btnSm, color: '#60a5fa' }}>Reopen PO</button>
          ) : (
            <button onClick={closePO} style={{ ...btnSm, color: '#22c55e' }}>Close PO</button>
          )}
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploadingPdf}
            style={{ ...btnSm, color: '#60a5fa', opacity: uploadingPdf ? 0.6 : 1 }}
          >
            {uploadingPdf ? 'Uploading…' : '+ Upload PDF'}
          </button>
          <button
            onClick={() => openCreateGfxJob()}
            title="Opens the graphics job form prefilled from this PO — review and submit to create"
            style={{ ...btnSm, color: '#a78bfa' }}
          >
            + Graphics Job
          </button>
          {(() => {
            const hasSO = po.netsuite_so_id || soResult?.salesOrderId;
            const soError = soResult?.status === 'error';
            return (
              <button
                onClick={createNetSuiteSO}
                disabled={creatingSO}
                title="Create a NetSuite sales order from this PO"
                style={{ ...btnSm, color: soError ? '#ef4444' : '#a78bfa', opacity: creatingSO ? 0.6 : 1 }}
              >
                {creatingSO ? 'Creating...' : hasSO ? `NS SO #${po.netsuite_so_number || soResult?.salesOrderNumber || 'Created'}` : soError ? 'Retry NS SO' : 'Create NS SO'}
              </button>
            );
          })()}
          {po.line_items.some(li => (li.installed || 0) < li.quantity) && (
            <button
              onClick={openInvoiceModal}
              title="Invoice this PO's open (not yet installed) quantities directly in NetSuite"
              style={{ ...btnSm, color: '#34d399' }}
            >
              Invoice Open Qty ({po.line_items.reduce((s, li) => s + Math.max(0, li.quantity - (li.installed || 0)), 0)} units)
            </button>
          )}
          <button onClick={() => printPo(po, dialog.alert)} style={btnSm}>Print PO</button>
          <button
            onClick={() => downloadPoCsv(po)}
            disabled={po.line_items.length === 0}
            style={{ ...btnSm, opacity: po.line_items.length === 0 ? 0.5 : 1, cursor: po.line_items.length === 0 ? 'not-allowed' : 'pointer' }}
          >
            Download CSV
          </button>
          {isAdmin && (
            <button onClick={deletePO} style={{ ...btnSm, color: '#f87171' }}>Delete PO</button>
          )}
        </div>

        {soResult?.status === 'error' && (
          <div style={{ marginTop: '8px', padding: '6px 8px', borderRadius: '6px', background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.15)', fontSize: '10px', color: '#ef4444' }}>
            {soResult.error}
          </div>
        )}

        {soResult?.unmatchedParts?.length > 0 && soResult?.status !== 'error' && (
          <div style={{ marginTop: '8px', padding: '6px 8px', borderRadius: '6px', background: 'rgba(251,191,36,0.06)', border: '1px solid rgba(251,191,36,0.15)', fontSize: '10px', color: '#fbbf24' }}>
            Note: {soResult.unmatchedParts.length} part(s) not found in NetSuite: {soResult.unmatchedParts.join(', ')}
          </div>
        )}

        {/* Facts */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '10px', marginTop: '14px' }}>
          <div>
            <div style={labelStyle}>Ordered</div>
            <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>{fmtDate(po.ordered_date)}</div>
          </div>
          <div>
            <div style={labelStyle}>Requested delivery</div>
            <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>{fmtDate(po.requested_delivery_date)}</div>
          </div>
          {/* Buyer Information off the PO PDF (migration 256) — who sent it,
              and whether the automatic receipt confirmation reached them. */}
          <div>
            <div style={labelStyle}>Buyer</div>
            <div style={{ fontSize: '13px', fontWeight: 700, color: po.buyer_name || po.buyer_email ? 'var(--text-primary)' : 'var(--text-muted)' }}>
              {po.buyer_name || po.buyer_email || 'Not on the PO'}
            </div>
            {po.buyer_name && po.buyer_email && (
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{po.buyer_email}</div>
            )}
          </div>
          <div>
            <div style={labelStyle}>Confirmation</div>
            <div
              title={po.confirmation_sent_at ? `Sent ${new Date(po.confirmation_sent_at).toLocaleString()} to ${(po.confirmation_sent_to || []).join(', ')}` : 'The receipt confirmation goes out automatically when the PO’s lines are imported — to the buyer on the PDF, or the customer’s billing email.'}
              style={{ fontSize: '13px', fontWeight: 700, color: po.confirmation_sent_at ? '#34d399' : 'var(--text-muted)' }}
            >
              {po.confirmation_sent_at ? `Sent ${fmtDate(po.confirmation_sent_at)}` : 'Not sent'}
            </div>
            {po.confirmation_sent_at && (po.confirmation_sent_to || []).length > 0 && (
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{(po.confirmation_sent_to || []).join(', ')}</div>
            )}
          </div>
          <div>
            <div style={labelStyle}>PO total</div>
            <div style={{ fontSize: '13px', fontWeight: 800, color: '#60a5fa', fontVariantNumeric: 'tabular-nums' }}>{fmt(totalValue)}</div>
          </div>
          <div>
            <div style={labelStyle}>Billed</div>
            <div style={{ fontSize: '13px', fontWeight: 700, color: invoiceList.length > 0 ? '#34d399' : 'var(--text-muted)' }}>
              {invoiceList.length > 0
                ? `${invoiceList.length} invoice${invoiceList.length !== 1 ? 's' : ''}${billedUnits > 0 ? ` · ${billedUnits} unit${billedUnits !== 1 ? 's' : ''}` : ''}`
                : 'No invoices'}
            </div>
          </div>
        </div>

        {/* Ship to */}
        <div style={{ marginTop: '12px' }}>
          <div style={labelStyle}>Ship to</div>
          {shipToText ? (
            <div style={{ fontSize: '12.5px', color: 'var(--text-secondary)', whiteSpace: 'pre-line' }}>{shipToText}</div>
          ) : (
            <div style={{ fontSize: '12px', color: '#fbbf24', fontWeight: 600 }}>No location on this PO — set one via Edit PO.</div>
          )}
        </div>

        {/* PO notes field (edited via Edit PO) */}
        {po.notes && (
          <div style={{ marginTop: '10px' }}>
            <div style={labelStyle}>PO notes</div>
            <div style={{ fontSize: '12.5px', color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' }}>{po.notes}</div>
          </div>
        )}

        {/* Install progress */}
        <div style={{ marginTop: '12px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', marginBottom: '3px' }}>
            <span style={{ color: 'var(--text-muted)' }}>Progress</span>
            <span style={{ color: pct >= 100 ? '#4ade80' : '#60a5fa', fontWeight: 700 }}>{totalInstalled}/{totalQty}</span>
          </div>
          <div style={{ height: '6px', background: 'var(--subtle-bg)', borderRadius: '3px' }}>
            <div style={{ height: '100%', width: `${Math.min(pct, 100)}%`, background: pct >= 100 ? '#22c55e' : '#3b82f6', borderRadius: '3px', transition: 'width 0.3s' }} />
          </div>
        </div>
      </div>

      {/* Edit PO */}
      {editingPo && (
        <div style={card}>
          <div style={eyebrow}>Edit PO</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
            <div>
              <label style={labelStyle}>PO Number</label>
              <input value={editPoForm.po_number} onChange={e => setEditPoForm({ ...editPoForm, po_number: e.target.value })} style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>Customer</label>
              <CustomerPicker
                value={editPoForm.customer}
                netsuiteId={editPoForm.customer_netsuite_id}
                onChange={({ customer, customerNetsuiteId }) => setEditPoForm({ ...editPoForm, customer, customer_netsuite_id: customerNetsuiteId })}
              />
            </div>
          </div>
          <div style={{ marginTop: '8px' }}>
            <label style={labelStyle}>Status</label>
            <select value={editPoForm.status} onChange={e => setEditPoForm({ ...editPoForm, status: e.target.value })} style={inputStyle}>
              <option value="open">Open</option>
              <option value="complete">Fulfilled</option>
              <option value="cancelled">Cancelled</option>
              <option value="closed">Closed</option>
            </select>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginTop: '8px' }}>
            <div>
              <label style={labelStyle}>Ordered Date</label>
              <input type="date" value={editPoForm.ordered_date} onChange={e => setEditPoForm({ ...editPoForm, ordered_date: e.target.value })} style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>Requested Delivery</label>
              <input type="date" value={editPoForm.requested_delivery_date} onChange={e => setEditPoForm({ ...editPoForm, requested_delivery_date: e.target.value })} style={inputStyle} />
            </div>
          </div>
          <div style={{ marginTop: '8px' }}>
            <label style={labelStyle}>Notes</label>
            <textarea value={editPoForm.notes} onChange={e => setEditPoForm({ ...editPoForm, notes: e.target.value })} rows={2} style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }} />
          </div>
          <div style={{ marginTop: '8px' }}>
            <ShipToFields
              locations={locations}
              selectedId={editShipToId}
              shipTo={editShipTo}
              onSelect={applyLocationToShipTo}
              onChange={next => { setEditShipToId(''); setEditShipTo(next); }}
              onSaveLocation={saveShipToAsLocation}
            />
          </div>
          <div style={{ display: 'flex', gap: '6px', marginTop: '10px' }}>
            <button onClick={saveEditPO} disabled={savingPo} style={{ flex: 1, padding: '8px', borderRadius: '8px', background: '#22c55e', color: '#fff', fontSize: '12px', fontWeight: 700, border: 'none', cursor: 'pointer', opacity: savingPo ? 0.6 : 1 }}>{savingPo ? 'Saving…' : 'Save'}</button>
            <button onClick={() => setEditingPo(false)} style={{ flex: 1, padding: '8px', borderRadius: '8px', background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-secondary)', fontSize: '12px', fontWeight: 700, cursor: 'pointer' }}>Cancel</button>
          </div>
        </div>
      )}

      {/* Line items */}
      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '10px' }}>
          <div style={eyebrow}>Line items ({po.line_items.length})</div>
          {!addLineOpen && (
            <button onClick={() => { setEditLineId(null); setAddLineOpen(true); setAddLineForm({ part_number: '', quantity: '1', unit_price: '' }); }} style={{ ...btnSm, color: '#22c55e' }}>+ Add Line</button>
          )}
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '560px' }}>
            <thead>
              <tr>
                <th style={th}>Part #</th>
                <th style={th}>Description</th>
                <th style={{ ...th, ...num }}>Qty</th>
                <th style={{ ...th, ...num }}>Done</th>
                <th style={{ ...th, ...num }}>Unit Price</th>
                <th style={{ ...th, ...num }}>Total</th>
                <th style={th}></th>
              </tr>
            </thead>
            <tbody>
              {sortedLines.map(li => {
                if (editLineId === li.id) {
                  return (
                    <tr key={li.id}>
                      <td colSpan={7} style={td}>
                        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr auto auto', gap: '6px', alignItems: 'end' }}>
                          <div>
                            <label style={labelStyle}>Part Number</label>
                            <input value={editLineForm.part_number} onChange={e => setEditLineForm({ ...editLineForm, part_number: e.target.value })} style={{ ...inputStyle, fontWeight: 700 }} />
                          </div>
                          <div>
                            <label style={labelStyle}>Qty</label>
                            <input type="number" value={editLineForm.quantity} onChange={e => setEditLineForm({ ...editLineForm, quantity: e.target.value })} style={inputStyle} />
                          </div>
                          <div>
                            <label style={labelStyle}>Done</label>
                            <input type="number" value={editLineForm.installed} onChange={e => setEditLineForm({ ...editLineForm, installed: e.target.value })} style={inputStyle} />
                          </div>
                          <div>
                            <label style={labelStyle}>Unit Price</label>
                            <input type="number" step="0.01" value={editLineForm.unit_price} onChange={e => setEditLineForm({ ...editLineForm, unit_price: e.target.value })} style={inputStyle} />
                          </div>
                          <button onClick={saveEditLine} style={{ padding: '8px 12px', borderRadius: '6px', background: '#22c55e', color: '#fff', fontSize: '11px', fontWeight: 700, border: 'none', cursor: 'pointer' }}>✓</button>
                          <button onClick={() => setEditLineId(null)} style={{ padding: '8px 12px', borderRadius: '6px', background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-secondary)', fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}>✕</button>
                        </div>
                      </td>
                    </tr>
                  );
                }
                const lineGfxJob = gfxJobs.find(j => j.po_line_item_id === li.id) || null;
                const catalogMatch = catalogParts.find(p =>
                  p.id === li.part_id || p.item_number.toUpperCase() === li.part_number.toUpperCase()
                ) || null;
                const catalogAdded = catalogAddResults[li.part_number] === 'added';
                return (
                  <tr key={li.id}>
                    <td style={{ ...td, fontWeight: 700, color: 'var(--text-primary)', cursor: 'pointer' }} onClick={() => startEditLine(li)} title="Edit this line">{li.part_number}</td>
                    <td style={{ ...td, maxWidth: '260px' }}>
                      <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '11.5px', color: 'var(--text-muted)' }}>
                        <PartLabel partNumber={li.part_number} fallbackDescription={li.description} nameOnly />
                      </div>
                      <div style={{ marginTop: '4px', display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
                        {catalogMatch ? (
                          <button
                            onClick={() => router.push(`/parts?catalog=${catalogMatch.catalog || 'graphics'}&q=${encodeURIComponent(li.part_number)}`)}
                            title="Open this part in the Parts Catalog to edit it"
                            style={{ padding: '2px 8px', borderRadius: '4px', fontSize: '9px', fontWeight: 700, background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.25)', color: '#4ade80', cursor: 'pointer' }}
                          >
                            ✓ In catalog — edit ↗
                          </button>
                        ) : catalogAdded ? (
                          <span style={{ fontSize: '9px', color: '#4ade80', fontWeight: 600 }}>✓ In catalog</span>
                        ) : (
                          <button
                            onClick={() => addLineToCatalog(li)}
                            disabled={addingToCatalog === li.part_number}
                            style={{ padding: '2px 8px', borderRadius: '4px', fontSize: '9px', fontWeight: 700, background: 'rgba(251,191,36,0.1)', border: '1px solid rgba(251,191,36,0.3)', color: '#fbbf24', cursor: 'pointer' }}
                          >
                            {addingToCatalog === li.part_number ? 'Adding...' : '+ Add to Catalog'}
                          </button>
                        )}
                        {lineGfxJob ? (
                          <button
                            onClick={() => router.push(`/graphics?editJob=${lineGfxJob.id}`)}
                            title={`${lineGfxJob.job_number || 'Graphics job'} — ${GRAPHICS_STATUS_LABELS[lineGfxJob.status] || lineGfxJob.status}`}
                            style={{ padding: '2px 8px', borderRadius: '4px', fontSize: '9px', fontWeight: 700, background: 'rgba(167,139,250,0.08)', border: '1px solid rgba(167,139,250,0.25)', color: '#a78bfa', cursor: 'pointer' }}
                          >
                            ✓ Graphics job — view ↗
                          </button>
                        ) : (
                          <button
                            onClick={() => openCreateGfxJob(li.id)}
                            title="Opens the graphics job form prefilled from this line — review and submit to create"
                            style={{ padding: '2px 8px', borderRadius: '4px', fontSize: '9px', fontWeight: 700, background: 'rgba(167,139,250,0.1)', border: '1px solid rgba(167,139,250,0.3)', color: '#a78bfa', cursor: 'pointer' }}
                          >
                            + Graphics Job
                          </button>
                        )}
                      </div>
                    </td>
                    <td style={{ ...td, ...num, fontWeight: 600, cursor: 'pointer' }} onClick={() => startEditLine(li)}>{li.quantity}</td>
                    <td style={{ ...td, ...num, fontWeight: 700, color: li.installed >= li.quantity ? '#4ade80' : '#fbbf24' }}>{li.installed}</td>
                    <td style={{ ...td, ...num, cursor: 'pointer' }} onClick={() => startEditLine(li)}>{fmt(li.unit_price)}</td>
                    <td style={{ ...td, ...num, fontWeight: 700, color: 'var(--text-primary)' }}>{fmt(li.quantity * li.unit_price)}</td>
                    <td style={{ ...td, width: '24px' }}>
                      <button onClick={() => deleteLine(li)} title="Remove this line" style={{ background: 'none', border: 'none', color: '#f87171', fontSize: '14px', padding: 0, cursor: 'pointer' }}>×</button>
                    </td>
                  </tr>
                );
              })}
              {po.line_items.length === 0 && (
                <tr><td colSpan={7} style={{ ...td, color: 'var(--text-muted)' }}>No line items on this PO.</td></tr>
              )}
            </tbody>
            {po.line_items.length > 0 && (
              <tfoot>
                <tr>
                  <td style={{ ...td, fontWeight: 800, color: 'var(--text-primary)', borderBottom: 'none' }}>Total</td>
                  <td style={{ ...td, borderBottom: 'none' }}></td>
                  <td style={{ ...td, ...num, fontWeight: 700, borderBottom: 'none' }}>{totalQty}</td>
                  <td style={{ ...td, ...num, fontWeight: 700, borderBottom: 'none', color: totalInstalled >= totalQty ? '#4ade80' : '#60a5fa' }}>{totalInstalled}</td>
                  <td style={{ ...td, borderBottom: 'none' }}></td>
                  <td style={{ ...td, ...num, fontWeight: 800, color: '#60a5fa', borderBottom: 'none' }}>{fmt(totalValue)}</td>
                  <td style={{ ...td, borderBottom: 'none' }}></td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>

        {/* Add a line for a part the scan missed */}
        {addLineOpen && (
          <div style={{ marginTop: '10px', padding: '10px', borderRadius: '10px', background: 'var(--subtle-bg)', border: '1px solid var(--border)' }}>
            <div style={{ marginBottom: '6px' }}>
              <label style={labelStyle}>Search Catalog</label>
              <PartSearchInput onPick={p => setAddLineForm(prev => ({ ...prev, part_number: p.item_number, unit_price: String(Number(p.sales_price) || 0) }))} />
            </div>
            <div style={{ marginBottom: '6px' }}>
              <label style={labelStyle}>Part Number</label>
              <input value={addLineForm.part_number} onChange={e => setAddLineForm({ ...addLineForm, part_number: e.target.value })} placeholder="Type or pick a part…" style={{ ...inputStyle, fontWeight: 700 }} />
            </div>
            <div style={{ display: 'flex', gap: '6px', alignItems: 'end' }}>
              <div style={{ flex: 1 }}>
                <label style={labelStyle}>Qty</label>
                <input type="number" min={1} value={addLineForm.quantity} onChange={e => setAddLineForm({ ...addLineForm, quantity: e.target.value })} style={inputStyle} />
              </div>
              <div style={{ flex: 1 }}>
                <label style={labelStyle}>Unit Price</label>
                <input type="number" step="0.01" value={addLineForm.unit_price} onChange={e => setAddLineForm({ ...addLineForm, unit_price: e.target.value })} style={inputStyle} />
              </div>
              <button onClick={saveAddLine} disabled={addingLine || !addLineForm.part_number.trim()} style={{ padding: '8px 12px', borderRadius: '6px', background: '#22c55e', color: '#fff', fontSize: '11px', fontWeight: 700, border: 'none', opacity: addingLine || !addLineForm.part_number.trim() ? 0.5 : 1, cursor: addingLine ? 'default' : 'pointer' }}>{addingLine ? '…' : '✓ Add'}</button>
              <button onClick={() => setAddLineOpen(false)} style={{ padding: '8px 12px', borderRadius: '6px', background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-secondary)', fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}>Done</button>
            </div>
          </div>
        )}
      </div>

      {/* Invoices + billing status */}
      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '10px' }}>
          <div style={eyebrow}>Invoices ({invoiceList.length})</div>
          <button
            onClick={recheckBilling}
            disabled={rechecking}
            title="Re-pull this PO's invoices from NetSuite and re-run the billing check — use after fixing an invoice in NetSuite"
            style={{ ...btnSm, color: '#34d399', opacity: rechecking ? 0.6 : 1 }}
          >
            {rechecking ? 'Rechecking…' : '↻ Recheck billing'}
          </button>
        </div>
        {invoiceList.length === 0 ? (
          po.status === 'complete' && checkStatus === 'no_invoices' ? (
            <div style={{ fontSize: '12px', fontWeight: 700, color: '#fbbf24' }} title="This PO is fulfilled but has no invoices linked — nothing has been billed">
              ⚠ Not invoiced — this PO is fulfilled but nothing has been billed.
            </div>
          ) : (
            <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>No invoices linked to this PO yet.</div>
          )
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {invoiceList.map((inv, idx) => (
              <div key={inv.netsuite_invoice_id || idx} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', padding: '7px 9px', borderRadius: '8px', background: 'rgba(52,211,153,0.06)', border: '1px solid rgba(52,211,153,0.15)' }}>
                <div style={{ minWidth: 0 }}>
                  {/* Open OUR invoice view — most staff have no NetSuite login,
                      so the old system.netsuite.com link was a dead end (the
                      PDF button already goes through our proxy). Fall back to
                      NetSuite only when the invoice has no number to filter by. */}
                  {inv.netsuite_invoice_number ? (
                    <a
                      href={deepLinks.invoicesSent(inv.netsuite_invoice_number)}
                      style={{ color: '#34d399', fontWeight: 700, fontSize: '12px', textDecoration: 'none' }}
                    >
                      INV #{inv.netsuite_invoice_number}
                    </a>
                  ) : (
                    <a
                      href={`https://system.netsuite.com/app/accounting/transactions/custinvc.nl?id=${inv.netsuite_invoice_id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ color: '#34d399', fontWeight: 700, fontSize: '12px', textDecoration: 'none' }}
                    >
                      INV #{inv.netsuite_invoice_id}
                    </a>
                  )}
                  {(() => {
                    // Payment status from NetSuite, refreshed by the invoice
                    // sync sweeps and the Recheck button.
                    if (inv.ns_status === 'paid') {
                      return <span style={{ marginLeft: '6px', fontSize: '9px', fontWeight: 800, padding: '2px 6px', borderRadius: '5px', background: 'rgba(74,222,128,0.12)', color: '#4ade80' }}>PAID</span>;
                    }
                    if (inv.ns_status === 'open') {
                      const today = new Date().toISOString().slice(0, 10);
                      if (inv.due_date && inv.due_date < today) {
                        const days = Math.floor((Date.now() - new Date(inv.due_date + 'T12:00:00').getTime()) / 86_400_000);
                        return <span style={{ marginLeft: '6px', fontSize: '9px', fontWeight: 800, padding: '2px 6px', borderRadius: '5px', background: 'rgba(248,113,113,0.12)', color: '#f87171' }}>PAST DUE · {days}d</span>;
                      }
                      return <span style={{ marginLeft: '6px', fontSize: '9px', fontWeight: 800, padding: '2px 6px', borderRadius: '5px', background: 'rgba(96,165,250,0.12)', color: '#60a5fa' }}>OPEN</span>;
                    }
                    return null;
                  })()}
                  {inv.memo && <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px' }}>{inv.memo}</div>}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
                  <div style={{ textAlign: 'right' }}>
                    {inv.total_qty != null && <div style={{ fontSize: '11px', color: 'var(--text-secondary)', fontWeight: 600 }}>{inv.total_qty} unit{inv.total_qty !== 1 ? 's' : ''}</div>}
                    {inv.created_at && <div style={{ fontSize: '9px', color: 'var(--text-muted)' }}>{new Date(inv.created_at).toLocaleDateString([], { month: 'short', day: 'numeric' })}</div>}
                  </div>
                  <button
                    onClick={async () => {
                      const r = await openNetSuitePdf('invoice', String(inv.netsuite_invoice_id));
                      if (!r.ok) await dialog.alert(`Couldn't open the invoice PDF: ${r.error}`);
                    }}
                    title="Open the invoice PDF"
                    style={{ padding: '4px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700, background: 'rgba(52,211,153,0.12)', border: '1px solid rgba(52,211,153,0.35)', color: '#34d399', cursor: 'pointer', whiteSpace: 'nowrap' }}
                  >
                    PDF
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Billing check verdict — list every line that doesn't add up */}
        {checkStatus && check && invoiceList.length > 0 && (
          checkStatus !== 'attention' ? (
            <div style={{ marginTop: '8px', fontSize: '10px', color: '#34d399', fontWeight: 600 }}>
              ✓ Billed quantities match this PO (checked {new Date(check.checked_at).toLocaleDateString([], { month: 'short', day: 'numeric' })})
            </div>
          ) : (
            <div style={{ marginTop: '8px', padding: '8px', borderRadius: '8px', background: 'rgba(248,113,113,0.06)', border: '1px solid rgba(248,113,113,0.25)' }}>
              <div style={{ fontSize: '10px', fontWeight: 700, color: '#f87171', textTransform: 'uppercase', letterSpacing: '0.3px', marginBottom: '4px' }}>
                ⚠ Billing needs attention
              </div>
              {/* Same rule as the server check: under-billing only counts
                  against a fulfilled PO. */}
              {(check.lines || [])
                .filter(l => l.status === 'over' || l.status === 'extra' || (l.status === 'under' && po.status === 'complete'))
                .map((l, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', fontSize: '11px', padding: '2px 0', color: 'var(--text-secondary)' }}>
                    <span style={{ fontWeight: 700 }}>{l.part_number}</span>
                    <span style={{ color: l.status === 'under' ? '#fbbf24' : '#f87171', fontWeight: 600 }}>
                      {l.status === 'extra'
                        ? `invoiced ${l.invoiced} — not on this PO`
                        : `invoiced ${l.invoiced} of ${l.ordered} ordered${l.status === 'over' ? ' — over-billed' : ''}`}
                    </span>
                  </div>
                ))}
            </div>
          )
        )}
      </div>

      {/* Graphics jobs */}
      <div style={card}>
        <div style={eyebrow}>Graphics jobs ({gfxJobs.length})</div>
        {gfxJobs.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '10px' }}>
            {gfxJobs.map(j => (
              <div
                key={j.id}
                onClick={() => router.push(`/graphics?editJob=${j.id}`)}
                style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', padding: '7px 9px', borderRadius: '8px', background: 'rgba(167,139,250,0.06)', border: '1px solid rgba(167,139,250,0.15)', cursor: 'pointer' }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ color: '#a78bfa', fontWeight: 700, fontSize: '12px' }}>
                    {j.job_number || j.id.slice(0, 8)}
                    {!j.po_line_item_id && <span style={{ fontWeight: 400, color: 'var(--text-muted)', marginLeft: '6px', fontSize: '10px' }}>whole PO</span>}
                  </div>
                  {j.title && <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{j.title}</div>}
                </div>
                <span style={{ fontSize: '10px', fontWeight: 700, whiteSpace: 'nowrap', color: GRAPHICS_STATUS_COLORS[j.status] || 'var(--text-secondary)' }}>
                  {GRAPHICS_STATUS_LABELS[j.status] || j.status}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '10px' }}>
            No graphics jobs created from this PO yet.
          </div>
        )}
        <button
          onClick={() => openCreateGfxJob()}
          title="Opens the graphics job form prefilled from this PO — review and submit to create"
          style={{ width: '100%', padding: '10px', borderRadius: '8px', background: 'rgba(167,139,250,0.08)', border: '1px solid rgba(167,139,250,0.25)', color: '#a78bfa', fontSize: '12px', fontWeight: 700, cursor: 'pointer' }}
        >
          + Create Graphics Job ({po.line_items.length} part{po.line_items.length !== 1 ? 's' : ''})
        </button>
      </div>

      {/* PDF attachments */}
      <DropZone accept=".pdf,application/pdf" disabled={uploadingPdf} onFiles={uploadPoPdfs} style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '10px' }}>
          <div style={eyebrow}>PDF attachments ({poFiles.length})</div>
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploadingPdf}
            style={{ ...btnSm, color: '#60a5fa', opacity: uploadingPdf ? 0.6 : 1 }}
          >
            {uploadingPdf ? 'Uploading…' : '+ Upload PDF'}
          </button>
        </div>
        {poFiles.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {poFiles.map(f => (
              <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '7px 9px', borderRadius: '8px', background: 'var(--subtle-bg)', border: '1px solid var(--border)' }}>
                <button
                  type="button"
                  onClick={() => setPdfPreview({ url: fileUrl(f.storage_path, f.file_name), name: f.file_name })}
                  title="Preview this PDF"
                  style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left', background: 'none', border: 'none', padding: 0, fontSize: '11.5px', fontWeight: 600, color: '#60a5fa', cursor: 'pointer' }}
                >
                  {f.file_name}
                </button>
                {f.source && <span style={{ fontSize: '9px', color: 'var(--text-muted)', textTransform: 'uppercase' }}>{f.source === 'pdf_upload' ? 'PDF' : 'Email'}</span>}
                {f.file_size != null && <span style={{ fontSize: '9px', color: 'var(--text-muted)' }}>{(f.file_size / 1024).toFixed(0)}KB</span>}
                <a href={pdfTabUrl(fileUrl(f.storage_path, f.file_name), f.file_name)} onClick={openPdfTab} target="_blank" rel="noreferrer" title="Open in a new tab" style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textDecoration: 'none' }}>↗</a>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>No attachments. Upload or drop a PDF here.</div>
        )}
      </DropZone>

      {/* Notes — flag a PO that needs attention and tag teammates */}
      <div style={card}>
        <div style={eyebrow}>Notes ({poNotes.length})</div>
        {poNotes.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '8px' }}>
            {poNotes.map(n => (
              <div key={n.id} id={`po-note-${n.id}`} style={{ padding: '7px 9px', borderRadius: '8px', background: 'var(--subtle-bg)', border: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', marginBottom: '2px' }}>
                  <span style={{ fontSize: '11px', fontWeight: 700, color: '#fbbf24' }}>{profileName(n.author_id)}</span>
                  <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{new Date(n.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
                </div>
                <div style={{ fontSize: '12px', color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' }}>{n.body}</div>
                {(n.mentions || []).length > 0 && (
                  <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', marginTop: '4px' }}>
                    {n.mentions.map(id => (
                      <span key={id} style={{ fontSize: '10px', fontWeight: 700, color: '#60a5fa', background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.25)', padding: '0 6px', borderRadius: '8px' }}>
                        @{profileName(id)}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        <MentionTextArea
          value={noteText}
          onChange={setNoteText}
          placeholder="Add a note — @ tags a teammate, e.g. what needs fixing or attention…"
          rows={2}
          style={{ width: '100%', padding: '8px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '12px', resize: 'vertical' }}
        />
        <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', alignItems: 'center', marginTop: '6px' }}>
          <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 700 }}>Tag:</span>
          {teamProfiles.filter(p => p.id !== user?.id).map(p => {
            const tagged = noteTags.has(p.id);
            return (
              <button
                key={p.id}
                onClick={() => {
                  setNoteTags(prev => {
                    const next = new Set(prev);
                    if (next.has(p.id)) next.delete(p.id); else next.add(p.id);
                    return next;
                  });
                }}
                style={{
                  padding: '2px 8px', borderRadius: '10px', fontSize: '10px', fontWeight: 700, cursor: 'pointer',
                  background: tagged ? 'rgba(59,130,246,0.18)' : 'var(--subtle-bg)',
                  border: tagged ? '1px solid rgba(59,130,246,0.5)' : '1px solid var(--border)',
                  color: tagged ? '#60a5fa' : 'var(--text-muted)',
                }}
              >
                @{p.full_name || p.email}
              </button>
            );
          })}
          <button
            onClick={postNote}
            disabled={postingNote || !noteText.trim()}
            style={{
              marginLeft: 'auto', padding: '5px 14px', borderRadius: '8px', fontSize: '11px', fontWeight: 800,
              background: postingNote || !noteText.trim() ? 'var(--subtle-bg)' : '#f59e0b',
              color: postingNote || !noteText.trim() ? 'var(--text-muted)' : '#111',
              border: 'none', cursor: postingNote || !noteText.trim() ? 'default' : 'pointer',
            }}
          >
            {postingNote ? 'Posting…' : 'Post'}
          </button>
        </div>
      </div>

      {/* Invoice open quantities modal (ported from the PO list) */}
      {invoiceOpenVisible && (() => {
        const openLines = po.line_items.filter(li => (li.installed || 0) < li.quantity);
        const openUnits = openLines.reduce((s, li) => s + (invoiceOpenQtys[li.id] || 0), 0);
        const openValue = openLines.reduce((s, li) => s + (invoiceOpenQtys[li.id] || 0) * li.unit_price, 0);
        return (
          <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'var(--overlay)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' }}>
            <div style={{ background: 'var(--card)', border: '1px solid rgba(52,211,153,0.3)', borderRadius: '14px', padding: '18px', width: '100%', maxWidth: '560px', maxHeight: 'calc(85vh / var(--ts))', overflowY: 'auto' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '4px' }}>
                <div style={{ fontSize: '16px', fontWeight: 800, color: 'var(--text-primary)' }}>Invoice Open Quantities — PO #{po.po_number}</div>
                <button onClick={() => setInvoiceOpenVisible(false)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '18px', cursor: 'pointer', padding: '2px' }}>✕</button>
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '12px' }}>
                Prefilled with each line&apos;s open (not yet installed) quantity — adjust before creating. Completed lines are left off.
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {openLines.map(li => {
                  const open = li.quantity - (li.installed || 0);
                  return (
                    <div key={li.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 10px', borderRadius: '8px', background: 'var(--subtle-bg)', border: '1px solid var(--border)' }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>{li.part_number}</div>
                        <div style={{ fontSize: '11px', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {li.description || '—'} · open {open} of {li.quantity} · ${li.unit_price.toFixed(2)}/ea
                        </div>
                      </div>
                      <NumberInput
                        min={0}
                        max={open}
                        value={invoiceOpenQtys[li.id] ?? 0}
                        onChange={e => {
                          const v = Math.max(0, Math.min(open, parseInt(e.target.value) || 0));
                          setInvoiceOpenQtys(prev => ({ ...prev, [li.id]: v }));
                        }}
                        style={{ width: '76px', padding: '8px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '14px', fontWeight: 700, textAlign: 'right' }}
                      />
                    </div>
                  );
                })}
              </div>
              <div style={{ marginTop: '10px', padding: '8px 10px', borderRadius: '8px', background: 'rgba(52,211,153,0.06)', border: '1px solid rgba(52,211,153,0.2)', fontSize: '12px', fontWeight: 700, color: '#34d399' }}>
                {openUnits} unit{openUnits !== 1 ? 's' : ''} · ${openValue.toFixed(2)}
              </div>
              <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
                <button
                  onClick={createOpenQtyInvoice}
                  disabled={creatingOpenInvoice || openUnits === 0}
                  style={{
                    flex: 1, padding: '12px', borderRadius: '10px', border: 'none',
                    background: creatingOpenInvoice || openUnits === 0 ? 'var(--subtle-bg)' : '#10b981',
                    color: '#fff', fontWeight: 800, fontSize: '13px', cursor: 'pointer',
                    opacity: creatingOpenInvoice || openUnits === 0 ? 0.5 : 1,
                  }}
                >
                  {creatingOpenInvoice ? 'Creating…' : `Create Invoice (${openUnits} unit${openUnits !== 1 ? 's' : ''})`}
                </button>
                <button
                  onClick={() => setInvoiceOpenVisible(false)}
                  style={{ flex: 1, padding: '12px', borderRadius: '10px', background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-secondary)', fontWeight: 700, fontSize: '13px', cursor: 'pointer' }}
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Email the freshly created invoice (shared component) */}
      {emailTarget && (
        <EmailInvoicesModal
          customerName={emailTarget.customerName}
          invoices={emailTarget.invoices}
          onClose={() => setEmailTarget(null)}
        />
      )}

      {/* PDF preview modal */}
      {pdfPreview && (
        <div
          onClick={() => setPdfPreview(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{ background: 'var(--card)', borderRadius: '12px', width: 'min(960px, 100%)', height: 'min(calc(90vh / var(--ts)), 100%)', display: 'flex', flexDirection: 'column', border: '1px solid var(--border)', boxShadow: '0 24px 60px rgba(0,0,0,0.4)', overflow: 'hidden' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pdfPreview.name}</div>
                {extractingShipTo && <div style={{ fontSize: '11px', fontWeight: 600, color: '#60a5fa', marginTop: '2px' }}>Reading ship-to from PDF…</div>}
              </div>
              <div style={{ display: 'flex', gap: '8px', flexShrink: 0 }}>
                <a
                  href={pdfTabUrl(pdfPreview.url, pdfPreview.name)}
                  onClick={openPdfTab}
                  target="_blank"
                  rel="noreferrer"
                  style={{ padding: '6px 12px', borderRadius: '6px', fontSize: '11px', fontWeight: 700, background: 'rgba(96,165,250,0.12)', border: '1px solid rgba(96,165,250,0.3)', color: '#60a5fa', textDecoration: 'none' }}
                >Open in new tab ↗</a>
                <button
                  type="button"
                  onClick={() => setPdfPreview(null)}
                  aria-label="Close"
                  style={{ width: '32px', height: '32px', borderRadius: '8px', background: 'var(--subtle-bg)', border: '1px solid var(--border)', color: 'var(--text-muted)', fontSize: '16px', fontWeight: 700, cursor: 'pointer' }}
                >✕</button>
              </div>
            </div>
            <iframe src={pdfPreview.url} title={pdfPreview.name} style={{ flex: 1, width: '100%', border: 'none', background: '#525659' }} />
          </div>
        </div>
      )}
    </div>
  );
}
