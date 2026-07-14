'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import { parseMasterackPO, type ParsedPO, type ParsedPOLine } from '@/lib/parsePO';
import { resolvePoCustomer } from '@/lib/customer-match';
import { storage } from '@/lib/storage';
import type { PurchaseOrder, POLineItem, CatalogItem, PoLocation } from '@/lib/types';
import { PartLabel } from '@/components/PartLabel';
import { CreateNetsuiteItemModal } from '@/components/CreateNetsuiteItemModal';
import { useDialog } from '@/components/DialogProvider';

interface ImportLine extends ParsedPOLine {
  catalog_match: CatalogItem | null;
  use_catalog_price: boolean;
  final_price: number;
  include: boolean;
  // Fields for creating new catalog entry if unmatched
  new_end_customer: string;
  new_vehicle_type: string;
  new_graphic_package: string;
}

interface PoFile {
  id: string;
  po_id: string;
  file_name: string;
  file_type: string | null;
  file_size: number | null;
  storage_path: string;
  source: 'pdf_upload' | 'email_import' | null;
  uploaded_at: string;
}

function formatShipTo(shipTo: PurchaseOrder['ship_to']): string | null {
  if (!shipTo) return null;
  const lines = [
    shipTo.name,
    shipTo.address,
    [shipTo.city, shipTo.state].filter(Boolean).join(', '),
    shipTo.zip,
  ].map(s => (s || '').trim()).filter(Boolean);
  return lines.length > 0 ? lines.join('\n') : null;
}

function buildJobContent(lines: { part_number: string; description: string | null; quantity: number }[]): string | null {
  if (!lines.length) return null;
  return lines
    .map(li => {
      const desc = (li.description || '').trim();
      const head = desc ? `${li.part_number} — ${desc}` : li.part_number;
      return `${head} (Qty: ${li.quantity})`;
    })
    .join('\n');
}

function csvEscape(value: string | number | null | undefined): string {
  if (value == null) return '';
  const s = String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadPoCsv(po: PurchaseOrder & { line_items: POLineItem[] }) {
  const header = ['Part Number', 'Description', 'Quantity', 'Installed', 'Unit Price', 'Line Total'];
  const rows = po.line_items.map(li => [
    li.part_number,
    li.description || '',
    li.quantity,
    li.installed,
    li.unit_price.toFixed(2),
    (li.quantity * li.unit_price).toFixed(2),
  ]);
  const total = po.line_items.reduce((s, li) => s + li.quantity * li.unit_price, 0);
  rows.push(['', '', '', '', 'Total', total.toFixed(2)]);
  const csv = [header, ...rows].map(r => r.map(csvEscape).join(',')).join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `PO-${po.po_number || po.id}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

async function printPo(po: PurchaseOrder & { line_items: POLineItem[] }, alertFn: (message: string) => Promise<void>) {
  const ship = formatShipTo(po.ship_to);
  const total = po.line_items.reduce((s, li) => s + li.quantity * li.unit_price, 0);
  const escape = (s: string) => s.replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!
  ));
  const ordered = po.ordered_date ? new Date(po.ordered_date).toLocaleDateString() : '';
  const requested = po.requested_delivery_date ? new Date(po.requested_delivery_date).toLocaleDateString() : '';
  const linesHtml = po.line_items.map(li => `
    <tr>
      <td>${escape(li.part_number)}</td>
      <td>${escape(li.description || '')}</td>
      <td class="num">${li.quantity}</td>
      <td class="num">$${li.unit_price.toFixed(2)}</td>
      <td class="num">$${(li.quantity * li.unit_price).toFixed(2)}</td>
    </tr>`).join('');
  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>PO #${escape(po.po_number)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, Segoe UI, Helvetica, Arial, sans-serif; color: #111; margin: 32px; font-size: 12px; }
  h1 { margin: 0 0 4px 0; font-size: 22px; }
  .sub { color: #666; font-size: 12px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin: 20px 0 24px; }
  .box h3 { margin: 0 0 6px 0; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: #666; }
  .box .v { white-space: pre-line; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; }
  th, td { padding: 8px 10px; border-bottom: 1px solid #ddd; text-align: left; vertical-align: top; }
  th { background: #f4f4f4; font-size: 11px; text-transform: uppercase; letter-spacing: 0.4px; color: #333; }
  td.num, th.num { text-align: right; white-space: nowrap; }
  tfoot td { font-weight: 700; border-top: 2px solid #111; border-bottom: none; padding-top: 12px; }
  .notes { margin-top: 24px; padding: 12px; border: 1px solid #ddd; border-radius: 6px; background: #fafafa; }
  .notes h3 { margin: 0 0 6px 0; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: #666; }
  @media print { body { margin: 16px; } @page { margin: 0.5in; } }
</style>
</head>
<body>
  <h1>Purchase Order #${escape(po.po_number)}</h1>
  <div class="sub">${escape(po.customer)}${po.status ? ` · ${escape(po.status)}` : ''}</div>
  <div class="grid">
    <div class="box">
      <h3>Ship To</h3>
      <div class="v">${ship ? escape(ship) : '<span style="color:#999">—</span>'}</div>
    </div>
    <div class="box">
      <h3>Dates</h3>
      <div class="v">Ordered: ${escape(ordered) || '—'}${requested ? `\nRequested: ${escape(requested)}` : ''}</div>
    </div>
  </div>
  <table>
    <thead>
      <tr>
        <th>Part #</th>
        <th>Description</th>
        <th class="num">Qty</th>
        <th class="num">Unit Price</th>
        <th class="num">Total</th>
      </tr>
    </thead>
    <tbody>${linesHtml}</tbody>
    <tfoot>
      <tr>
        <td colspan="4" class="num">Total</td>
        <td class="num">$${total.toFixed(2)}</td>
      </tr>
    </tfoot>
  </table>
  ${po.notes ? `<div class="notes"><h3>Notes</h3>${escape(po.notes)}</div>` : ''}
</body>
</html>`;
  const w = window.open('', '_blank');
  if (!w) { await alertFn('Pop-up blocked. Allow pop-ups to print.'); return; }
  w.document.open();
  w.document.write(html);
  w.document.close();
  w.onload = () => { w.focus(); w.print(); };
}

// ── Unified parts catalog (phase 2) ──────────────────────────────────────
// The catalog the PO screen matches against is now netsuite_parts (the merged
// catalog), not the old `catalog` table. These helpers load it in the
// CatalogItem shape the screen already works in, and create manual (non-
// NetSuite) parts as source='manual' with a NULL netsuite_id so the NetSuite
// sync never deactivates them.
const PART_FIELDS =
  'id, item_number, catalog, customer, billable_customer, vehicle_type, graphic_package, sales_price, proof_pages, is_active';

function partToCatalogItem(p: any): CatalogItem {
  return {
    id: p.id,
    part_number: p.item_number,
    catalog: p.catalog === 'upfit' ? 'upfit' : 'graphics',
    customer: p.customer || '',
    end_customer: p.billable_customer || '',
    vehicle_type: p.vehicle_type || '',
    graphic_package: p.graphic_package || '',
    price: Number(p.sales_price) || 0,
    proof_pages: p.proof_pages ?? 1,
    active: p.is_active !== false,
  };
}

async function loadUnifiedCatalog(
  supabase: ReturnType<typeof createClient>,
): Promise<CatalogItem[]> {
  const { data } = await supabase
    .from('netsuite_parts')
    .select(PART_FIELDS)
    .eq('is_active', true)
    .order('item_number');
  return ((data as any[]) || []).map(partToCatalogItem);
}

// Find a part by item number (case-insensitive), creating a manual row if it
// doesn't exist yet. Returns it in CatalogItem shape (its id is a part_id).
async function findOrCreateManualPart(
  supabase: ReturnType<typeof createClient>,
  params: {
    partNumber: string;
    description?: string | null;
    price?: number;
    customer?: string | null;
    billableCustomer?: string | null;
    vehicleType?: string | null;
    graphicPackage?: string | null;
  },
): Promise<CatalogItem | null> {
  const partNumber = (params.partNumber || '').trim();
  if (!partNumber) return null;
  // ilike fetches a case-insensitive superset; narrow to an exact match in JS
  // so wildcard chars in a part number can't cause a false positive.
  const { data: candidates } = await supabase
    .from('netsuite_parts')
    .select(PART_FIELDS)
    .ilike('item_number', partNumber);
  const existing = ((candidates as any[]) || []).find(
    (c) => (c.item_number || '').toUpperCase() === partNumber.toUpperCase(),
  );
  if (existing) return partToCatalogItem(existing);

  const { data: created } = await supabase
    .from('netsuite_parts')
    .insert({
      netsuite_id: null,
      item_number: partNumber,
      display_name: params.description || partNumber,
      description: params.description || null,
      catalog: 'graphics',
      source: 'manual',
      sales_price: params.price || 0,
      customer: params.customer || null,
      billable_customer: params.billableCustomer || null,
      vehicle_type: params.vehicleType || null,
      graphic_package: params.graphicPackage || null,
      is_active: true,
    })
    .select(PART_FIELDS)
    .single();
  return created ? partToCatalogItem(created as any) : null;
}

// Upload the source PDF to R2 and record it on the PO so it stays attached
// to the record (and is visible on linked graphics jobs).
async function persistPoPdf(
  supabase: ReturnType<typeof createClient>,
  poId: string,
  file: File,
  uploadedBy: string | null,
): Promise<{ path: string; name: string } | null> {
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const path = `po-pdfs/${poId}/${Date.now()}-${safeName}`;
  const { error: upErr } = await storage.from('graphics-proofs').upload(path, file, { contentType: file.type || 'application/pdf' });
  if (upErr) {
    console.warn('PO PDF upload failed:', upErr);
    return null;
  }
  await supabase.from('po_files').insert({
    po_id: poId,
    file_name: file.name,
    file_type: file.type || 'application/pdf',
    file_size: file.size,
    storage_path: path,
    source: 'pdf_upload',
    uploaded_by: uploadedBy,
  });
  return { path, name: file.name };
}


export default function POsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { isAdmin, user } = useAuth();
  const dialog = useDialog();
  const supabase = createClient();

  const [pos, setPos] = useState<(PurchaseOrder & { line_items: POLineItem[]; po_invoices?: any[] })[]>([]);
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [poTab, setPoTab] = useState<'open' | 'closed'>('open');
  const [showCreate, setShowCreate] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [expandedPo, setExpandedPo] = useState<string | null>(null);
  // Deep-link target to briefly highlight after search/notification navigation.
  const [highlightPo, setHighlightPo] = useState<string | null>(null);
  const [editPoId, setEditPoId] = useState<string | null>(null);
  const [editPoForm, setEditPoForm] = useState({ po_number: '', customer: '', status: '' as string, ordered_date: '', requested_delivery_date: '', notes: '' });
  const [editLineId, setEditLineId] = useState<string | null>(null);
  const [editLineForm, setEditLineForm] = useState({ part_number: '', quantity: '', unit_price: '', installed: '' });
  // Add-a-line state: lets the user tack on a part the scan missed while
  // viewing a PO. Keyed by PO id so only one PO's form is open at a time.
  const [addLinePoId, setAddLinePoId] = useState<string | null>(null);
  const [addLineForm, setAddLineForm] = useState({ part_number: '', quantity: '1', unit_price: '' });
  const [addingLine, setAddingLine] = useState(false);
  const [form, setForm] = useState({ po_number: '', customer: 'Masterack', ordered_date: '', requested_delivery_date: '', notes: '' });
  const [lineItems, setLineItems] = useState<{ part_id: string | null; part_number: string; quantity: number; unit_price: number }[]>([]);
  // Staging form for adding a line while building a new PO — mirrors the
  // existing-PO "+ Add Line" form (catalog prefill + free-text fallback).
  const [createLineForm, setCreateLineForm] = useState({ part_number: '', quantity: '1', unit_price: '' });
  const fileRef = useRef<HTMLInputElement>(null);
  const [poSearch, setPoSearch] = useState('');

  // PDF Import state
  const [parsedPO, setParsedPO] = useState<ParsedPO | null>(null);
  const [parsedPdfFile, setParsedPdfFile] = useState<File | null>(null);
  const [importLines, setImportLines] = useState<ImportLine[]>([]);
  // PO files (PDFs) attached to each PO, lazy-loaded on expand
  const [poFiles, setPoFiles] = useState<Record<string, PoFile[]>>({});
  // Manual PO PDF backfill state
  const poFileInputRef = useRef<HTMLInputElement>(null);
  const [uploadingPoId, setUploadingPoId] = useState<string | null>(null);
  const [uploadingPoPdf, setUploadingPoPdf] = useState(false);
  // Auto-popped PDF preview (set after upload or when a file row is clicked)
  const [pdfPreview, setPdfPreview] = useState<{ url: string; name: string } | null>(null);
  // True while the AI ship-to extraction is running after an upload
  const [extractingShipTo, setExtractingShipTo] = useState(false);
  // PO list sort direction (by PO number)
  const [poSort, setPoSort] = useState<'asc' | 'desc'>('asc');
  const [parseError, setParseError] = useState('');
  const [importing, setImporting] = useState(false);
  const [pdfOverwriteExisting, setPdfOverwriteExisting] = useState<any>(null); // existing PO to overwrite

  // Gmail Import state
  const [showEmailImport, setShowEmailImport] = useState(false);
  const [emailLoading, setEmailLoading] = useState(false);
  const [emailEmails, setEmailEmails] = useState<any[]>([]);
  const [emailError, setEmailError] = useState('');
  const [emailNeedsAuth, setEmailNeedsAuth] = useState(false);
  const [importingEmailId, setImportingEmailId] = useState<string | null>(null);
  const [emailImportResults, setEmailImportResults] = useState<Record<string, any>>({});
  // PO overwrite confirmation state
  const [showOverwriteConfirm, setShowOverwriteConfirm] = useState(false);
  const [overwriteData, setOverwriteData] = useState<any>(null);
  const [overwriteMessageId, setOverwriteMessageId] = useState<string | null>(null);
  const [overwriting, setOverwriting] = useState(false);
  // Email PO review/edit state. `pdf` points at the original email attachment
  // (served by /api/gmail/attachment) so it can be shown beside the form.
  type ReviewItem = {
    messageId: string;
    extracted: any;
    pdf?: { url: string; name: string };
    // Which source PDFs belong to this PO (multi-PO emails) — sent back on
    // confirm so only those files attach to the created/updated PO.
    attachmentIds?: string[];
    queuePos?: { index: number; total: number };
  };
  const [reviewingExtraction, setReviewingExtraction] = useState<ReviewItem | null>(null);
  // Remaining reviews for a multi-PO email, shown one at a time after the current one
  const [reviewQueue, setReviewQueue] = useState<ReviewItem[]>([]);
  // Whether the source-PDF pane is showing; reset per open, defaults on for wide screens
  const [reviewPdfOpen, setReviewPdfOpen] = useState(false);
  const [reviewShipToId, setReviewShipToId] = useState<string>('');

  // URL that streams a Gmail PDF for same-origin preview. Without attachmentId
  // the API resolves the message's best PO PDF (by filename when given).
  const gmailPdfUrl = (messageId: string, attachmentId?: string, filename?: string) => {
    const params = new URLSearchParams({ messageId });
    if (attachmentId) params.set('attachmentId', attachmentId);
    if (filename) params.set('filename', filename);
    return `/api/gmail/attachment?${params.toString()}`;
  };

  // The extractor returns both the customer's item number (part_number) and
  // BMG's number from the PO's "Supplier Part" row (supplier_part). Our
  // internal part numbers always match the supplier part, and the import
  // endpoint prefers supplier_part when saving lines — so collapse the pair
  // into a single editable Part Number before review (supplier_part wins) and
  // drop supplier_part, otherwise edits to the visible field wouldn't stick.
  const collapseSupplierParts = (extracted: any) => ({
    ...extracted,
    lines: (extracted.lines || []).map(({ supplier_part, ...l }: any) => ({
      ...l,
      part_number: supplier_part || l.part_number,
    })),
  });
  // NetSuite item creation from a review line: holds the line being created; tracks created lines by index
  const [createNsItemLine, setCreateNsItemLine] = useState<{ idx: number; partNumber: string; description: string | null } | null>(null);
  const [createdNsLines, setCreatedNsLines] = useState<Set<number>>(new Set());
  // NetSuite SO creation state
  const [creatingSOForPo, setCreatingSOForPo] = useState<string | null>(null);
  const [soResults, setSoResults] = useState<Record<string, any>>({});
  // NetSuite Invoice state
  const [selectedForInvoice, setSelectedForInvoice] = useState<Set<string>>(new Set());
  const [creatingInvoices, setCreatingInvoices] = useState(false);
  const [invoiceResults, setInvoiceResults] = useState<any>(null);
  // Catalog add state for unmatched parts
  const [addingToCatalog, setAddingToCatalog] = useState<string | null>(null); // part_number being added
  const [catalogAddResults, setCatalogAddResults] = useState<Record<string, 'added' | 'error'>>({});
  // Create graphics job from PO line item
  const [creatingGfxJob, setCreatingGfxJob] = useState<string | null>(null); // line item id
  const [gfxJobResults, setGfxJobResults] = useState<Record<string, 'created' | 'error'>>({});
  // Create multi-part graphics job from entire PO
  const [creatingGfxJobForPo, setCreatingGfxJobForPo] = useState<string | null>(null); // po id
  // Gmail PO auto-import status — surfaced in a strip above the PO list so
  // it's obvious whether the hourly cron is finding emails / connected to
  // Gmail at all, without anyone having to dig through Vercel logs.
  const [gmailStatus, setGmailStatus] = useState<{
    gmailConnected: boolean;
    lastRunAt: string | null;
    lastResult: any | null;
    recentErrors?: any[];
  } | null>(null);
  const [gmailRunning, setGmailRunning] = useState(false);
  const [gmailRunMessage, setGmailRunMessage] = useState<string | null>(null);
  const [gmailErrorsOpen, setGmailErrorsOpen] = useState(false);
  // Batch delete state
  const [editMode, setEditMode] = useState(false);
  // Line item sort
  const [liSort, setLiSort] = useState<{ col: 'part_number' | 'quantity' | 'installed' | 'unit_price'; dir: 'asc' | 'desc' }>({ col: 'part_number', dir: 'asc' });
  const toggleLiSort = (col: typeof liSort.col) => {
    setLiSort(prev => prev.col === col ? { col, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { col, dir: 'asc' });
  };
  const liSortIndicator = (col: typeof liSort.col) => liSort.col === col ? (liSort.dir === 'asc' ? ' ▲' : ' ▼') : '';
  const sortLineItems = (items: POLineItem[]) => [...items].sort((a, b) => {
    const av = a[liSort.col]; const bv = b[liSort.col];
    const cmp = typeof av === 'string' ? av.localeCompare(bv as string) : (av as number) - (bv as number);
    return liSort.dir === 'asc' ? cmp : -cmp;
  });

  // Pending PO queue state
  const [pendingPOs, setPendingPOs] = useState<any[]>([]);
  const [pendingLoading, setPendingLoading] = useState(false);

  // Saved ship-to locations
  const [locations, setLocations] = useState<PoLocation[]>([]);
  const [showLocations, setShowLocations] = useState(false);
  const [locationForm, setLocationForm] = useState({ id: '', name: '', address: '', city: '', state: '', zip: '' });
  const [locationSaving, setLocationSaving] = useState(false);
  const [createShipToId, setCreateShipToId] = useState<string>('');
  const [createShipTo, setCreateShipTo] = useState<NonNullable<PurchaseOrder['ship_to']>>({});
  const [editShipToId, setEditShipToId] = useState<string>('');
  const [editShipTo, setEditShipTo] = useState<NonNullable<PurchaseOrder['ship_to']>>({});

  function applyLocationToShipTo(locId: string, setShipToId: (s: string) => void, setShipTo: (s: NonNullable<PurchaseOrder['ship_to']>) => void) {
    setShipToId(locId);
    if (!locId) return;
    const loc = locations.find(l => l.id === locId);
    if (!loc) return;
    setShipTo({
      name: loc.name,
      address: loc.address || '',
      city: loc.city || '',
      state: loc.state || '',
      zip: loc.zip || '',
    });
  }

  async function saveLocation() {
    if (!locationForm.name.trim()) { await dialog.alert('Location name is required'); return; }
    setLocationSaving(true);
    try {
      const payload = {
        name: locationForm.name.trim(),
        address: locationForm.address.trim() || null,
        city: locationForm.city.trim() || null,
        state: locationForm.state.trim() || null,
        zip: locationForm.zip.trim() || null,
      };
      if (locationForm.id) {
        const { data, error } = await supabase
          .from('po_locations').update(payload).eq('id', locationForm.id).select().single();
        if (error) throw error;
        setLocations(prev => prev.map(l => l.id === locationForm.id ? (data as PoLocation) : l));
      } else {
        const { data, error } = await supabase
          .from('po_locations').insert({ ...payload, created_by: user?.id }).select().single();
        if (error) throw error;
        setLocations(prev => [...prev, data as PoLocation].sort((a, b) => a.name.localeCompare(b.name)));
      }
      setLocationForm({ id: '', name: '', address: '', city: '', state: '', zip: '' });
    } catch (err: any) {
      await dialog.alert('Failed to save location: ' + (err?.message || 'unknown error'));
    } finally {
      setLocationSaving(false);
    }
  }

  async function saveShipToAsLocation(
    shipTo: NonNullable<PurchaseOrder['ship_to']>,
    setSelectedId: (id: string) => void,
  ) {
    const defaultName = (shipTo.name || shipTo.address || '').trim();
    const name = await dialog.prompt('Name this location (e.g., "St. Louis Branch"):', defaultName);
    if (!name?.trim()) return;
    try {
      const { data, error } = await supabase
        .from('po_locations')
        .insert({
          name: name.trim(),
          address: (shipTo.address || '').trim() || null,
          city: (shipTo.city || '').trim() || null,
          state: (shipTo.state || '').trim() || null,
          zip: (shipTo.zip || '').trim() || null,
          created_by: user?.id,
        })
        .select()
        .single();
      if (error) throw error;
      const loc = data as PoLocation;
      setLocations(prev => [...prev, loc].sort((a, b) => a.name.localeCompare(b.name)));
      setSelectedId(loc.id);
    } catch (err: any) {
      await dialog.alert('Failed to save location: ' + (err?.message || 'unknown error'));
    }
  }

  async function archiveLocation(id: string) {
    if (!(await dialog.confirm('Remove this location from the picker? Past POs that reference it keep their address.', { destructive: true, confirmLabel: 'Remove' }))) return;
    const { error } = await supabase.from('po_locations').update({ archived: true }).eq('id', id);
    if (error) { await dialog.alert('Failed: ' + error.message); return; }
    setLocations(prev => prev.filter(l => l.id !== id));
  }

  const reviewPendingPO = (pending: any) => {
    if (pending.raw_extraction) {
      // attachment_filename is a comma-joined list, importer's best candidate first
      const firstPdfName = (pending.attachment_filename || '').split(',')[0].trim();
      setReviewPdfOpen(window.innerWidth >= 1000);
      setReviewingExtraction({
        messageId: pending.message_id,
        extracted: collapseSupplierParts(pending.raw_extraction),
        pdf: { url: gmailPdfUrl(pending.message_id, undefined, firstPdfName || undefined), name: firstPdfName || 'PO PDF' },
      });
    }
  };

  const dismissPendingPO = async (id: string) => {
    const pending = pendingPOs.find(p => p.id === id);
    if (pending?.message_id) {
      await fetch('/api/gmail/dismiss-po', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId: pending.message_id }),
      });
    }
    setPendingPOs(prev => prev.filter(p => p.id !== id));
  };
  const [selectedForDelete, setSelectedForDelete] = useState<Set<string>>(new Set());
  const [deletingBatch, setDeletingBatch] = useState(false);
  const [backfillingCustomers, setBackfillingCustomers] = useState(false);

  // One-time maintenance: resolve every PO's free-text customer to a real
  // NetSuite customer (id + canonical name) and flow it to their graphics jobs.
  const backfillCustomers = async () => {
    if (!(await dialog.confirm(
      'Link all POs to real NetSuite customers? Each PO\'s customer name is matched to the NetSuite customer record (e.g. "Masterack" becomes "Masterack LLC") and its graphics jobs are updated too. Names that don\'t match exactly one customer are left unchanged.'
    ))) return;
    setBackfillingCustomers(true);
    try {
      const res = await fetch('/api/pos/backfill-customers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok) {
        await dialog.alert(`Backfill failed: ${data.error || `HTTP ${res.status}`}`);
      } else {
        const unmatchedNote = data.unmatched?.length
          ? `\n\nCouldn't match (left as-is): ${data.unmatched.map((u: any) => `${u.name} (${u.count} PO${u.count !== 1 ? 's' : ''})`).join(', ')}`
          : '';
        await dialog.alert(
          `Linked ${data.matched} of ${data.scanned} PO${data.scanned !== 1 ? 's' : ''} to NetSuite customers and updated ${data.updatedGraphicsJobs} graphics job${data.updatedGraphicsJobs !== 1 ? 's' : ''}.${unmatchedNote}`
        );
        window.location.reload();
        return;
      }
    } catch (e: any) {
      await dialog.alert(`Backfill failed: ${e.message}`);
    }
    setBackfillingCustomers(false);
  };

  useEffect(() => {
    if (!isAdmin) { router.push('/home'); return; }
    const load = async () => {
      const { data: poData } = await supabase
        .from('purchase_orders')
        .select('*, po_line_items(*), po_invoices(*)')
        .order('created_at', { ascending: false });

      const FILTERED_CUSTOMERS = ['ranger design', 'enterprise fleet management', 'bmg fleet installations'];
      const mapped = (poData || [])
        .filter((po: any) => !FILTERED_CUSTOMERS.some(fc => po.customer?.toLowerCase().includes(fc)))
        .map((po: any) => ({
          ...po,
          line_items: po.po_line_items || [],
          po_invoices: (po.po_invoices || []).sort((a: any, b: any) =>
            new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
          ),
        }));
      setPos(mapped);

      setCatalog(await loadUnifiedCatalog(supabase));
      setLoading(false);

      // Load pending PO queue
      const { data: pending } = await supabase
        .from('gmail_po_imports')
        .select('*')
        .eq('status', 'pending')
        .order('created_at', { ascending: false });
      setPendingPOs(pending || []);

      const { data: locs } = await supabase
        .from('po_locations')
        .select('*')
        .eq('archived', false)
        .order('name');
      setLocations((locs as PoLocation[]) || []);
    };
    load();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  }, [isAdmin]);

  const refreshGmailStatus = async () => {
    try {
      const res = await fetch('/api/gmail/auto-import-status');
      if (res.ok) setGmailStatus(await res.json());
    } catch {}
  };

  useEffect(() => {
    if (!isAdmin) return;
    refreshGmailStatus();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional
  }, [isAdmin]);

  const runGmailImportNow = async () => {
    setGmailRunning(true);
    setGmailRunMessage(null);
    try {
      const res = await fetch('/api/gmail/auto-import?manual=true');
      const text = await res.text();
      let body: any = null;
      try { body = JSON.parse(text); } catch {}
      if (!res.ok) {
        setGmailRunMessage(`HTTP ${res.status}: ${body?.error || text.slice(0, 200)}`);
      } else if (body?.syncStateWrite && body.syncStateWrite.ok === false) {
        setGmailRunMessage(`Run completed but sync_state write failed: ${body.syncStateWrite.error}`);
      } else if (body) {
        const found = body.results ? body.results.length : (typeof body.imported === 'number' ? body.imported + (body.skipped || 0) + (body.errors || 0) : 0);
        setGmailRunMessage(`Run completed: ${found} processed · ${body.imported ?? 0} imported · ${body.skipped ?? 0} skipped · ${body.errors ?? 0} errors`);
      }
    } catch (err: any) {
      setGmailRunMessage(`Request failed: ${err?.message || 'unknown'}`);
    }
    await refreshGmailStatus();
    setGmailRunning(false);
  };

  // Auto-open PO from URL param (deep link from notifications/search): switch to
  // the right tab, clear any filter, expand it, then scroll to + highlight it so
  // it's not buried somewhere down the list.
  useEffect(() => {
    if (loading) return;
    const poId = searchParams.get('id');
    if (!poId) return;
    const target = pos.find(p => p.id === poId);
    if (!target) return;
    setPoTab(target.status === 'closed' ? 'closed' : 'open');
    setPoSearch('');
    setExpandedPo(poId);
    setHighlightPo(poId);
    const clear = setTimeout(() => setHighlightPo(null), 2500);
    // Defer the scroll so the right tab/expanded row is in the DOM first.
    setTimeout(() => {
      document.getElementById(`po-row-${poId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 200);
    return () => clearTimeout(clear);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: deep-link once after load
  }, [loading, searchParams]);

  useEffect(() => {
    if (!reviewingExtraction) { setReviewShipToId(''); return; }
    const ship = reviewingExtraction.extracted.ship_to || {};
    const match = locations.find(l =>
      (l.name || '').trim() === (ship.name || '').trim() &&
      (l.address || '') === (ship.address || '') &&
      (l.city || '') === (ship.city || '') &&
      (l.state || '') === (ship.state || '') &&
      (l.zip || '') === (ship.zip || '')
    );
    setReviewShipToId(match ? match.id : '');
  // eslint-disable-next-line react-hooks/exhaustive-deps -- only fire on review change
  }, [reviewingExtraction?.messageId, locations]);

  useEffect(() => {
    if (!showCreate) return;
    if (createShipToId) return;
    if (Object.values(createShipTo).some(v => (v || '').toString().trim())) return;
    // Prefix match: the form's short names ("Masterack") still find POs whose
    // customer was canonicalized to the NetSuite name ("Masterack LLC").
    const lastWithShipTo = pos.find(p =>
      p.customer?.toLowerCase().startsWith(form.customer.toLowerCase()) && p.ship_to
    );
    if (!lastWithShipTo?.ship_to) return;
    const ship = lastWithShipTo.ship_to;
    const match = locations.find(l =>
      (l.name || '').trim() === (ship.name || '').trim() &&
      (l.address || '') === (ship.address || '') &&
      (l.city || '') === (ship.city || '') &&
      (l.state || '') === (ship.state || '') &&
      (l.zip || '') === (ship.zip || '')
    );
    if (match) {
      setCreateShipToId(match.id);
      setCreateShipTo({
        name: match.name,
        address: match.address || '',
        city: match.city || '',
        state: match.state || '',
        zip: match.zip || '',
      });
    } else {
      setCreateShipTo({ ...ship });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- only fire on customer or open
  }, [showCreate, form.customer]);

  // PDF Upload handler
  const handlePDFUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setParseError('');
    setParsedPO(null);
    setImportLines([]);

    try {
      const parsed = await parseMasterackPO(file);
      if (!parsed.po_number) {
        setParseError('Could not find PO number in PDF');
        return;
      }
      if (parsed.lines.length === 0) {
        setParseError('No line items found in PDF');
        return;
      }

      // Check for duplicate PO — if exists, prompt for overwrite instead of blocking
      const existing = pos.find((p) => p.po_number === parsed.po_number);
      if (existing) {
        setPdfOverwriteExisting(existing);
      } else {
        setPdfOverwriteExisting(null);
      }

      // Match lines to catalog
      const lines: ImportLine[] = parsed.lines.map((line) => {
        const match = catalog.find((c) =>
          c.part_number.toUpperCase() === line.part_number.toUpperCase()
        );
        const poPrice = line.unit_price;
        const catPrice = match?.price || 0;
        return {
          ...line,
          catalog_match: match || null,
          use_catalog_price: catPrice > 0,
          final_price: catPrice > 0 ? catPrice : poPrice,
          include: true,
          new_end_customer: '',
          new_vehicle_type: '',
          new_graphic_package: line.description || '',
        };
      });

      setParsedPO(parsed);
      setParsedPdfFile(file);
      setImportLines(lines);
    } catch (err: any) {
      setParseError('Error parsing PDF: ' + (err.message || 'Unknown error'));
    }

    if (fileRef.current) fileRef.current.value = '';
  };

  const toggleLineInclude = (idx: number) => {
    setImportLines((prev) => prev.map((l, i) => i === idx ? { ...l, include: !l.include } : l));
  };

  const togglePriceSource = (idx: number) => {
    setImportLines((prev) => prev.map((l, i) => {
      if (i !== idx) return l;
      const useCatalog = !l.use_catalog_price;
      return {
        ...l,
        use_catalog_price: useCatalog,
        final_price: useCatalog ? (l.catalog_match?.price || l.unit_price) : l.unit_price,
      };
    }));
  };

  const updateFinalPrice = (idx: number, price: string) => {
    setImportLines((prev) => prev.map((l, i) => i === idx ? { ...l, final_price: parseFloat(price) || 0 } : l));
  };

  const handleImportPO = async () => {
    if (!parsedPO || !user) return;
    const linesToImport = importLines.filter((l) => l.include);
    if (linesToImport.length === 0) return;

    setImporting(true);

    // Resolve to a real NetSuite customer (canonical name + internal id) so
    // it flows through to graphics jobs / sales orders / invoices.
    const { customer, customerNetsuiteId } = await resolvePoCustomer(
      supabase, parsedPO.customer || 'Masterack'
    );

    // Create PO
    const { data: po, error } = await supabase
      .from('purchase_orders')
      .insert({
        po_number: parsedPO.po_number,
        customer,
        customer_netsuite_id: customerNetsuiteId,
        ordered_date: parsedPO.ordered_date || null,
        requested_delivery_date: parsedPO.requested_delivery_date || null,
        created_by: user.id,
      })
      .select()
      .single();

    if (!po || error) {
      await dialog.alert('Error creating PO: ' + error?.message);
      setImporting(false);
      return;
    }

    // Auto-create catalog parts for unmatched lines (manual rows in netsuite_parts)
    for (const l of linesToImport) {
      if (!l.catalog_match) {
        const created = await findOrCreateManualPart(supabase, {
          partNumber: l.part_number,
          description: l.description || null,
          price: l.final_price,
          customer: 'Masterack',
          billableCustomer: l.new_end_customer || null,
          vehicleType: l.new_vehicle_type || null,
          graphicPackage: l.new_graphic_package || l.description || null,
        });
        if (created) {
          l.catalog_match = created;
          // Update local catalog list
          setCatalog((prev) => [...prev, created]);
        }
      }
    }

    // Create line items
    const { data: items } = await supabase
      .from('po_line_items')
      .insert(linesToImport.map((l) => ({
        po_id: po.id,
        part_id: l.catalog_match?.id || null,
        part_number: l.part_number,
        description: l.description || null,
        quantity: l.quantity,
        unit_price: l.final_price,
      })))
      .select();

    if (parsedPdfFile) {
      await persistPoPdf(supabase, po.id, parsedPdfFile, user.id);
      setPoFiles(prev => { const c = { ...prev }; delete c[po.id]; return c; });
    }

    setPos((prev) => [{ ...po, line_items: (items as POLineItem[]) || [] }, ...prev]);
    setParsedPO(null);
    setParsedPdfFile(null);
    setImportLines([]);
    setPdfOverwriteExisting(null);
    setShowImport(false);
    setImporting(false);
  };

  // Overwrite existing PO with new PDF data
  const handleOverwritePO = async () => {
    if (!parsedPO || !user || !pdfOverwriteExisting) return;
    const linesToImport = importLines.filter((l) => l.include);
    if (linesToImport.length === 0) return;

    setImporting(true);
    const existingPo = pdfOverwriteExisting;

    // Clear FK references from scanned_vehicles before deleting line items
    const existingLineIds = (existingPo.line_items || []).map((li: any) => li.id);
    if (existingLineIds.length > 0) {
      await supabase
        .from('scanned_vehicles')
        .update({ po_line_item_id: null })
        .in('po_line_item_id', existingLineIds);
    }

    // Delete old line items
    const { error: deleteErr } = await supabase.from('po_line_items').delete().eq('po_id', existingPo.id);
    if (deleteErr) {
      await dialog.alert('Error removing old line items: ' + deleteErr.message);
      setImporting(false);
      return;
    }

    // Update PO header (customer resolved to canonical NetSuite name + id)
    const { customer: overwriteCustomer, customerNetsuiteId: overwriteCustomerNsId } =
      await resolvePoCustomer(supabase, parsedPO.customer || existingPo.customer);
    await supabase.from('purchase_orders').update({
      customer: overwriteCustomer,
      customer_netsuite_id: overwriteCustomerNsId || existingPo.customer_netsuite_id || null,
      ordered_date: parsedPO.ordered_date || existingPo.ordered_date || null,
      requested_delivery_date: parsedPO.requested_delivery_date || existingPo.requested_delivery_date || null,
    }).eq('id', existingPo.id);

    // Auto-create catalog parts for unmatched lines (manual rows in netsuite_parts)
    for (const l of linesToImport) {
      if (!l.catalog_match) {
        const created = await findOrCreateManualPart(supabase, {
          partNumber: l.part_number,
          description: l.description || null,
          price: l.final_price,
          customer: parsedPO.customer || 'Masterack',
          billableCustomer: l.new_end_customer || null,
          vehicleType: l.new_vehicle_type || null,
          graphicPackage: l.new_graphic_package || l.description || null,
        });
        if (created) {
          l.catalog_match = created;
          setCatalog((prev) => [...prev, created]);
        }
      }
    }

    // Insert new line items
    const { data: items } = await supabase
      .from('po_line_items')
      .insert(linesToImport.map((l) => ({
        po_id: existingPo.id,
        part_id: l.catalog_match?.id || null,
        part_number: l.part_number,
        description: l.description || null,
        quantity: l.quantity,
        unit_price: l.final_price,
      })))
      .select();

    if (parsedPdfFile) {
      await persistPoPdf(supabase, existingPo.id, parsedPdfFile, user.id);
      setPoFiles(prev => { const c = { ...prev }; delete c[existingPo.id]; return c; });
    }

    // Update local state
    setPos((prev) => prev.map((p) =>
      p.id === existingPo.id
        ? { ...p, line_items: (items as POLineItem[]) || [], customer: parsedPO.customer || p.customer, ordered_date: parsedPO.ordered_date || p.ordered_date }
        : p
    ));
    setParsedPO(null);
    setParsedPdfFile(null);
    setImportLines([]);
    setPdfOverwriteExisting(null);
    setShowImport(false);
    setImporting(false);
  };

  const cancelImport = () => {
    setParsedPO(null);
    setParsedPdfFile(null);
    setImportLines([]);
    setParseError('');
    setPdfOverwriteExisting(null);
    setShowImport(false);
  };

  // Quick-pick from the catalog dropdown when building a new PO: prefill the
  // part number and price so the user can adjust qty/price before adding.
  const pickCreateLinePart = (catId: string) => {
    const item = catalog.find((c) => c.id === catId);
    if (!item) return;
    setCreateLineForm((prev) => ({ ...prev, part_number: item.part_number, unit_price: item.price.toString() }));
  };

  // Stage a line for the new PO. Mirrors the existing-PO "+ Add Line" form:
  // catalog parts link part_id; free-typed parts stage with part_id null.
  const addCreateLine = async () => {
    const partNum = createLineForm.part_number.trim();
    if (!partNum) { await dialog.alert('Enter or pick a part number'); return; }
    const qty = parseInt(createLineForm.quantity) || 1;
    const price = parseFloat(createLineForm.unit_price) || 0;
    const catalogMatch = catalog.find((c) => c.part_number.toUpperCase() === partNum.toUpperCase());
    setLineItems((prev) => [...prev, { part_id: catalogMatch?.id || null, part_number: partNum, quantity: qty, unit_price: price }]);
    setCreateLineForm({ part_number: '', quantity: '1', unit_price: '' });
  };

  const handleCreate = async () => {
    if (!form.po_number || !form.customer || lineItems.length === 0 || !user) return null;
    const hasShipTo = Object.values(createShipTo).some(v => (v || '').toString().trim());
    // Resolve the picked name ("Masterack") to the real NetSuite customer
    // ("Masterack LLC" + internal id) before storing.
    const { customer, customerNetsuiteId } = await resolvePoCustomer(supabase, form.customer);
    const { data: po, error } = await supabase
      .from('purchase_orders')
      .insert({
        po_number: form.po_number,
        customer,
        customer_netsuite_id: customerNetsuiteId,
        created_by: user.id,
        ship_to: hasShipTo ? createShipTo : null,
        ordered_date: form.ordered_date || null,
        requested_delivery_date: form.requested_delivery_date || null,
        notes: form.notes.trim() || null,
      })
      .select()
      .single();

    if (!po || error) { await dialog.alert('Error: ' + error?.message); return null; }

    const { data: items } = await supabase
      .from('po_line_items')
      .insert(lineItems.map((li) => ({ po_id: po.id, ...li })))
      .select();

    setPos((prev) => [{ ...po, line_items: (items as POLineItem[]) || [] }, ...prev]);
    setForm({ po_number: '', customer: 'Masterack', ordered_date: '', requested_delivery_date: '', notes: '' });
    setLineItems([]);
    setCreateLineForm({ part_number: '', quantity: '1', unit_price: '' });
    setCreateShipToId('');
    setCreateShipTo({});
    setShowCreate(false);
    return po;
  };

  const handleCreateAndGraphics = async () => {
    const po = await handleCreate();
    if (!po) return;
    const params = new URLSearchParams({
      new: '1',
      customer: po.customer || '',
      so: po.po_number || '',
    });
    router.push(`/graphics?${params.toString()}`);
  };

  const handleDeletePO = async (poId: string) => {
    try {
      const res = await fetch('/api/pos/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ poIds: [poId] }),
      });
      const data = await res.json();
      if (data.success) {
        setPos((prev) => prev.filter((p) => p.id !== poId));
      } else {
        await dialog.alert(`Failed to delete PO: ${data.results?.[0]?.error || data.error || 'Unknown error'}`);
      }
    } catch {
      await dialog.alert('Delete failed — please try again');
    }
  };

  const toggleDeleteSelection = (poId: string) => {
    setSelectedForDelete(prev => {
      const next = new Set(prev);
      if (next.has(poId)) next.delete(poId);
      else next.add(poId);
      return next;
    });
  };

  const handleBatchDelete = async () => {
    if (selectedForDelete.size === 0) return;
    const count = selectedForDelete.size;
    if (!(await dialog.confirm(`Delete ${count} PO${count !== 1 ? 's' : ''} and all their line items? This cannot be undone.`, { destructive: true, confirmLabel: 'Delete' }))) return;

    setDeletingBatch(true);
    try {
      const res = await fetch('/api/pos/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ poIds: Array.from(selectedForDelete) }),
      });
      const data = await res.json();
      if (data.deleted > 0) {
        const deletedIds = data.results.filter((r: any) => r.success).map((r: any) => r.id);
        setPos((prev) => prev.filter((p) => !deletedIds.includes(p.id)));
      }
      if (!data.success) {
        const failed = data.results.filter((r: any) => !r.success);
        await dialog.alert(`${data.deleted} of ${data.total} POs deleted. ${failed.length} failed.`);
      }
    } catch {
      await dialog.alert('Batch delete failed — please try again');
    }
    setSelectedForDelete(new Set());
    setEditMode(false);
    setDeletingBatch(false);
  };

  const handleDeleteLineItem = async (lineId: string, poId: string) => {
    try {
      const res = await fetch('/api/pos/delete-line', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lineId }),
      });
      const data = await res.json();
      if (data.success) {
        setPos((prev) =>
          prev.map((po) =>
            po.id === poId
              ? { ...po, line_items: po.line_items.filter((li) => li.id !== lineId) }
              : po
          )
        );
      }
    } catch {
      await dialog.alert('Failed to delete line item');
    }
  };

  const startEditPO = (po: PurchaseOrder & { line_items: POLineItem[] }) => {
    setEditPoId(po.id);
    setEditPoForm({
      po_number: po.po_number,
      customer: po.customer,
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
  };

  const saveEditPO = async () => {
    if (!editPoId) return;
    const hasShipTo = Object.values(editShipTo).some(v => (v || '').toString().trim());
    const update = {
      po_number: editPoForm.po_number,
      customer: editPoForm.customer,
      status: editPoForm.status,
      ship_to: hasShipTo ? editShipTo : null,
      ordered_date: editPoForm.ordered_date || null,
      requested_delivery_date: editPoForm.requested_delivery_date || null,
      notes: editPoForm.notes.trim() || null,
    };
    const { error } = await supabase
      .from('purchase_orders')
      .update(update)
      .eq('id', editPoId);

    if (!error) {
      setPos((prev) =>
        prev.map((po) =>
          po.id === editPoId
            ? { ...po, ...update, status: update.status as any }
            : po
        )
      );
      setEditPoId(null);
    }
  };

  const startEditLine = (li: POLineItem) => {
    setEditLineId(li.id);
    setEditLineForm({ part_number: li.part_number || '', quantity: li.quantity.toString(), unit_price: li.unit_price.toString(), installed: li.installed.toString() });
  };

  const saveEditLine = async (poId: string) => {
    if (!editLineId) return;
    const partNum = editLineForm.part_number.trim();
    const qty = parseInt(editLineForm.quantity) || 1;
    const price = parseFloat(editLineForm.unit_price) || 0;
    const installed = parseInt(editLineForm.installed) || 0;
    const { error } = await supabase
      .from('po_line_items')
      .update({ part_number: partNum, quantity: qty, unit_price: price, installed })
      .eq('id', editLineId);

    if (!error) {
      setPos((prev) =>
        prev.map((po) =>
          po.id === poId
            ? { ...po, line_items: po.line_items.map((li) => li.id === editLineId ? { ...li, part_number: partNum, quantity: qty, unit_price: price, installed } : li) }
            : po
        )
      );
      setEditLineId(null);
    }
  };

  const startAddLine = (poId: string) => {
    setEditLineId(null);
    setAddLinePoId(poId);
    setAddLineForm({ part_number: '', quantity: '1', unit_price: '' });
  };

  const cancelAddLine = () => {
    setAddLinePoId(null);
    setAddLineForm({ part_number: '', quantity: '1', unit_price: '' });
  };

  // Quick-pick from the catalog dropdown: fill in the part number and the
  // catalog price. The user can still tweak qty/price before adding.
  const pickAddLinePart = (catId: string) => {
    const item = catalog.find((c) => c.id === catId);
    if (!item) return;
    setAddLineForm((prev) => ({ ...prev, part_number: item.part_number, unit_price: item.price.toString() }));
  };

  const saveAddLine = async (poId: string) => {
    const partNum = addLineForm.part_number.trim();
    if (!partNum) { await dialog.alert('Enter or pick a part number'); return; }
    const qty = parseInt(addLineForm.quantity) || 1;
    const price = parseFloat(addLineForm.unit_price) || 0;
    // Link the catalog part when the number matches, mirroring the PDF/email
    // import paths. PartLabel resolves the display name from part_number, so
    // we leave description null like the manual-create flow.
    const catalogMatch = catalog.find((c) => c.part_number.toUpperCase() === partNum.toUpperCase());
    setAddingLine(true);
    const { data, error } = await supabase
      .from('po_line_items')
      .insert({
        po_id: poId,
        ...(catalogMatch?.id ? { part_id: catalogMatch.id } : {}),
        part_number: partNum,
        quantity: qty,
        unit_price: price,
      })
      .select()
      .single();
    setAddingLine(false);
    if (error || !data) { await dialog.alert('Error adding line: ' + (error?.message || 'unknown')); return; }
    setPos((prev) =>
      prev.map((po) =>
        po.id === poId ? { ...po, line_items: [...po.line_items, data as POLineItem] } : po
      )
    );
    // Keep the form open with cleared fields so several missed parts can be
    // added back-to-back. Cancel/Done closes it.
    setAddLineForm({ part_number: '', quantity: '1', unit_price: '' });
  };

  const toggleExpand = (poId: string) => {
    const opening = expandedPo !== poId;
    setExpandedPo(opening ? poId : null);
    setEditPoId(null);
    setEditLineId(null);
    setAddLinePoId(null);
    if (opening && !poFiles[poId]) loadPoFiles(poId);
  };

  const loadPoFiles = async (poId: string) => {
    const { data } = await supabase
      .from('po_files')
      .select('*')
      .eq('po_id', poId)
      .order('uploaded_at', { ascending: false });
    setPoFiles(prev => ({ ...prev, [poId]: (data as PoFile[]) || [] }));
  };

  const triggerPoPdfUpload = (poId: string) => {
    setUploadingPoId(poId);
    poFileInputRef.current?.click();
  };

  const handlePoPdfUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    const poId = uploadingPoId;
    if (!poId || files.length === 0 || !user) {
      setUploadingPoId(null);
      return;
    }
    setUploadingPoPdf(true);
    let lastUpload: { path: string; name: string } | null = null;
    for (const file of files) {
      const result = await persistPoPdf(supabase, poId, file, user.id);
      if (result) lastUpload = result;
    }
    await loadPoFiles(poId);
    setUploadingPoPdf(false);
    setUploadingPoId(null);
    // Pop the freshly uploaded PDF into its own preview window so the user
    // doesn't have to scroll the list to find it.
    if (lastUpload) {
      const url = storage.from('graphics-proofs').getPublicUrl(lastUpload.path).data.publicUrl;
      setPdfPreview({ url, name: lastUpload.name });
      // Mirror the Gmail import behaviour: send the freshly uploaded PDF to
      // the extraction endpoint so the PO's ship_to gets filled in
      // automatically. Best-effort; failures are logged but don't block.
      setExtractingShipTo(true);
      try {
        const res = await fetch('/api/pos/extract-ship-to', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ poId, storagePath: lastUpload.path }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.ship_to) {
          setPos(prev => prev.map(p => p.id === poId ? { ...p, ship_to: data.ship_to } : p));
        } else if (!res.ok) {
          console.warn('Ship-to extraction failed:', data.error || res.status);
        }
      } catch (err) {
        console.warn('Ship-to extraction threw:', err);
      }
      setExtractingShipTo(false);
    }
  };

  // Gmail import functions
  const searchGmailPOs = async (days = 90) => {
    setEmailLoading(true);
    setEmailError('');
    setEmailNeedsAuth(false);
    try {
      const res = await fetch(`/api/gmail/search-pos?days=${days}`);
      const data = await res.json();
      if (data.needsAuth) {
        setEmailNeedsAuth(true);
        return;
      }
      if (data.error) {
        setEmailError(data.error);
        return;
      }
      setEmailEmails(data.emails || []);
    } catch (err: any) {
      setEmailError(err.message || 'Failed to search Gmail');
    }
    setEmailLoading(false);
  };

  const dismissEmail = async (messageId: string, email: any) => {
    await fetch('/api/gmail/dismiss-po', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messageId,
        threadId: email.threadId,
        subject: email.subject,
        fromEmail: email.fromEmail,
        poNumber: email.poNumber,
      }),
    });
    setEmailEmails(prev => prev.filter(e => e.messageId !== messageId));
  };

  // Multi-PO emails queue one review per PO. Advance to the next one, or
  // close the panel when the queue is spent.
  const advanceReviewQueue = () => {
    const [next, ...rest] = reviewQueue;
    if (next) {
      setReviewingExtraction(next);
      setReviewQueue(rest);
    } else {
      setReviewingExtraction(null);
    }
  };

  const importEmailPO = async (messageId: string, skipReview = false) => {
    setImportingEmailId(messageId);
    try {
      const res = await fetch('/api/gmail/import-po', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId, autoCreate: skipReview, extractOnly: !skipReview }),
      });
      const data = await res.json();

      // Normalize error responses — API returns { error: '...' } on non-200
      if (!res.ok || data.error) {
        setEmailImportResults(prev => ({ ...prev, [messageId]: { status: 'error', error: data.error || `Request failed (${res.status})` } }));
        setImportingEmailId(null);
        return;
      }

      // Extract-only mode: show review panel with the source PDF alongside.
      // A multi-PO email returns one review per PO — queue them one at a time.
      if (data.status === 'review') {
        const toItem = (r: any, queuePos?: { index: number; total: number }): ReviewItem => {
          const pdf = r.pdfs?.[0];
          return {
            messageId,
            extracted: collapseSupplierParts(r.extracted),
            attachmentIds: (r.pdfs || []).map((p: any) => p.attachmentId),
            queuePos,
            pdf: pdf
              ? { url: gmailPdfUrl(messageId, pdf.attachmentId, pdf.filename), name: pdf.filename }
              : { url: gmailPdfUrl(messageId), name: 'PO PDF' },
          };
        };
        const items: ReviewItem[] = data.multi && data.reviews?.length
          ? data.reviews.map((r: any, i: number) => toItem(r, { index: i + 1, total: data.reviews.length }))
          : [toItem(data)];
        setReviewPdfOpen(window.innerWidth >= 1000);
        setReviewingExtraction(items[0]);
        setReviewQueue(items.slice(1));
        setImportingEmailId(null);
        return;
      }

      // If PO already exists, show the change confirmation dialog
      if (data.status === 'exists') {
        setOverwriteData(data);
        setOverwriteMessageId(messageId);
        setShowOverwriteConfirm(true);
        setImportingEmailId(null);
        return;
      }

      setEmailImportResults(prev => ({ ...prev, [messageId]: data }));

      // Refresh PO list if imported or updated, remove from pending/email lists
      if (data.status === 'imported' || data.status === 'updated') {
        setPendingPOs(prev => prev.filter(p => p.message_id !== messageId));
        setEmailEmails(prev => prev.filter(e => e.messageId !== messageId));
        const { data: poData } = await supabase
          .from('purchase_orders')
          .select('*, po_line_items(*), po_invoices(*)')
          .order('created_at', { ascending: false });
        const FILTERED_CUSTOMERS = ['ranger design', 'enterprise fleet management', 'bmg fleet installations'];
        const mapped = (poData || [])
          .filter((po: any) => !FILTERED_CUSTOMERS.some(fc => po.customer?.toLowerCase().includes(fc)))
          .map((po: any) => ({ ...po, line_items: po.po_line_items || [], po_invoices: (po.po_invoices || []).sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()) }));
        setPos(mapped);
      }
    } catch (err: any) {
      setEmailImportResults(prev => ({ ...prev, [messageId]: { status: 'error', error: err.message || 'Network error' } }));
    }
    setImportingEmailId(null);
  };

  // Confirm import with reviewed/edited extraction data
  const confirmReviewedImport = async () => {
    if (!reviewingExtraction) return;
    const { messageId, extracted, attachmentIds } = reviewingExtraction;
    setImportingEmailId(messageId);
    const isLastInQueue = reviewQueue.length === 0;
    try {
      const res = await fetch('/api/gmail/import-po', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId, preExtracted: extracted, attachmentIds }),
      });
      const data = await res.json();

      if (!res.ok || data.error) {
        setEmailImportResults(prev => ({ ...prev, [messageId]: { status: 'error', error: data.error || `Request failed (${res.status})` } }));
        advanceReviewQueue();
      } else if (data.status === 'exists') {
        // The overwrite dialog takes over; the queue resumes when it resolves.
        setOverwriteData({ ...data, attachmentIds });
        setOverwriteMessageId(messageId);
        setShowOverwriteConfirm(true);
        setReviewingExtraction(null);
      } else {
        setEmailImportResults(prev => ({ ...prev, [messageId]: data }));
        if (data.status === 'imported' || data.status === 'updated') {
          // Remove from pending/email lists only once every PO in the email
          // has been through review
          if (isLastInQueue) {
            setPendingPOs(prev => prev.filter(p => p.message_id !== messageId));
            setEmailEmails(prev => prev.filter(e => e.messageId !== messageId));
          }
          const { data: poData } = await supabase
            .from('purchase_orders')
            .select('*, po_line_items(*), po_invoices(*)')
            .order('created_at', { ascending: false });
          const FILTERED_CUSTOMERS = ['ranger design', 'enterprise fleet management', 'bmg fleet installations'];
          const mapped = (poData || [])
            .filter((po: any) => !FILTERED_CUSTOMERS.some(fc => po.customer?.toLowerCase().includes(fc)))
            .map((po: any) => ({ ...po, line_items: po.po_line_items || [], po_invoices: (po.po_invoices || []).sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()) }));
          setPos(mapped);
        }
        advanceReviewQueue();
      }
    } catch (err: any) {
      setEmailImportResults(prev => ({ ...prev, [messageId]: { status: 'error', error: err.message || 'Network error' } }));
      advanceReviewQueue();
    }
    setImportingEmailId(null);
  };

  // Update a line in the reviewed extraction
  const updateReviewLine = (lineIdx: number, field: string, value: any) => {
    if (!reviewingExtraction) return;
    setReviewingExtraction(prev => {
      if (!prev) return prev;
      const updated = { ...prev, extracted: { ...prev.extracted, lines: [...prev.extracted.lines] } };
      updated.extracted.lines[lineIdx] = { ...updated.extracted.lines[lineIdx], [field]: value };
      return updated;
    });
  };

  // Remove a line from reviewed extraction
  const removeReviewLine = (lineIdx: number) => {
    if (!reviewingExtraction) return;
    setReviewingExtraction(prev => {
      if (!prev) return prev;
      const updated = { ...prev, extracted: { ...prev.extracted, lines: prev.extracted.lines.filter((_: any, i: number) => i !== lineIdx) } };
      return updated;
    });
  };

  const confirmOverwrite = async () => {
    if (!overwriteMessageId || !overwriteData?.extracted) return;
    setOverwriting(true);
    const isLastInQueue = reviewQueue.length === 0;
    try {
      // Overwrite with the extraction we already have (reviewed/edited when it
      // came through the review panel) instead of re-extracting the email —
      // faster, cheaper, and correctly scoped to one PO of a multi-PO email.
      const res = await fetch('/api/gmail/import-po', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messageId: overwriteMessageId,
          preExtracted: overwriteData.extracted,
          forceOverwrite: true,
          attachmentIds: overwriteData.attachmentIds,
        }),
      });
      const data = await res.json();

      if (!res.ok || data.error) {
        setEmailImportResults(prev => ({ ...prev, [overwriteMessageId!]: { status: 'error', error: data.error || `Update failed (${res.status})` } }));
      } else {
        setEmailImportResults(prev => ({ ...prev, [overwriteMessageId!]: data }));

        // Refresh PO list and remove from pending/email lists
        if (data.status === 'updated') {
          if (isLastInQueue) {
            setPendingPOs(prev => prev.filter(p => p.message_id !== overwriteMessageId));
            setEmailEmails(prev => prev.filter(e => e.messageId !== overwriteMessageId));
          }
          const { data: poData } = await supabase
            .from('purchase_orders')
            .select('*, po_line_items(*), po_invoices(*)')
            .order('created_at', { ascending: false });
          const FILTERED_CUSTOMERS = ['ranger design', 'enterprise fleet management', 'bmg fleet installations'];
          const mapped = (poData || [])
            .filter((po: any) => !FILTERED_CUSTOMERS.some(fc => po.customer?.toLowerCase().includes(fc)))
            .map((po: any) => ({ ...po, line_items: po.po_line_items || [], po_invoices: (po.po_invoices || []).sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()) }));
          setPos(mapped);
        }
      }
    } catch (err: any) {
      setEmailImportResults(prev => ({ ...prev, [overwriteMessageId!]: { status: 'error', error: err.message || 'Network error' } }));
    }
    setOverwriting(false);
    setShowOverwriteConfirm(false);
    setOverwriteData(null);
    setOverwriteMessageId(null);
    advanceReviewQueue();
  };

  const cancelOverwrite = () => {
    setShowOverwriteConfirm(false);
    setOverwriteData(null);
    setOverwriteMessageId(null);
    // Skipping the overwrite still moves a multi-PO email on to its next PO
    advanceReviewQueue();
  };

  const createNetSuiteSO = async (poId: string) => {
    setCreatingSOForPo(poId);
    try {
      const res = await fetch('/api/netsuite/create-sales-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ poId }),
      });
      const data = await res.json();

      if (!res.ok || data.error) {
        setSoResults(prev => ({ ...prev, [poId]: { status: 'error', error: data.error || 'Failed' } }));
      } else {
        setSoResults(prev => ({ ...prev, [poId]: data }));
        // Update the local PO with the NetSuite SO info
        if (data.salesOrderId) {
          setPos(prev => prev.map(po =>
            po.id === poId
              ? { ...po, netsuite_so_id: data.salesOrderId, netsuite_so_number: data.salesOrderNumber }
              : po
          ));
        }
      }
    } catch (err: any) {
      setSoResults(prev => ({ ...prev, [poId]: { status: 'error', error: err.message || 'Network error' } }));
    }
    setCreatingSOForPo(null);
  };

  // Toggle PO selection for batch invoicing
  const toggleInvoiceSelection = (poId: string) => {
    setSelectedForInvoice(prev => {
      const next = new Set(prev);
      if (next.has(poId)) next.delete(poId);
      else next.add(poId);
      return next;
    });
  };

  // Batch create invoices from selected POs
  const createBatchInvoices = async () => {
    if (selectedForInvoice.size === 0) return;
    setCreatingInvoices(true);
    setInvoiceResults(null);

    // Get the NetSuite SO IDs for the selected POs
    const salesOrderIds = pos
      .filter(po => selectedForInvoice.has(po.id) && (po as any).netsuite_so_id)
      .map(po => (po as any).netsuite_so_id);

    try {
      const res = await fetch('/api/netsuite/create-invoice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ salesOrderIds }),
      });
      const data = await res.json();

      if (!res.ok) {
        setInvoiceResults({ error: data.error || 'Failed to create invoices' });
      } else {
        setInvoiceResults(data);
        // Update local PO data with invoice info
        if (data.results) {
          for (const result of data.results) {
            if (result.status === 'success' && result.invoiceId) {
              setPos(prev => prev.map(po => {
                if (po.id !== result.poId) return po;
                const newInvoice = {
                  netsuite_invoice_id: result.invoiceId,
                  netsuite_invoice_number: result.invoiceNumber,
                  created_at: new Date().toISOString(),
                  total_qty: null,
                  line_count: null,
                  memo: `PO #${po.po_number}`,
                };
                return {
                  ...po,
                  netsuite_invoice_id: result.invoiceId,
                  netsuite_invoice_number: result.invoiceNumber,
                  po_invoices: [newInvoice, ...((po as any).po_invoices || [])],
                } as any;
              }));
            }
          }
        }
        setSelectedForInvoice(new Set());
      }
    } catch (err: any) {
      setInvoiceResults({ error: err.message || 'Network error' });
    }
    setCreatingInvoices(false);
  };

  // Get POs that are eligible for invoicing (have SO, have installed qty, no invoice yet)
  const invoiceablePOs = pos.filter(po => {
    const hasNsSO = !!(po as any).netsuite_so_id;
    const noInvoice = !(po as any).netsuite_invoice_id;
    const hasInstalled = po.line_items.some(li => li.installed > 0);
    return hasNsSO && noInvoice && hasInstalled;
  });

  const importAllNewPOs = async () => {
    const newEmails = emailEmails.filter(e => !e.alreadyImported && !e.alreadyInSystem && e.pdfs.length > 0 && !emailImportResults[e.messageId]);
    for (let i = 0; i < newEmails.length; i++) {
      await importEmailPO(newEmails[i].messageId);
      // Wait 5 seconds between imports to avoid API rate limiting / degraded responses
      if (i < newEmails.length - 1) {
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  };

  // Add a PO line item's part to the catalog
  const addLineItemToCatalog = async (li: { id: string; part_number: string; description: string | null; unit_price: number }, customer: string) => {
    setAddingToCatalog(li.part_number);
    try {
      const created = await findOrCreateManualPart(supabase, {
        partNumber: li.part_number,
        description: li.description || null,
        price: li.unit_price,
        customer: customer || null,
        graphicPackage: li.description || null,
      });
      if (!created) {
        setCatalogAddResults(prev => ({ ...prev, [li.part_number]: 'error' }));
      } else {
        setCatalogAddResults(prev => ({ ...prev, [li.part_number]: 'added' }));
        setCatalog(await loadUnifiedCatalog(supabase));
      }
    } catch {
      setCatalogAddResults(prev => ({ ...prev, [li.part_number]: 'error' }));
    }
    setAddingToCatalog(null);
  };

  // Link any PDFs already saved on the PO into the new graphics job's files.
  // Reuses the same R2 storage_path so the PO and job point at one object.
  const attachPoFilesToGraphicsJob = async (poId: string, jobId: string) => {
    const { data: poFiles } = await supabase
      .from('po_files')
      .select('file_name, file_type, file_size, storage_path')
      .eq('po_id', poId);
    if (!poFiles || poFiles.length === 0) return;
    await supabase.from('graphics_job_files').insert(
      poFiles.map((f: any) => ({
        job_id: jobId,
        file_name: f.file_name,
        file_type: f.file_type,
        file_size: f.file_size,
        storage_path: f.storage_path,
        uploaded_by: user?.id || null,
      }))
    );
  };

  // Create a graphics job from a PO line item
  const createGfxJobFromLine = async (po: PurchaseOrder, li: { id: string; part_number: string; description: string | null; quantity: number }) => {
    setCreatingGfxJob(li.id);
    try {
      const jobNumber = `GFX-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
      const { data: job, error } = await supabase
        .from('graphics_jobs')
        .insert({
          po_id: po.id,
          po_line_item_id: li.id,
          job_number: jobNumber,
          title: li.description || `Graphic - ${li.part_number}`,
          part_number: li.part_number,
          customer: po.customer || null,
          customer_netsuite_id: po.customer_netsuite_id || null,
          quantity: li.quantity,
          status: 'received',
          job_category: 'production',
          priority: 'normal',
          po_number: po.po_number || null,
          ship_to: formatShipTo(po.ship_to),
          content: buildJobContent([li]),
          due_date: po.requested_delivery_date || null,
          created_by: user?.id || null,
        })
        .select('id')
        .single();

      if (error) throw error;
      // RLS or any other quirk could let INSERT through but block the
      // RETURNING SELECT, leaving us with a null `job`. Catch that
      // explicitly — otherwise the success path runs and we falsely
      // mark the line "✓ Graphics job created" with no row in the DB.
      if (!job?.id) throw new Error('Graphics job insert returned no row (possible RLS read denial).');

      // Log status history
      await supabase.from('graphics_status_history').insert({
        job_id: job.id,
        from_status: null,
        to_status: 'received',
        changed_by: user?.id || null,
        note: `Created from PO #${po.po_number}`,
      });

      await attachPoFilesToGraphicsJob(po.id, job.id);

      setGfxJobResults(prev => ({ ...prev, [li.id]: 'created' }));
      setCreatingGfxJob(null);
      // Take the user to the new job so success is unambiguous and they
      // can finish editing it (spec, due date, etc.) in one motion.
      router.push(`/graphics?editJob=${job.id}`);
      return;
    } catch (err: any) {
      console.error('[admin/pos] createGfxJobFromLine failed:', err);
      setGfxJobResults(prev => ({ ...prev, [li.id]: 'error' }));
      await dialog.alert(`Failed to create graphics job: ${err?.message || String(err)}`);
    }
    setCreatingGfxJob(null);
  };

  // Create a single graphics job from ALL line items in a PO
  const createGfxJobFromPO = async (po: PurchaseOrder & { line_items: POLineItem[] }) => {
    if (!po.line_items.length) return;
    setCreatingGfxJobForPo(po.id);
    try {
      const jobNumber = `GFX-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
      const partNumbers = [...new Set(po.line_items.map(li => li.part_number))].join(', ');
      const totalQty = po.line_items.reduce((sum, li) => sum + li.quantity, 0);
      const { data: job, error } = await supabase
        .from('graphics_jobs')
        .insert({
          po_id: po.id,
          po_line_item_id: null,
          job_number: jobNumber,
          title: `PO #${po.po_number} – ${po.customer}`,
          part_number: partNumbers,
          customer: po.customer || null,
          customer_netsuite_id: po.customer_netsuite_id || null,
          quantity: totalQty,
          status: 'received',
          job_category: 'production',
          priority: 'normal',
          po_number: po.po_number || null,
          ship_to: formatShipTo(po.ship_to),
          content: buildJobContent(po.line_items),
          due_date: po.requested_delivery_date || null,
          created_by: user?.id || null,
        })
        .select('id')
        .single();

      if (error) throw error;
      if (!job?.id) throw new Error('Graphics job insert returned no row (possible RLS read denial).');

      await supabase.from('graphics_status_history').insert({
        job_id: job.id,
        from_status: null,
        to_status: 'received',
        changed_by: user?.id || null,
        note: `Created from PO #${po.po_number} with ${po.line_items.length} part(s)`,
      });

      await attachPoFilesToGraphicsJob(po.id, job.id);

      // Navigate to graphics page with the new job open for editing
      router.push(`/graphics?editJob=${job.id}`);
    } catch (err: any) {
      console.error('[admin/pos] createGfxJobFromPO failed:', err);
      await dialog.alert(`Failed to create graphics job: ${err?.message || String(err)}`);
    }
    setCreatingGfxJobForPo(null);
  };

  const addPartToCatalog = async (part: { part_number: string; description: string; unit_price: number }, customer: string) => {
    setAddingToCatalog(part.part_number);
    try {
      const created = await findOrCreateManualPart(supabase, {
        partNumber: part.part_number,
        description: part.description || null,
        price: part.unit_price,
        customer: customer || 'Masterack',
        graphicPackage: part.description || null,
      });
      if (!created) {
        setCatalogAddResults(prev => ({ ...prev, [part.part_number]: 'error' }));
      } else {
        setCatalogAddResults(prev => ({ ...prev, [part.part_number]: 'added' }));
        // Refresh catalog list
        setCatalog(await loadUnifiedCatalog(supabase));
      }
    } catch (err) {
      setCatalogAddResults(prev => ({ ...prev, [part.part_number]: 'error' }));
    }
    setAddingToCatalog(null);
  };

  const fmt = (n: number) => '$' + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

  // Sort by PO number and filter by search
  const openPos = pos.filter(po => po.status !== 'closed');
  const closedPos = pos.filter(po => po.status === 'closed');
  const filteredPos = (poTab === 'closed' ? closedPos : openPos)
    .filter((po) => {
      if (!poSearch.trim()) return true;
      const q = poSearch.toLowerCase();
      if (po.po_number.toLowerCase().includes(q)) return true;
      if (po.customer.toLowerCase().includes(q)) return true;
      if (po.line_items.some((li) => li.part_number.toLowerCase().includes(q) || li.description?.toLowerCase().includes(q))) return true;
      return false;
    })
    .sort((a, b) => {
      const cmp = a.po_number.localeCompare(b.po_number, undefined, { numeric: true });
      return poSort === 'asc' ? cmp : -cmp;
    });

  const closePO = async (poId: string) => {
    await supabase.from('purchase_orders').update({ status: 'closed' }).eq('id', poId);
    setPos(prev => prev.map(p => p.id === poId ? { ...p, status: 'closed' as any } : p));
    setExpandedPo(null);
  };

  const reopenPO = async (poId: string) => {
    await supabase.from('purchase_orders').update({ status: 'open' }).eq('id', poId);
    setPos(prev => prev.map(p => p.id === poId ? { ...p, status: 'open' } : p));
  };

  if (loading) return <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-label)' }}>Loading...</div>;

  return (
    <div>
      {/* Hidden file input used by per-PO "Upload PDF" buttons */}
      <input
        ref={poFileInputRef}
        type="file"
        accept=".pdf,application/pdf"
        multiple
        onChange={handlePoPdfUpload}
        style={{ display: 'none' }}
      />
      {/* Gmail auto-import status strip */}
      {gmailStatus && (() => {
        const r: any = gmailStatus.lastResult || {};
        const status = r.status as 'ok' | 'error' | undefined;
        const minutesAgo = gmailStatus.lastRunAt
          ? Math.round((Date.now() - new Date(gmailStatus.lastRunAt).getTime()) / 60000)
          : null;
        const tone = !gmailStatus.gmailConnected || status === 'error'
          ? { bg: 'rgba(239,68,68,0.08)', border: 'rgba(239,68,68,0.25)', color: '#ef4444' }
          : status === 'ok'
            ? { bg: 'rgba(34,197,94,0.06)', border: 'rgba(34,197,94,0.2)', color: '#22c55e' }
            : { bg: 'var(--subtle-bg)', border: 'var(--border)', color: 'var(--text-muted)' };
        let summary = '';
        if (!gmailStatus.gmailConnected) {
          summary = 'Gmail is not connected. Connect a mailbox to auto-import POs.';
        } else if (status === 'error') {
          summary = `Last run failed: ${r.reason || r.error || 'unknown error'}`;
        } else if (status === 'ok') {
          summary = `Last run: ${r.messagesFound ?? 0} email${r.messagesFound === 1 ? '' : 's'} found · ${r.imported ?? 0} imported · ${r.skipped ?? 0} skipped${(r.errors ?? 0) > 0 ? ` · ${r.errors} errors` : ''}`;
        } else if (gmailStatus.lastRunAt) {
          summary = 'No detail recorded for last run.';
        } else {
          summary = 'No run recorded yet.';
        }
        const errs = gmailStatus.recentErrors || [];
        return (
          <div style={{
            padding: '8px 12px', borderRadius: '10px', marginBottom: '10px',
            background: tone.bg, border: `1px solid ${tone.border}`,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                <div style={{ fontSize: '11px', fontWeight: 700, color: tone.color, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                  Gmail PO Auto-Import
                  {minutesAgo !== null && (
                    <span style={{ marginLeft: '6px', color: 'var(--text-muted)', fontWeight: 600 }}>
                      · {minutesAgo < 1 ? 'just now' : minutesAgo < 60 ? `${minutesAgo}m ago` : `${Math.round(minutesAgo / 60)}h ago`}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: '11px', color: 'var(--text-body)', marginTop: '2px' }}>{summary}</div>
                {gmailRunMessage && (
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px', fontStyle: 'italic' }}>
                    {gmailRunMessage}
                  </div>
                )}
                {errs.length > 0 && (
                  <button
                    onClick={() => setGmailErrorsOpen(v => !v)}
                    style={{
                      marginTop: '4px', alignSelf: 'flex-start', padding: '2px 0',
                      background: 'transparent', border: 'none', cursor: 'pointer',
                      fontSize: '10px', fontWeight: 700, color: '#ef4444', textDecoration: 'underline',
                    }}
                  >{gmailErrorsOpen ? 'Hide' : 'Show'} last {errs.length} import error{errs.length === 1 ? '' : 's'}</button>
                )}
              </div>
              <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
                {!gmailStatus.gmailConnected && (
                  <a
                    href="/api/auth/google"
                    style={{
                      padding: '6px 10px', borderRadius: '6px', fontSize: '11px', fontWeight: 700,
                      background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.3)',
                      color: '#60a5fa', textDecoration: 'none',
                    }}
                  >Connect Gmail</a>
                )}
                <button
                  onClick={runGmailImportNow}
                  disabled={gmailRunning || !gmailStatus.gmailConnected}
                  style={{
                    padding: '6px 10px', borderRadius: '6px', fontSize: '11px', fontWeight: 700,
                    background: 'var(--subtle-bg)', border: '1px solid var(--border)',
                    color: 'var(--text-body)',
                    cursor: gmailRunning || !gmailStatus.gmailConnected ? 'default' : 'pointer',
                    opacity: gmailRunning || !gmailStatus.gmailConnected ? 0.5 : 1,
                  }}
                >{gmailRunning ? 'Running…' : 'Run Now'}</button>
              </div>
            </div>
            {gmailErrorsOpen && errs.length > 0 && (
              <div style={{
                marginTop: '10px', paddingTop: '10px', borderTop: `1px dashed ${tone.border}`,
                display: 'flex', flexDirection: 'column', gap: '6px',
              }}>
                {errs.map((e: any, i: number) => (
                  <div key={e.message_id || i} style={{
                    padding: '6px 8px', borderRadius: '6px',
                    background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.18)',
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '8px' }}>
                      <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {e.subject || e.attachment_filename || '(no subject)'}
                      </div>
                      <div style={{ fontSize: '9px', color: 'var(--text-muted)', flexShrink: 0 }}>
                        {e.from_email || ''}
                      </div>
                    </div>
                    <div style={{ fontSize: '10px', color: '#ef4444', marginTop: '2px', wordBreak: 'break-word' }}>
                      {e.error_message || '(no error message recorded)'}
                    </div>
                    {(e.received_at || e.created_at) && (
                      <div style={{ fontSize: '9px', color: 'var(--text-muted)', marginTop: '2px' }}>
                        {new Date(e.received_at || e.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })()}

      {/* Open / Closed tabs */}
      <div style={{ display: 'flex', gap: '4px', marginBottom: '10px' }}>
        <button onClick={() => setPoTab('open')} style={{
          padding: '6px 14px', borderRadius: '8px', fontSize: '11px', fontWeight: 700, cursor: 'pointer',
          background: poTab === 'open' ? 'var(--tab-active-bg)' : 'transparent',
          border: poTab === 'open' ? '1px solid var(--tab-active-border)' : '1px solid var(--border)',
          color: poTab === 'open' ? '#60a5fa' : 'var(--text-muted)',
        }}>Open ({openPos.length})</button>
        <button onClick={() => setPoTab('closed')} style={{
          padding: '6px 14px', borderRadius: '8px', fontSize: '11px', fontWeight: 700, cursor: 'pointer',
          background: poTab === 'closed' ? 'var(--tab-active-bg)' : 'transparent',
          border: poTab === 'closed' ? '1px solid var(--tab-active-border)' : '1px solid var(--border)',
          color: poTab === 'closed' ? '#94a3b8' : 'var(--text-muted)',
        }}>Closed ({closedPos.length})</button>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-label)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            {poTab === 'closed' ? 'Closed' : ''} Purchase Orders ({filteredPos.length}{poSearch ? ` of ${pos.length}` : ''})
          </div>
          <button
            onClick={() => setPoSort(s => s === 'asc' ? 'desc' : 'asc')}
            title={`Sort PO# ${poSort === 'asc' ? 'descending' : 'ascending'}`}
            style={{
              padding: '3px 8px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
              background: 'var(--subtle-bg)', border: '1px solid var(--border)',
              color: 'var(--text-body)', cursor: 'pointer',
            }}
          >
            PO# {poSort === 'asc' ? '▲' : '▼'}
          </button>
        </div>
        <div style={{ display: 'flex', gap: '6px' }}>
          {!editMode ? (
            <>
              <button
                onClick={backfillCustomers}
                disabled={backfillingCustomers}
                title="Resolve every PO's customer name to its NetSuite customer record"
                style={{ padding: '6px 12px', borderRadius: '8px', background: 'rgba(167,139,250,0.1)', border: '1px solid rgba(167,139,250,0.25)', color: '#a78bfa', fontSize: '12px', fontWeight: 700, opacity: backfillingCustomers ? 0.6 : 1 }}
              >
                {backfillingCustomers ? 'Linking…' : 'Link Customers'}
              </button>
              <button
                onClick={() => { setEditMode(true); setSelectedForDelete(new Set()); }}
                style={{ padding: '6px 12px', borderRadius: '8px', background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.25)', color: '#f87171', fontSize: '12px', fontWeight: 700 }}
              >
                Edit
              </button>
              <button
                onClick={() => { setShowEmailImport(!showEmailImport); setShowImport(false); setShowCreate(false); if (!showEmailImport) { searchGmailPOs(); window.scrollTo({ top: 0, behavior: 'smooth' }); } }}
                style={{ padding: '6px 12px', borderRadius: '8px', background: showEmailImport ? 'var(--subtle-bg)' : 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.25)', color: '#4ade80', fontSize: '12px', fontWeight: 700 }}
              >
                {showEmailImport ? 'Cancel' : 'Email'}
              </button>
              <button
                onClick={() => { setShowImport(!showImport); setShowCreate(false); setShowEmailImport(false); setParsedPO(null); setImportLines([]); setParseError(''); }}
                style={{ padding: '6px 12px', borderRadius: '8px', background: showImport ? 'var(--subtle-bg)' : 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.25)', color: '#60a5fa', fontSize: '12px', fontWeight: 700 }}
              >
                {showImport ? 'Cancel' : 'PDF'}
              </button>
              <button
                onClick={() => setShowLocations(s => !s)}
                title="Manage saved ship-to locations"
                style={{ padding: '6px 12px', borderRadius: '8px', background: showLocations ? 'var(--subtle-bg)' : 'rgba(148,163,184,0.1)', border: '1px solid rgba(148,163,184,0.25)', color: 'var(--text-body)', fontSize: '12px', fontWeight: 700 }}
              >
                Locations
              </button>
              <button
                onClick={() => { setShowCreate(!showCreate); setShowImport(false); setShowEmailImport(false); }}
                style={{ padding: '6px 12px', borderRadius: '8px', background: '#3b82f6', color: '#fff', fontSize: '12px', fontWeight: 700, border: 'none' }}
              >
                {showCreate ? 'Cancel' : '+ New'}
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => {
                  if (selectedForDelete.size === filteredPos.length) {
                    setSelectedForDelete(new Set());
                  } else {
                    setSelectedForDelete(new Set(filteredPos.map(p => p.id)));
                  }
                }}
                style={{ padding: '6px 12px', borderRadius: '8px', background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.25)', color: '#f87171', fontSize: '12px', fontWeight: 700 }}
              >
                {selectedForDelete.size === filteredPos.length ? 'Deselect All' : 'Select All'}
              </button>
              {selectedForDelete.size > 0 && (
                <button
                  onClick={handleBatchDelete}
                  disabled={deletingBatch}
                  style={{ padding: '6px 12px', borderRadius: '8px', background: '#ef4444', color: '#fff', fontSize: '12px', fontWeight: 700, border: 'none' }}
                >
                  {deletingBatch ? 'Deleting...' : `Delete (${selectedForDelete.size})`}
                </button>
              )}
              <button
                onClick={() => { setEditMode(false); setSelectedForDelete(new Set()); }}
                style={{ padding: '6px 12px', borderRadius: '8px', background: 'var(--subtle-bg)', border: '1px solid var(--border)', color: 'var(--text-body)', fontSize: '12px', fontWeight: 700 }}
              >
                Done
              </button>
            </>
          )}
        </div>
      </div>

      {/* Search bar */}
      <div style={{ position: 'relative', marginBottom: '10px' }}>
        <input
          value={poSearch}
          onChange={(e) => setPoSearch(e.target.value)}
          placeholder="Search PO #, part #, or customer..."
          style={{ width: '100%', padding: '9px 12px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-body)', fontSize: '12px', outline: 'none' }}
        />
        {poSearch && (
          <button
            onClick={() => setPoSearch('')}
            style={{ position: 'absolute', right: '8px', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: 'var(--text-body)', fontSize: '14px', cursor: 'pointer', padding: '0 4px' }}
          >×</button>
        )}
      </div>

      {/* Pending PO Queue */}
      {pendingPOs.length > 0 && (
        <div style={{ background: 'rgba(251,191,36,0.06)', border: '1px solid rgba(251,191,36,0.25)', borderRadius: '10px', padding: '14px', marginBottom: '12px' }}>
          <div style={{ fontSize: '13px', fontWeight: 700, color: '#fbbf24', marginBottom: '8px' }}>
            {pendingPOs.length} Pending PO{pendingPOs.length !== 1 ? 's' : ''} — Review Required
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {pendingPOs.map(p => {
              const extracted = p.raw_extraction;
              const poNum = extracted?.po_number || p.po_number || 'Unknown';
              const customer = extracted?.customer || '';
              const lineCount = extracted?.line_items?.length || 0;
              return (
                <div key={p.id} style={{
                  padding: '10px 12px', borderRadius: '8px', background: 'var(--bg)', border: '1px solid var(--border)',
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-body)' }}>
                      PO #{poNum}
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--text-label)', marginTop: '2px' }}>
                      {customer}{lineCount > 0 ? ` · ${lineCount} line${lineCount !== 1 ? 's' : ''}` : ''}
                      {p.subject ? ` · ${p.subject}` : ''}
                    </div>
                    <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px' }}>
                      {new Date(p.created_at).toLocaleString()}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
                    <button
                      onClick={() => reviewPendingPO(p)}
                      style={{
                        padding: '6px 12px', borderRadius: '6px', fontSize: '11px', fontWeight: 700,
                        background: 'rgba(59,130,246,0.12)', border: '1px solid rgba(59,130,246,0.3)',
                        color: '#60a5fa', cursor: 'pointer',
                      }}
                    >Review</button>
                    <button
                      onClick={() => dismissPendingPO(p.id)}
                      style={{
                        padding: '6px 10px', borderRadius: '6px', fontSize: '11px', fontWeight: 700,
                        background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.2)',
                        color: '#f87171', cursor: 'pointer',
                      }}
                    >Dismiss</button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Gmail Email Import Panel */}
      {showEmailImport && (
        <div style={{ background: 'var(--subtle-bg)', border: '1px solid rgba(34,197,94,0.25)', borderRadius: '10px', padding: '14px', marginBottom: '12px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-body)' }}>Import POs from Gmail</div>
            <div style={{ display: 'flex', gap: '6px' }}>
              <select
                defaultValue="90"
                onChange={(e) => searchGmailPOs(parseInt(e.target.value))}
                style={{ padding: '4px 8px', borderRadius: '6px', background: 'var(--subtle-bg)', border: '1px solid var(--border)', color: 'var(--text-body)', fontSize: '11px' }}
              >
                <option value="7">Last 7 days</option>
                <option value="30">Last 30 days</option>
                <option value="90">Last 90 days</option>
              </select>
              <button
                onClick={() => searchGmailPOs()}
                style={{ padding: '4px 10px', borderRadius: '6px', background: 'var(--border)', border: 'none', color: '#60a5fa', fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}
              >Refresh</button>
            </div>
          </div>

          {emailNeedsAuth && (
            <div style={{ textAlign: 'center', padding: '20px' }}>
              <div style={{ fontSize: '12px', color: '#f59e0b', marginBottom: '10px' }}>Gmail is not connected. Authorize access to search for PO emails.</div>
              <a
                href="/api/auth/google"
                style={{ display: 'inline-block', padding: '10px 20px', borderRadius: '8px', background: '#3b82f6', color: '#fff', fontSize: '13px', fontWeight: 700, textDecoration: 'none' }}
              >Connect Gmail</a>
            </div>
          )}

          {emailError && !emailNeedsAuth && (
            <div style={{ padding: '8px', borderRadius: '6px', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.25)', fontSize: '11px', color: '#ef4444', marginBottom: '8px' }}>{emailError}</div>
          )}

          {emailLoading && (
            <div style={{ textAlign: 'center', padding: '20px' }}>
              <div style={{ fontSize: '12px', color: 'var(--text-label)' }}>Searching Gmail for PO emails...</div>
            </div>
          )}

          {!emailLoading && !emailNeedsAuth && emailEmails.length > 0 && (
            <div>
              {/* Summary */}
              {(() => {
                const newCount = emailEmails.filter(e => !e.alreadyImported && !e.alreadyInSystem && e.pdfs.length > 0 && !emailImportResults[e.messageId]).length;
                return newCount > 0 ? (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 10px', borderRadius: '8px', background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.2)', marginBottom: '8px' }}>
                    <span style={{ fontSize: '12px', fontWeight: 700, color: '#4ade80' }}>{newCount} new PO{newCount !== 1 ? 's' : ''} ready to import</span>
                    <button
                      onClick={importAllNewPOs}
                      disabled={importingEmailId !== null}
                      style={{ padding: '5px 12px', borderRadius: '6px', background: '#22c55e', border: 'none', color: '#fff', fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}
                    >Import All</button>
                  </div>
                ) : (
                  <div style={{ fontSize: '11px', color: 'var(--text-label)', marginBottom: '8px' }}>All PO emails have been imported or already exist.</div>
                );
              })()}

              {/* Email list */}
              <div style={{ maxHeight: '400px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                {emailEmails.map((email) => {
                  const result = emailImportResults[email.messageId];
                  const isImporting = importingEmailId === email.messageId;
                  const justImported = result?.status === 'imported' || result?.status === 'updated';
                  const failed = result?.status === 'error';
                  const existsInSystem = email.alreadyImported || email.alreadyInSystem;
                  const hasPdfs = email.pdfs.length > 0;

                  const borderColor = justImported ? 'rgba(34,197,94,0.3)' : failed ? 'rgba(239,68,68,0.3)' : existsInSystem ? 'rgba(34,197,94,0.2)' : 'rgba(59,130,246,0.2)';
                  const bgColor = justImported ? 'rgba(34,197,94,0.05)' : failed ? 'rgba(239,68,68,0.05)' : 'var(--input-bg)';

                  return (
                    <div key={email.messageId} style={{ padding: '10px', borderRadius: '8px', border: `1px solid ${borderColor}`, background: bgColor }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px' }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-body)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {email.poNumber ? `PO #${email.poNumber}` : email.subject}
                          </div>
                          <div style={{ fontSize: '10px', color: 'var(--text-label)', marginTop: '2px' }}>
                            {email.customer} · {email.from} · {new Date(email.date).toLocaleDateString()}
                          </div>
                          {email.pdfs.length > 0 && (
                            <div style={{ fontSize: '10px', color: 'var(--text-label)', marginTop: '1px' }}>
                              {email.pdfs.map((p: any) => p.filename).join(', ')}
                            </div>
                          )}
                        </div>
                        <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: '6px' }}>
                          {/* Green imported tag - shows after successful import/update OR if previously imported */}
                          {(justImported || existsInSystem) && (
                            <span style={{ fontSize: '10px', fontWeight: 700, color: '#4ade80', padding: '3px 8px', borderRadius: '4px', background: 'rgba(34,197,94,0.1)' }}>
                              ✓ {justImported ? (result?.status === 'updated' ? 'Updated' : 'Imported') : 'Imported'}{justImported && result?.lineCount ? ` (${result.lineCount} lines)` : ''}
                            </span>
                          )}
                          {failed && (
                            <span style={{ fontSize: '10px', fontWeight: 600, color: '#ef4444', padding: '3px 8px', borderRadius: '4px', background: 'rgba(239,68,68,0.1)' }}>
                              Failed
                            </span>
                          )}
                          {/* Always show Update button if there are PDFs (regardless of import status) */}
                          {hasPdfs && (
                            <button
                              onClick={() => importEmailPO(email.messageId)}
                              disabled={isImporting}
                              style={{
                                padding: '4px 10px', borderRadius: '5px', fontSize: '10px', fontWeight: 700, cursor: 'pointer',
                                background: isImporting ? 'var(--subtle-bg)' : (existsInSystem || justImported) ? 'rgba(251,191,36,0.15)' : '#3b82f6',
                                border: (existsInSystem || justImported) ? '1px solid rgba(251,191,36,0.3)' : 'none',
                                color: (existsInSystem || justImported) ? '#fbbf24' : '#fff',
                              }}
                            >
                              {isImporting ? 'Checking...' : failed ? 'Retry' : (existsInSystem || justImported) ? 'Update' : 'Import'}
                            </button>
                          )}
                          {!hasPdfs && (
                            <span style={{ fontSize: '10px', color: 'var(--text-label)' }}>No PDF</span>
                          )}
                          {!existsInSystem && !justImported && (
                            <button
                              onClick={() => dismissEmail(email.messageId, email)}
                              style={{
                                padding: '4px 8px', borderRadius: '5px', fontSize: '10px', fontWeight: 700, cursor: 'pointer',
                                background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', color: '#ef4444',
                              }}
                            >Dismiss</button>
                          )}
                        </div>
                      </div>
                      {failed && result.error && (
                        <div style={{ fontSize: '10px', color: '#ef4444', marginTop: '4px' }}>{result.error}</div>
                      )}
                      {/* Unmatched parts — offer to add to catalog */}
                      {justImported && result?.unmatchedParts?.length > 0 && (
                        <div style={{ marginTop: '8px', padding: '8px', borderRadius: '6px', background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.2)' }}>
                          <div style={{ fontSize: '10px', fontWeight: 700, color: '#fbbf24', marginBottom: '6px' }}>
                            {result.unmatchedParts.length} part{result.unmatchedParts.length !== 1 ? 's' : ''} not in catalog
                          </div>
                          {result.unmatchedParts.map((part: any) => {
                            const added = catalogAddResults[part.part_number] === 'added';
                            const errored = catalogAddResults[part.part_number] === 'error';
                            const isAdding = addingToCatalog === part.part_number;
                            return (
                              <div key={part.part_number} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                                <div style={{ flex: 1, minWidth: 0 }}>
                                  <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-body)' }}>{part.part_number}</span>
                                  <span style={{ fontSize: '10px', color: 'var(--text-label)', marginLeft: '8px' }}>{part.description}</span>
                                  <span style={{ fontSize: '10px', color: '#94a3b8', marginLeft: '8px' }}>${part.unit_price.toFixed(2)}</span>
                                </div>
                                {added ? (
                                  <span style={{ fontSize: '10px', fontWeight: 700, color: '#4ade80' }}>Added</span>
                                ) : errored ? (
                                  <span style={{ fontSize: '10px', fontWeight: 600, color: '#ef4444' }}>Error</span>
                                ) : (
                                  <button
                                    onClick={() => addPartToCatalog(part, result.customer || 'Masterack')}
                                    disabled={isAdding}
                                    style={{
                                      padding: '3px 8px', borderRadius: '4px', fontSize: '10px', fontWeight: 700,
                                      background: isAdding ? 'var(--subtle-bg)' : 'rgba(59,130,246,0.15)', border: '1px solid rgba(59,130,246,0.3)',
                                      color: '#60a5fa', cursor: 'pointer', whiteSpace: 'nowrap',
                                    }}
                                  >
                                    {isAdding ? 'Adding...' : 'Add to Catalog'}
                                  </button>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {!emailLoading && !emailNeedsAuth && emailEmails.length === 0 && (
            <div style={{ textAlign: 'center', padding: '16px', fontSize: '12px', color: 'var(--text-label)' }}>
              No PO emails found in the selected timeframe.
            </div>
          )}
        </div>
      )}

      {/* Email PO Review/Edit Panel */}
      {reviewingExtraction && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'var(--overlay)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' }}>
          <div style={{ background: 'var(--card)', border: '1px solid rgba(59,130,246,0.3)', borderRadius: '14px', width: '100%', maxWidth: reviewingExtraction.pdf && reviewPdfOpen ? 'min(1280px, 96vw)' : '520px', height: reviewingExtraction.pdf && reviewPdfOpen ? '88vh' : 'auto', maxHeight: '88vh', display: 'flex', alignItems: 'stretch', overflow: 'hidden' }}>
            {/* Form pane (scrolls independently of the PDF pane) */}
            <div style={{ padding: '18px', overflowY: 'auto', flex: reviewingExtraction.pdf && reviewPdfOpen ? '0 1 520px' : '1 1 auto', minWidth: '300px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
              <div>
                <div style={{ fontSize: '16px', fontWeight: 800, color: 'var(--text-body)' }}>
                  Review PO Import
                  {reviewingExtraction.queuePos && (
                    <span style={{ marginLeft: '8px', fontSize: '11px', fontWeight: 700, color: '#60a5fa', background: 'rgba(59,130,246,0.12)', padding: '2px 8px', borderRadius: '10px', verticalAlign: 'middle' }}>
                      PO {reviewingExtraction.queuePos.index} of {reviewingExtraction.queuePos.total} in this email
                    </span>
                  )}
                </div>
                <div style={{ fontSize: '11px', color: 'var(--text-label)', marginTop: '2px' }}>
                  PO #{reviewingExtraction.extracted.po_number} · {reviewingExtraction.extracted.customer || 'Unknown'} · {reviewingExtraction.extracted.lines?.length || 0} line items
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                {reviewingExtraction.pdf && (
                  <button
                    onClick={() => setReviewPdfOpen(o => !o)}
                    style={{ background: reviewPdfOpen ? 'rgba(59,130,246,0.12)' : 'none', border: '1px solid rgba(59,130,246,0.35)', color: '#60a5fa', fontSize: '10px', fontWeight: 700, cursor: 'pointer', padding: '4px 8px', borderRadius: '6px', whiteSpace: 'nowrap' }}
                    title="Show the original PDF next to the form for comparison"
                  >{reviewPdfOpen ? 'Hide PDF' : 'View PDF'}</button>
                )}
                <button onClick={() => { setReviewingExtraction(null); setReviewQueue([]); }} style={{ background: 'none', border: 'none', color: 'var(--text-label)', fontSize: '18px', cursor: 'pointer', padding: '4px' }}>✕</button>
              </div>
            </div>

            {/* PO header fields */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px', marginBottom: '10px' }}>
              <div>
                <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-label)', textTransform: 'uppercase', marginBottom: '3px' }}>PO Number</div>
                <input
                  value={reviewingExtraction.extracted.po_number || ''}
                  onChange={e => setReviewingExtraction(prev => prev ? { ...prev, extracted: { ...prev.extracted, po_number: e.target.value } } : prev)}
                  style={{ width: '100%', padding: '6px 8px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-body)', fontSize: '12px', fontWeight: 700 }}
                />
              </div>
              <div>
                <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-label)', textTransform: 'uppercase', marginBottom: '3px' }}>Customer</div>
                <input
                  value={reviewingExtraction.extracted.customer || ''}
                  onChange={e => setReviewingExtraction(prev => prev ? { ...prev, extracted: { ...prev.extracted, customer: e.target.value } } : prev)}
                  style={{ width: '100%', padding: '6px 8px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-body)', fontSize: '12px' }}
                />
              </div>
              <div>
                <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-label)', textTransform: 'uppercase', marginBottom: '3px' }}>Order Date</div>
                <input
                  value={reviewingExtraction.extracted.ordered_date || ''}
                  onChange={e => setReviewingExtraction(prev => prev ? { ...prev, extracted: { ...prev.extracted, ordered_date: e.target.value } } : prev)}
                  style={{ width: '100%', padding: '6px 8px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-body)', fontSize: '12px' }}
                />
              </div>
            </div>

            {/* Ship To picker — same UI as the create/edit flows */}
            <div style={{ marginBottom: '14px' }}>
              <ShipToPicker
                label="Ship To"
                locations={locations}
                selectedId={reviewShipToId}
                shipTo={reviewingExtraction.extracted.ship_to || {}}
                onSelect={(id) => {
                  setReviewShipToId(id);
                  if (!id) return;
                  const loc = locations.find(l => l.id === id);
                  if (!loc) return;
                  setReviewingExtraction(prev => prev ? {
                    ...prev,
                    extracted: {
                      ...prev.extracted,
                      ship_to: {
                        name: loc.name,
                        address: loc.address || '',
                        city: loc.city || '',
                        state: loc.state || '',
                        zip: loc.zip || '',
                      },
                    },
                  } : prev);
                }}
                onChange={(next) => {
                  setReviewShipToId('');
                  setReviewingExtraction(prev => prev ? { ...prev, extracted: { ...prev.extracted, ship_to: next } } : prev);
                }}
                onManage={() => setShowLocations(true)}
                onSave={() => saveShipToAsLocation(reviewingExtraction.extracted.ship_to || {}, setReviewShipToId)}
              />
            </div>

            {/* Line items */}
            <div style={{ fontSize: '11px', fontWeight: 700, color: '#60a5fa', marginBottom: '8px' }}>
              Line Items ({reviewingExtraction.extracted.lines?.length || 0})
            </div>

            {(reviewingExtraction.extracted.lines || []).map((line: any, idx: number) => {
              const catalogMatch = catalog.find(c =>
                c.part_number.toUpperCase() === (line.part_number || '').toUpperCase()
              );
              return (
                <div key={idx} style={{
                  padding: '10px', marginBottom: '6px', borderRadius: '8px',
                  background: catalogMatch ? 'rgba(34,197,94,0.04)' : 'rgba(251,191,36,0.04)',
                  border: `1px solid ${catalogMatch ? 'rgba(34,197,94,0.2)' : 'rgba(251,191,36,0.2)'}`,
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                    <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-label)' }}>Line {line.line_no || idx + 1}</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      {catalogMatch && <span style={{ fontSize: '9px', color: '#4ade80', fontWeight: 600 }}>✓ Catalog match</span>}
                      {!catalogMatch && <span style={{ fontSize: '9px', color: '#fbbf24', fontWeight: 600 }}>No catalog match</span>}
                      {createdNsLines.has(idx) ? (
                        <span style={{ fontSize: '9px', color: '#4ade80', fontWeight: 700 }}>✓ NetSuite</span>
                      ) : line.part_number ? (
                        <button
                          onClick={() => setCreateNsItemLine({ idx, partNumber: line.part_number.trim(), description: line.description || null })}
                          style={{ background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.3)', color: '#22c55e', fontSize: '9px', fontWeight: 700, cursor: 'pointer', padding: '2px 6px', borderRadius: '5px' }}
                          title="Create this part in NetSuite"
                        >+ NetSuite</button>
                      ) : null}
                      <button
                        onClick={() => removeReviewLine(idx)}
                        style={{ background: 'none', border: 'none', color: '#ef4444', fontSize: '12px', cursor: 'pointer', padding: '2px 4px' }}
                        title="Remove line"
                      >✕</button>
                    </div>
                  </div>
                  <div style={{ marginBottom: '6px' }}>
                    <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-label)', textTransform: 'uppercase', marginBottom: '2px' }}>Part Number</div>
                    <input
                      value={line.part_number || ''}
                      onChange={e => updateReviewLine(idx, 'part_number', e.target.value)}
                      style={{ width: '100%', padding: '5px 7px', borderRadius: '5px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-body)', fontSize: '12px', fontWeight: 700 }}
                    />
                  </div>
                  <div style={{ marginBottom: '6px' }}>
                    <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-label)', textTransform: 'uppercase', marginBottom: '2px' }}>Description</div>
                    <input
                      value={line.description || ''}
                      onChange={e => updateReviewLine(idx, 'description', e.target.value)}
                      style={{ width: '100%', padding: '5px 7px', borderRadius: '5px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-body)', fontSize: '11px' }}
                    />
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '6px' }}>
                    <div>
                      <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-label)', textTransform: 'uppercase', marginBottom: '2px' }}>Qty</div>
                      <input
                        type="number"
                        value={line.quantity ?? ''}
                        onChange={e => updateReviewLine(idx, 'quantity', parseInt(e.target.value) || 0)}
                        style={{ width: '100%', padding: '5px 7px', borderRadius: '5px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-body)', fontSize: '12px' }}
                      />
                    </div>
                    <div>
                      <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-label)', textTransform: 'uppercase', marginBottom: '2px' }}>Unit Price</div>
                      <input
                        type="number"
                        step="0.01"
                        value={line.unit_price ?? ''}
                        onChange={e => updateReviewLine(idx, 'unit_price', parseFloat(e.target.value) || 0)}
                        style={{ width: '100%', padding: '5px 7px', borderRadius: '5px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-body)', fontSize: '12px' }}
                      />
                    </div>
                    <div>
                      <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-label)', textTransform: 'uppercase', marginBottom: '2px' }}>Delivery</div>
                      <input
                        value={line.delivery_date || ''}
                        onChange={e => updateReviewLine(idx, 'delivery_date', e.target.value)}
                        style={{ width: '100%', padding: '5px 7px', borderRadius: '5px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-body)', fontSize: '11px' }}
                      />
                    </div>
                  </div>
                  {line.drawing_number && (
                    <div style={{ marginTop: '4px', fontSize: '10px', color: 'var(--text-label)' }}>
                      Drawing: {line.drawing_number}
                    </div>
                  )}
                </div>
              );
            })}

            {/* Total summary */}
            {reviewingExtraction.extracted.lines?.length > 0 && (
              <div style={{ padding: '8px 10px', borderRadius: '6px', background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.15)', marginTop: '8px', marginBottom: '12px' }}>
                <div style={{ fontSize: '11px', color: '#60a5fa', fontWeight: 700 }}>
                  Total: {reviewingExtraction.extracted.lines.reduce((sum: number, l: any) => sum + (parseInt(l.quantity) || 0), 0)} units · ${reviewingExtraction.extracted.lines.reduce((sum: number, l: any) => sum + ((parseInt(l.quantity) || 0) * (parseFloat(l.unit_price) || 0)), 0).toFixed(2)}
                </div>
              </div>
            )}

            {/* Action buttons */}
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                onClick={confirmReviewedImport}
                disabled={importingEmailId !== null || !reviewingExtraction.extracted.lines?.length}
                style={{
                  flex: 1, padding: '12px', borderRadius: '10px',
                  background: importingEmailId ? 'var(--subtle-bg)' : '#22c55e',
                  color: '#fff', fontWeight: 800, fontSize: '13px', border: 'none', cursor: 'pointer',
                  opacity: importingEmailId || !reviewingExtraction.extracted.lines?.length ? 0.5 : 1,
                }}
              >
                {importingEmailId ? 'Importing...' : `Import ${reviewingExtraction.extracted.lines?.length || 0} Lines`}
              </button>
              <button
                onClick={() => { setReviewingExtraction(null); setReviewQueue([]); }}
                style={{ flex: 1, padding: '12px', borderRadius: '10px', background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-body)', fontWeight: 700, fontSize: '13px', cursor: 'pointer' }}
              >
                Cancel
              </button>
            </div>
            </div>

            {/* Source PDF pane — the original email attachment, side by side for comparison */}
            {reviewingExtraction.pdf && reviewPdfOpen && (
              <div style={{ flex: '1 1 340px', minWidth: 0, borderLeft: '1px solid var(--border)', display: 'flex', flexDirection: 'column', background: 'var(--subtle-bg)' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', padding: '8px 12px', borderBottom: '1px solid var(--border)' }}>
                  <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-label)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{reviewingExtraction.pdf.name}</div>
                  <a href={reviewingExtraction.pdf.url} target="_blank" rel="noreferrer" style={{ fontSize: '10px', fontWeight: 700, color: '#60a5fa', textDecoration: 'none', whiteSpace: 'nowrap' }}>Open in new tab ↗</a>
                </div>
                <iframe src={reviewingExtraction.pdf.url} title={reviewingExtraction.pdf.name} style={{ flex: 1, width: '100%', border: 'none' }} />
              </div>
            )}
          </div>
        </div>
      )}

      {/* PO Overwrite Confirmation Dialog */}
      {showOverwriteConfirm && overwriteData && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'var(--overlay)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' }}>
          <div style={{ background: 'var(--card)', border: '1px solid rgba(251,191,36,0.3)', borderRadius: '14px', padding: '18px', maxWidth: '420px', width: '100%', maxHeight: '80vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
              <div>
                <div style={{ fontSize: '15px', fontWeight: 800, color: '#fbbf24' }}>PO #{overwriteData.poNumber} Already Exists</div>
                <div style={{ fontSize: '11px', color: 'var(--text-label)', marginTop: '2px' }}>
                  {overwriteData.existingLineCount} existing line{overwriteData.existingLineCount !== 1 ? 's' : ''} vs {overwriteData.newLineCount} in new PDF
                </div>
              </div>
            </div>

            {overwriteData.hasChanges ? (
              <div>
                <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-body)', marginBottom: '8px' }}>Changes Detected:</div>

                {/* Added lines */}
                {overwriteData.changes.filter((c: any) => c.type === 'added').length > 0 && (
                  <div style={{ marginBottom: '8px' }}>
                    <div style={{ fontSize: '10px', fontWeight: 700, color: '#4ade80', textTransform: 'uppercase', marginBottom: '4px' }}>+ New Lines</div>
                    {overwriteData.changes.filter((c: any) => c.type === 'added').map((c: any, i: number) => (
                      <div key={`add-${i}`} style={{ padding: '6px 8px', marginBottom: '3px', borderRadius: '6px', background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.2)' }}>
                        <div style={{ fontSize: '12px', fontWeight: 700, color: '#4ade80' }}>{c.part_number}</div>
                        <div style={{ fontSize: '10px', color: 'var(--text-label)' }}>{c.description}</div>
                        <div style={{ fontSize: '11px', color: 'var(--text-body)', marginTop: '2px' }}>Qty: {c.quantity} × ${c.unit_price?.toFixed(2)}</div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Changed lines */}
                {overwriteData.changes.filter((c: any) => c.type === 'changed').length > 0 && (
                  <div style={{ marginBottom: '8px' }}>
                    <div style={{ fontSize: '10px', fontWeight: 700, color: '#fbbf24', textTransform: 'uppercase', marginBottom: '4px' }}>~ Modified Lines</div>
                    {overwriteData.changes.filter((c: any) => c.type === 'changed').map((c: any, i: number) => (
                      <div key={`chg-${i}`} style={{ padding: '6px 8px', marginBottom: '3px', borderRadius: '6px', background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.2)' }}>
                        <div style={{ fontSize: '12px', fontWeight: 700, color: '#fbbf24' }}>{c.part_number}</div>
                        <div style={{ fontSize: '10px', color: 'var(--text-label)' }}>{c.description}</div>
                        <div style={{ display: 'flex', gap: '12px', marginTop: '3px' }}>
                          {c.quantity_changed && (
                            <div style={{ fontSize: '11px' }}>
                              <span style={{ color: '#ef4444', textDecoration: 'line-through' }}>Qty: {c.old_quantity}</span>
                              <span style={{ color: '#4ade80', marginLeft: '4px' }}>Qty: {c.new_quantity}</span>
                            </div>
                          )}
                          {c.price_changed && (
                            <div style={{ fontSize: '11px' }}>
                              <span style={{ color: '#ef4444', textDecoration: 'line-through' }}>${c.old_price?.toFixed(2)}</span>
                              <span style={{ color: '#4ade80', marginLeft: '4px' }}>${c.new_price?.toFixed(2)}</span>
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Removed lines */}
                {overwriteData.changes.filter((c: any) => c.type === 'removed').length > 0 && (
                  <div style={{ marginBottom: '8px' }}>
                    <div style={{ fontSize: '10px', fontWeight: 700, color: '#ef4444', textTransform: 'uppercase', marginBottom: '4px' }}>- Removed Lines</div>
                    {overwriteData.changes.filter((c: any) => c.type === 'removed').map((c: any, i: number) => (
                      <div key={`rem-${i}`} style={{ padding: '6px 8px', marginBottom: '3px', borderRadius: '6px', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)' }}>
                        <div style={{ fontSize: '12px', fontWeight: 700, color: '#ef4444' }}>{c.part_number}</div>
                        <div style={{ fontSize: '11px', color: 'var(--text-body)' }}>Qty: {c.quantity} × ${c.unit_price?.toFixed(2)}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div style={{ padding: '12px', borderRadius: '8px', background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.2)', marginBottom: '8px' }}>
                <div style={{ fontSize: '12px', color: '#60a5fa', fontWeight: 600 }}>No changes detected</div>
                <div style={{ fontSize: '11px', color: 'var(--text-label)', marginTop: '2px' }}>The new PDF has the same line items as the existing PO. You can still overwrite to refresh the data.</div>
              </div>
            )}

            <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
              <button
                onClick={confirmOverwrite}
                disabled={overwriting}
                style={{ flex: 1, padding: '12px', borderRadius: '10px', background: overwriting ? 'var(--subtle-bg)' : '#f59e0b', color: '#fff', fontWeight: 800, fontSize: '13px', border: 'none', cursor: 'pointer' }}
              >
                {overwriting ? 'Updating...' : overwriteData.hasChanges ? 'Apply Changes' : 'Overwrite Anyway'}
              </button>
              <button
                onClick={cancelOverwrite}
                disabled={overwriting}
                style={{ flex: 1, padding: '12px', borderRadius: '10px', background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-body)', fontWeight: 700, fontSize: '13px', cursor: 'pointer' }}
              >
                Keep Existing
              </button>
            </div>
          </div>
        </div>
      )}

      {/* PDF Import Panel */}
      {showImport && !parsedPO && (
        <div style={{ background: 'var(--subtle-bg)', border: '1px solid var(--border)', borderRadius: '10px', padding: '14px', marginBottom: '12px' }}>
          <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-body)', marginBottom: '6px' }}>Import Masterack PO from PDF</div>
          <div style={{ fontSize: '11px', color: 'var(--text-label)', marginBottom: '10px' }}>
            Upload a Masterack PO PDF. Part numbers, quantities, and prices will be extracted. You can review and edit before saving.
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".pdf"
            onChange={handlePDFUpload}
            style={{ fontSize: '13px', color: 'var(--text-body)' }}
          />
          {parseError && (
            <div style={{ marginTop: '10px', padding: '8px 12px', background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: '8px', color: '#f87171', fontSize: '12px' }}>
              {parseError}
            </div>
          )}
        </div>
      )}

      {/* Review imported PO before saving */}
      {parsedPO && (
        <div style={{ background: 'var(--subtle-bg)', border: '1px solid rgba(59,130,246,0.3)', borderRadius: '10px', padding: '14px', marginBottom: '12px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
            <div>
              <div style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text-body)' }}>PO #{parsedPO.po_number}</div>
              <div style={{ fontSize: '11px', color: 'var(--text-label)' }}>
                Masterack • {parsedPO.ordered_date} • {importLines.filter((l) => l.include).length} lines
                {importLines.filter((l) => l.include && !l.catalog_match).length > 0 && (
                  <span style={{ color: '#fbbf24', marginLeft: '6px' }}>
                    • {importLines.filter((l) => l.include && !l.catalog_match).length} new to catalog
                  </span>
                )}
              </div>
            </div>
            <div style={{ fontSize: '11px', color: pdfOverwriteExisting ? '#f59e0b' : '#60a5fa', fontWeight: 700 }}>{pdfOverwriteExisting ? 'OVERWRITE' : 'REVIEW'}</div>
          </div>

          {/* Overwrite warning */}
          {pdfOverwriteExisting && (
            <div style={{ padding: '10px 12px', borderRadius: '8px', background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.3)', marginBottom: '10px', display: 'flex', alignItems: 'center', gap: '10px' }}>
              <span style={{ fontSize: '14px', fontWeight: 700, color: '#f59e0b' }}>Warning</span>
              <div>
                <div style={{ fontSize: '12px', fontWeight: 700, color: '#f59e0b' }}>PO #{parsedPO.po_number} already exists</div>
                <div style={{ fontSize: '11px', color: '#a08332' }}>
                  Current: {pdfOverwriteExisting.line_items?.length || 0} line items • New: {importLines.filter((l) => l.include).length} line items. Importing will replace all existing line items.
                </div>
              </div>
            </div>
          )}

          {/* Line items to review */}
          {importLines.map((line, idx) => (
            <div
              key={idx}
              style={{
                padding: '10px', marginBottom: '6px', borderRadius: '8px',
                background: line.include ? 'rgba(59,130,246,0.04)' : 'rgba(100,100,100,0.04)',
                border: `1px solid ${line.include ? 'rgba(59,130,246,0.15)' : 'rgba(100,100,100,0.15)'}`,
                opacity: line.include ? 1 : 0.5,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: '6px' }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 800, fontSize: '14px', color: 'var(--text-body)' }}>{line.part_number}</div>
                  <div style={{ fontSize: '11px', color: 'var(--text-label)', marginTop: '1px' }}>{line.description}</div>
                  {line.catalog_match ? (
                    <div style={{ fontSize: '10px', color: '#4ade80', marginTop: '3px' }}>✓ Found in catalog: {line.catalog_match.graphic_package || line.catalog_match.part_number}</div>
                  ) : (
                    <div>
                      <div style={{ fontSize: '10px', color: '#fbbf24', marginTop: '3px', marginBottom: '6px' }}>⚠ New part — will be added to catalog on import</div>
                      {line.include && (
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px' }}>
                          <div>
                            <label style={{ display: 'block', fontSize: '8px', fontWeight: 700, color: 'var(--text-label)', textTransform: 'uppercase', marginBottom: '2px' }}>End Customer</label>
                            <input
                              value={line.new_end_customer}
                              onChange={(e) => setImportLines((prev) => prev.map((l, j) => j === idx ? { ...l, new_end_customer: e.target.value } : l))}
                              placeholder="e.g. Glass America"
                              style={{ width: '100%', padding: '5px 8px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-body)', fontSize: '11px' }}
                            />
                          </div>
                          <div>
                            <label style={{ display: 'block', fontSize: '8px', fontWeight: 700, color: 'var(--text-label)', textTransform: 'uppercase', marginBottom: '2px' }}>Vehicle Type</label>
                            <input
                              value={line.new_vehicle_type}
                              onChange={(e) => setImportLines((prev) => prev.map((l, j) => j === idx ? { ...l, new_vehicle_type: e.target.value } : l))}
                              placeholder="e.g. Transit"
                              style={{ width: '100%', padding: '5px 8px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-body)', fontSize: '11px' }}
                            />
                          </div>
                          <div style={{ gridColumn: 'span 2' }}>
                            <label style={{ display: 'block', fontSize: '8px', fontWeight: 700, color: 'var(--text-label)', textTransform: 'uppercase', marginBottom: '2px' }}>Graphic Package</label>
                            <input
                              value={line.new_graphic_package}
                              onChange={(e) => setImportLines((prev) => prev.map((l, j) => j === idx ? { ...l, new_graphic_package: e.target.value } : l))}
                              placeholder="e.g. Install decals"
                              style={{ width: '100%', padding: '5px 8px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-body)', fontSize: '11px' }}
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
                <button
                  onClick={() => toggleLineInclude(idx)}
                  style={{
                    padding: '4px 8px', borderRadius: '6px', fontSize: '10px', fontWeight: 700, border: 'none',
                    background: line.include ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
                    color: line.include ? '#4ade80' : '#f87171',
                  }}
                >
                  {line.include ? '✓ Include' : '✕ Skip'}
                </button>
              </div>

              {line.include && (
                <div style={{ display: 'flex', gap: '8px', alignItems: 'end' }}>
                  <div>
                    <label style={{ display: 'block', fontSize: '9px', fontWeight: 700, color: 'var(--text-label)', textTransform: 'uppercase', marginBottom: '2px' }}>Qty</label>
                    <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-body)' }}>{line.quantity}</div>
                  </div>

                  <div style={{ flex: 1 }}>
                    <label style={{ display: 'block', fontSize: '9px', fontWeight: 700, color: 'var(--text-label)', textTransform: 'uppercase', marginBottom: '2px' }}>Price</label>
                    <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                      <input
                        type="number"
                        value={line.final_price}
                        onChange={(e) => updateFinalPrice(idx, e.target.value)}
                        step="0.01"
                        style={{ width: '90px', padding: '6px 8px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-body)', fontSize: '13px' }}
                      />
                      {line.catalog_match && line.catalog_match.price > 0 && (
                        <button
                          onClick={() => togglePriceSource(idx)}
                          style={{
                            padding: '3px 6px', borderRadius: '4px', fontSize: '9px', fontWeight: 700, border: 'none',
                            background: line.use_catalog_price ? 'rgba(34,197,94,0.1)' : 'rgba(251,191,36,0.1)',
                            color: line.use_catalog_price ? '#4ade80' : '#fbbf24',
                          }}
                        >
                          {line.use_catalog_price ? 'Catalog' : 'PO'} ${line.use_catalog_price ? line.catalog_match.price.toFixed(2) : line.unit_price.toFixed(2)}
                        </button>
                      )}
                    </div>
                  </div>

                  <div style={{ textAlign: 'right' }}>
                    <label style={{ display: 'block', fontSize: '9px', fontWeight: 700, color: 'var(--text-label)', textTransform: 'uppercase', marginBottom: '2px' }}>Total</label>
                    <div style={{ fontSize: '14px', fontWeight: 800, color: '#60a5fa' }}>{fmt(line.quantity * line.final_price)}</div>
                  </div>
                </div>
              )}
            </div>
          ))}

          {/* Totals and actions */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0 6px', borderTop: '1px solid var(--border)', marginTop: '6px' }}>
            <div style={{ fontSize: '14px', fontWeight: 800, color: 'var(--text-body)' }}>
              Grand Total: <span style={{ color: '#60a5fa' }}>{fmt(importLines.filter((l) => l.include).reduce((s, l) => s + l.quantity * l.final_price, 0))}</span>
            </div>
            <div style={{ fontSize: '11px', color: 'var(--text-label)' }}>
              {importLines.filter((l) => l.include).length} of {importLines.length} lines
            </div>
          </div>

          <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
            <button
              onClick={pdfOverwriteExisting ? handleOverwritePO : handleImportPO}
              disabled={importing || importLines.filter((l) => l.include).length === 0}
              style={{
                flex: 1, padding: '12px', borderRadius: '10px',
                background: pdfOverwriteExisting ? '#f59e0b' : '#22c55e',
                color: '#fff', fontWeight: 800, fontSize: '14px', border: 'none',
                opacity: importing || importLines.filter((l) => l.include).length === 0 ? 0.4 : 1,
              }}
            >
              {importing ? (pdfOverwriteExisting ? 'Overwriting...' : 'Importing...') : (pdfOverwriteExisting ? 'Overwrite PO' : 'Import PO')}
            </button>
            <button
              onClick={cancelImport}
              style={{ padding: '12px 20px', borderRadius: '10px', background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-body)', fontWeight: 700, fontSize: '14px' }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Manual create form */}
      {showLocations && (
        <div style={{ background: 'var(--subtle-bg)', border: '1px solid var(--border)', borderRadius: '10px', padding: '14px', marginBottom: '12px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
            <div style={{ fontSize: '13px', fontWeight: 800, color: 'var(--text-body)' }}>Saved ship-to locations</div>
            <button onClick={() => setShowLocations(false)} style={{ fontSize: '12px', fontWeight: 700, background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-body)', borderRadius: '6px', padding: '4px 10px' }}>Close</button>
          </div>
          {locations.length > 0 && (
            <div style={{ marginBottom: '12px' }}>
              {locations.map(loc => (
                <div key={loc.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px', padding: '8px 10px', borderRadius: '8px', marginBottom: '4px', background: 'var(--card-bg)', border: '1px solid var(--border)' }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-body)' }}>{loc.name}</div>
                    <div style={{ fontSize: '11px', color: 'var(--text-label)' }}>
                      {[loc.address, [loc.city, loc.state].filter(Boolean).join(', '), loc.zip].filter(Boolean).join(' · ') || '—'}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '4px' }}>
                    <button
                      onClick={() => setLocationForm({ id: loc.id, name: loc.name, address: loc.address || '', city: loc.city || '', state: loc.state || '', zip: loc.zip || '' })}
                      style={{ fontSize: '11px', fontWeight: 700, padding: '4px 8px', borderRadius: '6px', background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-body)' }}
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => archiveLocation(loc.id)}
                      style={{ fontSize: '11px', fontWeight: 700, padding: '4px 8px', borderRadius: '6px', background: 'transparent', border: '1px solid rgba(248,113,113,0.3)', color: '#f87171' }}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          {locations.length === 0 && (
            <div style={{ fontSize: '12px', color: 'var(--text-label)', marginBottom: '12px' }}>No saved locations yet. Add one below to use it on POs.</div>
          )}
          <div style={{ background: 'var(--card-bg)', border: '1px solid var(--border)', borderRadius: '8px', padding: '10px' }}>
            <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-label)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '6px' }}>
              {locationForm.id ? 'Edit location' : 'Add new location'}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '6px' }}>
              <input placeholder="Location name (e.g., Main Warehouse)" value={locationForm.name} onChange={e => setLocationForm({ ...locationForm, name: e.target.value })} style={inputStyle} />
              <input placeholder="Street address" value={locationForm.address} onChange={e => setLocationForm({ ...locationForm, address: e.target.value })} style={inputStyle} />
              <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: '6px' }}>
                <input placeholder="City" value={locationForm.city} onChange={e => setLocationForm({ ...locationForm, city: e.target.value })} style={inputStyle} />
                <input placeholder="State" value={locationForm.state} onChange={e => setLocationForm({ ...locationForm, state: e.target.value })} style={inputStyle} />
                <input placeholder="ZIP" value={locationForm.zip} onChange={e => setLocationForm({ ...locationForm, zip: e.target.value })} style={inputStyle} />
              </div>
            </div>
            <div style={{ display: 'flex', gap: '6px', marginTop: '8px' }}>
              <button
                onClick={saveLocation}
                disabled={locationSaving || !locationForm.name.trim()}
                style={{ flex: 1, padding: '8px', borderRadius: '8px', background: '#22c55e', color: '#fff', fontSize: '12px', fontWeight: 700, border: 'none', opacity: (locationSaving || !locationForm.name.trim()) ? 0.5 : 1 }}
              >
                {locationSaving ? 'Saving…' : (locationForm.id ? 'Save changes' : 'Add location')}
              </button>
              {locationForm.id && (
                <button
                  onClick={() => setLocationForm({ id: '', name: '', address: '', city: '', state: '', zip: '' })}
                  style={{ flex: 1, padding: '8px', borderRadius: '8px', background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-body)', fontSize: '12px', fontWeight: 700 }}
                >
                  Cancel edit
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {showCreate && (
        <div style={{ background: 'var(--subtle-bg)', border: '1px solid var(--border)', borderRadius: '10px', padding: '14px', marginBottom: '12px' }}>
          <div style={{ marginBottom: '8px' }}>
            <label style={labelStyle}>PO Number</label>
            <input value={form.po_number} onChange={(e) => setForm({ ...form, po_number: e.target.value })} style={inputStyle} />
          </div>
          <div style={{ marginBottom: '8px' }}>
            <label style={labelStyle}>Customer</label>
            <select value={form.customer} onChange={(e) => setForm({ ...form, customer: e.target.value })} style={inputStyle}>
              <option>Masterack</option><option>Knapheide</option><option>Bodewell</option><option>Designs That Stick</option>
            </select>
          </div>
          <ShipToPicker
            label="Ship To"
            locations={locations}
            selectedId={createShipToId}
            shipTo={createShipTo}
            onSelect={(id) => applyLocationToShipTo(id, setCreateShipToId, setCreateShipTo)}
            onChange={(next) => { setCreateShipToId(''); setCreateShipTo(next); }}
            onManage={() => setShowLocations(true)}
            onSave={() => saveShipToAsLocation(createShipTo, setCreateShipToId)}
          />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '8px' }}>
            <div>
              <label style={labelStyle}>Ordered Date</label>
              <input type="date" value={form.ordered_date} onChange={e => setForm({ ...form, ordered_date: e.target.value })} style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>Requested Delivery</label>
              <input type="date" value={form.requested_delivery_date} onChange={e => setForm({ ...form, requested_delivery_date: e.target.value })} style={inputStyle} />
            </div>
          </div>
          <div style={{ marginBottom: '8px' }}>
            <label style={labelStyle}>Notes</label>
            <textarea
              value={form.notes}
              onChange={e => setForm({ ...form, notes: e.target.value })}
              placeholder="Internal notes about this PO"
              rows={2}
              style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }}
            />
          </div>
          <div style={{ marginBottom: '8px' }}>
            <label style={labelStyle}>Add Part</label>
            <div style={{ marginBottom: '6px' }}>
              <CatalogPartSearch catalog={catalog} customer={form.customer} onPick={(c) => pickCreateLinePart(c.id)} />
            </div>
            <input
              value={createLineForm.part_number}
              onChange={(e) => setCreateLineForm({ ...createLineForm, part_number: e.target.value })}
              placeholder="Type or pick a part number…"
              style={{ ...inputStyle, marginBottom: '6px', fontWeight: 700 }}
            />
            <div style={{ display: 'flex', gap: '6px', alignItems: 'end' }}>
              <div style={{ flex: 1 }}>
                <label style={{ ...labelStyle, fontSize: '9px' }}>Qty</label>
                <input type="number" value={createLineForm.quantity} onChange={(e) => setCreateLineForm({ ...createLineForm, quantity: e.target.value })} style={inputStyle} min={1} />
              </div>
              <div style={{ flex: 1 }}>
                <label style={{ ...labelStyle, fontSize: '9px' }}>Unit Price</label>
                <input type="number" value={createLineForm.unit_price} onChange={(e) => setCreateLineForm({ ...createLineForm, unit_price: e.target.value })} style={inputStyle} step="0.01" />
              </div>
              <button
                onClick={addCreateLine}
                disabled={!createLineForm.part_number.trim()}
                style={{ padding: '10px 14px', borderRadius: '8px', background: '#22c55e', color: '#fff', fontWeight: 700, fontSize: '13px', border: 'none', opacity: createLineForm.part_number.trim() ? 1 : 0.5, cursor: createLineForm.part_number.trim() ? 'pointer' : 'default' }}
              >
                + Add
              </button>
            </div>
          </div>

          {lineItems.length > 0 && (
            <div style={{ marginBottom: '8px' }}>
              {lineItems.map((li, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
                  <div style={{ flex: 1, fontSize: '13px', fontWeight: 700 }}>{li.part_number}</div>
                  <div style={{ fontSize: '12px', color: 'var(--text-label)' }}>{fmt(li.unit_price)}</div>
                  <input
                    type="number"
                    value={li.quantity}
                    onChange={(e) => {
                      const q = parseInt(e.target.value) || 1;
                      setLineItems((prev) => prev.map((item, j) => j === i ? { ...item, quantity: q } : item));
                    }}
                    style={{ ...inputStyle, width: '60px', textAlign: 'center' }}
                    min={1}
                  />
                  <button onClick={() => setLineItems((prev) => prev.filter((_, j) => j !== i))} style={{ color: '#f87171', fontSize: '18px', padding: '0 4px', background: 'none', border: 'none' }}>×</button>
                </div>
              ))}
              <div style={{ textAlign: 'right', marginTop: '6px', fontSize: '13px', fontWeight: 700, color: '#60a5fa' }}>
                Total: {fmt(lineItems.reduce((s, l) => s + l.quantity * l.unit_price, 0))}
              </div>
            </div>
          )}

          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              onClick={handleCreate}
              disabled={!form.po_number || lineItems.length === 0}
              style={{
                flex: 1, padding: '12px', borderRadius: '10px', background: '#22c55e',
                color: '#fff', fontWeight: 800, fontSize: '14px', border: 'none',
                opacity: form.po_number && lineItems.length > 0 ? 1 : 0.4,
              }}
            >
              Create PO
            </button>
            <button
              onClick={handleCreateAndGraphics}
              disabled={!form.po_number || lineItems.length === 0}
              title="Save the PO and jump straight into the graphics-job form with the customer and PO# prefilled"
              style={{
                flex: 1, padding: '12px', borderRadius: '10px', background: '#a78bfa',
                color: '#fff', fontWeight: 800, fontSize: '14px', border: 'none',
                opacity: form.po_number && lineItems.length > 0 ? 1 : 0.4,
              }}
            >
              Create PO + Graphics Job
            </button>
          </div>
        </div>
      )}

      {pos.length === 0 && !showImport && !showCreate && (
        <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--text-label)' }}>
          <div style={{ fontWeight: 600, fontSize: '13px' }}>No purchase orders yet</div>
        </div>
      )}

      {pos.length > 0 && filteredPos.length === 0 && poSearch && (
        <div style={{ textAlign: 'center', padding: '24px 0', color: 'var(--text-label)' }}>
          <div style={{ fontSize: '12px' }}>No POs matching &quot;{poSearch}&quot;</div>
        </div>
      )}

      {/* Batch Invoice Controls */}
      {invoiceablePOs.length > 0 && (
        <div style={{ background: 'var(--subtle-bg)', border: '1px solid rgba(167,139,250,0.25)', borderRadius: '10px', padding: '10px 12px', marginBottom: '10px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ fontSize: '12px', fontWeight: 700, color: '#a78bfa' }}>
                Batch Invoice {selectedForInvoice.size > 0 ? `(${selectedForInvoice.size} selected)` : ''}
              </div>
              <div style={{ fontSize: '10px', color: 'var(--text-label)', marginTop: '2px' }}>
                {invoiceablePOs.length} PO{invoiceablePOs.length !== 1 ? 's' : ''} ready to invoice (have SO + installed qty)
              </div>
            </div>
            <div style={{ display: 'flex', gap: '6px' }}>
              <button
                onClick={() => {
                  if (selectedForInvoice.size === invoiceablePOs.length) {
                    setSelectedForInvoice(new Set());
                  } else {
                    setSelectedForInvoice(new Set(invoiceablePOs.map(p => p.id)));
                  }
                }}
                style={{ padding: '5px 10px', borderRadius: '6px', background: 'rgba(167,139,250,0.1)', border: '1px solid rgba(167,139,250,0.25)', color: '#a78bfa', fontSize: '10px', fontWeight: 700 }}
              >
                {selectedForInvoice.size === invoiceablePOs.length ? 'Deselect All' : 'Select All'}
              </button>
              {selectedForInvoice.size > 0 && (
                <button
                  onClick={createBatchInvoices}
                  disabled={creatingInvoices}
                  style={{ padding: '5px 12px', borderRadius: '6px', background: '#a78bfa', border: 'none', color: '#fff', fontSize: '10px', fontWeight: 700 }}
                >
                  {creatingInvoices ? 'Creating...' : `Create ${selectedForInvoice.size} Invoice${selectedForInvoice.size !== 1 ? 's' : ''}`}
                </button>
              )}
            </div>
          </div>

          {invoiceResults && (
            <div style={{ marginTop: '8px', padding: '8px', borderRadius: '6px', background: invoiceResults.error ? 'rgba(239,68,68,0.06)' : 'rgba(52,211,153,0.06)', border: invoiceResults.error ? '1px solid rgba(239,68,68,0.15)' : '1px solid rgba(52,211,153,0.15)' }}>
              {invoiceResults.error ? (
                <div style={{ fontSize: '11px', color: '#ef4444' }}>{invoiceResults.error}</div>
              ) : invoiceResults.summary ? (
                <div style={{ fontSize: '11px' }}>
                  <span style={{ color: '#34d399', fontWeight: 700 }}>{invoiceResults.summary.success} created</span>
                  {invoiceResults.summary.errors > 0 && <span style={{ color: '#ef4444', marginLeft: '8px' }}>{invoiceResults.summary.errors} failed</span>}
                  {invoiceResults.summary.skipped > 0 && <span style={{ color: '#fbbf24', marginLeft: '8px' }}>{invoiceResults.summary.skipped} skipped</span>}
                  {invoiceResults.results?.filter((r: any) => r.status === 'success').map((r: any) => (
                    <div key={r.poId} style={{ fontSize: '10px', color: 'var(--text-label)', marginTop: '2px' }}>
                      PO #{r.poNumber} → Invoice #{r.invoiceNumber}
                    </div>
                  ))}
                  {invoiceResults.results?.filter((r: any) => r.status === 'error').map((r: any) => (
                    <div key={r.poId || r.soId} style={{ fontSize: '10px', color: '#ef4444', marginTop: '2px' }}>
                      PO #{r.poNumber || '?'}: {r.error}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          )}
        </div>
      )}

      {filteredPos.map((po) => {
        const totalQty = po.line_items.reduce((s, l) => s + l.quantity, 0);
        const totalInstalled = po.line_items.reduce((s, l) => s + l.installed, 0);
        const totalValue = po.line_items.reduce((s, l) => s + l.quantity * l.unit_price, 0);
        const pct = totalQty > 0 ? (totalInstalled / totalQty) * 100 : 0;
        const isExpanded = expandedPo === po.id;
        const isEditingPO = editPoId === po.id;
        const displayDate = po.ordered_date ? new Date(po.ordered_date + 'T00:00:00') : new Date(po.created_at);

        return (
            <div key={po.id} id={`po-row-${po.id}`} style={{ background: 'var(--subtle-bg)', border: highlightPo === po.id ? '1px solid #60a5fa' : (editMode && selectedForDelete.has(po.id) ? '1px solid rgba(248,113,113,0.5)' : '1px solid var(--border)'), boxShadow: highlightPo === po.id ? '0 0 0 2px rgba(96,165,250,0.5)' : undefined, transition: 'box-shadow 0.3s ease, border-color 0.3s ease', borderRadius: '10px', marginBottom: '6px', overflow: 'hidden' }}>
              <div onClick={() => editMode ? toggleDeleteSelection(po.id) : toggleExpand(po.id)} style={{ padding: '12px', cursor: 'pointer' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
                  <div style={{ display: 'flex', alignItems: 'start', gap: '8px' }}>
                    {/* Edit mode: delete checkbox */}
                    {editMode && (
                      <input
                        type="checkbox"
                        checked={selectedForDelete.has(po.id)}
                        onChange={(e) => { e.stopPropagation(); toggleDeleteSelection(po.id); }}
                        onClick={(e) => e.stopPropagation()}
                        style={{ marginTop: '4px', width: '16px', height: '16px', accentColor: '#ef4444', cursor: 'pointer', flexShrink: 0 }}
                      />
                    )}
                    {/* Invoice checkbox — only show for invoiceable POs when not in edit mode */}
                    {!editMode && (() => {
                      const isInvoiceable = invoiceablePOs.some(p => p.id === po.id);
                      const hasInvoice = !!(po as any).netsuite_invoice_id;
                      if (isInvoiceable) {
                        return (
                          <input
                            type="checkbox"
                            checked={selectedForInvoice.has(po.id)}
                            onChange={(e) => { e.stopPropagation(); toggleInvoiceSelection(po.id); }}
                            onClick={(e) => e.stopPropagation()}
                            style={{ marginTop: '4px', width: '16px', height: '16px', accentColor: '#a78bfa', cursor: 'pointer', flexShrink: 0 }}
                          />
                        );
                      }
                      if (hasInvoice) {
                        return (
                          <div style={{ marginTop: '3px', width: '16px', height: '16px', borderRadius: '4px', background: 'rgba(52,211,153,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                            <span style={{ fontSize: '10px', color: '#34d399' }}>$</span>
                          </div>
                        );
                      }
                      return null;
                    })()}
                    <div>
                      <div style={{ fontWeight: 800, fontSize: '15px' }}>PO #{po.po_number}</div>
                      <div style={{ fontSize: '12px', color: 'var(--text-label)', marginTop: '1px' }}>
                        {po.customer} • {po.line_items.length} item{po.line_items.length !== 1 ? 's' : ''}
                        {po.status === 'complete' && <span style={{ color: '#4ade80', marginLeft: '6px' }}>&#10003; Complete</span>}
                        {(po as any).netsuite_invoice_number && <span style={{ color: '#34d399', marginLeft: '6px' }}>INV #{(po as any).netsuite_invoice_number}</span>}
                      </div>
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: '14px', fontWeight: 800, color: '#60a5fa' }}>{fmt(totalValue)}</div>
                    <div style={{ fontSize: '10px', color: 'var(--text-label)', marginTop: '1px' }}>{isExpanded ? '▲' : '▼'} Details</div>
                  </div>
                </div>
                <div style={{ marginTop: '8px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', marginBottom: '3px' }}>
                    <span style={{ color: 'var(--text-label)' }}>Progress</span>
                    <span style={{ color: pct >= 100 ? '#4ade80' : '#60a5fa', fontWeight: 700 }}>{totalInstalled}/{totalQty}</span>
                  </div>
                  <div style={{ height: '6px', background: 'var(--subtle-bg)', borderRadius: '3px' }}>
                    <div style={{ height: '100%', width: `${Math.min(pct, 100)}%`, background: pct >= 100 ? '#22c55e' : '#3b82f6', borderRadius: '3px', transition: 'width 0.3s' }} />
                  </div>
                </div>
              </div>

              {isExpanded && (
                <div style={{ borderTop: '1px solid var(--border)', padding: '10px 12px' }}>
                  {/* PDF Attachments */}
                  <div style={{ marginBottom: '10px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div style={labelStyle}>PDF Attachments</div>
                      <button
                        onClick={() => triggerPoPdfUpload(po.id)}
                        disabled={uploadingPoPdf && uploadingPoId === po.id}
                        style={{
                          padding: '3px 8px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
                          background: 'rgba(96,165,250,0.12)', border: '1px solid rgba(96,165,250,0.3)',
                          color: '#60a5fa', cursor: uploadingPoPdf && uploadingPoId === po.id ? 'default' : 'pointer',
                          opacity: uploadingPoPdf && uploadingPoId === po.id ? 0.6 : 1,
                        }}
                      >
                        {uploadingPoPdf && uploadingPoId === po.id ? 'Uploading…' : '+ Upload PDF'}
                      </button>
                    </div>
                    {(poFiles[po.id] || []).length > 0 ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '4px' }}>
                        {poFiles[po.id].map(f => (
                          <button
                            key={f.id}
                            type="button"
                            onClick={() => {
                              const url = storage.from('graphics-proofs').getPublicUrl(f.storage_path).data.publicUrl;
                              setPdfPreview({ url, name: f.file_name });
                            }}
                            style={{
                              display: 'flex', alignItems: 'center', gap: '8px',
                              padding: '6px 8px', borderRadius: '6px',
                              background: 'var(--subtle-bg)', border: '1px solid var(--border)',
                              fontSize: '11px', fontWeight: 600, color: '#60a5fa', textAlign: 'left',
                              cursor: 'pointer', width: '100%',
                            }}
                          >
                            <span style={{ fontSize: '14px' }}>{'📄'}</span>
                            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.file_name}</span>
                            {f.source && <span style={{ fontSize: '9px', color: 'var(--text-muted)', textTransform: 'uppercase' }}>{f.source === 'pdf_upload' ? 'PDF' : 'Email'}</span>}
                            {f.file_size && <span style={{ fontSize: '9px', color: 'var(--text-muted)' }}>{(f.file_size / 1024).toFixed(0)}KB</span>}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>No attachments. Use the button above to add a PDF.</div>
                    )}
                  </div>

                  {isEditingPO ? (
                    <div style={{ marginBottom: '10px', padding: '8px', background: 'rgba(59,130,246,0.05)', borderRadius: '8px' }}>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
                        <div>
                          <label style={labelStyle}>PO Number</label>
                          <input value={editPoForm.po_number} onChange={(e) => setEditPoForm({ ...editPoForm, po_number: e.target.value })} style={inputStyle} />
                        </div>
                        <div>
                          <label style={labelStyle}>Customer</label>
                          <select value={editPoForm.customer} onChange={(e) => setEditPoForm({ ...editPoForm, customer: e.target.value })} style={inputStyle}>
                            <option>Masterack</option><option>Knapheide</option><option>Bodewell</option><option>Designs That Stick</option>
                          </select>
                        </div>
                      </div>
                      <div style={{ marginTop: '6px' }}>
                        <label style={labelStyle}>Status</label>
                        <select value={editPoForm.status} onChange={(e) => setEditPoForm({ ...editPoForm, status: e.target.value })} style={inputStyle}>
                          <option value="open">Open</option><option value="complete">Complete</option><option value="cancelled">Cancelled</option>
                        </select>
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', marginTop: '6px' }}>
                        <div>
                          <label style={labelStyle}>Ordered Date</label>
                          <input type="date" value={editPoForm.ordered_date} onChange={e => setEditPoForm({ ...editPoForm, ordered_date: e.target.value })} style={inputStyle} />
                        </div>
                        <div>
                          <label style={labelStyle}>Requested Delivery</label>
                          <input type="date" value={editPoForm.requested_delivery_date} onChange={e => setEditPoForm({ ...editPoForm, requested_delivery_date: e.target.value })} style={inputStyle} />
                        </div>
                      </div>
                      <div style={{ marginTop: '6px' }}>
                        <label style={labelStyle}>Notes</label>
                        <textarea
                          value={editPoForm.notes}
                          onChange={e => setEditPoForm({ ...editPoForm, notes: e.target.value })}
                          rows={2}
                          style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }}
                        />
                      </div>
                      <div style={{ marginTop: '6px' }}>
                        <ShipToPicker
                          label="Ship To"
                          locations={locations}
                          selectedId={editShipToId}
                          shipTo={editShipTo}
                          onSelect={(id) => applyLocationToShipTo(id, setEditShipToId, setEditShipTo)}
                          onChange={(next) => { setEditShipToId(''); setEditShipTo(next); }}
                          onManage={() => setShowLocations(true)}
                          onSave={() => saveShipToAsLocation(editShipTo, setEditShipToId)}
                        />
                      </div>
                      <div style={{ display: 'flex', gap: '6px', marginTop: '8px' }}>
                        <button onClick={saveEditPO} style={{ flex: 1, padding: '8px', borderRadius: '8px', background: '#22c55e', color: '#fff', fontSize: '12px', fontWeight: 700, border: 'none' }}>Save</button>
                        <button onClick={() => setEditPoId(null)} style={{ flex: 1, padding: '8px', borderRadius: '8px', background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-body)', fontSize: '12px', fontWeight: 700 }}>Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                      <div style={{ fontSize: '10px', color: 'var(--text-label)' }}>
                        {po.ordered_date ? 'PO Date' : 'Imported'} {displayDate.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}
                        {(po as any).netsuite_so_number && (
                          <span style={{ color: '#a78bfa', marginLeft: '6px' }}>
                            · NS SO #{(po as any).netsuite_so_number}
                          </span>
                        )}
                      </div>
                      <div style={{ display: 'flex', gap: '4px' }}>
                        {(() => {
                          const soResult = soResults[po.id];
                          const isCreating = creatingSOForPo === po.id;
                          const hasSO = (po as any).netsuite_so_id || soResult?.salesOrderId;
                          const soError = soResult?.status === 'error';

                          return (
                            <button
                              onClick={(e) => { e.stopPropagation(); createNetSuiteSO(po.id); }}
                              disabled={isCreating}
                              style={{
                                padding: '3px 8px', borderRadius: '6px', fontSize: '10px', fontWeight: 700, cursor: 'pointer',
                                background: hasSO ? 'rgba(167,139,250,0.1)' : soError ? 'rgba(239,68,68,0.1)' : 'rgba(167,139,250,0.1)',
                                border: `1px solid ${hasSO ? 'rgba(167,139,250,0.25)' : soError ? 'rgba(239,68,68,0.25)' : 'rgba(167,139,250,0.25)'}`,
                                color: hasSO ? '#a78bfa' : soError ? '#ef4444' : '#a78bfa',
                              }}
                            >
                              {isCreating ? 'Creating...' : hasSO ? `NS SO #${(po as any).netsuite_so_number || soResult?.salesOrderNumber || 'Created'}` : soError ? 'Retry NS SO' : 'Create NS SO'}
                            </button>
                          );
                        })()}
                        <button
                          onClick={(e) => { e.stopPropagation(); startEditPO(po); }}
                          style={{ padding: '3px 8px', borderRadius: '6px', background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.25)', color: '#60a5fa', fontSize: '10px', fontWeight: 700 }}
                        >
                          Edit PO
                        </button>
                      </div>
                    </div>
                  )}

                  {soResults[po.id]?.status === 'error' && (
                    <div style={{ padding: '6px 8px', borderRadius: '6px', background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.15)', fontSize: '10px', color: '#ef4444', marginBottom: '6px' }}>
                      {soResults[po.id].error}
                    </div>
                  )}

                  {soResults[po.id]?.unmatchedParts?.length > 0 && soResults[po.id]?.status !== 'error' && (
                    <div style={{ padding: '6px 8px', borderRadius: '6px', background: 'rgba(251,191,36,0.06)', border: '1px solid rgba(251,191,36,0.15)', fontSize: '10px', color: '#fbbf24', marginBottom: '6px' }}>
                      Note: {soResults[po.id].unmatchedParts.length} part(s) not found in NetSuite: {soResults[po.id].unmatchedParts.join(', ')}
                    </div>
                  )}

                  {po.ship_to && (
                    <div style={{ padding: '6px 8px', borderRadius: '6px', background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.12)', marginBottom: '8px', fontSize: '11px', color: '#8899aa' }}>
                      <span style={{ fontWeight: 700, color: '#60a5fa', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.3px' }}>Ship To: </span>
                      {[po.ship_to.name, po.ship_to.address, po.ship_to.city && po.ship_to.state ? `${po.ship_to.city}, ${po.ship_to.state} ${po.ship_to.zip || ''}`.trim() : po.ship_to.city || po.ship_to.state].filter(Boolean).join(' · ')}
                    </div>
                  )}

                  <div style={{ display: 'flex', gap: '4px', padding: '8px 0 4px', borderBottom: '1px solid var(--border)', fontSize: '10px', fontWeight: 700, color: 'var(--text-label)', textTransform: 'uppercase', letterSpacing: '0.3px' }}>
                    <div onClick={() => toggleLiSort('part_number')} style={{ flex: 1, cursor: 'pointer', color: liSort.col === 'part_number' ? '#60a5fa' : undefined }}>Part #{liSortIndicator('part_number')}</div>
                    <div onClick={() => toggleLiSort('quantity')} style={{ width: '36px', textAlign: 'center', cursor: 'pointer', color: liSort.col === 'quantity' ? '#60a5fa' : undefined }}>Qty{liSortIndicator('quantity')}</div>
                    <div onClick={() => toggleLiSort('installed')} style={{ width: '42px', textAlign: 'center', cursor: 'pointer', color: liSort.col === 'installed' ? '#60a5fa' : undefined }}>Done{liSortIndicator('installed')}</div>
                    <div onClick={() => toggleLiSort('unit_price')} style={{ width: '65px', textAlign: 'right', cursor: 'pointer', color: liSort.col === 'unit_price' ? '#60a5fa' : undefined }}>Price{liSortIndicator('unit_price')}</div>
                    <div style={{ width: '55px', textAlign: 'right' }}>Total</div>
                    <div style={{ width: '24px' }}></div>
                  </div>

                  {sortLineItems(po.line_items).map((li) => {
                    const lineTotal = li.quantity * li.unit_price;
                    const linePct = li.quantity > 0 ? (li.installed / li.quantity) * 100 : 0;
                    const isEditingLine = editLineId === li.id;

                    if (isEditingLine) {
                      return (
                        <div key={li.id} style={{ padding: '8px 0', borderBottom: '1px solid rgba(30,45,61,0.5)' }}>
                          <div style={{ marginBottom: '6px' }}>
                            <label style={{ ...labelStyle, fontSize: '9px' }}>Part Number</label>
                            <input value={editLineForm.part_number} onChange={(e) => setEditLineForm({ ...editLineForm, part_number: e.target.value })} style={{ ...inputStyle, padding: '6px 8px', fontSize: '12px', fontWeight: 700 }} />
                          </div>
                          <div style={{ display: 'flex', gap: '6px', alignItems: 'end' }}>
                            <div style={{ flex: 1 }}>
                              <label style={{ ...labelStyle, fontSize: '9px' }}>Qty</label>
                              <input type="number" value={editLineForm.quantity} onChange={(e) => setEditLineForm({ ...editLineForm, quantity: e.target.value })} style={{ ...inputStyle, padding: '6px 8px', fontSize: '12px' }} />
                            </div>
                            <div style={{ flex: 1 }}>
                              <label style={{ ...labelStyle, fontSize: '9px' }}>Done</label>
                              <input type="number" value={editLineForm.installed} onChange={(e) => setEditLineForm({ ...editLineForm, installed: e.target.value })} style={{ ...inputStyle, padding: '6px 8px', fontSize: '12px' }} />
                            </div>
                            <div style={{ flex: 1 }}>
                              <label style={{ ...labelStyle, fontSize: '9px' }}>Unit Price</label>
                              <input type="number" value={editLineForm.unit_price} onChange={(e) => setEditLineForm({ ...editLineForm, unit_price: e.target.value })} style={{ ...inputStyle, padding: '6px 8px', fontSize: '12px' }} step="0.01" />
                            </div>
                            <button onClick={() => saveEditLine(po.id)} style={{ padding: '6px 10px', borderRadius: '6px', background: '#22c55e', color: '#fff', fontSize: '11px', fontWeight: 700, border: 'none' }}>✓</button>
                            <button onClick={() => setEditLineId(null)} style={{ padding: '6px 10px', borderRadius: '6px', background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-body)', fontSize: '11px', fontWeight: 700 }}>✕</button>
                          </div>
                        </div>
                      );
                    }

                    const catalogMatch = catalog.find(c => c.part_number.toUpperCase() === li.part_number.toUpperCase());
                    const catalogAdded = catalogAddResults[li.part_number] === 'added';
                    const gfxCreated = gfxJobResults[li.id] === 'created';

                    return (
                      <div key={li.id} style={{ padding: '8px 0', borderBottom: '1px solid rgba(30,45,61,0.5)' }}>
                        <div style={{ display: 'flex', gap: '4px', alignItems: 'center', fontSize: '12px' }}>
                          <div style={{ flex: 1 }} onClick={() => startEditLine(li)}>
                            <div style={{ fontWeight: 700, color: 'var(--text-body)' }}>{li.part_number}</div>
                            <div style={{ fontSize: '10px', color: 'var(--text-label)', marginTop: '1px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              <PartLabel partNumber={li.part_number} fallbackDescription={li.description} nameOnly />
                            </div>
                            <div style={{ height: '3px', background: 'var(--subtle-bg)', borderRadius: '2px', marginTop: '3px', width: '80%' }}>
                              <div style={{ height: '100%', width: `${Math.min(linePct, 100)}%`, background: linePct >= 100 ? '#22c55e' : '#3b82f6', borderRadius: '2px' }} />
                            </div>
                          </div>
                          <div style={{ width: '36px', textAlign: 'center', color: 'var(--text-body)', fontWeight: 600 }} onClick={() => startEditLine(li)}>{li.quantity}</div>
                          <div style={{ width: '42px', textAlign: 'center', fontWeight: 700, color: li.installed >= li.quantity ? '#4ade80' : '#fbbf24' }}>{li.installed}</div>
                          <div style={{ width: '65px', textAlign: 'right', color: 'var(--text-body)', fontSize: '11px' }} onClick={() => startEditLine(li)}>{fmt(li.unit_price)}</div>
                          <div style={{ width: '55px', textAlign: 'right', fontWeight: 700, color: 'var(--text-body)' }}>{fmt(lineTotal)}</div>
                          <button
                            onClick={async () => { if (await dialog.confirm(`Remove ${li.part_number} from this PO?`, { destructive: true, confirmLabel: 'Remove' })) handleDeleteLineItem(li.id, po.id); }}
                            style={{ width: '24px', background: 'none', border: 'none', color: '#f87171', fontSize: '14px', padding: 0, cursor: 'pointer' }}
                          >
                            ×
                          </button>
                        </div>
                        {/* Action buttons: Add to Catalog / Create Graphics Job */}
                        <div style={{ display: 'flex', gap: '6px', marginTop: '6px', paddingLeft: '2px' }}>
                          {catalogMatch ? (
                            <button
                              onClick={() => router.push(`/parts?catalog=${catalogMatch.catalog || 'graphics'}&q=${encodeURIComponent(li.part_number)}`)}
                              title="Open this part in the Parts Catalog to edit it"
                              style={{
                                padding: '3px 8px', borderRadius: '4px', fontSize: '9px', fontWeight: 700,
                                background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.25)',
                                color: '#4ade80', cursor: 'pointer',
                              }}
                            >
                              ✓ In catalog — edit ↗
                            </button>
                          ) : catalogAdded ? (
                            <span style={{ fontSize: '9px', color: '#4ade80', fontWeight: 600 }}>✓ In catalog</span>
                          ) : (
                            <button
                              onClick={() => addLineItemToCatalog(li, po.customer)}
                              disabled={addingToCatalog === li.part_number}
                              style={{
                                padding: '3px 8px', borderRadius: '4px', fontSize: '9px', fontWeight: 700,
                                background: 'rgba(251,191,36,0.1)', border: '1px solid rgba(251,191,36,0.3)',
                                color: '#fbbf24', cursor: 'pointer',
                              }}
                            >
                              {addingToCatalog === li.part_number ? 'Adding...' : '+ Add to Catalog'}
                            </button>
                          )}
                          {gfxCreated ? (
                            <span style={{ fontSize: '9px', color: '#4ade80', fontWeight: 600 }}>✓ Graphics job created</span>
                          ) : (
                            <button
                              onClick={() => createGfxJobFromLine(po, li)}
                              disabled={creatingGfxJob === li.id}
                              style={{
                                padding: '3px 8px', borderRadius: '4px', fontSize: '9px', fontWeight: 700,
                                background: 'rgba(167,139,250,0.1)', border: '1px solid rgba(167,139,250,0.3)',
                                color: '#a78bfa', cursor: 'pointer',
                              }}
                            >
                              {creatingGfxJob === li.id ? 'Creating...' : '+ Graphics Job'}
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}

                  {/* Add a line for a part the scan missed */}
                  {addLinePoId === po.id ? (
                    <div style={{ padding: '10px 0 8px', borderBottom: '1px solid rgba(30,45,61,0.5)' }}>
                      <div style={{ marginBottom: '6px' }}>
                        <label style={{ ...labelStyle, fontSize: '9px' }}>Search Catalog</label>
                        <CatalogPartSearch
                          catalog={catalog}
                          customer={po.customer}
                          onPick={(c) => pickAddLinePart(c.id)}
                          inputStyle={{ ...inputStyle, padding: '6px 8px', fontSize: '12px' }}
                        />
                      </div>
                      <div style={{ marginBottom: '6px' }}>
                        <label style={{ ...labelStyle, fontSize: '9px' }}>Part Number</label>
                        <input value={addLineForm.part_number} onChange={(e) => setAddLineForm({ ...addLineForm, part_number: e.target.value })} placeholder="Type or pick a part…" style={{ ...inputStyle, padding: '6px 8px', fontSize: '12px', fontWeight: 700 }} />
                      </div>
                      <div style={{ display: 'flex', gap: '6px', alignItems: 'end' }}>
                        <div style={{ flex: 1 }}>
                          <label style={{ ...labelStyle, fontSize: '9px' }}>Qty</label>
                          <input type="number" value={addLineForm.quantity} onChange={(e) => setAddLineForm({ ...addLineForm, quantity: e.target.value })} style={{ ...inputStyle, padding: '6px 8px', fontSize: '12px' }} min={1} />
                        </div>
                        <div style={{ flex: 1 }}>
                          <label style={{ ...labelStyle, fontSize: '9px' }}>Unit Price</label>
                          <input type="number" value={addLineForm.unit_price} onChange={(e) => setAddLineForm({ ...addLineForm, unit_price: e.target.value })} style={{ ...inputStyle, padding: '6px 8px', fontSize: '12px' }} step="0.01" />
                        </div>
                        <button onClick={() => saveAddLine(po.id)} disabled={addingLine || !addLineForm.part_number.trim()} style={{ padding: '6px 10px', borderRadius: '6px', background: '#22c55e', color: '#fff', fontSize: '11px', fontWeight: 700, border: 'none', opacity: addingLine || !addLineForm.part_number.trim() ? 0.5 : 1, cursor: addingLine ? 'default' : 'pointer' }}>{addingLine ? '…' : '✓ Add'}</button>
                        <button onClick={cancelAddLine} style={{ padding: '6px 10px', borderRadius: '6px', background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-body)', fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}>Done</button>
                      </div>
                    </div>
                  ) : (
                    <button
                      onClick={() => startAddLine(po.id)}
                      style={{ width: '100%', marginTop: '8px', padding: '8px', borderRadius: '8px', background: 'rgba(34,197,94,0.08)', border: '1px dashed rgba(34,197,94,0.4)', color: '#22c55e', fontSize: '12px', fontWeight: 700, cursor: 'pointer' }}
                    >
                      + Add Line
                    </button>
                  )}

                  <div style={{ display: 'flex', gap: '4px', padding: '10px 0 4px', fontSize: '13px' }}>
                    <div style={{ flex: 1, fontWeight: 800, color: 'var(--text-body)' }}>Total</div>
                    <div style={{ width: '36px', textAlign: 'center', fontWeight: 700, color: 'var(--text-body)' }}>{totalQty}</div>
                    <div style={{ width: '42px', textAlign: 'center', fontWeight: 700, color: totalInstalled >= totalQty ? '#4ade80' : '#60a5fa' }}>{totalInstalled}</div>
                    <div style={{ width: '65px' }}></div>
                    <div style={{ width: '55px', textAlign: 'right', fontWeight: 800, color: '#60a5fa' }}>{fmt(totalValue)}</div>
                    <div style={{ width: '24px' }}></div>
                  </div>

                  {/* Invoices linked to this PO */}
                  {(() => {
                    const invoices = (po as any).po_invoices || [];
                    if (invoices.length === 0 && !(po as any).netsuite_invoice_id) return null;

                    // If we have po_invoices records, show them; otherwise fall back to the legacy single field
                    const invoiceList = invoices.length > 0 ? invoices : (po as any).netsuite_invoice_id ? [{
                      netsuite_invoice_id: (po as any).netsuite_invoice_id,
                      netsuite_invoice_number: (po as any).netsuite_invoice_number,
                      created_at: null,
                      total_qty: null,
                      line_count: null,
                      memo: null,
                    }] : [];

                    if (invoiceList.length === 0) return null;

                    return (
                      <div style={{ marginTop: '10px', padding: '8px', borderRadius: '8px', background: 'rgba(52,211,153,0.04)', border: '1px solid rgba(52,211,153,0.15)' }}>
                        <div style={{ fontSize: '10px', fontWeight: 700, color: '#34d399', textTransform: 'uppercase', letterSpacing: '0.3px', marginBottom: '6px' }}>
                          Invoices ({invoiceList.length})
                        </div>
                        {invoiceList.map((inv: any, idx: number) => (
                          <div key={inv.netsuite_invoice_id || idx} style={{
                            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                            padding: '6px 8px', borderRadius: '6px', marginBottom: idx < invoiceList.length - 1 ? '4px' : 0,
                            background: 'rgba(52,211,153,0.06)',
                          }}>
                            <div>
                              <a
                                href={`https://system.netsuite.com/app/accounting/transactions/custinvc.nl?id=${inv.netsuite_invoice_id}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                style={{ color: '#34d399', fontWeight: 700, fontSize: '12px', textDecoration: 'none' }}
                              >
                                INV #{inv.netsuite_invoice_number || inv.netsuite_invoice_id}
                              </a>
                              {inv.memo && (
                                <div style={{ fontSize: '10px', color: 'var(--text-label)', marginTop: '2px' }}>{inv.memo}</div>
                              )}
                            </div>
                            <div style={{ textAlign: 'right' }}>
                              {inv.total_qty != null && (
                                <div style={{ fontSize: '11px', color: 'var(--text-body)', fontWeight: 600 }}>{inv.total_qty} unit{inv.total_qty !== 1 ? 's' : ''}</div>
                              )}
                              {inv.created_at && (
                                <div style={{ fontSize: '9px', color: 'var(--text-label)' }}>
                                  {new Date(inv.created_at).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                                </div>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    );
                  })()}

                  {/* Create Graphics Job for entire PO */}
                  <button
                    onClick={(e) => { e.stopPropagation(); createGfxJobFromPO(po); }}
                    disabled={creatingGfxJobForPo === po.id}
                    style={{
                      width: '100%', padding: '10px', borderRadius: '8px', marginTop: '10px',
                      background: 'rgba(167,139,250,0.08)', border: '1px solid rgba(167,139,250,0.25)',
                      color: '#a78bfa', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
                    }}
                  >
                    {creatingGfxJobForPo === po.id ? 'Creating...' : `+ Create Graphics Job (${po.line_items.length} part${po.line_items.length !== 1 ? 's' : ''})`}
                  </button>

                  {/* Print / CSV export */}
                  <div style={{ display: 'flex', gap: '6px', marginTop: '10px' }}>
                    <button
                      onClick={(e) => { e.stopPropagation(); printPo(po, dialog.alert); }}
                      style={{
                        flex: 1, padding: '8px', borderRadius: '8px',
                        background: 'rgba(148,163,184,0.08)', border: '1px solid rgba(148,163,184,0.25)',
                        color: 'var(--text-body)', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
                      }}
                    >
                      Print PO
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); downloadPoCsv(po); }}
                      disabled={po.line_items.length === 0}
                      style={{
                        flex: 1, padding: '8px', borderRadius: '8px',
                        background: 'rgba(148,163,184,0.08)', border: '1px solid rgba(148,163,184,0.25)',
                        color: po.line_items.length === 0 ? 'var(--text-label)' : 'var(--text-body)',
                        fontSize: '12px', fontWeight: 700,
                        cursor: po.line_items.length === 0 ? 'not-allowed' : 'pointer',
                      }}
                    >
                      Download CSV
                    </button>
                  </div>

                  {/* Close / Reopen / Delete PO buttons */}
                  <div style={{ display: 'flex', gap: '6px', marginTop: '10px' }}>
                    {po.status === 'closed' ? (
                      <button
                        onClick={(e) => { e.stopPropagation(); reopenPO(po.id); }}
                        style={{ flex: 1, padding: '8px', borderRadius: '8px', background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.2)', color: '#60a5fa', fontSize: '12px', fontWeight: 700, cursor: 'pointer' }}
                      >
                        Reopen PO
                      </button>
                    ) : (
                      <button
                        onClick={(e) => { e.stopPropagation(); closePO(po.id); }}
                        style={{ flex: 1, padding: '8px', borderRadius: '8px', background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.2)', color: '#22c55e', fontSize: '12px', fontWeight: 700, cursor: 'pointer' }}
                      >
                        Close PO
                      </button>
                    )}
                    <button
                      onClick={async (e) => {
                        e.stopPropagation();
                        if (await dialog.confirm(`Delete PO #${po.po_number} and all its line items? This cannot be undone.`, { destructive: true, confirmLabel: 'Delete' })) {
                          handleDeletePO(po.id);
                        }
                      }}
                      style={{ padding: '8px 14px', borderRadius: '8px', background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.2)', color: '#f87171', fontSize: '12px', fontWeight: 700, cursor: 'pointer' }}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              )}
            </div>
        );
      })}

      <button onClick={() => router.push('/more')} style={{ width: '100%', padding: '10px', borderRadius: '10px', marginTop: '14px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-body)', fontSize: '13px', fontWeight: 700 }}>
        ← Back
      </button>

      {pdfPreview && (
        <div
          onClick={() => setPdfPreview(null)}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
            zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: '20px',
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: 'var(--card)', borderRadius: '12px',
              width: 'min(960px, 100%)', height: 'min(90vh, 100%)',
              display: 'flex', flexDirection: 'column',
              border: '1px solid var(--border)', boxShadow: '0 24px 60px rgba(0,0,0,0.4)',
              overflow: 'hidden',
            }}
          >
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              gap: '12px', padding: '12px 16px', borderBottom: '1px solid var(--border)',
            }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {pdfPreview.name}
                </div>
                {extractingShipTo && (
                  <div style={{ fontSize: '11px', fontWeight: 600, color: '#60a5fa', marginTop: '2px' }}>
                    Reading ship-to from PDF…
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', gap: '8px', flexShrink: 0 }}>
                <a
                  href={pdfPreview.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    padding: '6px 12px', borderRadius: '6px', fontSize: '11px', fontWeight: 700,
                    background: 'rgba(96,165,250,0.12)', border: '1px solid rgba(96,165,250,0.3)',
                    color: '#60a5fa', textDecoration: 'none',
                  }}
                >Open in new tab ↗</a>
                <button
                  type="button"
                  onClick={() => setPdfPreview(null)}
                  aria-label="Close"
                  style={{
                    width: '32px', height: '32px', borderRadius: '8px',
                    background: 'var(--subtle-bg)', border: '1px solid var(--border)',
                    color: 'var(--text-muted)', fontSize: '16px', fontWeight: 700,
                    cursor: 'pointer',
                  }}
                >✕</button>
              </div>
            </div>
            <iframe
              src={pdfPreview.url}
              title={pdfPreview.name}
              style={{ flex: 1, width: '100%', border: 'none', background: '#525659' }}
            />
          </div>
        </div>
      )}

      {createNsItemLine !== null && (
        <CreateNetsuiteItemModal
          initialPartNumber={createNsItemLine.partNumber}
          initialDescription={createNsItemLine.description}
          catalog="graphics"
          onClose={() => setCreateNsItemLine(null)}
          onCreated={() => {
            setCreatedNsLines(prev => new Set(prev).add(createNsItemLine.idx));
            setCreateNsItemLine(null);
          }}
        />
      )}
    </div>
  );
}

const labelStyle: React.CSSProperties = { display: 'block', fontSize: '10px', fontWeight: 700, color: 'var(--text-label)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '4px' };
const inputStyle: React.CSSProperties = { width: '100%', padding: '10px 12px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-body)', fontSize: '13px' };

// Inline search/autocomplete over the loaded catalog. Replaces the long
// part-number dropdown: type to filter, click a hit to fill the line's part
// number + price. The plain-text part-number field below stays as the
// fallback for parts that aren't in the catalog.
function CatalogPartSearch({
  catalog,
  customer,
  onPick,
  inputStyle: inputStyleProp,
}: {
  catalog: CatalogItem[];
  customer: string;
  onPick: (item: CatalogItem) => void;
  inputStyle?: React.CSSProperties;
}) {
  const [query, setQuery] = useState('');
  // Part numbers visually conflate O/0; normalize both sides (mirrors PartPicker).
  const norm = (s: string) => (s || '').toLowerCase().replace(/o/g, '0');
  const q = query.trim();
  const matches = q
    ? (() => {
        const n = norm(q);
        return catalog
          .filter((c) => c.customer === customer || !c.customer)
          .filter((c) =>
            norm(c.part_number).includes(n) ||
            norm(c.graphic_package || '').includes(n) ||
            norm(c.end_customer || '').includes(n)
          )
          .slice(0, 20);
      })()
    : [];
  return (
    <div>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search catalog by part #, package, or customer…"
        style={inputStyleProp || inputStyle}
      />
      {matches.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '6px', maxHeight: '220px', overflowY: 'auto' }}>
          {matches.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => { onPick(c); setQuery(''); }}
              style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px',
                padding: '8px 10px', borderRadius: '8px', textAlign: 'left', width: '100%',
                background: 'var(--input-bg)', border: '1px solid var(--border)', cursor: 'pointer',
              }}
            >
              <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-body)' }}>
                {c.part_number}
                <span style={{ fontWeight: 400, color: 'var(--text-label)' }}> — {c.graphic_package || c.end_customer}</span>
              </span>
              <span style={{ fontSize: '11px', color: 'var(--text-label)', flexShrink: 0 }}>${c.price}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ShipToPicker({
  label,
  locations,
  selectedId,
  shipTo,
  onSelect,
  onChange,
  onManage,
  onSave,
}: {
  label: string;
  locations: PoLocation[];
  selectedId: string;
  shipTo: NonNullable<PurchaseOrder['ship_to']>;
  onSelect: (id: string) => void;
  onChange: (next: NonNullable<PurchaseOrder['ship_to']>) => void;
  onManage: () => void;
  onSave: () => void;
}) {
  const isCustom = !selectedId;
  const hasAddress = !!(shipTo.name || shipTo.address || shipTo.city);
  const matchesExisting = locations.some(l =>
    (l.name || '').trim() === (shipTo.name || '').trim() &&
    (l.address || '') === (shipTo.address || '') &&
    (l.city || '') === (shipTo.city || '') &&
    (l.state || '') === (shipTo.state || '') &&
    (l.zip || '') === (shipTo.zip || '')
  );
  const showSave = isCustom && hasAddress && !matchesExisting;
  return (
    <div style={{ marginBottom: '8px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <label style={labelStyle}>{label}</label>
        <button
          onClick={onManage}
          type="button"
          style={{ fontSize: '10px', fontWeight: 700, color: '#60a5fa', background: 'transparent', border: 'none', cursor: 'pointer', padding: 0, marginBottom: '4px' }}
        >
          Manage locations
        </button>
      </div>
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
          onClick={onSave}
          style={{ marginTop: '6px', padding: '6px 10px', borderRadius: '6px', background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.3)', color: '#22c55e', fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}
        >
          + Save this address as a location
        </button>
      )}
    </div>
  );
}
