'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { flashNote } from '@/lib/focus-note';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import { parseMasterackPO, type ParsedPO, type ParsedPOLine } from '@/lib/parsePO';
import { resolvePoCustomer } from '@/lib/customer-match';
import { storage } from '@/lib/storage';
import type { PurchaseOrder, POLineItem, CatalogItem, PoLocation, GraphicsJobStatus } from '@/lib/types';
import { GRAPHICS_STATUS_LABELS } from '@/lib/types';
import { DropZone } from '@/components/DropZone';
import { CreateNetsuiteItemModal } from '@/components/CreateNetsuiteItemModal';
import { useDialog } from '@/components/DialogProvider';
import CustomerPicker from '@/components/CustomerPicker';
import { isProofLikeName } from '@/lib/pdf-classify';
import { deepLinks } from '@/lib/deep-links';
import { applyInstallPartRule, isInstallDescription, partNumberIsDrawingNumber } from '@/lib/po-install-parts';
import { formatShipTo, shipToCityLabel } from '@/lib/graphics-job-from-po';
import { printPos } from '@/lib/po-print';
import { PART_FIELDS, partToCatalogItem, findOrCreateManualPart } from '@/lib/parts-catalog';
import { SortableTh, useTableSort } from '@/components/ui/SortableTh';
import FilterButton, { FilterLabel } from '@/components/ui/FilterButton';

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

// A graphics job linked back to a PO (whole-PO jobs have a null line item id)
interface PoGfxJob {
  id: string;
  job_number: string | null;
  title: string | null;
  status: GraphicsJobStatus;
  po_id: string;
  po_line_item_id: string | null;
}

// ── Unified parts catalog (phase 2) ──────────────────────────────────────
// The catalog the PO screen matches against is now netsuite_parts (the merged
// catalog), not the old `catalog` table. PART_FIELDS / partToCatalogItem /
// findOrCreateManualPart live in src/lib/parts-catalog.ts (shared with the
// PO record page); this loader stays here because only the list needs the
// whole catalog in memory.
async function loadUnifiedCatalog(
  supabase: ReturnType<typeof createClient>,
): Promise<CatalogItem[] | null> {
  // Paginate past PostgREST's 1000-row response cap — a silently truncated
  // catalog reads as "not in catalog" for every part sorting after the cut.
  // The id tiebreaker keeps page boundaries stable when item numbers repeat
  // (manual + NetSuite rows can share one). Returns null when any page
  // fails, so callers keep their last good copy instead of adopting an
  // empty or truncated list.
  const all: any[] = [];
  let pg = 0;
  let more = true;
  while (more) {
    const { data, error } = await supabase
      .from('netsuite_parts')
      .select(PART_FIELDS)
      .eq('is_active', true)
      .order('item_number')
      .order('id')
      .range(pg * 1000, (pg + 1) * 1000 - 1);
    if (error) return null;
    all.push(...((data as any[]) || []));
    more = ((data as any[]) || []).length === 1000;
    pg++;
  }
  return all.map(partToCatalogItem);
}

// ── Billed dollars for the list's Billed column ──────────────────────────
// po_invoices has NO amount column; the verify-invoices check stores per-part
// billed QUANTITIES on purchase_orders.invoice_check.lines, so dollars are
// reconstructed as billed qty × the PO line's unit price. A part can span
// several lines (possibly at different prices): billed units fill the lines
// in id order — the same deterministic rule the server uses when consuming
// open quantity (see distributeInstalled in src/lib/po-invoice-verify.ts) —
// and any overflow beyond the ordered quantity (over-billing) is priced at
// the last line's rate. Parts invoiced but not on the PO at all ('extra')
// have no known price and contribute $0.
const normPart = (s: string): string => {
  const segs = String(s || '').split(':');
  return segs[segs.length - 1].trim().toUpperCase();
};

function billedDollars(po: PurchaseOrder & { line_items: POLineItem[] }): number {
  const checkLines = po.invoice_check?.lines;
  if (!checkLines || checkLines.length === 0) return 0;
  let total = 0;
  for (const chk of checkLines) {
    if (!chk.invoiced) continue;
    const partLines = po.line_items
      .filter(li => normPart(li.part_number) === normPart(chk.part_number))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (partLines.length === 0) continue; // 'extra' part — price unknown
    let remaining = chk.invoiced;
    for (const li of partLines) {
      const fill = Math.min(remaining, li.quantity || 0);
      total += fill * li.unit_price;
      remaining -= fill;
    }
    if (remaining > 0) total += remaining * partLines[partLines.length - 1].unit_price;
  }
  return total;
}

// Status chip meta for the table's Status column.
const PO_STATUS_META: Record<string, { label: string; color: string }> = {
  open: { label: 'Open', color: '#60a5fa' },
  complete: { label: 'Fulfilled', color: '#4ade80' },
  closed: { label: 'Closed', color: '#94a3b8' },
  cancelled: { label: 'Cancelled', color: '#9ca3af' },
};

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
  const { isAdmin, user, loading: authLoading } = useAuth();
  const dialog = useDialog();
  const supabase = createClient();

  const [pos, setPos] = useState<(PurchaseOrder & { line_items: POLineItem[]; po_invoices?: any[] })[]>([]);
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  // Monotonic guard for async catalog reloads: a reload only lands if
  // nothing newer wrote the catalog while it was in flight (manual part
  // adds bump the seq), and a failed load (null) never replaces a good
  // copy with an empty one.
  const catalogSeq = useRef(0);
  const refreshCatalog = async (): Promise<CatalogItem[] | null> => {
    const seq = ++catalogSeq.current;
    const fresh = await loadUnifiedCatalog(supabase);
    if (fresh && catalogSeq.current === seq) setCatalog(fresh);
    return fresh;
  };
  const [loading, setLoading] = useState(true);
  const [poTab, setPoTab] = useState<'open' | 'fulfilled' | 'closed'>('open');
  const [showCreate, setShowCreate] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [form, setForm] = useState({ po_number: '', customer: 'Masterack', customer_netsuite_id: null as string | null, ordered_date: '', requested_delivery_date: '', notes: '' });
  const [lineItems, setLineItems] = useState<{ part_id: string | null; part_number: string; quantity: number; unit_price: number }[]>([]);
  // Staging form for adding a line while building a new PO — mirrors the
  // existing-PO "+ Add Line" form (catalog prefill + free-text fallback).
  const [createLineForm, setCreateLineForm] = useState({ part_number: '', quantity: '1', unit_price: '' });
  const fileRef = useRef<HTMLInputElement>(null);
  const [poSearch, setPoSearch] = useState('');
  // List filters: attribute filter (billing issues, notes, graphics jobs)
  // and a date window on the PO date (imported date when none on record).
  type PoFilter = 'all' | 'billing' | 'not_invoiced' | 'notes' | 'has_gfx' | 'no_gfx';
  const [poFilter, setPoFilter] = useState<PoFilter>('all');
  const [poCustomerFilter, setPoCustomerFilter] = useState<string>('all');
  const [poDateRange, setPoDateRange] = useState<'all' | '30' | '90' | 'month' | 'lastmonth'>('all');
  // Collapsed "⋯ More" menu for the secondary toolbar actions
  const [showMoreMenu, setShowMoreMenu] = useState(false);

  // PDF Import state
  const [parsedPO, setParsedPO] = useState<ParsedPO | null>(null);
  const [parsedPdfFile, setParsedPdfFile] = useState<File | null>(null);
  const [importLines, setImportLines] = useState<ImportLine[]>([]);
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
    // confirm so only those files attach to the created/updated PO. Filenames
    // ride along because Gmail attachment ids go stale between fetches; the
    // server matches on either.
    attachmentIds?: string[];
    attachmentFilenames?: string[];
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

  // Where "Open in new tab" points for the review PDF: the in-app viewer, not
  // the raw bytes. A bare PDF tab has no app chrome and no working Back
  // button, so opening one mid-import stranded you there; the viewer keeps the
  // header/nav and its ← closes the tab straight back into this review.
  const pdfTabUrl = (pdf: { url: string; name: string }, messageId: string) =>
    deepLinks.pdfViewer(pdf.url, {
      name: pdf.name,
      back: deepLinks.poPendingReview(messageId),
      backLabel: 'PO import',
    });

  // Opened with window.open (not a plain target="_blank") so the new tab keeps
  // an opener and is allowed to close itself — modifier-clicks fall through to
  // the browser's own new-tab handling.
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

  // The extractor returns both the customer's item number (part_number) and
  // BMG's number from the PO's "Supplier Part" row (supplier_part). Our
  // internal part numbers always match the supplier part, and the import
  // endpoint prefers supplier_part when saving lines — so collapse the pair
  // into a single editable Part Number before review (supplier_part wins) and
  // drop supplier_part, otherwise edits to the visible field wouldn't stick.
  // The 02/06 install rule runs here too, not just at extraction time: the
  // pending-import queue replays extractions stored earlier (by the cron,
  // possibly before the rule existed), and those would otherwise reach review
  // uncorrected.
  const collapseSupplierParts = (extracted: any) => ({
    ...extracted,
    lines: applyInstallPartRule(
      (extracted.lines || []).map(({ supplier_part, ...l }: any) => ({
        ...l,
        part_number: supplier_part || l.part_number,
      })),
    ).lines,
  });
  // NetSuite item creation from a review line: holds the line being created; tracks created lines by index
  const [createNsItemLine, setCreateNsItemLine] = useState<{ idx: number; partNumber: string; description: string | null } | null>(null);
  const [createdNsLines, setCreatedNsLines] = useState<Set<number>>(new Set());
  // Catalog add state for unmatched parts
  const [addingToCatalog, setAddingToCatalog] = useState<string | null>(null); // part_number being added
  const [catalogAddResults, setCatalogAddResults] = useState<Record<string, 'added' | 'error'>>({});
  // Graphics jobs already linked to each PO (by po_id), so the list can tag
  // POs that have a job without anyone cross-referencing the graphics board.
  const [gfxJobsByPo, setGfxJobsByPo] = useState<Record<string, PoGfxJob[]>>({});
  // Gmail PO auto-import status — surfaced in a strip above the PO list so
  // it's obvious whether the hourly cron is finding emails / connected to
  // Gmail at all, without anyone having to dig through Vercel logs.
  const [gmailStatus, setGmailStatus] = useState<{
    gmailConnected: boolean;
    lastRunAt: string | null;
    lastResult: any | null;
    recentErrors?: any[];
    cronSecretConfigured?: boolean;
    heartbeatWriteError?: string | null;
  } | null>(null);
  const [gmailRunning, setGmailRunning] = useState(false);
  const [gmailRunMessage, setGmailRunMessage] = useState<string | null>(null);
  const [gmailErrorsOpen, setGmailErrorsOpen] = useState(false);
  // Batch delete state
  const [editMode, setEditMode] = useState(false);

  // Pending PO queue state
  const [pendingPOs, setPendingPOs] = useState<any[]>([]);

  // Saved ship-to locations
  const [locations, setLocations] = useState<PoLocation[]>([]);
  const [showLocations, setShowLocations] = useState(false);
  const [locationForm, setLocationForm] = useState({ id: '', name: '', address: '', city: '', state: '', zip: '' });
  const [locationSaving, setLocationSaving] = useState(false);
  const [createShipToId, setCreateShipToId] = useState<string>('');
  const [createShipTo, setCreateShipTo] = useState<NonNullable<PurchaseOrder['ship_to']>>({});

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
    const raw = pending.raw_extraction;
    if (!raw) return;

    // Multi-PO email (stored by the review-mode importer as {multi, pos}):
    // queue one review per PO, mirroring the live import flow. Records must
    // carry each PO's own PDFs ({extracted, pdfs}); older ones can't say
    // which PDF belongs to which PO (the viewer's fallback used to show the
    // proof), so re-run the import fresh and let it rebuild the queue with
    // current classification.
    if (raw.multi && Array.isArray(raw.pos) && raw.pos.length > 0) {
      const hasPdfRefs = raw.pos.every((p: any) => Array.isArray(p?.pdfs) && p.pdfs.length > 0);
      if (!hasPdfRefs) {
        importEmailPO(pending.message_id);
        return;
      }
      const items: ReviewItem[] = raw.pos.map((p: any, i: number) => {
        const extracted = p?.extracted || p;
        const pdfs = Array.isArray(p?.pdfs) ? p.pdfs : [];
        const pdf = pdfs[0];
        return {
          messageId: pending.message_id,
          extracted: collapseSupplierParts(extracted),
          attachmentIds: pdfs.map((f: any) => f.attachmentId),
          attachmentFilenames: pdfs.map((f: any) => f.filename).filter(Boolean),
          queuePos: { index: i + 1, total: raw.pos.length },
          pdf: pdf
            ? { url: gmailPdfUrl(pending.message_id, pdf.attachmentId, pdf.filename), name: pdf.filename }
            : { url: gmailPdfUrl(pending.message_id), name: 'PO PDF' },
        };
      });
      setReviewPdfOpen(window.innerWidth >= 1000);
      setReviewingExtraction(items[0]);
      setReviewQueue(items.slice(1));
      return;
    }

    // Stale/junk record (e.g. the old importer got confused by a proof PDF
    // and stored an extraction with no PO number or lines): re-run the import
    // fresh instead of opening a dead review panel.
    const hasUsableLines = (raw.lines || []).some((l: any) => l.part_number);
    if (!raw.po_number || !hasUsableLines) {
      importEmailPO(pending.message_id);
      return;
    }

    // attachment_filename is a comma-joined list; prefer the first name that
    // isn't a proof/artwork file so the viewer opens the actual PO document.
    const attachmentNames = (pending.attachment_filename || '')
      .split(',').map((s: string) => s.trim()).filter(Boolean);
    const firstPdfName = attachmentNames.find((n: string) => !isProofLikeName(n)) || attachmentNames[0] || '';
    setReviewPdfOpen(window.innerWidth >= 1000);
    setReviewingExtraction({
      messageId: pending.message_id,
      extracted: collapseSupplierParts(raw),
      pdf: { url: gmailPdfUrl(pending.message_id, undefined, firstPdfName || undefined), name: firstPdfName || 'PO PDF' },
    });
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

  // Per-pending-PO review note ("why I haven't imported this yet"). Draft is
  // held locally so typing is smooth; saved on blur when it differs from the
  // stored value, then written back to the list so a refresh keeps it.
  const [pendingNoteDraft, setPendingNoteDraft] = useState<Record<string, string>>({});
  const [pendingNoteSaving, setPendingNoteSaving] = useState<string | null>(null);
  const savePendingNote = async (id: string) => {
    const draft = pendingNoteDraft[id] ?? '';
    const current = pendingPOs.find(p => p.id === id)?.review_note ?? '';
    if (draft === current) return;
    setPendingNoteSaving(id);
    try {
      const res = await fetch('/api/gmail/pending-po-note', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, note: draft }),
      });
      if (res.ok) {
        setPendingPOs(prev => prev.map(p => p.id === id ? { ...p, review_note: draft.trim() || null } : p));
      }
    } catch { /* left in the draft for a retry on next blur */ }
    setPendingNoteSaving(null);
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
    if (authLoading) return; // role flags aren't resolved until auth finishes loading
    if (!isAdmin) { router.push('/home'); return; }
    const load = async () => {
      const { data: poData } = await supabase
        .from('purchase_orders')
        .select('*, po_line_items(*), po_invoices(*)')
        .order('created_at', { ascending: false });
      const notesByPo = await fetchNoteCounts();

      const FILTERED_CUSTOMERS = ['ranger design', 'enterprise fleet management', 'bmg fleet installations'];
      const mapped = (poData || [])
        .filter((po: any) => !FILTERED_CUSTOMERS.some(fc => po.customer?.toLowerCase().includes(fc)))
        .map((po: any) => ({
          ...po,
          line_items: po.po_line_items || [],
          po_notes: notesByPo[po.id] || [],
          po_invoices: (po.po_invoices || []).sort((a: any, b: any) =>
            new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
          ),
        }));
      setPos(mapped);

      // Graphics jobs linked to POs — powers the "has a graphics job" tag.
      // Cancelled jobs don't count: a PO whose only job was cancelled still
      // needs one created.
      const { data: gfxJobs } = await supabase
        .from('graphics_jobs')
        .select('id, job_number, title, status, po_id, po_line_item_id')
        .not('po_id', 'is', null)
        .neq('status', 'cancelled');
      const byPo: Record<string, PoGfxJob[]> = {};
      for (const j of (gfxJobs || []) as PoGfxJob[]) {
        (byPo[j.po_id] ||= []).push(j);
      }
      setGfxJobsByPo(byPo);

      await refreshCatalog();
      setLoading(false);

      // Load pending PO queue
      await refreshPendingPOs();

      const { data: locs } = await supabase
        .from('po_locations')
        .select('*')
        .eq('archived', false)
        .order('name');
      setLocations((locs as PoLocation[]) || []);
    };
    load();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  }, [authLoading, isAdmin]);

  const refreshGmailStatus = async () => {
    try {
      const res = await fetch('/api/gmail/auto-import-status', { cache: 'no-store' });
      if (res.ok) setGmailStatus(await res.json());
    } catch {}
  };

  const refreshPendingPOs = async () => {
    const { data } = await supabase
      .from('gmail_po_imports')
      .select('*')
      .eq('status', 'pending')
      .order('created_at', { ascending: false });
    setPendingPOs(data || []);
  };

  useEffect(() => {
    if (!isAdmin) return;
    refreshGmailStatus();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional
  }, [isAdmin]);

  // The PO screen stays open all day. Without a refresh loop, POs the
  // background cron queues for review never appear until a full page
  // reload — which reads as "the cron is broken" (field report). Same for
  // the parts catalog: parts added on the Parts page (or synced from
  // NetSuite) while this screen sits open otherwise stay "not in catalog"
  // here (field report). Keep all of it fresh on a timer and whenever the
  // tab regains focus.
  useEffect(() => {
    if (!isAdmin) return;
    const tick = () => {
      refreshPendingPOs();
      refreshGmailStatus();
      refreshCatalog();
    };
    const onVisible = () => { if (document.visibilityState === 'visible') tick(); };
    const timer = setInterval(tick, 3 * 60 * 1000);
    window.addEventListener('focus', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onVisible);
      document.removeEventListener('visibilitychange', onVisible);
    };
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
    // Freshly imported POs land in the review queue — pull it now so the
    // pending box appears without a page reload.
    await Promise.all([refreshGmailStatus(), refreshPendingPOs()]);
    setGmailRunning(false);
  };

  // ?id= deep links (notifications / search) used to expand the PO in place;
  // the PO record page owns per-PO viewing now, so send them straight there.
  useEffect(() => {
    const poId = searchParams.get('id');
    if (!poId) return;
    router.replace(`/admin/pos/${poId}`);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: redirect on param change only
  }, [searchParams]);

  // ?review=<gmail message id> deep link ("1 new PO pending review"
  // notifications): scroll-flash that entry in the pending-import queue once
  // it loads. One-shot per message id; the queue refreshes on a timer, so
  // without the guard every tick would re-flash.
  const reviewDeepLink = useRef<string | null>(null);
  useEffect(() => {
    const msgId = searchParams.get('review');
    if (!msgId || reviewDeepLink.current === msgId) return;
    const entry = pendingPOs.find(p => p.message_id === msgId);
    if (!entry) return; // already imported/dismissed — the queue box explains itself
    reviewDeepLink.current = msgId;
    flashNote(`pending-po-${entry.id}`);
  }, [searchParams, pendingPOs]);

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
    await importPoPdf(file);
  };

  // Shared core for the file input and drag-and-drop onto the import panel.
  const importPoPdf = async (file: File) => {
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

      // Match lines against a freshly loaded catalog — the in-memory copy
      // can predate parts added on the Parts page since this screen mounted,
      // and matching against it marks those lines "new to catalog". A failed
      // reload falls back to the in-memory copy rather than treating every
      // line as unmatched.
      const freshCatalog = (await refreshCatalog()) || catalog;
      // Same 02/06 rule the AI extraction runs: an install line is an 06 part,
      // never an 02. Applied before catalog matching so a corrected number
      // matches the right catalog entry.
      const ruledLines = applyInstallPartRule(parsed.lines).lines as ParsedPOLine[];
      const lines: ImportLine[] = ruledLines.map((line) => {
        const match = freshCatalog.find((c) =>
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
          catalogSeq.current++; // manual write — invalidate in-flight reloads
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
          catalogSeq.current++; // manual write — invalidate in-flight reloads
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
    // The customer picker already resolves as the user types/picks/creates;
    // only fall back to re-resolving here for free text that was typed
    // without clicking a suggestion (e.g. an exact but unclicked match).
    const { customer, customerNetsuiteId } = form.customer_netsuite_id
      ? { customer: form.customer, customerNetsuiteId: form.customer_netsuite_id }
      : await resolvePoCustomer(supabase, form.customer);
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
    setForm({ po_number: '', customer: 'Masterack', customer_netsuite_id: null, ordered_date: '', requested_delivery_date: '', notes: '' });
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

  // Note counts are fetched separately and best-effort: embedding po_notes in
  // the main PO select makes the ENTIRE list fail when the table hasn't been
  // migrated yet — an empty page is a far worse failure than a missing badge.
  const fetchNoteCounts = async (): Promise<Record<string, { id: string }[]>> => {
    const byPo: Record<string, { id: string }[]> = {};
    try {
      const { data } = await supabase.from('po_notes').select('id, po_id');
      for (const n of (data || []) as { id: string; po_id: string }[]) {
        (byPo[n.po_id] = byPo[n.po_id] || []).push({ id: n.id });
      }
    } catch { /* table may not exist yet */ }
    return byPo;
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

  // Backfill: find each PDF-less PO's source email in Gmail and attach its
  // PDF(s). The server works in time-budgeted batches; loop until done,
  // carrying forward the no-match ids so every batch makes progress.
  const [backfillRunning, setBackfillRunning] = useState(false);
  const [backfillProgress, setBackfillProgress] = useState('');
  const runPdfBackfill = async () => {
    if (backfillRunning) return;
    setBackfillRunning(true);
    setBackfillProgress('scanning…');
    const skipPoIds: string[] = [];
    let totalAttached = 0;
    let totalNoMatch = 0;
    let totalStoreFailed = 0;
    let totalLocRecords = 0;
    let failed: string | null = null;
    // Each round is retried once — a single batch dying (e.g. a slow one cut
    // off at the function ceiling) shouldn't kill the whole run, and work
    // already attached persists server-side either way.
    let retried = false;
    for (let round = 0; round < 60; round++) {
      try {
        const res = await fetch('/api/pos/backfill-pdfs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ skipPoIds }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
          if (!retried) { retried = true; continue; }
          failed = data.error || `request failed (${res.status})`;
          break;
        }
        retried = false;
        totalAttached += data.attached.length;
        totalNoMatch += data.noMatch.length;
        totalStoreFailed += (data.storeFailed || []).length;
        totalLocRecords += data.locationsFromRecords || 0;
        for (const n of data.noMatch) skipPoIds.push(n.poId);
        // Store-failure POs are skipped too — retrying them this run would
        // just fail the same way and loop forever.
        for (const n of data.storeFailed || []) skipPoIds.push(n.poId);
        setBackfillProgress(`${totalAttached} attached · ${data.remaining} to go`);
        if (data.remaining <= 0 || data.processed === 0) break;
      } catch (err: any) {
        if (!retried) { retried = true; continue; }
        failed = err.message || 'network error';
        break;
      }
    }

    // Phase 2: fill in missing ship-to locations. Any PO with a stored PDF
    // (including ones just attached) but no location gets the ship-to
    // extractor run over its first PDF. Capped per run — each is an AI call.
    // Failures are collected per PO (number + why) so the summary can name
    // them instead of just counting.
    let locationsFilled = 0;
    const locationFailures: string[] = [];
    try {
      const { data: missingLoc } = await supabase
        .from('purchase_orders')
        .select('id, po_number, ship_to, po_files(storage_path)')
        .is('ship_to', null);
      const candidates = ((missingLoc || []) as any[]).filter(p => (p.po_files || []).length > 0);
      const LOC_CAP = 25;
      const runCount = Math.min(candidates.length, LOC_CAP);
      for (let i = 0; i < runCount; i++) {
        const p = candidates[i];
        setBackfillProgress(`locations ${i + 1}/${runCount}…`);
        try {
          const res = await fetch('/api/pos/extract-ship-to', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ poId: p.id, storagePath: p.po_files[0].storage_path }),
          });
          const data = await res.json().catch(() => ({}));
          if (res.ok && data.ship_to) {
            locationsFilled++;
            setPos(prev => prev.map(x => x.id === p.id ? { ...x, ship_to: data.ship_to } : x));
          } else if (res.ok) {
            // The extractor ran fine but found no ship-to — the stored PDF is
            // probably a proof/artwork file rather than the PO document.
            locationFailures.push(`PO #${p.po_number}: no ship-to address found on its PDF`);
          } else {
            locationFailures.push(`PO #${p.po_number}: ${data.error || `request failed (${res.status})`}`);
          }
        } catch (err: any) {
          locationFailures.push(`PO #${p.po_number}: ${err?.message || 'network error'}`);
        }
      }
    } catch { /* best-effort */ }

    setBackfillRunning(false);
    setBackfillProgress('');
    const lines = [];
    if (failed) lines.push(`PDF search stopped early: ${failed}.`);
    lines.push(`Attached PDFs to ${totalAttached} PO${totalAttached === 1 ? '' : 's'}.`);
    if (totalNoMatch > 0) lines.push(`${totalNoMatch} PO${totalNoMatch === 1 ? '' : 's'} had no matching email in Gmail.`);
    if (totalStoreFailed > 0) lines.push(`${totalStoreFailed} PO${totalStoreFailed === 1 ? '' : 's'} found an email but the files couldn't be stored — check the server logs.`);
    if (totalLocRecords > 0) {
      lines.push(`Recovered locations on ${totalLocRecords} PO${totalLocRecords === 1 ? '' : 's'} from their original import records.`);
    }
    if (locationsFilled > 0 || locationFailures.length > 0) {
      lines.push(`Read locations off the PDF for ${locationsFilled} more PO${locationsFilled === 1 ? '' : 's'}${locationFailures.length > 0 ? ` (${locationFailures.length} couldn't be read)` : ''}.`);
      for (const f of locationFailures.slice(0, 10)) lines.push(`• ${f}`);
      if (locationFailures.length > 10) lines.push(`• …and ${locationFailures.length - 10} more.`);
    }
    if (!failed && totalAttached === 0 && totalNoMatch === 0 && totalLocRecords === 0 && locationsFilled === 0 && locationFailures.length === 0) {
      lines.push('Nothing to do — no POs are missing a PDF or location.');
    }
    if (!failed && (totalNoMatch > 0 || totalLocRecords > 0 || locationsFilled > 0)) {
      lines.push('Run again to process more if any remain.');
    }
    await dialog.alert(lines.join('\n'));
  };

  // Re-pull the PO book after a maintenance action (sync / billing check /
  // audit) so badges and invoice lists reflect what the server just wrote.
  const reloadPosAfterMaintenance = async () => {
    const { data: poData } = await supabase
      .from('purchase_orders')
      .select('*, po_line_items(*), po_invoices(*)')
      .order('created_at', { ascending: false });
    const notesByPo = await fetchNoteCounts();
    const FILTERED_CUSTOMERS = ['ranger design', 'enterprise fleet management', 'bmg fleet installations'];
    const mapped = (poData || [])
      .filter((po: any) => !FILTERED_CUSTOMERS.some(fc => po.customer?.toLowerCase().includes(fc)))
      .map((po: any) => ({ ...po, line_items: po.po_line_items || [], po_notes: notesByPo[po.id] || [], po_invoices: (po.po_invoices || []).sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()) }));
    setPos(mapped);
  };

  // Check every PO's linked invoices against its ordered quantities and flag
  // mismatches (over-billed, fulfilled-but-under-billed, billed parts not on
  // the PO) as needing attention.
  const [verifyingInvoices, setVerifyingInvoices] = useState(false);
  const verifyInvoices = async () => {
    if (verifyingInvoices) return;
    setVerifyingInvoices(true);
    try {
      const res = await fetch('/api/pos/verify-invoices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        await dialog.alert(`Billing check failed: ${data.error || `request failed (${res.status})`}`);
      } else {
        await reloadPosAfterMaintenance();
        const flaggedList = (data.flaggedPos || [])
          .slice(0, 12)
          .map((f: any) => `PO #${f.poNumber}`)
          .join(', ');
        const lines = [
          data.flagged > 0
            ? `Checked ${data.posChecked} PO${data.posChecked !== 1 ? 's' : ''} with invoices — ${data.flagged} need${data.flagged === 1 ? 's' : ''} attention: ${flaggedList}${(data.flaggedPos || []).length > 12 ? '…' : ''}. Look for the ⚠ badge.`
            : `Checked ${data.posChecked} PO${data.posChecked !== 1 ? 's' : ''} with invoices — billed quantities all match.`,
        ];
        if (data.noInvoices > 0) {
          lines.push(
            `${data.noInvoices} PO${data.noInvoices !== 1 ? 's have' : ' has'} no invoices linked at all` +
            (data.noInvoicesFulfilled > 0
              ? ` — ${data.noInvoicesFulfilled} of them fulfilled (look for the ⚠ Not invoiced badge).`
              : '.'),
          );
        }
        await dialog.alert(lines.join('\n'));
      }
    } catch (err: any) {
      await dialog.alert(`Billing check failed: ${err.message || 'network error'}`);
    }
    setVerifyingInvoices(false);
  };

  // Pull in invoices created directly in NetSuite (matched by the PO number
  // on the invoice's Reference No.) so every PO's invoice list is complete
  // regardless of which system created the invoice.
  const [syncingInvoices, setSyncingInvoices] = useState(false);
  const syncInvoices = async () => {
    if (syncingInvoices) return;
    setSyncingInvoices(true);
    try {
      const res = await fetch('/api/pos/sync-invoices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) {
        await dialog.alert(`Invoice sync failed: ${data.error || `request failed (${res.status})`}`);
      } else {
        await reloadPosAfterMaintenance();
        await dialog.alert(`Linked ${data.linked} new invoice${data.linked !== 1 ? 's' : ''} (${data.invoicesFound} found across ${data.posScanned} PO numbers).`);
      }
    } catch (err: any) {
      await dialog.alert(`Invoice sync failed: ${err.message || 'network error'}`);
    }
    setSyncingInvoices(false);
  };

  // Deep audit: sweep EVERY NetSuite invoice in a window and find ones that
  // look like they belong to a PO but aren't linked — a blank or
  // reformatted Reference No., a PO only the memo or the scan stamps know
  // about. Those invoices are invisible to Sync Invoices / Check Billing
  // (which match Reference No. exactly), so a PO can read "all clear" while
  // carrying unlinked billing. Dry-run first; on confirm, link the matches
  // and re-run the billing check on the affected POs.
  const [auditingInvoices, setAuditingInvoices] = useState(false);
  const auditInvoices = async () => {
    if (auditingInvoices) return;
    setAuditingInvoices(true);
    try {
      const res = await fetch('/api/pos/audit-invoices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ months: 12 }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) {
        await dialog.alert(`Invoice audit failed: ${data.error || `request failed (${res.status})`}`);
      } else {
        const matches: any[] = data.matches || [];
        const ambiguous: any[] = data.ambiguous || [];
        const header = `Scanned ${data.invoicesInRange} NetSuite invoice${data.invoicesInRange !== 1 ? 's' : ''} from the last ${data.months} months — ${data.alreadyLinked} already linked to POs.`;
        if (matches.length === 0 && ambiguous.length === 0) {
          await dialog.alert(`${header}\nNone of the rest look like they belong to a PO.`);
        } else {
          const lines = [header];
          if (matches.length > 0) {
            lines.push('', `${matches.length} unlinked invoice${matches.length !== 1 ? 's' : ''} matched a PO:`);
            for (const m of matches.slice(0, 12)) {
              lines.push(`• ${m.invoiceNumber} → PO #${m.poNumber} (${m.detail})`);
            }
            if (matches.length > 12) lines.push(`…and ${matches.length - 12} more`);
          }
          if (ambiguous.length > 0) {
            lines.push('', `${ambiguous.length} matched more than one PO — left alone, review by hand:`);
            for (const a of ambiguous.slice(0, 6)) {
              lines.push(`• ${a.invoiceNumber} could be PO ${a.candidates.join(' or ')}`);
            }
          }
          if (matches.length === 0) {
            await dialog.alert(lines.join('\n'));
          } else if (await dialog.confirm(`${lines.join('\n')}\n\nLink ${matches.length === 1 ? 'this invoice' : 'these invoices'} and recheck billing on the affected POs?`)) {
            const applyRes = await fetch('/api/pos/audit-invoices', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ months: 12, apply: true }),
            });
            const applied = await applyRes.json().catch(() => ({}));
            if (!applyRes.ok || !applied.success) {
              await dialog.alert(`Linking failed: ${applied.error || `request failed (${applyRes.status})`}`);
            } else {
              await reloadPosAfterMaintenance();
              const v = applied.verify;
              const flaggedList = (v?.flaggedPos || []).slice(0, 12).map((f: any) => `PO #${f.poNumber}`).join(', ');
              await dialog.alert([
                `Linked ${applied.applied} invoice${applied.applied !== 1 ? 's' : ''}.`,
                v && v.flagged > 0
                  ? `⚠ ${v.flagged} PO${v.flagged !== 1 ? 's' : ''} now need${v.flagged === 1 ? 's' : ''} billing attention: ${flaggedList} — look for the ⚠ badge.`
                  : 'Billed quantities still check out on the affected POs.',
              ].join('\n'));
            }
          }
        }
      }
    } catch (err: any) {
      await dialog.alert(`Invoice audit failed: ${err.message || 'network error'}`);
    }
    setAuditingInvoices(false);
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
            attachmentFilenames: (r.pdfs || []).map((p: any) => p.filename).filter(Boolean),
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
        const notesByPo = await fetchNoteCounts();
        const FILTERED_CUSTOMERS = ['ranger design', 'enterprise fleet management', 'bmg fleet installations'];
        const mapped = (poData || [])
          .filter((po: any) => !FILTERED_CUSTOMERS.some(fc => po.customer?.toLowerCase().includes(fc)))
          .map((po: any) => ({ ...po, line_items: po.po_line_items || [], po_notes: notesByPo[po.id] || [], po_invoices: (po.po_invoices || []).sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()) }));
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
    const { messageId, extracted, attachmentIds, attachmentFilenames } = reviewingExtraction;
    setImportingEmailId(messageId);
    const isLastInQueue = reviewQueue.length === 0;
    try {
      const res = await fetch('/api/gmail/import-po', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId, preExtracted: extracted, attachmentIds, attachmentFilenames }),
      });
      const data = await res.json();

      if (!res.ok || data.error) {
        const errMsg = data.error || `Request failed (${res.status})`;
        setEmailImportResults(prev => ({ ...prev, [messageId]: { status: 'error', error: errMsg } }));
        // Surface the failure in your face — a quietly advancing queue reads
        // as success and the PO never lands.
        await dialog.alert(`PO #${extracted?.po_number || ''} did NOT import: ${errMsg}`);
        advanceReviewQueue();
      } else if (data.status === 'exists') {
        // The overwrite dialog takes over; the queue resumes when it resolves.
        setOverwriteData({ ...data, attachmentIds, attachmentFilenames });
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
          const notesByPo = await fetchNoteCounts();
          const FILTERED_CUSTOMERS = ['ranger design', 'enterprise fleet management', 'bmg fleet installations'];
          const mapped = (poData || [])
            .filter((po: any) => !FILTERED_CUSTOMERS.some(fc => po.customer?.toLowerCase().includes(fc)))
            .map((po: any) => ({ ...po, line_items: po.po_line_items || [], po_notes: notesByPo[po.id] || [], po_invoices: (po.po_invoices || []).sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()) }));
          setPos(mapped);
        }
        advanceReviewQueue();
      }
    } catch (err: any) {
      setEmailImportResults(prev => ({ ...prev, [messageId]: { status: 'error', error: err.message || 'Network error' } }));
      await dialog.alert(`PO #${extracted?.po_number || ''} did NOT import: ${err.message || 'network error'}`);
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
          attachmentFilenames: overwriteData.attachmentFilenames,
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
          const notesByPo = await fetchNoteCounts();
          const FILTERED_CUSTOMERS = ['ranger design', 'enterprise fleet management', 'bmg fleet installations'];
          const mapped = (poData || [])
            .filter((po: any) => !FILTERED_CUSTOMERS.some(fc => po.customer?.toLowerCase().includes(fc)))
            .map((po: any) => ({ ...po, line_items: po.po_line_items || [], po_notes: notesByPo[po.id] || [], po_invoices: (po.po_invoices || []).sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()) }));
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
        await refreshCatalog();
      }
    } catch (err) {
      setCatalogAddResults(prev => ({ ...prev, [part.part_number]: 'error' }));
    }
    setAddingToCatalog(null);
  };

  const fmt = (n: number) => '$' + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

  // Sort by PO number and filter by search
  const openPos = pos.filter(po => po.status !== 'closed' && po.status !== 'complete');
  const fulfilledPos = pos.filter(po => po.status === 'complete');
  const closedPos = pos.filter(po => po.status === 'closed');

  const matchesPoFilter = (po: PurchaseOrder & { line_items: POLineItem[] }, filter: PoFilter): boolean => {
    switch (filter) {
      case 'billing': return (po as any).invoice_check_status === 'attention';
      case 'not_invoiced': return po.status === 'complete' && (po as any).invoice_check_status === 'no_invoices';
      case 'notes': return ((po as any).po_notes || []).length > 0;
      case 'has_gfx': return (gfxJobsByPo[po.id] || []).length > 0;
      case 'no_gfx': return (gfxJobsByPo[po.id] || []).length === 0;
      default: return true;
    }
  };
  const matchesPoDateRange = (po: PurchaseOrder): boolean => {
    if (poDateRange === 'all') return true;
    const d = new Date(po.ordered_date || po.created_at);
    if (isNaN(d.getTime())) return false;
    const now = new Date();
    if (poDateRange === '30' || poDateRange === '90') {
      const start = new Date(now);
      start.setDate(now.getDate() - (poDateRange === '30' ? 30 : 90));
      return d >= start;
    }
    if (poDateRange === 'month') {
      return d >= new Date(now.getFullYear(), now.getMonth(), 1);
    }
    // lastmonth
    return d >= new Date(now.getFullYear(), now.getMonth() - 1, 1)
      && d < new Date(now.getFullYear(), now.getMonth(), 1);
  };

  const tabPos = poTab === 'closed' ? closedPos : poTab === 'fulfilled' ? fulfilledPos : openPos;
  // Counts shown in the filter dropdown, computed on the current tab before
  // the attribute/date/search narrowing so the menu reads as "what's here".
  const poFilterCounts: Record<PoFilter, number> = {
    all: tabPos.length,
    billing: tabPos.filter(p => matchesPoFilter(p, 'billing')).length,
    not_invoiced: tabPos.filter(p => matchesPoFilter(p, 'not_invoiced')).length,
    notes: tabPos.filter(p => matchesPoFilter(p, 'notes')).length,
    has_gfx: tabPos.filter(p => matchesPoFilter(p, 'has_gfx')).length,
    no_gfx: tabPos.filter(p => matchesPoFilter(p, 'no_gfx')).length,
  };
  // Distinct customers present in the current tab, for the customer filter
  // dropdown — counts computed the same way as poFilterCounts (before
  // search), so the menu reads as "what's here".
  const poCustomerCounts = new Map<string, number>();
  for (const p of tabPos) poCustomerCounts.set(p.customer, (poCustomerCounts.get(p.customer) || 0) + 1);
  const poCustomerOptions = Array.from(poCustomerCounts.keys()).sort((a, b) => a.localeCompare(b));

  const filteredPos = tabPos
    .filter(po => matchesPoFilter(po, poFilter) && matchesPoDateRange(po))
    .filter(po => poCustomerFilter === 'all' || po.customer === poCustomerFilter)
    .filter((po) => {
      if (!poSearch.trim()) return true;
      const q = poSearch.toLowerCase();
      if (po.po_number.toLowerCase().includes(q)) return true;
      if (po.customer.toLowerCase().includes(q)) return true;
      if (po.line_items.some((li) => li.part_number.toLowerCase().includes(q) || li.description?.toLowerCase().includes(q))) return true;
      return false;
    });

  // Column headers own sorting (SortableTh) — no separate Sort dropdown.
  // Newest first is the natural default for a PO list.
  const { sorted: sortedPos, sort: poTableSort, toggle: togglePoSort } = useTableSort(filteredPos, {
    po: p => p.po_number,
    customer: p => p.customer,
    location: p => shipToCityLabel(p.ship_to) || null,
    date: p => new Date(p.ordered_date || p.created_at).getTime() || 0,
    billed: p => billedDollars(p),
    total: p => p.line_items.reduce((s, l) => s + l.quantity * l.unit_price, 0),
    status: p => (PO_STATUS_META[p.status] || { label: p.status }).label,
  }, { key: 'date', dir: 'desc' });

  if (loading) return <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-label)' }}>Loading...</div>;

  return (
    <div>
      {/* Gmail auto-import runs on a 20-minute cron — silent when healthy.
          This strip only appears when something needs a human: Gmail is
          disconnected, the last run failed, the cron looks stalled, or a
          manual run (⋯ More menu) is in flight / just reported. */}
      {gmailStatus && (() => {
        const r: any = gmailStatus.lastResult || {};
        const status = r.status as 'ok' | 'error' | undefined;
        const minutesAgo = gmailStatus.lastRunAt
          ? Math.round((Date.now() - new Date(gmailStatus.lastRunAt).getTime()) / 60000)
          : null;
        // The cron fires every 20 minutes; treat over an hour of silence
        // (or no recorded run at all) as stalled and say so.
        const stalled = gmailStatus.gmailConnected && (minutesAgo === null || minutesAgo > 60);
        const unhealthy = !gmailStatus.gmailConnected || status === 'error' || stalled;
        // Runs can be "healthy" while every individual email errors out —
        // status ok, strip hidden, and the failed POs invisible. Per-message
        // failures need a human, so they surface the strip too (amber).
        const errs = gmailStatus.recentErrors || [];
        const needsAttention = !unhealthy && (errs.length > 0 || (r.errors ?? 0) > 0);
        if (!unhealthy && !needsAttention && !gmailRunning && !gmailRunMessage) return null;
        const tone = unhealthy
          ? { bg: 'rgba(239,68,68,0.08)', border: 'rgba(239,68,68,0.25)', color: '#ef4444' }
          : needsAttention
            ? { bg: 'rgba(251,191,36,0.08)', border: 'rgba(251,191,36,0.3)', color: '#f59e0b' }
            : { bg: 'var(--subtle-bg)', border: 'var(--border)', color: 'var(--text-muted)' };
        let summary = '';
        if (!gmailStatus.gmailConnected) {
          summary = 'Gmail is not connected. Connect a mailbox to auto-import POs.';
        } else if (status === 'error') {
          summary = `Last run failed: ${r.reason || r.error || 'unknown error'}`;
        } else if (stalled) {
          const silence = minutesAgo === null
            ? 'The auto-import cron has never recorded a run'
            : `The auto-import cron hasn't run in ${minutesAgo < 120 ? `${minutesAgo} minutes` : `${Math.round(minutesAgo / 60)} hours`} (it should fire every 20 minutes)`;
          // The server tells us whether CRON_SECRET exists — without it the
          // route rejects Vercel's cron requests before anything records,
          // which is exactly what a silent stall looks like. And when the
          // status endpoint's own probe write fails, the runs are likely
          // fine and only the heartbeat record is broken — say exactly that.
          summary = gmailStatus.heartbeatWriteError
            ? `Heads up: imports may be running fine — the run record can't be written. Database says: "${gmailStatus.heartbeatWriteError}"`
            : gmailStatus.cronSecretConfigured === false
              ? `${silence} — CRON_SECRET is not set on this deployment, so the cron's requests are being rejected. Add it in Vercel → Settings → Environment Variables, then redeploy.`
              : `${silence} — the secret is configured, so check that the cron jobs are enabled (and not paused) in Vercel → Settings → Cron Jobs, and that the account plan allows a 20-minute schedule.`;
        } else if (gmailRunning) {
          summary = 'Manual import running…';
        } else if (errs.length > 0) {
          summary = `The cron is running (last run: ${r.messagesFound ?? 0} found · ${r.imported ?? 0} imported · ${r.skipped ?? 0} skipped), but ${errs.length} recent email${errs.length === 1 ? '' : 's'} failed to import — those POs never landed. Open the error list below for the details.`;
        } else {
          summary = `Last run: ${r.messagesFound ?? 0} email${r.messagesFound === 1 ? '' : 's'} found · ${r.imported ?? 0} imported · ${r.skipped ?? 0} skipped${(r.errors ?? 0) > 0 ? ` · ${r.errors} errors` : ''}`;
        }
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
                >{gmailRunning ? 'Running…' : 'Retry Now'}</button>
                {gmailRunMessage && !gmailRunning && (
                  <button
                    onClick={() => setGmailRunMessage(null)}
                    title="Dismiss"
                    style={{
                      padding: '6px 8px', borderRadius: '6px', fontSize: '11px', fontWeight: 700,
                      background: 'transparent', border: '1px solid var(--border)',
                      color: 'var(--text-muted)', cursor: 'pointer',
                    }}
                  >✕</button>
                )}
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
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '4px', gap: '8px' }}>
                      <div style={{ fontSize: '9px', color: 'var(--text-muted)' }}>
                        {(e.received_at || e.created_at)
                          ? new Date(e.received_at || e.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
                          : ''}
                      </div>
                      <div style={{ display: 'flex', gap: '6px' }}>
                        {/* Re-run through today's import — older failures often
                            predate fixes (e.g. $0.00 pricing is accepted now)
                            and just need another pass into the review queue. */}
                        <button
                          onClick={() => importEmailPO(e.message_id)}
                          disabled={importingEmailId !== null}
                          style={{
                            padding: '2px 8px', borderRadius: '5px', fontSize: '9px', fontWeight: 700,
                            background: 'rgba(96,165,250,0.1)', border: '1px solid rgba(96,165,250,0.3)',
                            color: '#60a5fa', cursor: importingEmailId ? 'wait' : 'pointer',
                          }}
                        >
                          {importingEmailId === e.message_id ? 'Retrying…' : 'Retry import'}
                        </button>
                        <button
                          onClick={async () => {
                            await fetch('/api/gmail/dismiss-po', {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({
                                messageId: e.message_id,
                                subject: e.subject || null,
                                fromEmail: e.from_email || null,
                              }),
                            }).catch(() => {});
                            setGmailStatus(prev => prev ? {
                              ...prev,
                              recentErrors: (prev.recentErrors || []).filter((r: any) => r.message_id !== e.message_id),
                            } : prev);
                          }}
                          title="Mark this email handled — it stops showing here and won't be re-imported"
                          style={{
                            padding: '2px 8px', borderRadius: '5px', fontSize: '9px', fontWeight: 700,
                            background: 'transparent', border: '1px solid var(--border)',
                            color: 'var(--text-muted)', cursor: 'pointer',
                          }}
                        >
                          Dismiss
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })()}

      {/* Open / Fulfilled / Closed tabs */}
      <div style={{ display: 'flex', gap: '4px', marginBottom: '10px' }}>
        <button onClick={() => setPoTab('open')} style={{
          padding: '6px 14px', borderRadius: '8px', fontSize: '11px', fontWeight: 700, cursor: 'pointer',
          background: poTab === 'open' ? 'var(--tab-active-bg)' : 'transparent',
          border: poTab === 'open' ? '1px solid var(--tab-active-border)' : '1px solid var(--border)',
          color: poTab === 'open' ? '#60a5fa' : 'var(--text-muted)',
        }}>Open ({openPos.length})</button>
        <button onClick={() => setPoTab('fulfilled')} style={{
          padding: '6px 14px', borderRadius: '8px', fontSize: '11px', fontWeight: 700, cursor: 'pointer',
          background: poTab === 'fulfilled' ? 'var(--tab-active-bg)' : 'transparent',
          border: poTab === 'fulfilled' ? '1px solid var(--tab-active-border)' : '1px solid var(--border)',
          color: poTab === 'fulfilled' ? '#4ade80' : 'var(--text-muted)',
        }}>Fulfilled ({fulfilledPos.length})</button>
        <button onClick={() => setPoTab('closed')} style={{
          padding: '6px 14px', borderRadius: '8px', fontSize: '11px', fontWeight: 700, cursor: 'pointer',
          background: poTab === 'closed' ? 'var(--tab-active-bg)' : 'transparent',
          border: poTab === 'closed' ? '1px solid var(--tab-active-border)' : '1px solid var(--border)',
          color: poTab === 'closed' ? '#94a3b8' : 'var(--text-muted)',
        }}>Closed ({closedPos.length})</button>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
        <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-label)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          {poTab === 'closed' ? 'Closed' : poTab === 'fulfilled' ? 'Fulfilled' : ''} Purchase Orders ({filteredPos.length}{poSearch || poFilter !== 'all' || poCustomerFilter !== 'all' || poDateRange !== 'all' ? ` of ${tabPos.length}` : ''})
        </div>
        <div style={{ display: 'flex', gap: '6px' }}>
          {!editMode ? (
            <>
              <button
                onClick={() => { setShowCreate(!showCreate); setShowImport(false); setShowEmailImport(false); }}
                style={{ padding: '6px 12px', borderRadius: '8px', background: '#3b82f6', color: '#fff', fontSize: '12px', fontWeight: 700, border: 'none' }}
              >
                {showCreate ? 'Cancel' : '+ New'}
              </button>
              {/* Everything secondary lives behind one menu — the toolbar was
                  eight buttons deep and drowning the screen. */}
              <div style={{ position: 'relative' }}>
                <button
                  onClick={() => setShowMoreMenu(s => !s)}
                  title="Import, linking, and maintenance actions"
                  style={{ padding: '6px 12px', borderRadius: '8px', background: showMoreMenu ? 'var(--tab-active-bg)' : 'var(--subtle-bg)', border: '1px solid var(--border)', color: 'var(--text-body)', fontSize: '12px', fontWeight: 700 }}
                >
                  ⋯ More
                </button>
                {showMoreMenu && (
                  <>
                    <div onClick={() => setShowMoreMenu(false)} style={{ position: 'fixed', inset: 0, zIndex: 90 }} />
                    <div style={{
                      position: 'absolute', right: 0, top: 'calc(100% + 6px)', zIndex: 91,
                      background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '10px',
                      boxShadow: '0 12px 40px rgba(0,0,0,0.35)', minWidth: '240px', padding: '6px',
                      display: 'flex', flexDirection: 'column', gap: '2px',
                    }}>
                      {([
                        {
                          label: showEmailImport ? 'Close Email Import' : 'Import from Email',
                          hint: 'Pull PO PDFs out of Gmail',
                          onClick: () => { setShowEmailImport(!showEmailImport); setShowImport(false); setShowCreate(false); if (!showEmailImport) { searchGmailPOs(); window.scrollTo({ top: 0, behavior: 'smooth' }); } },
                        },
                        {
                          label: showImport ? 'Close PDF Import' : 'Import a PDF',
                          hint: 'Upload and parse a PO PDF',
                          onClick: () => { setShowImport(!showImport); setShowCreate(false); setShowEmailImport(false); setParsedPO(null); setImportLines([]); setParseError(''); },
                        },
                        {
                          label: gmailRunning ? 'Running Auto-Import…' : 'Run Auto-Import',
                          hint: 'Fetch new PO emails from Gmail now',
                          onClick: () => { runGmailImportNow(); window.scrollTo({ top: 0, behavior: 'smooth' }); },
                          busy: gmailRunning,
                        },
                        {
                          label: 'Select POs…',
                          hint: 'Multi-select to print or delete',
                          onClick: () => { setEditMode(true); setSelectedForDelete(new Set()); },
                        },
                        {
                          label: backfillingCustomers ? 'Linking Customers…' : 'Link Customers',
                          hint: 'Match customer names to NetSuite records',
                          onClick: backfillCustomers, busy: backfillingCustomers,
                        },
                        {
                          label: backfillRunning ? `Finding PDFs… ${backfillProgress}` : 'Find Missing PDFs',
                          hint: 'Search Gmail for POs with no PDF attached',
                          onClick: runPdfBackfill, busy: backfillRunning,
                        },
                        {
                          label: syncingInvoices ? 'Syncing Invoices…' : 'Sync Invoices',
                          hint: 'Link NetSuite invoices to their POs',
                          onClick: syncInvoices, busy: syncingInvoices,
                        },
                        {
                          label: verifyingInvoices ? 'Checking Billing…' : 'Check Billing',
                          hint: 'Flag POs whose invoices don’t add up',
                          onClick: verifyInvoices, busy: verifyingInvoices,
                        },
                        {
                          label: auditingInvoices ? 'Auditing Invoices…' : 'Audit Invoices',
                          hint: 'Find NetSuite invoices missing their PO link',
                          onClick: auditInvoices, busy: auditingInvoices,
                        },
                        {
                          label: showLocations ? 'Close Locations' : 'Locations',
                          hint: 'Manage saved ship-to locations',
                          onClick: () => setShowLocations(s => !s),
                        },
                      ] as { label: string; hint: string; onClick: () => void; busy?: boolean }[]).map(item => (
                        <button
                          key={item.hint}
                          disabled={item.busy}
                          onClick={() => { if (!item.busy) { setShowMoreMenu(false); item.onClick(); } }}
                          style={{
                            display: 'block', width: '100%', textAlign: 'left', padding: '8px 10px',
                            borderRadius: '7px', background: 'transparent', border: 'none',
                            cursor: item.busy ? 'wait' : 'pointer', opacity: item.busy ? 0.6 : 1,
                          }}
                        >
                          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-body)' }}>{item.label}</div>
                          <div style={{ fontSize: '10px', color: 'var(--text-label)', marginTop: '1px' }}>{item.hint}</div>
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
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
                  onClick={() => printPos(
                    pos
                      .filter(p => selectedForDelete.has(p.id))
                      .sort((a, b) => a.po_number.localeCompare(b.po_number, undefined, { numeric: true })),
                    dialog.alert,
                  )}
                  style={{ padding: '6px 12px', borderRadius: '8px', background: '#3b82f6', color: '#fff', fontSize: '12px', fontWeight: 700, border: 'none' }}
                >
                  Print ({selectedForDelete.size})
                </button>
              )}
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

      {/* Search + filter popover (sorting lives on the column headers) */}
      <div style={{ display: 'flex', gap: '6px', marginBottom: '10px', alignItems: 'center' }}>
        <div style={{ position: 'relative', flex: 1 }}>
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
        {(() => {
          const filterSelectStyle: React.CSSProperties = {
            width: '100%', padding: '6px 8px', borderRadius: '7px', fontSize: '12px', fontWeight: 600,
            background: 'var(--input-bg)', border: '1px solid var(--border)', color: 'var(--text-primary)',
          };
          return (
            <FilterButton
              activeCount={(poFilter !== 'all' ? 1 : 0) + (poCustomerFilter !== 'all' ? 1 : 0) + (poDateRange !== 'all' ? 1 : 0)}
              onClear={() => { setPoFilter('all'); setPoCustomerFilter('all'); setPoDateRange('all'); }}
            >
              <FilterLabel>Show only</FilterLabel>
              <select
                value={poFilter}
                onChange={e => setPoFilter(e.target.value as PoFilter)}
                title="Show only POs matching a condition"
                style={filterSelectStyle}
              >
                <option value="all">All ({poFilterCounts.all})</option>
                <option value="billing">⚠ Billing needs attention ({poFilterCounts.billing})</option>
                <option value="not_invoiced">⚠ Fulfilled, not invoiced ({poFilterCounts.not_invoiced})</option>
                <option value="notes">💬 Has notes ({poFilterCounts.notes})</option>
                <option value="has_gfx">🎨 Has graphics job ({poFilterCounts.has_gfx})</option>
                <option value="no_gfx">No graphics job ({poFilterCounts.no_gfx})</option>
              </select>
              <FilterLabel>Customer</FilterLabel>
              <select
                value={poCustomerFilter}
                onChange={e => setPoCustomerFilter(e.target.value)}
                title="Show only POs for one customer"
                style={filterSelectStyle}
              >
                <option value="all">All customers ({tabPos.length})</option>
                {poCustomerOptions.map(c => (
                  <option key={c} value={c}>{c} ({poCustomerCounts.get(c)})</option>
                ))}
              </select>
              <FilterLabel>Date</FilterLabel>
              <select
                value={poDateRange}
                onChange={e => setPoDateRange(e.target.value as typeof poDateRange)}
                title="Limit to a PO-date window (imported date when the PO has no date on record)"
                style={filterSelectStyle}
              >
                <option value="all">All time</option>
                <option value="30">Last 30 days</option>
                <option value="90">Last 90 days</option>
                <option value="month">This month</option>
                <option value="lastmonth">Last month</option>
              </select>
            </FilterButton>
          );
        })()}
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
                <div key={p.id} id={`pending-po-${p.id}`} style={{
                  padding: '10px 12px', borderRadius: '8px', background: 'var(--bg)', border: '1px solid var(--border)',
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
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
                  {/* Reviewer note — why this hasn't been imported yet. Saved on blur. */}
                  <input
                    value={pendingNoteDraft[p.id] ?? p.review_note ?? ''}
                    onChange={e => setPendingNoteDraft(prev => ({ ...prev, [p.id]: e.target.value }))}
                    onBlur={() => savePendingNote(p.id)}
                    placeholder="Note — why not imported yet (waiting on revised PDF, pricing question…)"
                    style={{
                      width: '100%', marginTop: '8px', padding: '6px 8px', borderRadius: '6px',
                      border: '1px solid var(--border)', background: 'var(--subtle-bg)',
                      color: 'var(--text-body)', fontSize: '11px',
                    }}
                  />
                  {pendingNoteSaving === p.id && (
                    <div style={{ fontSize: '9px', color: 'var(--text-muted)', marginTop: '2px' }}>Saving…</div>
                  )}
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
                <CustomerPicker
                  value={reviewingExtraction.extracted.customer || ''}
                  netsuiteId={reviewingExtraction.extracted.customer_netsuite_id}
                  onChange={({ customer, customerNetsuiteId }) => setReviewingExtraction(prev => prev ? { ...prev, extracted: { ...prev.extracted, customer, customer_netsuite_id: customerNetsuiteId } } : prev)}
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
              // 02 = physical part, 06 = its installation charge. An install
              // line is always an 06, so say when the extraction was corrected
              // to one — and flag it if an edit puts it back to an 02.
              const installMismatch = isInstallDescription(line.description)
                && (line.part_number || '').trim().toUpperCase().startsWith('02');
              // Part number equal to the row's drawing number means the
              // far-right column got read instead of the Item Number column.
              const fromDrawingColumn = partNumberIsDrawingNumber(line);
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
                      {fromDrawingColumn ? (
                        <span
                          title="This matches the line's Drawing Number & Revision — the part number belongs to the Item Number column, left of the description. Check the PDF."
                          style={{ fontSize: '9px', color: '#f87171', fontWeight: 700 }}
                        >⚠ Drawing #, not item #</span>
                      ) : installMismatch ? (
                        <span
                          title="This line reads as an installation charge, so its item number should start with 06 (02 is the physical part)."
                          style={{ fontSize: '9px', color: '#f87171', fontWeight: 700 }}
                        >⚠ Install line — expected 06</span>
                      ) : line.install_prefix_corrected ? (
                        <span
                          title="Read as an 02 (physical part) on an install line — corrected to the 06 installation number. Edit it if that's wrong."
                          style={{ fontSize: '9px', color: '#60a5fa', fontWeight: 700 }}
                        >02→06 install</span>
                      ) : null}
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
              {(reviewingExtraction.queuePos || reviewQueue.length > 0) && (
                <button
                  onClick={advanceReviewQueue}
                  title="Skip this PO without importing and move to the next one. The email stays in the list so you can come back to it."
                  style={{ flex: 1, padding: '12px', borderRadius: '10px', background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.35)', color: '#60a5fa', fontWeight: 700, fontSize: '13px', cursor: 'pointer' }}
                >
                  Skip {reviewQueue.length > 0 ? '→' : ''}
                </button>
              )}
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
                  <a href={pdfTabUrl(reviewingExtraction.pdf, reviewingExtraction.messageId)} onClick={openPdfTab} target="_blank" rel="noreferrer" style={{ fontSize: '10px', fontWeight: 700, color: '#60a5fa', textDecoration: 'none', whiteSpace: 'nowrap' }}>Open in new tab ↗</a>
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
        <DropZone accept=".pdf" multiple={false} onFiles={files => importPoPdf(files[0])}>
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
        </DropZone>
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
            <CustomerPicker
              value={form.customer}
              netsuiteId={form.customer_netsuite_id}
              onChange={({ customer, customerNetsuiteId }) => setForm({ ...form, customer, customer_netsuite_id: customerNetsuiteId })}
            />
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

      {pos.length > 0 && filteredPos.length === 0 && (poSearch || poFilter !== 'all' || poCustomerFilter !== 'all' || poDateRange !== 'all') && (
        <div style={{ textAlign: 'center', padding: '24px 0', color: 'var(--text-label)' }}>
          <div style={{ fontSize: '12px' }}>
            {poSearch ? <>No POs matching &quot;{poSearch}&quot;</> : 'No POs match the current filters'}
          </div>
        </div>
      )}


      {/* PO table — thin rows; each row opens the PO record page. In edit
          (select) mode a leading checkbox column replaces row navigation. */}
      {sortedPos.length > 0 && (() => {
        const thStyle: React.CSSProperties = {
          fontSize: '10px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.5px',
          color: 'var(--text-muted)', padding: '10px 12px', borderBottom: '1px solid var(--border-strong)',
        };
        const tdStyle: React.CSSProperties = {
          padding: '9px 12px', borderBottom: '1px solid var(--border)', fontSize: '12.5px', whiteSpace: 'nowrap',
        };
        const numStyle: React.CSSProperties = { ...tdStyle, textAlign: 'right', fontVariantNumeric: 'tabular-nums' };
        return (
          <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', overflow: 'hidden' }}>
            <div className="responsive-table">
              <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: '820px' }}>
                <thead><tr>
                  {editMode && <th style={{ ...thStyle, width: '28px' }} aria-label="Select"></th>}
                  <SortableTh label="PO #" sortKey="po" sort={poTableSort} onToggle={togglePoSort} style={thStyle} />
                  <SortableTh label="Customer" sortKey="customer" sort={poTableSort} onToggle={togglePoSort} style={thStyle} />
                  <SortableTh label="Location" sortKey="location" sort={poTableSort} onToggle={togglePoSort} style={thStyle} />
                  <SortableTh label="Date" sortKey="date" sort={poTableSort} onToggle={togglePoSort} defaultDir="desc" style={thStyle} />
                  <SortableTh label="Billed" sortKey="billed" sort={poTableSort} onToggle={togglePoSort} defaultDir="desc" align="right" style={thStyle} />
                  <SortableTh label="Total" sortKey="total" sort={poTableSort} onToggle={togglePoSort} defaultDir="desc" align="right" style={thStyle} />
                  <SortableTh label="Status" sortKey="status" sort={poTableSort} onToggle={togglePoSort} style={thStyle} />
                  <th style={thStyle}>Flags</th>
                </tr></thead>
                <tbody>
                  {sortedPos.map((po) => {
                    const totalValue = po.line_items.reduce((s, l) => s + l.quantity * l.unit_price, 0);
                    const billed = billedDollars(po);
                    const billedColor = billed <= 0
                      ? 'var(--text-muted)'
                      : billed > totalValue + 0.005
                        ? '#f87171'
                        : billed >= totalValue - 0.005
                          ? '#4ade80'
                          : '#60a5fa';
                    const displayDate = po.ordered_date ? new Date(po.ordered_date + 'T00:00:00') : new Date(po.created_at);
                    const loc = shipToCityLabel(po.ship_to);
                    const statusMeta = PO_STATUS_META[po.status] || { label: po.status, color: '#94a3b8' };
                    const jobs = gfxJobsByPo[po.id] || [];
                    const noteCount = ((po as any).po_notes || []).length;
                    const checkStatus = (po as any).invoice_check_status;
                    const hasFlags = jobs.length > 0 || noteCount > 0 || checkStatus === 'attention'
                      || (checkStatus === 'no_invoices' && po.status === 'complete')
                      || !!(po as any).netsuite_invoice_number;
                    return (
                      <tr
                        key={po.id}
                        className="table-row-link"
                        onClick={() => editMode ? toggleDeleteSelection(po.id) : router.push(`/admin/pos/${po.id}`)}
                      >
                        {editMode && (
                          <td style={tdStyle} onClick={(e) => e.stopPropagation()}>
                            <input
                              type="checkbox"
                              checked={selectedForDelete.has(po.id)}
                              onChange={() => toggleDeleteSelection(po.id)}
                              style={{ width: '15px', height: '15px', accentColor: '#ef4444', cursor: 'pointer', display: 'block' }}
                            />
                          </td>
                        )}
                        <td style={tdStyle}>
                          <span style={{ fontWeight: 800, color: '#60a5fa' }}>{po.po_number}</span>
                        </td>
                        <td style={{ ...tdStyle, color: 'var(--text-secondary)' }}>{po.customer}</td>
                        <td style={{ ...tdStyle, color: loc ? 'var(--text-secondary)' : 'var(--text-muted)' }} title={formatShipTo(po.ship_to) || undefined}>
                          {loc || '—'}
                        </td>
                        <td style={{ ...tdStyle, color: 'var(--text-secondary)' }} title={po.ordered_date ? 'PO date' : 'Imported date (no PO date on record)'}>
                          {displayDate.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}
                        </td>
                        <td style={numStyle} title={`${billed <= 0 ? '$0' : fmt(billed)} billed of ${fmt(totalValue)}`}>
                          <span style={{ fontWeight: 700, color: billedColor }}>{billed <= 0 ? '$0' : fmt(billed)}</span>
                        </td>
                        <td style={numStyle}>
                          <span style={{ fontWeight: 800, color: '#60a5fa' }}>{fmt(totalValue)}</span>
                        </td>
                        <td style={tdStyle}>
                          <span style={{
                            fontSize: '10px', fontWeight: 800, padding: '2px 8px', borderRadius: '999px',
                            background: `${statusMeta.color}15`, border: `1px solid ${statusMeta.color}33`, color: statusMeta.color,
                          }}>
                            {statusMeta.label}
                          </span>
                        </td>
                        <td style={tdStyle}>
                          {hasFlags ? (
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                              {jobs.length > 0 && (
                                <span
                                  onClick={(e) => { e.stopPropagation(); router.push(`/graphics?editJob=${jobs[0].id}`); }}
                                  title={jobs.map(j => `${j.job_number || j.id.slice(0, 8)} — ${GRAPHICS_STATUS_LABELS[j.status] || j.status}`).join('\n')}
                                  style={{ cursor: 'pointer', fontWeight: 700, color: '#a78bfa', fontSize: '12px' }}
                                >
                                  🎨{jobs.length > 1 ? ` ×${jobs.length}` : ''}
                                </span>
                              )}
                              {noteCount > 0 && (
                                <span style={{ color: '#fbbf24', fontWeight: 700, fontSize: '11px' }} title={`${noteCount} note${noteCount !== 1 ? 's' : ''}`}>
                                  💬 {noteCount}
                                </span>
                              )}
                              {checkStatus === 'attention' && (
                                <span
                                  style={{ color: '#f87171', fontWeight: 700, fontSize: '11px' }}
                                  title={(((po as any).invoice_check?.problems || []) as string[]).join('\n') || 'Billed quantities don\'t match this PO'}
                                >
                                  ⚠ Billing
                                </span>
                              )}
                              {checkStatus === 'no_invoices' && po.status === 'complete' && (
                                <span style={{ color: '#fbbf24', fontWeight: 700, fontSize: '11px' }} title="This PO is fulfilled but has no invoices linked — nothing has been billed">
                                  ⚠ Not invoiced
                                </span>
                              )}
                              {(po as any).netsuite_invoice_number && (
                                <span style={{ color: '#34d399', fontWeight: 700, fontSize: '11px' }}>
                                  INV #{(po as any).netsuite_invoice_number}
                                </span>
                              )}
                            </div>
                          ) : (
                            <span style={{ color: 'var(--text-muted)' }}>—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        );
      })()}

      <button onClick={() => router.push('/more')} style={{ width: '100%', padding: '10px', borderRadius: '10px', marginTop: '14px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-body)', fontSize: '13px', fontWeight: 700 }}>
        ← Back
      </button>

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
