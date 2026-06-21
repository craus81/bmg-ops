'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { storage } from '@/lib/storage';
import { useAuth } from '@/components/AuthProvider';

interface Part {
  id: string;
  netsuite_id: string;
  item_number: string;
  display_name: string | null;
  description: string | null;
  item_type: string | null;
  catalog: 'upfit' | 'graphics';
  sales_price: number;
  purchase_price: number;
  quantity_on_hand: number;
  quantity_available: number;
  labor_hours: number;
  ns_class: string | null;
  ns_department: string | null;
  vendor: string | null;
  billable_customer: string | null;
  requires_po_match: boolean;
  is_active: boolean;
  last_synced_at: string;
}

interface SyncLog {
  id: string;
  started_at: string;
  completed_at: string | null;
  status: string;
  parts_synced: number;
  error: string | null;
}

// Time window for the "completed" (scan) count. Calendar-period-to-date.
type CompletedRange = 'day' | 'week' | 'month' | 'year' | 'all';
const RANGES: { id: CompletedRange; label: string }[] = [
  { id: 'day', label: 'Today' },
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' },
  { id: 'year', label: 'Year' },
  { id: 'all', label: 'All' },
];
const RANGE_PHRASE: Record<CompletedRange, string> = {
  day: 'today', week: 'this week', month: 'this month', year: 'this year', all: 'all time',
};

export default function PartsPage() {
  const router = useRouter();
  const { user, isAdmin, isSales } = useAuth();
  const supabase = createClient();

  const [parts, setParts] = useState<Part[]>([]);
  const [loading, setLoading] = useState(true);
  const [catalog, setCatalog] = useState<'upfit' | 'graphics'>('upfit');
  const [search, setSearch] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState('');
  const [lastSync, setLastSync] = useState<SyncLog | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // Deep-link focus: the item number to open + scroll to once parts load, and
  // the row to briefly highlight so it's obvious where the search landed you.
  const [pendingFocus, setPendingFocus] = useState<string | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [editingLabor, setEditingLabor] = useState<string | null>(null);
  const [sortCol, setSortCol] = useState<'item_number' | 'sales_price' | 'quantity_on_hand' | 'labor_hours'>('item_number');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [laborValue, setLaborValue] = useState('');

  // Completed (scan) + PO-quantity stats, keyed by uppercased item number.
  const [range, setRange] = useState<CompletedRange>('all');
  const [scanRows, setScanRows] = useState<{ part: string; at: string }[]>([]);
  const [poOpenByPart, setPoOpenByPart] = useState<Record<string, number>>({});
  const [poAllByPart, setPoAllByPart] = useState<Record<string, number>>({});
  const [statsLoading, setStatsLoading] = useState(true);

  // Billable customer editing
  const [editingCustomer, setEditingCustomer] = useState<string | null>(null);
  const [customerValue, setCustomerValue] = useState('');

  // Part files
  interface PartFile { id: string; part_id: string; file_name: string; file_type: string | null; file_size: number | null; storage_path: string; }
  const [partFiles, setPartFiles] = useState<Record<string, PartFile[]>>({});
  const [uploadingFile, setUploadingFile] = useState(false);
  const partFileRef = useRef<HTMLInputElement>(null);
  // Monotonic token to ignore stale loadParts() responses. A deep-link switches
  // catalog right after mount, so a slower earlier load must not clobber it.
  const loadReqRef = useRef(0);

  useEffect(() => {
    if (!isAdmin && !isSales) { router.push('/home'); return; }
    // loadParts() is driven by the [catalog] effect below (fires on mount too),
    // so we don't call it here — a second call just races the first.
    loadLastSync();
    loadStats();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  }, [isAdmin, isSales]);

  useEffect(() => {
    loadParts();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  }, [catalog]);

  // Deep-link from global search: /parts?catalog=graphics&q=06U183
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const c = params.get('catalog');
    const q = params.get('q');
    if (c === 'graphics' || c === 'upfit') setCatalog(c);
    if (q) { setSearch(q); setPendingFocus(q.toUpperCase()); }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- read URL once on mount
  }, []);

  const loadParts = async () => {
    const reqId = ++loadReqRef.current;
    setLoading(true);
    // Supabase returns max 1000 rows by default — paginate to get all
    let allParts: Part[] = [];
    let page = 0;
    const pageSize = 1000;
    let hasMore = true;
    while (hasMore) {
      const from = page * pageSize;
      const to = from + pageSize - 1;
      const { data } = await supabase
        .from('netsuite_parts')
        .select('*')
        .eq('catalog', catalog)
        .eq('is_active', true)
        .order('item_number', { ascending: true })
        .range(from, to);
      const batch = (data || []) as Part[];
      allParts = allParts.concat(batch);
      hasMore = batch.length === pageSize;
      page++;
    }
    // Collapse duplicate rows for the same item number (legacy data: pre-merge
    // mirrors, repeated "add to catalog", etc.) — keep the most authoritative.
    const isRealNs = (p: Part) => !!p.netsuite_id && !/^(LOCAL-|bmg-)/i.test(p.netsuite_id);
    const score = (p: Part) =>
      (isRealNs(p) ? 4 : 0) +
      (p.display_name && p.display_name !== p.item_number ? 2 : 0) +
      ((p.sales_price || 0) > 0 ? 1 : 0);
    const byItem = new Map<string, Part>();
    for (const p of allParts) {
      const key = (p.item_number || '').toUpperCase();
      const cur = byItem.get(key);
      if (!cur || score(p) > score(cur)) byItem.set(key, p);
    }
    if (loadReqRef.current !== reqId) return; // superseded by a newer load
    setParts([...byItem.values()].sort((a, b) => a.item_number.localeCompare(b.item_number)));
    setLoading(false);
  };

  const loadLastSync = async () => {
    const { data } = await supabase
      .from('parts_sync_log')
      .select('*')
      .order('started_at', { ascending: false })
      .limit(1)
      .single();
    if (data) setLastSync(data as SyncLog);
  };

  // Pull scans ("completed") + PO quantities once and aggregate per part. Runs
  // in the background after parts so the catalog itself renders immediately.
  const loadStats = async () => {
    setStatsLoading(true);

    const fetchAll = async (table: string, cols: string): Promise<any[]> => {
      let all: any[] = [];
      let pg = 0;
      let more = true;
      while (more) {
        const { data } = await supabase.from(table).select(cols).range(pg * 1000, pg * 1000 + 999);
        const batch = data || [];
        all = all.concat(batch);
        more = batch.length === 1000;
        pg++;
      }
      return all;
    };

    const [scanData, poData, lineData] = await Promise.all([
      fetchAll('scan_logs', 'part_number, scanned_at'),
      fetchAll('purchase_orders', 'id, status'),
      fetchAll('po_line_items', 'part_number, quantity, po_id'),
    ]);

    setScanRows(
      scanData
        .filter((s) => s.part_number)
        .map((s) => ({ part: String(s.part_number).toUpperCase(), at: s.scanned_at }))
    );

    // PO status by id, so line-item quantities can be split into open vs. all.
    const poStatus = new Map<string, string>();
    for (const p of poData) poStatus.set(p.id, p.status);

    const open: Record<string, number> = {};
    const all: Record<string, number> = {};
    for (const l of lineData) {
      if (!l.part_number) continue;
      const key = String(l.part_number).toUpperCase();
      const q = l.quantity || 0;
      all[key] = (all[key] || 0) + q;
      if (poStatus.get(l.po_id) === 'open') open[key] = (open[key] || 0) + q;
    }
    setPoOpenByPart(open);
    setPoAllByPart(all);
    setStatsLoading(false);
  };

  const handleSync = async () => {
    setSyncing(true);
    setSyncMessage('Syncing parts from NetSuite...');

    try {
      const res = await fetch('/api/parts/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user?.id }),
      });

      const data = await res.json();

      if (!res.ok) {
        setSyncMessage(`Sync failed: ${data.error || 'Unknown error'}`);
      } else {
        const details = [
          `${data.synced} parts synced`,
          data.itemsWithPrice ? `${data.itemsWithPrice} with price` : null,
          data.itemsWithQty ? `${data.itemsWithQty} with qty` : null,
        ].filter(Boolean).join(', ');
        setSyncMessage(details);
        loadParts();
        loadLastSync();
      }
    } catch (err: any) {
      setSyncMessage(`Sync error: ${err.message}`);
    } finally {
      setSyncing(false);
      setTimeout(() => setSyncMessage(''), 5000);
    }
  };

  const updateLaborHours = async (partId: string) => {
    const hours = parseFloat(laborValue);
    if (isNaN(hours) || hours < 0) return;

    await supabase
      .from('netsuite_parts')
      .update({ labor_hours: hours, updated_at: new Date().toISOString() })
      .eq('id', partId);

    setEditingLabor(null);
    setLaborValue('');
    loadParts();
  };

  const updateBillableCustomer = async (partId: string) => {
    await supabase.from('netsuite_parts').update({ billable_customer: customerValue.trim() || null }).eq('id', partId);
    setParts(prev => prev.map(p => p.id === partId ? { ...p, billable_customer: customerValue.trim() || null } : p));
    setEditingCustomer(null);
    setCustomerValue('');
  };

  const loadPartFiles = async (partId: string) => {
    const { data } = await supabase.from('part_files').select('*').eq('part_id', partId).order('uploaded_at', { ascending: false });
    if (data) setPartFiles(prev => ({ ...prev, [partId]: data as PartFile[] }));
  };

  // Once parts have loaded, open + scroll to the deep-linked item (exact item
  // number match from global search) and highlight it briefly.
  useEffect(() => {
    if (!pendingFocus || parts.length === 0) return;
    const target = parts.find(p => (p.item_number || '').toUpperCase() === pendingFocus);
    if (!target) return;
    setPendingFocus(null);
    setExpandedId(target.id);
    loadPartFiles(target.id);
    setHighlightId(target.id);
    const t = setTimeout(() => setHighlightId(null), 2500);
    requestAnimationFrame(() => {
      document.getElementById(`part-row-${target.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- focus once parts arrive
  }, [parts, pendingFocus]);

  const uploadPartFile = async (partId: string, file: File) => {
    setUploadingFile(true);
    const ext = file.name.split('.').pop() || 'bin';
    const path = `part-files/${partId}/${Date.now()}.${ext}`;
    const { error: upErr } = await storage.from('graphics-proofs').upload(path, file, { contentType: file.type });
    if (!upErr) {
      await supabase.from('part_files').insert({ part_id: partId, file_name: file.name, file_type: file.type || null, file_size: file.size, storage_path: path, uploaded_by: user?.id });
      await loadPartFiles(partId);
    }
    setUploadingFile(false);
  };

  const deletePartFile = async (file: PartFile) => {
    if (!window.confirm(`Delete "${file.file_name}"?`)) return;
    await storage.from('graphics-proofs').remove([file.storage_path]);
    await supabase.from('part_files').delete().eq('id', file.id);
    setPartFiles(prev => ({ ...prev, [file.part_id]: (prev[file.part_id] || []).filter(f => f.id !== file.id) }));
  };

  const getFileUrl = (path: string) => storage.from('graphics-proofs').getPublicUrl(path).data.publicUrl;

  const toggleSort = (col: typeof sortCol) => {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortCol(col); setSortDir('asc'); }
  };
  const sortIndicator = (col: typeof sortCol) => sortCol === col ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';

  // Start of the selected window (ms). Recompute completed counts client-side
  // from the loaded scans, so changing the range needs no refetch.
  const rangeStartMs = useMemo(() => {
    if (range === 'all') return 0;
    const now = new Date();
    if (range === 'day') return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    if (range === 'week') { const d = new Date(now.getFullYear(), now.getMonth(), now.getDate()); d.setDate(d.getDate() - d.getDay()); return d.getTime(); }
    if (range === 'month') return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    return new Date(now.getFullYear(), 0, 1).getTime(); // year
  }, [range]);

  const completedByPart = useMemo(() => {
    const m: Record<string, number> = {};
    for (const r of scanRows) {
      if (rangeStartMs && new Date(r.at).getTime() < rangeStartMs) continue;
      m[r.part] = (m[r.part] || 0) + 1;
    }
    return m;
  }, [scanRows, rangeStartMs]);

  // Catalog-wide roll-up for the header line.
  const catalogTotals = useMemo(() => {
    let completed = 0, openPo = 0;
    for (const p of parts) {
      const k = (p.item_number || '').toUpperCase();
      completed += completedByPart[k] || 0;
      openPo += poOpenByPart[k] || 0;
    }
    return { completed, openPo };
  }, [parts, completedByPart, poOpenByPart]);

  const filtered = parts.filter(p => {
    if (!search) return true;
    const s = search.toLowerCase();
    return (
      p.item_number.toLowerCase().includes(s) ||
      p.display_name?.toLowerCase().includes(s) ||
      p.description?.toLowerCase().includes(s)
    );
  }).sort((a, b) => {
    const av = a[sortCol] ?? 0;
    const bv = b[sortCol] ?? 0;
    const cmp = typeof av === 'string' ? av.localeCompare(bv as string) : (av as number) - (bv as number);
    return sortDir === 'asc' ? cmp : -cmp;
  });

  const formatCurrency = (val: number) => {
    return val ? `$${val.toFixed(2)}` : '$0.00';
  };

  const formatQty = (val: number) => {
    return val % 1 === 0 ? val.toString() : val.toFixed(1);
  };

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '8px 10px', borderRadius: '8px',
    border: '1px solid var(--border)', background: 'var(--input-bg)',
    color: 'var(--text-primary)', fontSize: '12px',
  };

  if (!isAdmin && !isSales) return null;

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '14px' }}>
        <div>
          <div style={{ fontSize: '22px', fontWeight: 800, color: 'var(--text-primary)' }}>Parts Catalog</div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
            {parts.length} {catalog} parts {lastSync?.completed_at ? `· Last synced ${new Date(lastSync.completed_at).toLocaleString()}` : ''}
          </div>
        </div>
        {isAdmin && (
          <button
            onClick={handleSync}
            disabled={syncing}
            style={{
              padding: '8px 14px', borderRadius: '10px',
              background: syncing ? 'var(--subtle-bg)' : 'var(--accent)',
              color: '#fff', fontWeight: 800, fontSize: '12px',
              border: 'none', cursor: syncing ? 'not-allowed' : 'pointer',
              opacity: syncing ? 0.6 : 1,
              whiteSpace: 'nowrap',
            }}
          >
            {syncing ? 'Syncing...' : 'Sync Now'}
          </button>
        )}
      </div>

      {/* Sync message */}
      {syncMessage && (
        <div style={{
          padding: '8px 12px', borderRadius: '8px', marginBottom: '10px',
          background: syncMessage.includes('fail') || syncMessage.includes('error')
            ? 'var(--error-bg)' : 'rgba(16,185,129,0.1)',
          border: `1px solid ${syncMessage.includes('fail') || syncMessage.includes('error')
            ? 'var(--error-border)' : 'rgba(16,185,129,0.2)'}`,
          color: syncMessage.includes('fail') || syncMessage.includes('error')
            ? 'var(--error)' : '#34d399',
          fontSize: '12px', fontWeight: 600,
        }}>
          {syncMessage}
        </div>
      )}

      {/* Catalog tabs */}
      <div style={{
        display: 'flex', gap: '4px', padding: '4px',
        background: 'var(--card)', border: '1px solid var(--border)',
        borderRadius: '12px', marginBottom: '10px',
      }}>
        {([
          { id: 'upfit' as const, label: 'Upfit Parts', desc: 'Fleet & install' },
          { id: 'graphics' as const, label: 'Graphic Parts', desc: 'Decals & wraps' },
        ]).map((tab) => (
          <button
            key={tab.id}
            onClick={() => { setCatalog(tab.id); setExpandedId(null); }}
            style={{
              flex: 1, padding: '10px 8px', borderRadius: '10px',
              fontSize: '13px', fontWeight: 700, textAlign: 'center',
              background: catalog === tab.id ? 'var(--tab-active-bg)' : 'transparent',
              border: catalog === tab.id ? '1px solid var(--tab-active-border)' : '1px solid transparent',
              color: catalog === tab.id ? 'var(--text-primary)' : 'var(--text-muted)',
              transition: 'all 0.15s',
            }}
          >
            <div>{tab.label}</div>
            <div style={{ fontSize: '9px', fontWeight: 400, marginTop: '1px', color: 'var(--text-muted)' }}>{tab.desc}</div>
          </button>
        ))}
      </div>

      {/* Search */}
      <input
        placeholder={`Search ${catalog} parts...`}
        value={search}
        onChange={e => setSearch(e.target.value)}
        style={{ ...inputStyle, marginBottom: '10px' }}
      />

      {/* Completed time-range filter + catalog roll-up */}
      <div style={{ marginBottom: '10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '10px', fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.3px' }}>Completed</span>
          {RANGES.map(r => (
            <button key={r.id} onClick={() => setRange(r.id)} style={{
              padding: '4px 10px', borderRadius: '8px', fontSize: '11px', fontWeight: 700,
              background: range === r.id ? 'var(--tab-active-bg)' : 'transparent',
              border: range === r.id ? '1px solid var(--tab-active-border)' : '1px solid var(--border)',
              color: range === r.id ? 'var(--text-primary)' : 'var(--text-muted)', cursor: 'pointer',
            }}>{r.label}</button>
          ))}
        </div>
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '6px' }}>
          {statsLoading ? 'Loading stats…' : (
            <>
              <span style={{ color: '#34d399', fontWeight: 800 }}>{catalogTotals.completed}</span> completed {RANGE_PHRASE[range]}
              {' · '}
              <span style={{ color: '#60a5fa', fontWeight: 800 }}>{formatQty(catalogTotals.openPo)}</span> on open POs
            </>
          )}
        </div>
      </div>

      {/* Parts list */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>Loading parts...</div>
      ) : filtered.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>
          <div style={{ fontSize: '13px', marginBottom: '8px', fontWeight: 700, color: 'var(--text-muted)' }}>—</div>
          <div style={{ fontSize: '13px', fontWeight: 700 }}>
            {parts.length === 0 ? 'No parts synced yet' : 'No matching parts'}
          </div>
          <div style={{ fontSize: '11px', marginTop: '4px' }}>
            {parts.length === 0 ? 'Hit "Sync Now" to pull parts from NetSuite.' : 'Try different search terms.'}
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {/* Column headers */}
          <div style={{
            display: 'grid', gridTemplateColumns: '1fr 70px 50px 50px',
            padding: '6px 12px', fontSize: '9px', fontWeight: 700,
            color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.3px',
          }}>
            <div onClick={() => toggleSort('item_number')} style={{ cursor: 'pointer', color: sortCol === 'item_number' ? '#60a5fa' : undefined }}>Part{sortIndicator('item_number')}</div>
            <div onClick={() => toggleSort('sales_price')} style={{ textAlign: 'right', cursor: 'pointer', color: sortCol === 'sales_price' ? '#60a5fa' : undefined }}>Sale ${sortIndicator('sales_price')}</div>
            <div onClick={() => toggleSort('quantity_on_hand')} style={{ textAlign: 'right', cursor: 'pointer', color: sortCol === 'quantity_on_hand' ? '#60a5fa' : undefined }}>Qty{sortIndicator('quantity_on_hand')}</div>
            <div onClick={() => toggleSort('labor_hours')} style={{ textAlign: 'right', cursor: 'pointer', color: sortCol === 'labor_hours' ? '#60a5fa' : undefined }}>Labor{sortIndicator('labor_hours')}</div>
          </div>

          {filtered.map(part => {
            const isExpanded = expandedId === part.id;
            const isEditingLabor = editingLabor === part.id;
            const key = (part.item_number || '').toUpperCase();
            const completed = completedByPart[key] || 0;
            const margin = part.sales_price > 0 && part.purchase_price > 0
              ? ((part.sales_price - part.purchase_price) / part.sales_price * 100).toFixed(1)
              : null;

            return (
              <div key={part.id} id={`part-row-${part.id}`} style={{
                borderRadius: '10px',
                background: 'var(--card)',
                border: highlightId === part.id ? '1px solid #60a5fa' : '1px solid var(--border)',
                boxShadow: highlightId === part.id ? '0 0 0 2px rgba(96,165,250,0.5)' : undefined,
                transition: 'box-shadow 0.3s ease, border-color 0.3s ease',
                overflow: 'hidden',
              }}>
                {/* Row summary */}
                <div
                  onClick={() => { const newId = isExpanded ? null : part.id; setExpandedId(newId); if (newId) loadPartFiles(newId); }}
                  style={{
                    display: 'grid', gridTemplateColumns: '1fr 70px 50px 50px',
                    padding: '10px 12px', cursor: 'pointer', alignItems: 'center',
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {part.item_number}
                      </span>
                      {part.vendor && (
                        <span style={{ fontSize: '8px', fontWeight: 700, padding: '1px 5px', borderRadius: '4px', background: 'rgba(167,139,250,0.1)', border: '1px solid rgba(167,139,250,0.25)', color: '#a78bfa', whiteSpace: 'nowrap', flexShrink: 0 }}>
                          {part.vendor}
                        </span>
                      )}
                      {completed > 0 && (
                        <span title={`Completed ${RANGE_PHRASE[range]}`} style={{ fontSize: '8px', fontWeight: 800, padding: '1px 5px', borderRadius: '4px', background: 'rgba(52,211,153,0.12)', border: '1px solid rgba(52,211,153,0.3)', color: '#34d399', whiteSpace: 'nowrap', flexShrink: 0 }}>
                          ✓ {completed}
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: '10px', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {part.display_name || part.description || '—'}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right', fontSize: '12px', fontWeight: 700, color: '#34d399' }}>
                    {formatCurrency(part.sales_price)}
                  </div>
                  <div style={{ textAlign: 'right', fontSize: '12px', fontWeight: 600, color: part.quantity_on_hand > 0 ? 'var(--text-primary)' : 'var(--error)' }}>
                    {formatQty(part.quantity_on_hand)}
                  </div>
                  <div style={{ textAlign: 'right', fontSize: '12px', fontWeight: 600, color: part.labor_hours > 0 ? '#c084fc' : 'var(--text-muted)' }}>
                    {part.labor_hours > 0 ? `${part.labor_hours}h` : '—'}
                  </div>
                </div>

                {/* Expanded detail */}
                {isExpanded && (
                  <div style={{ padding: '0 12px 12px', borderTop: '1px solid var(--border)' }}>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginTop: '10px' }}>
                      <DetailField label="Sales Price" value={formatCurrency(part.sales_price)} color="#34d399" />
                      <DetailField label="Purchase Price" value={formatCurrency(part.purchase_price)} color="#60a5fa" />
                      <DetailField label="Qty On Hand" value={formatQty(part.quantity_on_hand)} color={part.quantity_on_hand > 0 ? 'var(--text-primary)' : 'var(--error)'} />
                      <DetailField label="Qty Available" value={formatQty(part.quantity_available)} color={part.quantity_available > 0 ? 'var(--text-primary)' : 'var(--error)'} />
                      <DetailField label={`Completed · ${RANGE_PHRASE[range]}`} value={statsLoading ? '…' : completed.toString()} color="#34d399" />
                      <DetailField label="On Open POs" value={statsLoading ? '…' : formatQty(poOpenByPart[key] || 0)} color="#60a5fa" />
                      <DetailField label="On All POs" value={statsLoading ? '…' : formatQty(poAllByPart[key] || 0)} color="var(--text-secondary)" />
                      {margin && (
                        <DetailField label="Margin" value={`${margin}%`} color={parseFloat(margin) > 30 ? '#34d399' : '#f59e0b'} />
                      )}
                      <div>
                        <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '2px' }}>
                          Labor Hours
                        </div>
                        {isEditingLabor ? (
                          <div style={{ display: 'flex', gap: '4px' }}>
                            <input
                              type="number"
                              step="0.25"
                              min="0"
                              value={laborValue}
                              onChange={e => setLaborValue(e.target.value)}
                              style={{ ...inputStyle, padding: '4px 6px', width: '70px' }}
                              autoFocus
                              onKeyDown={e => { if (e.key === 'Enter') updateLaborHours(part.id); if (e.key === 'Escape') setEditingLabor(null); }}
                            />
                            <button
                              onClick={() => updateLaborHours(part.id)}
                              style={{ padding: '4px 8px', borderRadius: '6px', background: 'var(--accent)', color: '#fff', fontSize: '10px', fontWeight: 700, border: 'none', cursor: 'pointer' }}
                            >
                              Save
                            </button>
                          </div>
                        ) : (
                          <div
                            onClick={() => { if (isAdmin) { setEditingLabor(part.id); setLaborValue(part.labor_hours.toString()); } }}
                            style={{ fontSize: '14px', fontWeight: 700, color: '#c084fc', cursor: isAdmin ? 'pointer' : 'default' }}
                          >
                            {part.labor_hours > 0 ? `${part.labor_hours}h` : '—'}
                            {isAdmin && <span style={{ fontSize: '9px', color: 'var(--text-muted)', marginLeft: '4px' }}>Edit</span>}
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Extra info */}
                    <div style={{ marginTop: '10px', display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                      {part.item_type && (
                        <Tag label={part.item_type} />
                      )}
                      {part.ns_class && (
                        <Tag label={part.ns_class} />
                      )}
                      {part.ns_department && (
                        <Tag label={part.ns_department} />
                      )}
                    </div>

                    {part.description && (
                      <div style={{ marginTop: '8px', fontSize: '11px', color: 'var(--text-muted)', lineHeight: 1.5 }}>
                        {part.description}
                      </div>
                    )}

                    {/* Billable Customer */}
                    {isAdmin && (
                      <div style={{ marginTop: '10px' }}>
                        <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '4px' }}>Billable Customer</div>
                        {editingCustomer === part.id ? (
                          <div style={{ display: 'flex', gap: '4px' }}>
                            <input value={customerValue} onChange={e => setCustomerValue(e.target.value)} placeholder="e.g. Masterack" autoFocus
                              onKeyDown={e => { if (e.key === 'Enter') updateBillableCustomer(part.id); if (e.key === 'Escape') setEditingCustomer(null); }}
                              style={{ ...inputStyle, padding: '6px 8px', flex: 1 }} />
                            <button onClick={() => updateBillableCustomer(part.id)} style={{ padding: '6px 10px', borderRadius: '6px', background: '#22c55e', color: '#fff', fontSize: '10px', fontWeight: 700, border: 'none', cursor: 'pointer' }}>Save</button>
                          </div>
                        ) : (
                          <div onClick={() => { setEditingCustomer(part.id); setCustomerValue(part.billable_customer || ''); }}
                            style={{ fontSize: '13px', fontWeight: 700, color: part.billable_customer ? '#a78bfa' : 'var(--text-muted)', cursor: 'pointer' }}>
                            {part.billable_customer || '— Set Customer'}
                            <span style={{ fontSize: '9px', color: 'var(--text-muted)', marginLeft: '4px' }}>Edit</span>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Part Files */}
                    <div style={{ marginTop: '10px' }}>
                      <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '4px' }}>Files &amp; Proofs</div>
                      {(partFiles[part.id] || []).map(f => (
                        <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 6px', borderRadius: '6px', background: 'var(--subtle-bg)', marginBottom: '3px' }}>
                          <a href={getFileUrl(f.storage_path)} target="_blank" rel="noopener noreferrer"
                            style={{ flex: 1, fontSize: '11px', fontWeight: 600, color: '#60a5fa', textDecoration: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {f.file_name}
                          </a>
                          {isAdmin && (
                            <button onClick={() => deletePartFile(f)} style={{ padding: '2px 6px', borderRadius: '4px', border: 'none', background: 'rgba(248,113,113,0.1)', color: '#f87171', fontSize: '10px', fontWeight: 700, cursor: 'pointer' }}>✕</button>
                          )}
                        </div>
                      ))}
                      {isAdmin && (
                        <>
                          <input ref={partFileRef} type="file" accept="image/*,.pdf,.eps,.ai,.svg" style={{ display: 'none' }}
                            onChange={async (e) => { const f = e.target.files?.[0]; if (f) await uploadPartFile(part.id, f); e.target.value = ''; }} />
                          <button onClick={() => partFileRef.current?.click()} disabled={uploadingFile} style={{
                            width: '100%', padding: '6px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
                            background: 'var(--subtle-bg)', border: '1px dashed var(--border)',
                            color: uploadingFile ? 'var(--text-muted)' : 'var(--text-secondary)', cursor: 'pointer',
                          }}>{uploadingFile ? 'Uploading...' : '+ Upload Proof / File'}</button>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Part count */}
      {!loading && filtered.length > 0 && (
        <div style={{ textAlign: 'center', padding: '10px', fontSize: '11px', color: 'var(--text-muted)' }}>
          Showing {filtered.length} of {parts.length} {catalog} parts
        </div>
      )}
    </div>
  );
}

function DetailField({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div>
      <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '2px' }}>
        {label}
      </div>
      <div style={{ fontSize: '14px', fontWeight: 700, color }}>
        {value}
      </div>
    </div>
  );
}

function Tag({ label }: { label: string }) {
  return (
    <span style={{
      padding: '2px 8px', borderRadius: '4px',
      background: 'var(--subtle-bg)', border: '1px solid var(--border)',
      color: 'var(--text-muted)', fontSize: '9px', fontWeight: 700,
    }}>
      {label}
    </span>
  );
}
