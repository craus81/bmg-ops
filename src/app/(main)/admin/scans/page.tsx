'use client';

import { useState, useEffect } from 'react';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import { theme } from '@/lib/theme';

interface ScanLog {
  id: string;
  vin: string;
  vehicle_year: string | null;
  vehicle_make: string | null;
  vehicle_model: string | null;
  part_number: string | null;
  part_description: string | null;
  billable_customer: string | null;
  location_name: string | null;
  po_id: string | null;
  po_number: string | null;
  po_line_item_id: string | null;
  scanned_by: string | null;
  scanned_at: string;
  exported_at: string | null;
  archived_at: string | null;
  requires_po?: boolean;
}

type ViewTab = 'ready' | 'waiting' | 'exported' | 'bulk';

export default function AdminScansPage() {
  const { user } = useAuth();
  const supabase = createClient();

  const [scans, setScans] = useState<ScanLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<ViewTab>('ready');
  const [search, setSearch] = useState('');
  const [profiles, setProfiles] = useState<Record<string, string>>({});
  const [selectedScans, setSelectedScans] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);
  const [matching, setMatching] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  // Part requires_po_match lookup
  const [poRequired, setPoRequired] = useState<Record<string, boolean>>({});

  // Bulk upload state
  const [allParts, setAllParts] = useState<{ id: string; item_number: string; display_name: string | null; billable_customer: string | null }[]>([]);
  const [allLocations, setAllLocations] = useState<{ id: string; name: string }[]>([]);
  const [bulkPart, setBulkPart] = useState<string>('');
  const [bulkPartSearch, setBulkPartSearch] = useState('');
  const [bulkPartLabel, setBulkPartLabel] = useState('');
  const [bulkLocation, setBulkLocation] = useState<string>('');
  const [bulkCustomer, setBulkCustomer] = useState('');
  const [bulkVins, setBulkVins] = useState('');
  const [bulkProcessing, setBulkProcessing] = useState(false);
  const [bulkResult, setBulkResult] = useState<{ success: number; failed: number; skipped?: number } | null>(null);
  const [scanningWorksheet, setScanningWorksheet] = useState(false);
  const [worksheetNotes, setWorksheetNotes] = useState<string | null>(null);

  // Direct invoice state
  const [invoicing, setInvoicing] = useState(false);
  const [invoiceResult, setInvoiceResult] = useState<{ results: { customer: string; vehicleCount: number; status: string; invoiceNumber?: string; error?: string }[]; summary: { success: number; errors: number } } | null>(null);

  useEffect(() => { loadAll(); }, []);

  const loadAll = async () => {
    setLoading(true);
    const [scansRes, profilesRes, partsRes, fullPartsRes, locsRes] = await Promise.all([
      supabase.from('scan_logs').select('*').is('archived_at', null).order('scanned_at', { ascending: false }).limit(1000),
      supabase.from('profiles').select('id, full_name'),
      supabase.from('netsuite_parts').select('item_number, requires_po_match'),
      // All active parts — paginate to get all
      (async () => {
        let all: any[] = [];
        let pg = 0;
        let more = true;
        while (more) {
          const { data } = await supabase.from('netsuite_parts').select('id, item_number, display_name, billable_customer').eq('is_active', true).order('item_number').range(pg * 1000, (pg + 1) * 1000 - 1);
          all = [...all, ...(data || [])];
          more = (data || []).length === 1000;
          pg++;
        }
        return { data: all };
      })(),
      supabase.from('work_locations').select('id, name').eq('is_active', true).order('name'),
    ]);
    setAllParts((fullPartsRes.data || []) as typeof allParts);
    setAllLocations((locsRes.data || []) as typeof allLocations);

    setScans((scansRes.data || []) as ScanLog[]);

    const pMap: Record<string, string> = {};
    (profilesRes.data || []).forEach((p: any) => { pMap[p.id] = p.full_name; });
    setProfiles(pMap);

    const poMap: Record<string, boolean> = {};
    (partsRes.data || []).forEach((p: any) => { poMap[p.item_number] = p.requires_po_match !== false; });
    setPoRequired(poMap);

    setSelectedScans(new Set());
    setLoading(false);
  };

  const needsPO = (scan: ScanLog) => poRequired[scan.part_number || ''] !== false;

  // Categorize scans
  const pending = scans.filter(s => !s.exported_at);
  const readyToExport = pending.filter(s => s.po_id || !needsPO(s));
  const waitingForPO = pending.filter(s => !s.po_id && needsPO(s));
  const exported = scans.filter(s => s.exported_at);

  const getTabScans = () => {
    if (tab === 'ready') return readyToExport;
    if (tab === 'waiting') return waitingForPO;
    if (tab === 'exported') return exported;
    return [];
  };

  const tabScans = getTabScans().filter(s => {
    if (!search) return true;
    const q = search.toLowerCase();
    return s.vin.toLowerCase().includes(q) ||
      s.part_number?.toLowerCase().includes(q) ||
      s.billable_customer?.toLowerCase().includes(q) ||
      s.location_name?.toLowerCase().includes(q) ||
      s.po_number?.toLowerCase().includes(q) ||
      [s.vehicle_year, s.vehicle_make, s.vehicle_model].filter(Boolean).join(' ').toLowerCase().includes(q);
  });

  // Group by billable customer → part + location
  const grouped = tabScans.reduce((acc: Record<string, Record<string, ScanLog[]>>, s) => {
    const customer = s.billable_customer || 'No Customer';
    const subKey = `${s.part_number || 'No Part'} · ${s.location_name || 'No Location'}`;
    if (!acc[customer]) acc[customer] = {};
    if (!acc[customer][subKey]) acc[customer][subKey] = [];
    acc[customer][subKey].push(s);
    return acc;
  }, {});
  const customerKeys = Object.keys(grouped).sort((a, b) => a === 'No Customer' ? 1 : b === 'No Customer' ? -1 : a.localeCompare(b));

  const toggleGroup = (key: string) => {
    setCollapsedGroups(prev => { const n = new Set(prev); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  };

  const toggleSelectGroup = (ids: string[]) => {
    setSelectedScans(prev => {
      const n = new Set(prev);
      const allSelected = ids.every(id => n.has(id));
      if (allSelected) { ids.forEach(id => n.delete(id)); } else { ids.forEach(id => n.add(id)); }
      return n;
    });
  };

  const toggleSelect = (id: string) => {
    setSelectedScans(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  };

  const selectAllVisible = () => {
    if (selectedScans.size === tabScans.length) setSelectedScans(new Set());
    else setSelectedScans(new Set(tabScans.map(s => s.id)));
  };

  // Trigger retroactive PO matching
  const runAutoMatch = async () => {
    setMatching(true);
    try {
      const res = await fetch('/api/scans/match-po', { method: 'POST' });
      const data = await res.json();
      alert(`Matched ${data.matched} of ${data.total} unmatched scans`);
      await loadAll();
    } catch {
      alert('Match failed');
    }
    setMatching(false);
  };

  // Export to CSV
  const exportCSV = async () => {
    const toExport = tabScans.filter(s => selectedScans.has(s.id));
    if (toExport.length === 0) return;
    setExporting(true);

    const headers = ['VIN', 'Year', 'Make', 'Model', 'Part Number', 'Description', 'Billable Customer', 'Location', 'PO Number', 'Scanned By', 'Date'];
    const rows = toExport.map(s => [
      s.vin, s.vehicle_year || '', s.vehicle_make || '', s.vehicle_model || '',
      s.part_number || '', s.part_description || '', s.billable_customer || '',
      s.location_name || '', s.po_number || '',
      profiles[s.scanned_by || ''] || '', new Date(s.scanned_at).toLocaleString(),
    ]);

    const csv = [headers, ...rows].map(r => r.map(c => `"${(c || '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `scans-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);

    await supabase.from('scan_logs').update({ exported_at: new Date().toISOString(), exported_by: user?.id }).in('id', toExport.map(s => s.id));
    setExporting(false);
    loadAll();
  };

  const archiveExported = async () => {
    const ids = [...selectedScans];
    if (ids.length === 0) return;
    await supabase.from('scan_logs').update({ archived_at: new Date().toISOString() }).in('id', ids);
    loadAll();
  };

  // Create direct invoice in NetSuite (no PO/SO needed)
  const createInvoice = async () => {
    const ids = [...selectedScans];
    if (ids.length === 0) return;
    if (!window.confirm(`Create NetSuite invoice for ${ids.length} scan${ids.length !== 1 ? 's' : ''}? This will bill the customer directly.`)) return;
    setInvoicing(true);
    setInvoiceResult(null);
    try {
      const res = await fetch('/api/netsuite/invoice-vehicles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scanIds: ids }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(`Invoice failed: ${data.error || 'Unknown error'}`);
      } else {
        setInvoiceResult(data);
        loadAll();
      }
    } catch (e: any) {
      alert(`Invoice failed: ${e.message}`);
    }
    setInvoicing(false);
  };

  // Edit scan
  const [editingScan, setEditingScan] = useState<ScanLog | null>(null);
  const saveEditScan = async () => {
    if (!editingScan) return;
    const { id, vin, vehicle_year, vehicle_make, vehicle_model, part_number, part_description, billable_customer, location_name } = editingScan;
    await supabase.from('scan_logs').update({ vin, vehicle_year, vehicle_make, vehicle_model, part_number, part_description, billable_customer, location_name }).eq('id', id);
    setEditingScan(null);
    loadAll();
  };

  // Delete
  const deleteScan = async (id: string) => {
    if (!window.confirm('Delete this scan?')) return;
    await supabase.from('scan_logs').delete().eq('id', id);
    loadAll();
  };

  const bulkDelete = async () => {
    const count = selectedScans.size;
    if (count === 0) return;
    if (!window.confirm(`Delete ${count} scan${count !== 1 ? 's' : ''}? This cannot be undone.`)) return;
    await supabase.from('scan_logs').delete().in('id', [...selectedScans]);
    setSelectedScans(new Set());
    loadAll();
  };

  // Bulk edit — apply part/customer/location to all selected
  const [showBulkEdit, setShowBulkEdit] = useState(false);
  const [bulkEditPart, setBulkEditPart] = useState('');
  const [bulkEditCustomer, setBulkEditCustomer] = useState('');
  const [bulkEditLocation, setBulkEditLocation] = useState('');
  const applyBulkEdit = async () => {
    const ids = [...selectedScans];
    if (ids.length === 0) return;
    const updates: any = {};
    if (bulkEditPart) {
      const part = allParts.find(p => p.id === bulkEditPart);
      if (part) { updates.part_number = part.item_number; updates.part_description = part.display_name; updates.billable_customer = part.billable_customer; }
    }
    if (bulkEditCustomer) updates.billable_customer = bulkEditCustomer;
    if (bulkEditLocation) {
      const loc = allLocations.find(l => l.id === bulkEditLocation);
      if (loc) { updates.location_id = loc.id; updates.location_name = loc.name; }
    }
    if (Object.keys(updates).length === 0) { setShowBulkEdit(false); return; }
    await supabase.from('scan_logs').update(updates).in('id', ids);
    setShowBulkEdit(false);
    setBulkEditPart('');
    setBulkEditCustomer('');
    setBulkEditLocation('');
    loadAll();
  };

  // Bulk upload handler
  const handleBulkUpload = async () => {
    if (!bulkVins.trim()) return;
    const selectedPart = allParts.find(p => p.id === bulkPart);
    const selectedLoc = allLocations.find(l => l.id === bulkLocation);

    // Parse VINs — one per line, strip whitespace, skip empty
    const vins = bulkVins.split(/[\n,]+/).map(v => v.trim().toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/gi, '')).filter(v => v.length >= 5);
    if (vins.length === 0) { setBulkResult({ success: 0, failed: 0 }); return; }

    setBulkProcessing(true);
    setBulkResult(null);

    // Check for duplicate VINs already in the system
    const { data: existingScans } = await supabase.from('scan_logs').select('vin').in('vin', vins);
    const existingVins = new Set((existingScans || []).map(s => s.vin));
    const dupeVins = vins.filter(v => existingVins.has(v));
    const newVins = vins.filter(v => !existingVins.has(v));

    if (dupeVins.length > 0 && newVins.length === 0) {
      alert(`All ${dupeVins.length} VIN${dupeVins.length !== 1 ? 's' : ''} already exist in the system.`);
      setBulkProcessing(false);
      return;
    }
    if (dupeVins.length > 0) {
      if (!window.confirm(`${dupeVins.length} VIN${dupeVins.length !== 1 ? 's' : ''} already exist and will be skipped:\n${dupeVins.slice(0, 5).join('\n')}${dupeVins.length > 5 ? `\n...and ${dupeVins.length - 5} more` : ''}\n\nContinue uploading ${newVins.length} new VIN${newVins.length !== 1 ? 's' : ''}?`)) {
        setBulkProcessing(false);
        return;
      }
    }

    let success = 0, failed = 0, skipped = dupeVins.length;

    for (const vin of newVins) {
      // Decode VIN
      let vehicleData: any = {};
      try {
        const res = await fetch(`https://vpic.nhtsa.dot.gov/api/vehicles/decodevin/${vin}?format=json`);
        const json = await res.json();
        const results = json.Results || [];
        const get = (id: number) => results.find((r: any) => r.VariableId === id)?.Value || null;
        vehicleData = { vehicle_year: get(29), vehicle_make: get(26), vehicle_model: get(28), vehicle_trim: get(38), body_class: get(5) };
      } catch {}

      const { error } = await supabase.from('scan_logs').insert({
        vin,
        ...vehicleData,
        part_number: selectedPart?.item_number || null,
        part_description: selectedPart?.display_name || null,
        billable_customer: bulkCustomer.trim() || selectedPart?.billable_customer || null,
        location_id: selectedLoc?.id || null,
        location_name: selectedLoc?.name || null,
        scanned_by: user?.id,
      });

      if (error) failed++; else success++;
    }

    setBulkResult({ success, failed, skipped });
    setBulkProcessing(false);
    if (success > 0) { setBulkVins(''); setBulkCustomer(''); loadAll(); }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      setBulkVins(prev => prev ? prev + '\n' + text : text);
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const handleWorksheetScan = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    setScanningWorksheet(true);
    setWorksheetNotes(null);
    setBulkResult(null);

    try {
      // Convert to base64
      const buffer = await file.arrayBuffer();
      const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
      const mediaType = file.type || (file.name.endsWith('.pdf') ? 'application/pdf' : 'image/jpeg');

      const res = await fetch('/api/scan-worksheet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageBase64: base64, mediaType }),
      });
      const result = await res.json();

      if (!res.ok || !result.data) {
        setWorksheetNotes(`Scan failed: ${result.error || 'Unknown error'}`);
        setScanningWorksheet(false);
        return;
      }

      const { header, rows, notes } = result.data;

      // Auto-select part number if found
      if (header?.part_number) {
        const partNumbers = header.part_number.split('/').map((p: string) => p.trim());
        const matchedPart = allParts.find(p => partNumbers.some((pn: string) => p.item_number.includes(pn)));
        if (matchedPart) setBulkPart(matchedPart.id);
      }

      // Populate VINs from rows
      if (rows && rows.length > 0) {
        const vins = rows.map((r: any) => r.partial_vin).filter(Boolean);
        setBulkVins(prev => prev ? prev + '\n' + vins.join('\n') : vins.join('\n'));
      }

      setWorksheetNotes(
        `Extracted: ${rows?.length || 0} VINs` +
        (header?.part_number ? ` · Part: ${header.part_number}` : '') +
        (header?.customer ? ` · Customer: ${header.customer}` : '') +
        (notes ? `\n${notes}` : '')
      );
    } catch (err: any) {
      setWorksheetNotes(`Scan error: ${err.message}`);
    }
    setScanningWorksheet(false);
  };

  if (loading) return <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>Loading...</div>;

  return (
    <div>
      <div style={{ fontSize: '11px', fontWeight: 700, color: theme.textMuted, textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: '12px' }}>
        Scan Log
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: '4px', marginBottom: '12px', flexWrap: 'wrap' }}>
        {([
          { id: 'ready' as ViewTab, label: `Ready to Export (${readyToExport.length})`, color: '#22c55e' },
          { id: 'waiting' as ViewTab, label: `Waiting for PO (${waitingForPO.length})`, color: '#f59e0b' },
          { id: 'exported' as ViewTab, label: `Exported (${exported.length})`, color: '#60a5fa' },
          { id: 'bulk' as ViewTab, label: 'Bulk Upload', color: '#a78bfa' },
        ]).map(t => (
          <button key={t.id} onClick={() => { setTab(t.id); setSelectedScans(new Set()); }} style={{
            padding: '6px 12px', borderRadius: '8px', fontSize: '11px', fontWeight: 700,
            background: tab === t.id ? 'var(--tab-active-bg)' : 'transparent',
            border: tab === t.id ? '1px solid var(--tab-active-border)' : '1px solid var(--border)',
            color: tab === t.id ? t.color : 'var(--text-muted)',
          }}>{t.label}</button>
        ))}
      </div>

      {/* Search */}
      {tab !== 'bulk' && <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search VIN, part, customer, location, PO..."
        style={{ width: '100%', padding: '10px 14px', borderRadius: '10px', fontSize: '13px', border: `1px solid ${theme.border}`, background: theme.card, color: theme.textPrimary, fontWeight: 600, marginBottom: '10px' }} />}

      {/* Actions */}
      <div style={{ display: 'flex', gap: '6px', marginBottom: '12px', flexWrap: 'wrap' }}>
        <button onClick={selectAllVisible} style={{ padding: '6px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700, background: 'var(--subtle-bg)', border: '1px solid var(--border)', color: 'var(--text-secondary)', cursor: 'pointer' }}>
          {selectedScans.size === tabScans.length && tabScans.length > 0 ? 'Deselect All' : `Select All (${tabScans.length})`}
        </button>
        {tab === 'waiting' && waitingForPO.length > 0 && (
          <button onClick={runAutoMatch} disabled={matching} style={{ padding: '6px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700, background: 'rgba(167,139,250,0.1)', border: '1px solid rgba(167,139,250,0.25)', color: '#a78bfa', cursor: 'pointer' }}>
            {matching ? 'Matching...' : 'Try Auto-Match POs'}
          </button>
        )}
        {(tab === 'ready' || tab === 'waiting') && selectedScans.size > 0 && (
          <>
            <button onClick={exportCSV} disabled={exporting} style={{ padding: '6px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700, background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.25)', color: '#22c55e', cursor: 'pointer' }}>
              {exporting ? 'Exporting...' : `Export ${selectedScans.size} to CSV`}
            </button>
            <button onClick={createInvoice} disabled={invoicing} style={{ padding: '6px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700, background: 'rgba(251,191,36,0.1)', border: '1px solid rgba(251,191,36,0.25)', color: '#fbbf24', cursor: 'pointer' }}>
              {invoicing ? 'Creating...' : `Create Invoice (${selectedScans.size})`}
            </button>
          </>
        )}
        {tab === 'exported' && selectedScans.size > 0 && (
          <>
            <button onClick={exportCSV} disabled={exporting} style={{ padding: '6px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700, background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.25)', color: '#22c55e', cursor: 'pointer' }}>
              {exporting ? 'Exporting...' : `Download CSV (${selectedScans.size})`}
            </button>
            <button onClick={archiveExported} style={{ padding: '6px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700, background: 'rgba(167,139,250,0.1)', border: '1px solid rgba(167,139,250,0.25)', color: '#a78bfa', cursor: 'pointer' }}>
              Archive {selectedScans.size}
            </button>
          </>
        )}
        {tab !== 'bulk' && selectedScans.size > 0 && (
          <>
            <button onClick={() => setShowBulkEdit(true)} style={{ padding: '6px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700, background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.25)', color: '#60a5fa', cursor: 'pointer' }}>
              Edit {selectedScans.size}
            </button>
            <button onClick={bulkDelete} style={{ padding: '6px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700, background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', color: '#ef4444', cursor: 'pointer' }}>
              Delete {selectedScans.size}
            </button>
          </>
        )}
      </div>

      {/* Invoice result banner */}
      {invoiceResult && (
        <div style={{ padding: '12px 14px', borderRadius: '10px', marginBottom: '12px', background: 'var(--card)', border: `1px solid ${invoiceResult.summary.errors > 0 ? 'rgba(239,68,68,0.3)' : 'rgba(34,197,94,0.3)'}` }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: invoiceResult.results.length > 0 ? '8px' : 0 }}>
            <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)' }}>
              Invoice Result: {invoiceResult.summary.success} created{invoiceResult.summary.errors > 0 ? `, ${invoiceResult.summary.errors} failed` : ''}
            </div>
            <button onClick={() => setInvoiceResult(null)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '14px', cursor: 'pointer' }}>✕</button>
          </div>
          {invoiceResult.results.map((r, i) => (
            <div key={i} style={{ fontSize: '11px', fontWeight: 600, color: r.status === 'success' ? '#22c55e' : '#ef4444', marginBottom: '2px' }}>
              {r.customer} ({r.vehicleCount} VIN{r.vehicleCount !== 1 ? 's' : ''})
              {r.status === 'success' ? ` → Invoice #${r.invoiceNumber}` : ` — ${r.error}`}
            </div>
          ))}
        </div>
      )}

      {/* Bulk edit modal */}
      {showBulkEdit && (
        <div style={{ background: 'var(--card)', border: `1px solid ${theme.border}`, borderRadius: '12px', padding: '14px', marginBottom: '12px' }}>
          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '10px' }}>Edit {selectedScans.size} Scan{selectedScans.size !== 1 ? 's' : ''}</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px', marginBottom: '10px' }}>
            <div>
              <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '3px' }}>Part Number</div>
              <select value={bulkEditPart} onChange={e => setBulkEditPart(e.target.value)} style={{ width: '100%', padding: '8px', borderRadius: '6px', border: `1px solid ${theme.border}`, background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '11px' }}>
                <option value="">— No change —</option>
                {allParts.map(p => <option key={p.id} value={p.id}>{p.item_number}{p.billable_customer ? ` — ${p.billable_customer}` : ''}</option>)}
              </select>
            </div>
            <div>
              <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '3px' }}>Billable Customer</div>
              <input value={bulkEditCustomer} onChange={e => setBulkEditCustomer(e.target.value)} placeholder="No change" style={{ width: '100%', padding: '8px', borderRadius: '6px', border: `1px solid ${theme.border}`, background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '11px' }} />
            </div>
            <div>
              <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '3px' }}>Location</div>
              <select value={bulkEditLocation} onChange={e => setBulkEditLocation(e.target.value)} style={{ width: '100%', padding: '8px', borderRadius: '6px', border: `1px solid ${theme.border}`, background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '11px' }}>
                <option value="">— No change —</option>
                {allLocations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </div>
          </div>
          <div style={{ display: 'flex', gap: '6px' }}>
            <button onClick={applyBulkEdit} style={{ padding: '8px 14px', borderRadius: '6px', fontSize: '11px', fontWeight: 700, background: '#22c55e', color: '#fff', border: 'none', cursor: 'pointer' }}>Apply Changes</button>
            <button onClick={() => setShowBulkEdit(false)} style={{ padding: '8px 14px', borderRadius: '6px', fontSize: '11px', fontWeight: 700, background: 'transparent', border: `1px solid ${theme.border}`, color: 'var(--text-muted)', cursor: 'pointer' }}>Cancel</button>
          </div>
        </div>
      )}

      {/* Bulk Upload tab */}
      {tab === 'bulk' && (
        <div style={{ background: 'var(--card)', border: `1px solid ${theme.border}`, borderRadius: '14px', padding: '16px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px', marginBottom: '12px' }}>
            <div style={{ position: 'relative' }}>
              <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '4px' }}>Part Number</div>
              {bulkPart ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '10px', borderRadius: '8px', border: `1px solid ${theme.border}`, background: 'var(--input-bg)' }}>
                  <span style={{ flex: 1, fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>{bulkPartLabel}</span>
                  <button onClick={() => { setBulkPart(''); setBulkPartLabel(''); setBulkPartSearch(''); }} style={{ background: 'none', border: 'none', color: '#f87171', fontSize: '14px', cursor: 'pointer' }}>✕</button>
                </div>
              ) : (
                <div>
                  <input value={bulkPartSearch} onChange={e => setBulkPartSearch(e.target.value)} placeholder="Search graphics parts..." style={{ width: '100%', padding: '10px', borderRadius: '8px', border: `1px solid ${theme.border}`, background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '13px' }} />
                  {bulkPartSearch.length >= 2 && (() => {
                    const q = bulkPartSearch.toLowerCase();
                    const matches = allParts.filter(p => p.item_number.toLowerCase().includes(q) || p.display_name?.toLowerCase().includes(q) || p.billable_customer?.toLowerCase().includes(q)).slice(0, 8);
                    if (matches.length === 0) return <div style={{ fontSize: '10px', color: 'var(--text-muted)', padding: '6px 0' }}>No matching graphics parts</div>;
                    return (
                      <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50, background: 'var(--card)', border: `1px solid ${theme.border}`, borderRadius: '8px', boxShadow: '0 4px 12px rgba(0,0,0,0.2)', maxHeight: '200px', overflowY: 'auto', marginTop: '2px' }}>
                        {matches.map(p => (
                          <button key={p.id} onClick={() => { setBulkPart(p.id); setBulkPartLabel(`${p.item_number}${p.billable_customer ? ` — ${p.billable_customer}` : ''}`); setBulkPartSearch(''); }} style={{
                            display: 'block', width: '100%', padding: '8px 10px', textAlign: 'left', border: 'none', borderBottom: `1px solid ${theme.border}`,
                            background: 'transparent', cursor: 'pointer', fontSize: '12px', color: 'var(--text-primary)',
                          }}>
                            <span style={{ fontWeight: 700 }}>{p.item_number}</span>
                            {p.billable_customer && <span style={{ color: '#a78bfa', marginLeft: '6px' }}>{p.billable_customer}</span>}
                            {p.display_name && <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{p.display_name}</div>}
                          </button>
                        ))}
                      </div>
                    );
                  })()}
                </div>
              )}
            </div>
            <div>
              <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '4px' }}>Location</div>
              <select value={bulkLocation} onChange={e => setBulkLocation(e.target.value)} style={{ width: '100%', padding: '10px', borderRadius: '8px', border: `1px solid ${theme.border}`, background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '13px' }}>
                <option value="">— Select Location —</option>
                {allLocations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </div>
            <div>
              <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '4px' }}>Customer</div>
              <input value={bulkCustomer} onChange={e => setBulkCustomer(e.target.value)} placeholder="Override part default" style={{ width: '100%', padding: '10px', borderRadius: '8px', border: `1px solid ${theme.border}`, background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '13px' }} />
            </div>
          </div>

          <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '4px' }}>VINs (one per line, or paste from spreadsheet)</div>
          <textarea
            value={bulkVins}
            onChange={e => setBulkVins(e.target.value)}
            placeholder={'Paste VINs here, one per line...\n1FTBR1Y82TKA82014\n1FTBR1Y84TKA82175\n1FTBR1Y88TKA82180'}
            style={{
              width: '100%', minHeight: '150px', padding: '12px', borderRadius: '8px',
              border: `1px solid ${theme.border}`, background: 'var(--input-bg)',
              color: 'var(--text-primary)', fontSize: '13px', fontFamily: 'monospace',
              resize: 'vertical',
            }}
          />
          <div style={{ display: 'flex', gap: '8px', marginTop: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
            <label style={{
              padding: '8px 14px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
              background: 'var(--subtle-bg)', border: `1px solid ${theme.border}`,
              color: 'var(--text-secondary)', cursor: 'pointer',
            }}>
              Upload CSV
              <input type="file" accept=".csv,.txt,.tsv" onChange={handleFileUpload} style={{ display: 'none' }} />
            </label>
            <label style={{
              padding: '8px 14px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
              background: scanningWorksheet ? 'rgba(167,139,250,0.15)' : 'rgba(167,139,250,0.08)',
              border: '1px solid rgba(167,139,250,0.25)',
              color: '#a78bfa', cursor: scanningWorksheet ? 'default' : 'pointer',
              opacity: scanningWorksheet ? 0.6 : 1,
            }}>
              {scanningWorksheet ? 'Scanning...' : 'Scan Worksheet (OCR)'}
              <input type="file" accept="image/*,.pdf" capture="environment" onChange={handleWorksheetScan} disabled={scanningWorksheet} style={{ display: 'none' }} />
            </label>
            <span style={{ fontSize: '11px', color: 'var(--text-muted)', flex: 1 }}>
              {bulkVins.split(/[\n,]+/).filter(v => v.trim().length >= 5).length} VINs detected
            </span>
            <button
              onClick={handleBulkUpload}
              disabled={bulkProcessing || !bulkVins.trim()}
              style={{
                padding: '10px 20px', borderRadius: '8px', fontSize: '13px', fontWeight: 800,
                background: bulkProcessing || !bulkVins.trim() ? theme.border : '#22c55e',
                color: '#fff', border: 'none', cursor: bulkProcessing || !bulkVins.trim() ? 'default' : 'pointer',
                opacity: bulkProcessing || !bulkVins.trim() ? 0.5 : 1,
              }}
            >
              {bulkProcessing ? 'Processing...' : 'Upload VINs'}
            </button>
          </div>
          {worksheetNotes && (
            <div style={{ marginTop: '10px', padding: '10px 14px', borderRadius: '8px', background: 'rgba(167,139,250,0.06)', border: '1px solid rgba(167,139,250,0.2)', color: '#a78bfa', fontSize: '12px', fontWeight: 600, whiteSpace: 'pre-wrap' }}>
              {worksheetNotes}
            </div>
          )}
          {bulkResult && (
            <div style={{ marginTop: '10px', padding: '10px 14px', borderRadius: '8px', background: 'rgba(34,197,94,0.06)', border: '1px solid rgba(34,197,94,0.2)', color: '#22c55e', fontSize: '12px', fontWeight: 700 }}>
              {bulkResult.success} VIN{bulkResult.success !== 1 ? 's' : ''} uploaded{bulkResult.failed > 0 ? ` · ${bulkResult.failed} failed` : ''}{bulkResult.skipped ? ` · ${bulkResult.skipped} duplicate${bulkResult.skipped !== 1 ? 's' : ''} skipped` : ''}
            </div>
          )}
        </div>
      )}

      {/* Empty state */}
      {tab !== 'bulk' && tabScans.length === 0 && (
        <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--text-muted)', fontSize: '13px', fontWeight: 600 }}>
          {tab === 'ready' ? 'No scans ready to export' : tab === 'waiting' ? 'No scans waiting for PO — all matched!' : 'No exported scans'}
        </div>
      )}

      {/* Grouped list */}
      {tab !== 'bulk' && <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {customerKeys.map(customer => {
          const subGroups = grouped[customer];
          const subKeys = Object.keys(subGroups).sort();
          const totalVins = subKeys.reduce((sum, k) => sum + subGroups[k].length, 0);
          const isCustomerCollapsed = collapsedGroups.has(customer);

          const customerScanIds = subKeys.flatMap(k => subGroups[k].map(s => s.id));
          const allCustomerSelected = customerScanIds.length > 0 && customerScanIds.every(id => selectedScans.has(id));

          return (
            <div key={customer}>
              {/* Customer header */}
              <div style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '10px 14px', borderRadius: '10px',
                background: 'var(--card)', border: '1px solid var(--border)', marginBottom: isCustomerCollapsed ? 0 : '6px',
              }}>
                <div onClick={() => toggleGroup(customer)} style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', flex: 1 }}>
                  <span style={{ fontSize: '10px', color: 'var(--text-muted)', transition: 'transform 0.15s', transform: isCustomerCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}>▼</span>
                  <span style={{ fontWeight: 800, fontSize: '14px', color: 'var(--text-primary)' }}>{customer}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <button onClick={(e) => { e.stopPropagation(); toggleSelectGroup(customerScanIds); }} style={{ padding: '2px 8px', borderRadius: '4px', fontSize: '9px', fontWeight: 700, background: allCustomerSelected ? 'rgba(59,130,246,0.15)' : 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.2)', color: '#60a5fa', cursor: 'pointer' }}>
                    {allCustomerSelected ? 'Deselect' : 'Select'} All
                  </button>
                  <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)' }}>{totalVins} VIN{totalVins !== 1 ? 's' : ''}</span>
                </div>
              </div>

              {!isCustomerCollapsed && (
                <div style={{ paddingLeft: '12px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {subKeys.map(subKey => {
                    const groupScans = subGroups[subKey];
                    const subCollapsed = collapsedGroups.has(`${customer}|${subKey}`);
                    const [partLabel, locLabel] = subKey.split(' · ');
                    const groupIds = groupScans.map(s => s.id);
                    const allGroupSelected = groupIds.length > 0 && groupIds.every(id => selectedScans.has(id));

                    return (
                      <div key={subKey}>
                        {/* Part + location sub-header */}
                        <div style={{
                          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                          padding: '6px 10px', borderRadius: '8px',
                          background: 'var(--subtle-bg)', border: '1px solid var(--border)', marginBottom: subCollapsed ? 0 : '3px',
                        }}>
                          <div onClick={() => toggleGroup(`${customer}|${subKey}`)} style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', flex: 1 }}>
                            <span style={{ fontSize: '9px', color: 'var(--text-muted)', transform: subCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}>▼</span>
                            <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)' }}>{partLabel}</span>
                            <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{locLabel}</span>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <button onClick={(e) => { e.stopPropagation(); toggleSelectGroup(groupIds); }} style={{ padding: '2px 6px', borderRadius: '4px', fontSize: '8px', fontWeight: 700, background: allGroupSelected ? 'rgba(59,130,246,0.15)' : 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.2)', color: '#60a5fa', cursor: 'pointer' }}>
                              {allGroupSelected ? 'Deselect' : 'Select'}
                            </button>
                            {groupScans[0]?.po_number && <span style={{ fontSize: '9px', fontWeight: 700, padding: '2px 6px', borderRadius: '4px', background: 'rgba(34,197,94,0.1)', color: '#22c55e' }}>PO #{groupScans[0].po_number}</span>}
                            <span style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)' }}>{groupScans.length}</span>
                          </div>
                        </div>

                        {/* VIN list */}
                        {!subCollapsed && (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', paddingLeft: '10px' }}>
                            {groupScans.map(scan => (
                              <div key={scan.id} style={{
                                display: 'flex', alignItems: 'center', gap: '8px',
                                padding: '6px 10px', borderRadius: '6px',
                                background: 'var(--card)', border: `1px solid ${scan.po_id ? 'rgba(34,197,94,0.15)' : 'var(--border)'}`,
                              }}>
                                <input type="checkbox" checked={selectedScans.has(scan.id)} onChange={() => toggleSelect(scan.id)} style={{ width: '14px', height: '14px', flexShrink: 0 }} />
                                <div style={{ flex: 1, minWidth: 0 }}>
                                  <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-primary)' }}>
                                    {[scan.vehicle_year, scan.vehicle_make, scan.vehicle_model].filter(Boolean).join(' ') || 'Unknown'}
                                  </div>
                                  <div style={{ fontSize: '9px', fontFamily: 'monospace', color: 'var(--text-muted)' }}>{scan.vin}</div>
                                </div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}>
                                  <div style={{ fontSize: '9px', color: 'var(--text-muted)', textAlign: 'right' }}>
                                    {profiles[scan.scanned_by || ''] || ''}<br />
                                    {new Date(scan.scanned_at).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                                  </div>
                                  <button onClick={() => setEditingScan({ ...scan })} style={{ padding: '2px 5px', borderRadius: '4px', border: 'none', background: 'rgba(59,130,246,0.08)', color: '#60a5fa', fontSize: '9px', fontWeight: 700, cursor: 'pointer' }}>Edit</button>
                                  <button onClick={() => deleteScan(scan.id)} style={{ padding: '2px 5px', borderRadius: '4px', border: 'none', background: 'rgba(239,68,68,0.08)', color: '#ef4444', fontSize: '9px', fontWeight: 700, cursor: 'pointer' }}>✕</button>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>}

      {/* Edit scan modal */}
      {editingScan && (
        <div style={{ position: 'fixed', inset: 0, background: 'var(--overlay)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }} onClick={() => setEditingScan(null)}>
          <div onClick={e => e.stopPropagation()} style={{ background: 'var(--card)', borderRadius: '14px', padding: '20px', width: '100%', maxWidth: '450px', boxShadow: '0 8px 30px rgba(0,0,0,0.3)' }}>
            <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '12px' }}>Edit Scan</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '10px' }}>
              <div style={{ gridColumn: '1 / -1' }}>
                <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '2px' }}>VIN</div>
                <input value={editingScan.vin} onChange={e => setEditingScan({ ...editingScan, vin: e.target.value.toUpperCase() })} style={{ width: '100%', padding: '8px', borderRadius: '6px', border: `1px solid ${theme.border}`, background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '13px', fontFamily: 'monospace' }} />
              </div>
              <div>
                <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '2px' }}>Year</div>
                <input value={editingScan.vehicle_year || ''} onChange={e => setEditingScan({ ...editingScan, vehicle_year: e.target.value })} style={{ width: '100%', padding: '8px', borderRadius: '6px', border: `1px solid ${theme.border}`, background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '12px' }} />
              </div>
              <div>
                <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '2px' }}>Make</div>
                <input value={editingScan.vehicle_make || ''} onChange={e => setEditingScan({ ...editingScan, vehicle_make: e.target.value })} style={{ width: '100%', padding: '8px', borderRadius: '6px', border: `1px solid ${theme.border}`, background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '12px' }} />
              </div>
              <div>
                <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '2px' }}>Model</div>
                <input value={editingScan.vehicle_model || ''} onChange={e => setEditingScan({ ...editingScan, vehicle_model: e.target.value })} style={{ width: '100%', padding: '8px', borderRadius: '6px', border: `1px solid ${theme.border}`, background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '12px' }} />
              </div>
              <div>
                <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '2px' }}>Part Number</div>
                <input value={editingScan.part_number || ''} onChange={e => setEditingScan({ ...editingScan, part_number: e.target.value })} style={{ width: '100%', padding: '8px', borderRadius: '6px', border: `1px solid ${theme.border}`, background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '12px' }} />
              </div>
              <div>
                <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '2px' }}>Billable Customer</div>
                <input value={editingScan.billable_customer || ''} onChange={e => setEditingScan({ ...editingScan, billable_customer: e.target.value })} style={{ width: '100%', padding: '8px', borderRadius: '6px', border: `1px solid ${theme.border}`, background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '12px' }} />
              </div>
              <div style={{ gridColumn: '1 / -1' }}>
                <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '2px' }}>Location</div>
                <input value={editingScan.location_name || ''} onChange={e => setEditingScan({ ...editingScan, location_name: e.target.value })} style={{ width: '100%', padding: '8px', borderRadius: '6px', border: `1px solid ${theme.border}`, background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '12px' }} />
              </div>
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button onClick={() => setEditingScan(null)} style={{ flex: 1, padding: '10px', borderRadius: '8px', fontSize: '12px', fontWeight: 700, background: 'transparent', border: `1px solid ${theme.border}`, color: 'var(--text-body)', cursor: 'pointer' }}>Cancel</button>
              <button onClick={saveEditScan} style={{ flex: 1, padding: '10px', borderRadius: '8px', fontSize: '12px', fontWeight: 700, background: '#22c55e', color: '#fff', border: 'none', cursor: 'pointer' }}>Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
