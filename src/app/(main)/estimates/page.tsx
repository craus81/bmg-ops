'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import { theme } from '@/lib/theme';

interface Part {
  id: string;
  netsuite_id: string;
  item_number: string;
  display_name: string;
  description: string;
  sales_price: number;
  labor_hours: number;
  catalog: string;
}

interface LineItem {
  key: string; // local key for React
  part_id: string | null;
  netsuite_item_id: string | null;
  item_number: string;
  description: string;
  quantity: number;
  unit_price: number;
  labor_hours: number;
  is_custom: boolean;
}

interface Estimate {
  id: string;
  estimate_number: string;
  customer_id: string | null;
  customer_name: string | null;
  customer_netsuite_id: string | null;
  title: string | null;
  notes: string | null;
  status: string;
  tax_rate: number;
  tax_exempt: boolean;
  labor_rate: number;
  labor_hours: number;
  labor_hours_override: number | null;
  subtotal: number;
  labor_total: number;
  tax_amount: number;
  grand_total: number;
  netsuite_estimate_id: string | null;
  netsuite_estimate_number: string | null;
  pushed_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

interface Customer {
  id: string;
  netsuite_id: string;
  company_name: string;
  entity_id: string;
}

type ViewMode = 'list' | 'builder';

const DEFAULT_TAX_RATE = 0.0795;
const DEFAULT_LABOR_RATE = 120;

const STATUS_COLORS: Record<string, string> = {
  draft: '#60a5fa',
  sent: '#fbbf24',
  accepted: '#22c55e',
  rejected: '#ef4444',
  pushed: '#a78bfa',
};

const STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  sent: 'Sent',
  accepted: 'Accepted',
  rejected: 'Rejected',
  pushed: 'Pushed to NS',
};

function genKey() {
  return Math.random().toString(36).substring(2, 10);
}

export default function EstimatesPage() {
  const router = useRouter();
  const { user, isAdmin, isSales, isGraphicsProduction, profile } = useAuth();
  const supabase = createClient();

  const [view, setView] = useState<ViewMode>('list');
  const [estimates, setEstimates] = useState<Estimate[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  // Builder state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [customerName, setCustomerName] = useState('');
  const [customerNsId, setCustomerNsId] = useState<string | null>(null);
  const [taxRate, setTaxRate] = useState(DEFAULT_TAX_RATE);
  const [taxExempt, setTaxExempt] = useState(false);
  const [laborRate, setLaborRate] = useState(DEFAULT_LABOR_RATE);
  const [laborOverride, setLaborOverride] = useState<number | null>(null);
  const [lines, setLines] = useState<LineItem[]>([]);
  const [estSortCol, setEstSortCol] = useState<'item_number' | 'quantity' | 'unit_price' | 'labor_hours' | null>(null);
  const [estSortDir, setEstSortDir] = useState<'asc' | 'desc'>('asc');
  const toggleEstSort = (col: typeof estSortCol) => {
    if (estSortCol === col) { if (estSortDir === 'desc') { setEstSortCol(null); } else { setEstSortDir('desc'); } }
    else { setEstSortCol(col); setEstSortDir('asc'); }
  };
  const estSortIndicator = (col: NonNullable<typeof estSortCol>) => estSortCol === col ? (estSortDir === 'asc' ? ' ▲' : ' ▼') : '';
  const sortedLines = estSortCol ? [...lines].sort((a, b) => {
    const av = a[estSortCol] ?? 0; const bv = b[estSortCol] ?? 0;
    const cmp = typeof av === 'string' ? av.localeCompare(bv as string) : (av as number) - (bv as number);
    return estSortDir === 'asc' ? cmp : -cmp;
  }) : lines;
  const [saving, setSaving] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Part search
  const [partSearch, setPartSearch] = useState('');
  const [partResults, setPartResults] = useState<Part[]>([]);
  const [partSearching, setPartSearching] = useState(false);
  const partSearchRef = useRef<HTMLInputElement>(null);

  // Customer search
  const [custSearch, setCustSearch] = useState('');
  const [custResults, setCustResults] = useState<Customer[]>([]);
  const [custSearching, setCustSearching] = useState(false);
  const [showCustDropdown, setShowCustDropdown] = useState(false);

  useEffect(() => {
    if (!user) return;
    if (!isAdmin && !isSales && !isGraphicsProduction) { router.push('/home'); return; }
    loadEstimates();
  }, [user, isAdmin, isSales, isGraphicsProduction]);

  const loadEstimates = async () => {
    setLoading(true);
    const res = await fetch('/api/estimates');
    const data = await res.json();
    setEstimates(data.estimates || []);
    setLoading(false);
  };

  // ── Customer search ──
  const searchCustomers = useCallback(async (q: string) => {
    if (q.length < 2) { setCustResults([]); return; }
    setCustSearching(true);
    const { data } = await supabase
      .from('customers')
      .select('id, netsuite_id, company_name, entity_id')
      .or(`company_name.ilike.%${q}%,entity_id.ilike.%${q}%`)
      .limit(8);
    setCustResults((data as Customer[]) || []);
    setCustSearching(false);
  }, []);

  useEffect(() => {
    const t = setTimeout(() => searchCustomers(custSearch), 300);
    return () => clearTimeout(t);
  }, [custSearch]);

  // ── Part search ──
  const searchParts = useCallback(async (q: string) => {
    if (q.length < 2) { setPartResults([]); return; }
    setPartSearching(true);
    const { data } = await supabase
      .from('netsuite_parts')
      .select('id, netsuite_id, item_number, display_name, description, sales_price, labor_hours, catalog')
      .eq('is_active', true)
      .or(`item_number.ilike.%${q}%,display_name.ilike.%${q}%,description.ilike.%${q}%`)
      .limit(10);
    setPartResults((data as Part[]) || []);
    setPartSearching(false);
  }, []);

  useEffect(() => {
    const t = setTimeout(() => searchParts(partSearch), 300);
    return () => clearTimeout(t);
  }, [partSearch]);

  // ── Add part as line item ──
  const addPartLine = (part: Part) => {
    const line: LineItem = {
      key: genKey(),
      part_id: part.id,
      netsuite_item_id: part.netsuite_id,
      item_number: part.item_number,
      description: part.display_name || part.description || part.item_number,
      quantity: 1,
      unit_price: part.sales_price || 0,
      labor_hours: part.labor_hours || 0,
      is_custom: false,
    };
    setLines(prev => [...prev, line]);
    setPartSearch('');
    setPartResults([]);
    partSearchRef.current?.focus();
  };

  // ── Add custom line ──
  const addCustomLine = () => {
    const line: LineItem = {
      key: genKey(),
      part_id: null,
      netsuite_item_id: null,
      item_number: '',
      description: '',
      quantity: 1,
      unit_price: 0,
      labor_hours: 0,
      is_custom: true,
    };
    setLines(prev => [...prev, line]);
  };

  const updateLine = (key: string, field: keyof LineItem, value: any) => {
    setLines(prev => prev.map(l => l.key === key ? { ...l, [field]: value } : l));
  };

  const removeLine = (key: string) => {
    setLines(prev => prev.filter(l => l.key !== key));
  };

  // ── Computed totals ──
  const subtotal = lines.reduce((s, l) => s + l.quantity * l.unit_price, 0);
  const autoLaborHours = lines.reduce((s, l) => s + (l.labor_hours * l.quantity), 0);
  const effectiveLaborHours = laborOverride !== null ? laborOverride : autoLaborHours;
  const laborTotal = effectiveLaborHours * laborRate;
  const taxableAmount = subtotal; // Tax on parts/materials only, not labor
  const taxAmount = taxExempt ? 0 : taxableAmount * taxRate;
  const grandTotal = subtotal + laborTotal + taxAmount;

  // ── Save estimate ──
  const saveEstimate = async (status: string = 'draft') => {
    setSaving(true);
    try {
      const body = {
        id: editingId || undefined,
        customer_id: customerId,
        customer_name: customerName,
        customer_netsuite_id: customerNsId,
        title, notes, status,
        tax_rate: taxRate,
        tax_exempt: taxExempt,
        labor_rate: laborRate,
        labor_hours_override: laborOverride,
        line_items: lines.map(l => ({
          part_id: l.part_id,
          netsuite_item_id: l.netsuite_item_id,
          item_number: l.item_number,
          description: l.description,
          quantity: l.quantity,
          unit_price: l.unit_price,
          labor_hours: l.labor_hours,
          is_custom: l.is_custom,
        })),
        created_by: user?.id,
      };

      const res = await fetch('/api/estimates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data = await res.json();
      if (data.success) {
        if (!editingId) setEditingId(data.id);
        await loadEstimates();
      } else {
        alert('Save failed: ' + (data.error || 'Unknown error'));
      }
    } catch (err) {
      alert('Network error — please try again');
    }
    setSaving(false);
  };

  // ── Push to NetSuite (initial push or sync update) ──
  const pushToNetSuite = async (isSync: boolean = false) => {
    if (!editingId) {
      alert('Please save the estimate first');
      return;
    }
    if (!customerNsId) {
      alert('Please select a customer with a NetSuite ID');
      return;
    }
    if (lines.length === 0) {
      alert('Please add at least one line item');
      return;
    }

    const confirmMsg = isSync
      ? 'Sync changes to NetSuite? This will update the existing Estimate in NetSuite.'
      : 'Push this estimate to NetSuite? This will create an Estimate record in NetSuite.';
    if (!window.confirm(confirmMsg)) return;

    // Save first to ensure latest data
    await saveEstimate(isSync ? 'pushed' : 'draft');

    if (isSync) {
      setSyncing(true);
    } else {
      setPushing(true);
    }

    try {
      const res = await fetch('/api/estimates/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ estimateId: editingId, userId: user?.id }),
      });
      const data = await res.json();
      if (data.success) {
        const msg = data.updated
          ? 'Estimate synced to NetSuite!'
          : `Estimate pushed to NetSuite!\nEstimate #: ${data.netsuite_estimate_number || data.netsuite_estimate_id}`;
        alert(msg);
        await loadEstimates();
        resetBuilder();
        setView('list');
      } else {
        alert((isSync ? 'Sync' : 'Push') + ' failed: ' + (data.error || 'Unknown error'));
      }
    } catch {
      alert('Network error — please try again');
    }
    setPushing(false);
    setSyncing(false);
  };

  // ── Open estimate for editing ──
  const openEstimate = async (est: Estimate) => {
    setEditingId(est.id);
    setTitle(est.title || '');
    setNotes(est.notes || '');
    setCustomerId(est.customer_id);
    setCustomerName(est.customer_name || '');
    setCustomerNsId(est.customer_netsuite_id);
    setTaxRate(est.tax_rate || DEFAULT_TAX_RATE);
    setTaxExempt(est.tax_exempt);
    setLaborRate(est.labor_rate || DEFAULT_LABOR_RATE);
    setLaborOverride(est.labor_hours_override);

    // Load line items
    const { data } = await supabase
      .from('estimate_line_items')
      .select('*')
      .eq('estimate_id', est.id)
      .order('sort_order');

    setLines((data || []).map((l: any) => ({
      key: genKey(),
      part_id: l.part_id,
      netsuite_item_id: l.netsuite_item_id,
      item_number: l.item_number || '',
      description: l.description || '',
      quantity: l.quantity || 1,
      unit_price: l.unit_price || 0,
      labor_hours: l.labor_hours || 0,
      is_custom: l.is_custom || false,
    })));

    setView('builder');
  };

  const resetBuilder = () => {
    setEditingId(null);
    setTitle('');
    setNotes('');
    setCustomerId(null);
    setCustomerName('');
    setCustomerNsId(null);
    setTaxRate(DEFAULT_TAX_RATE);
    setTaxExempt(false);
    setLaborRate(DEFAULT_LABOR_RATE);
    setLaborOverride(null);
    setLines([]);
    setPartSearch('');
    setPartResults([]);
    setCustSearch('');
    setCustResults([]);
  };

  const deleteEstimate = async (id: string, hasNsId: boolean = false) => {
    const msg = hasNsId
      ? 'Delete this estimate? This will ALSO delete it from NetSuite. This cannot be undone.'
      : 'Delete this estimate? This cannot be undone.';
    if (!window.confirm(msg)) return;

    setDeleting(true);
    try {
      const res = await fetch('/api/estimates', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      const data = await res.json();
      if (!data.success && data.error) {
        alert('Delete failed: ' + data.error);
      }
    } catch {
      alert('Network error — please try again');
    }
    setDeleting(false);
    await loadEstimates();
  };

  const fmt = (n: number) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '8px 10px', borderRadius: '8px',
    border: '1px solid var(--border)', background: 'var(--input-bg)',
    color: 'var(--text-body)', fontSize: '12px',
  };
  const labelStyle: React.CSSProperties = {
    fontSize: '9px', fontWeight: 700, color: 'var(--text-label)',
    textTransform: 'uppercase', letterSpacing: '0.3px', marginBottom: '3px',
  };

  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: '40px 0' }}>
        <div style={{ width: '36px', height: '36px', border: '3px solid var(--border)', borderTopColor: theme.orange, borderRadius: '50%', margin: '0 auto', animation: 'spin 1s linear infinite' }} />
        <div style={{ color: 'var(--text-label)', marginTop: '12px', fontSize: '13px', fontWeight: 600 }}>Loading estimates...</div>
      </div>
    );
  }

  // ═══════════ LIST VIEW ═══════════
  if (view === 'list') {
    const filteredEstimates = estimates.filter(e => {
      if (!search) return true;
      const s = search.toLowerCase();
      return (
        e.estimate_number?.toLowerCase().includes(s) ||
        e.customer_name?.toLowerCase().includes(s) ||
        e.title?.toLowerCase().includes(s)
      );
    });

    return (
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
          <div style={{ fontSize: '22px', fontWeight: 800 }}>Estimates</div>
          <button
            onClick={() => { resetBuilder(); setView('builder'); }}
            style={{ padding: '8px 14px', borderRadius: '10px', background: theme.orange, color: '#fff', fontWeight: 800, fontSize: '12px', border: 'none', cursor: 'pointer', boxShadow: '0 2px 8px rgba(238,49,32,0.3)' }}
          >
            + New Estimate
          </button>
        </div>

        <input
          placeholder="Search estimates..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ ...inputStyle, marginBottom: '12px', background: 'var(--subtle-bg)', border: '1px solid var(--border)' }}
        />

        {filteredEstimates.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '30px 0', color: 'var(--text-label)', fontSize: '13px' }}>
            {search ? 'No matching estimates.' : 'No estimates yet. Create one to get started.'}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {filteredEstimates.map(est => {
              const statusColor = STATUS_COLORS[est.status] || '#6b7280';
              return (
                <button
                  key={est.id}
                  onClick={() => openEstimate(est)}
                  style={{
                    width: '100%', textAlign: 'left',
                    borderRadius: '12px', overflow: 'hidden',
                    border: `1px solid var(--border)`, background: 'var(--subtle-bg)',
                    padding: '12px', cursor: 'pointer',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '3px' }}>
                        <div style={{ fontSize: '13px', fontWeight: 800, color: 'var(--text-body)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {est.title || est.estimate_number}
                        </div>
                      </div>
                      <div style={{ fontSize: '10px', color: 'var(--text-label)', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                        <span>#{est.estimate_number}</span>
                        {est.customer_name && <span>{est.customer_name}</span>}
                        <span style={{ color: 'var(--text-body)', fontWeight: 700 }}>{fmt(est.grand_total)}</span>
                        <span>{new Date(est.created_at).toLocaleDateString()}</span>
                        {est.netsuite_estimate_number && <span style={{ color: '#a78bfa' }}>NS: {est.netsuite_estimate_number}</span>}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: '4px', alignItems: 'center', flexShrink: 0 }}>
                      <div style={{
                        padding: '4px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
                        background: `${statusColor}18`, border: `1px solid ${statusColor}44`,
                        color: statusColor, whiteSpace: 'nowrap',
                      }}>
                        {STATUS_LABELS[est.status] || est.status}
                      </div>
                      {isAdmin && (
                        <button
                          onClick={(e) => { e.stopPropagation(); deleteEstimate(est.id, !!est.netsuite_estimate_id); }}
                          disabled={deleting}
                          style={{
                            padding: '4px 8px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
                            background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.2)',
                            color: '#f87171', cursor: 'pointer',
                            opacity: deleting ? 0.5 : 1,
                          }}
                        >
                          Del
                        </button>
                      )}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  // ═══════════ BUILDER VIEW ═══════════
  const isPushed = editingId && estimates.find(e => e.id === editingId)?.netsuite_estimate_id;

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
        <button
          onClick={() => { setView('list'); }}
          style={{ background: 'transparent', border: 'none', color: '#60a5fa', fontSize: '13px', fontWeight: 700, cursor: 'pointer' }}
        >
          ← Back to Estimates
        </button>
        <div style={{ fontSize: '10px', color: 'var(--text-label)' }}>
          {editingId ? 'Editing' : 'New Estimate'}
        </div>
      </div>

      {/* Customer Selection */}
      <div style={{ marginBottom: '12px', position: 'relative' }}>
        <div style={labelStyle}>Customer</div>
        {customerName ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div style={{
              flex: 1, padding: '8px 10px', borderRadius: '8px',
              background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.2)',
              color: 'var(--text-body)', fontSize: '12px', fontWeight: 700,
            }}>
              {customerName}
              {customerNsId && <span style={{ color: 'var(--text-label)', fontWeight: 400, marginLeft: '6px' }}>NS #{customerNsId}</span>}
            </div>
            {(
              <button
                onClick={() => { setCustomerId(null); setCustomerName(''); setCustomerNsId(null); setCustSearch(''); }}
                style={{ padding: '6px 10px', borderRadius: '6px', background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.2)', color: '#f87171', fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}
              >
                Change
              </button>
            )}
          </div>
        ) : (
          <div>
            <input
              placeholder="Search customers..."
              value={custSearch}
              onChange={e => { setCustSearch(e.target.value); setShowCustDropdown(true); }}
              onFocus={() => setShowCustDropdown(true)}
              style={inputStyle}
            />
            {showCustDropdown && custResults.length > 0 && (
              <div style={{
                position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50,
                background: 'var(--subtle-bg)', border: '1px solid var(--border)', borderRadius: '8px',
                maxHeight: '200px', overflowY: 'auto', marginTop: '2px',
              }}>
                {custResults.map(c => (
                  <button
                    key={c.id}
                    onClick={() => {
                      setCustomerId(c.id);
                      setCustomerName(c.company_name);
                      setCustomerNsId(c.netsuite_id);
                      setCustSearch('');
                      setShowCustDropdown(false);
                    }}
                    style={{
                      width: '100%', textAlign: 'left', padding: '8px 10px', border: 'none',
                      background: 'transparent', color: 'var(--text-body)', fontSize: '12px',
                      cursor: 'pointer', borderBottom: '1px solid var(--border)',
                    }}
                  >
                    <div style={{ fontWeight: 700 }}>{c.company_name}</div>
                    <div style={{ fontSize: '10px', color: 'var(--text-label)' }}>{c.entity_id} · NS #{c.netsuite_id}</div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Title & Notes */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '12px' }}>
        <div>
          <div style={labelStyle}>Estimate Title</div>
          <input
            style={inputStyle}
            value={title}
            onChange={e => setTitle(e.target.value)}
            placeholder="e.g. Fleet Upfit — 10 Transits"

          />
        </div>
        <div>
          <div style={labelStyle}>Internal Notes</div>
          <input
            style={inputStyle}
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="Notes (not pushed to NS)"

          />
        </div>
      </div>

      {/* ── LINE ITEMS ── */}
      <div style={{ marginBottom: '8px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
          <div style={labelStyle}>Line Items</div>
          {(
            <button
              onClick={addCustomLine}
              style={{ padding: '3px 8px', borderRadius: '5px', fontSize: '10px', fontWeight: 700, background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.2)', color: '#60a5fa', cursor: 'pointer' }}
            >
              + Custom Line
            </button>
          )}
        </div>

        {/* Part search */}
        {(
          <div style={{ position: 'relative', marginBottom: '8px' }}>
            <input
              ref={partSearchRef}
              placeholder="Search parts catalog to add..."
              value={partSearch}
              onChange={e => setPartSearch(e.target.value)}
              style={{ ...inputStyle, background: 'var(--subtle-bg)' }}
            />
            {partResults.length > 0 && (
              <div style={{
                position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50,
                background: 'var(--subtle-bg)', border: '1px solid var(--border)', borderRadius: '8px',
                maxHeight: '250px', overflowY: 'auto', marginTop: '2px',
              }}>
                {partResults.map(p => (
                  <button
                    key={p.id}
                    onClick={() => addPartLine(p)}
                    style={{
                      width: '100%', textAlign: 'left', padding: '8px 10px', border: 'none',
                      background: 'transparent', color: 'var(--text-body)', fontSize: '12px',
                      cursor: 'pointer', borderBottom: '1px solid var(--border)',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <div>
                        <span style={{ fontWeight: 700 }}>{p.item_number}</span>
                        <span style={{ color: 'var(--text-label)', marginLeft: '8px' }}>{p.display_name || p.description}</span>
                      </div>
                      <div style={{ display: 'flex', gap: '10px', flexShrink: 0 }}>
                        <span style={{ color: '#22c55e', fontWeight: 700 }}>{fmt(p.sales_price)}</span>
                        {p.labor_hours > 0 && <span style={{ color: '#fbbf24', fontSize: '10px' }}>{p.labor_hours}h labor</span>}
                        <span style={{ color: 'var(--text-label)', fontSize: '10px', textTransform: 'uppercase' }}>{p.catalog}</span>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Line item rows */}
        {lines.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '20px', color: 'var(--text-label)', fontSize: '12px', border: '1px dashed var(--border)', borderRadius: '8px' }}>
            Search for parts above or add a custom line item
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {/* Header row */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr 60px 80px 80px 60px 30px', gap: '4px', padding: '4px 0', fontSize: '9px', fontWeight: 700, color: 'var(--text-label)', textTransform: 'uppercase' }}>
              <div onClick={() => toggleEstSort('item_number')} style={{ cursor: 'pointer', color: estSortCol === 'item_number' ? '#60a5fa' : undefined }}>Item #{estSortIndicator('item_number')}</div>
              <div>Description</div>
              <div onClick={() => toggleEstSort('quantity')} style={{ textAlign: 'center', cursor: 'pointer', color: estSortCol === 'quantity' ? '#60a5fa' : undefined }}>Qty{estSortIndicator('quantity')}</div>
              <div onClick={() => toggleEstSort('unit_price')} style={{ textAlign: 'right', cursor: 'pointer', color: estSortCol === 'unit_price' ? '#60a5fa' : undefined }}>Price{estSortIndicator('unit_price')}</div>
              <div style={{ textAlign: 'right' }}>Total</div>
              <div onClick={() => toggleEstSort('labor_hours')} style={{ textAlign: 'center', cursor: 'pointer', color: estSortCol === 'labor_hours' ? '#60a5fa' : undefined }}>Labor{estSortIndicator('labor_hours')}</div>
              <div></div>
            </div>

            {sortedLines.map(line => (
              <div
                key={line.key}
                style={{
                  display: 'grid', gridTemplateColumns: '1fr 2fr 60px 80px 80px 60px 30px',
                  gap: '4px', alignItems: 'center',
                  padding: '6px 0', borderBottom: '1px solid var(--border)',
                }}
              >
                {line.is_custom ? (
                  <input
                    style={{ ...inputStyle, padding: '4px 6px', fontSize: '11px' }}
                    value={line.item_number}
                    onChange={e => updateLine(line.key, 'item_number', e.target.value)}
                    placeholder="Item #"
                  />
                ) : (
                  <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-body)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {line.item_number}
                    {line.is_custom && <span style={{ color: '#fbbf24', fontSize: '9px', marginLeft: '4px' }}>CUSTOM</span>}
                  </div>
                )}

                {line.is_custom ? (
                  <input
                    style={{ ...inputStyle, padding: '4px 6px', fontSize: '11px' }}
                    value={line.description}
                    onChange={e => updateLine(line.key, 'description', e.target.value)}
                    placeholder="Description"
                  />
                ) : (
                  <div style={{ fontSize: '11px', color: 'var(--text-body)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{line.description}</div>
                )}

                <input
                  type="number"
                  style={{ ...inputStyle, padding: '4px 6px', fontSize: '11px', textAlign: 'center' }}
                  value={line.quantity}
                  onChange={e => updateLine(line.key, 'quantity', parseFloat(e.target.value) || 0)}
      
                  min={0}
                />

                <input
                  type="number"
                  style={{ ...inputStyle, padding: '4px 6px', fontSize: '11px', textAlign: 'right' }}
                  value={line.unit_price}
                  onChange={e => updateLine(line.key, 'unit_price', parseFloat(e.target.value) || 0)}
      
                  step={0.01}
                />

                <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-body)', textAlign: 'right' }}>
                  {fmt(line.quantity * line.unit_price)}
                </div>

                <div style={{ fontSize: '10px', color: line.labor_hours > 0 ? '#fbbf24' : 'var(--text-label)', textAlign: 'center' }}>
                  {line.labor_hours > 0 ? `${(line.labor_hours * line.quantity).toFixed(1)}h` : '—'}
                </div>

                {(
                  <button
                    onClick={() => removeLine(line.key)}
                    style={{ background: 'transparent', border: 'none', color: '#f87171', fontSize: '14px', cursor: 'pointer', padding: '2px' }}
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── LABOR & TAX SECTION ── */}
      <div style={{
        background: 'var(--subtle-bg)', border: '1px solid var(--border)', borderRadius: '10px',
        padding: '12px', marginBottom: '12px',
      }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px', marginBottom: '10px' }}>
          <div>
            <div style={labelStyle}>Labor Rate ($/hr)</div>
            <input
              type="number"
              style={inputStyle}
              value={laborRate}
              onChange={e => setLaborRate(parseFloat(e.target.value) || 0)}
  
              step={0.01}
            />
          </div>
          <div>
            <div style={labelStyle}>Auto Labor Hours</div>
            <div style={{ padding: '8px 10px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: '#fbbf24', fontSize: '12px', fontWeight: 700 }}>
              {autoLaborHours.toFixed(1)}h
              <span style={{ color: 'var(--text-label)', fontWeight: 400, fontSize: '10px', marginLeft: '4px' }}>(from parts)</span>
            </div>
          </div>
          <div>
            <div style={labelStyle}>Labor Override</div>
            <input
              type="number"
              style={inputStyle}
              value={laborOverride ?? ''}
              onChange={e => {
                const v = e.target.value;
                setLaborOverride(v === '' ? null : parseFloat(v) || 0);
              }}
              placeholder={autoLaborHours.toFixed(1)}
  
              step={0.1}
            />
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '10px' }}>
          <div style={{ flex: 1 }}>
            <div style={labelStyle}>Tax Rate</div>
            <input
              type="number"
              style={inputStyle}
              value={(taxRate * 100).toFixed(2)}
              onChange={e => setTaxRate((parseFloat(e.target.value) || 0) / 100)}
  
              step={0.01}
            />
          </div>
          <div style={{ paddingTop: '14px' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={taxExempt}
                onChange={e => setTaxExempt(e.target.checked)}


                style={{ width: '16px', height: '16px', accentColor: theme.orange }}
              />
              <span style={{ fontSize: '12px', fontWeight: 700, color: taxExempt ? '#22c55e' : 'var(--text-label)' }}>
                Tax Exempt
              </span>
            </label>
          </div>
        </div>

        {/* Totals */}
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: '10px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: 'var(--text-body)', marginBottom: '4px' }}>
            <span>Parts Subtotal</span>
            <span>{fmt(subtotal)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: '#fbbf24', marginBottom: '4px' }}>
            <span>Labor ({effectiveLaborHours.toFixed(1)}h × {fmt(laborRate)}/hr)</span>
            <span>{fmt(laborTotal)}</span>
          </div>
          {!taxExempt && (
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: 'var(--text-body)', marginBottom: '4px' }}>
              <span>Sales Tax on Parts ({(taxRate * 100).toFixed(2)}%)</span>
              <span>{fmt(taxAmount)}</span>
            </div>
          )}
          {taxExempt && (
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: '#22c55e', marginBottom: '4px' }}>
              <span>Tax Exempt</span>
              <span>{fmt(0)}</span>
            </div>
          )}
          <div style={{
            display: 'flex', justifyContent: 'space-between', fontSize: '16px', fontWeight: 800,
            color: 'var(--text-body)', borderTop: '1px solid var(--border)', paddingTop: '8px', marginTop: '4px',
          }}>
            <span>Total</span>
            <span>{fmt(grandTotal)}</span>
          </div>
        </div>
      </div>

      {/* ── ACTION BUTTONS ── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        {/* NS status banner for pushed estimates */}
        {isPushed && (
          <div style={{
            padding: '10px 14px', borderRadius: '10px',
            background: 'rgba(167,139,250,0.08)', border: '1px solid rgba(167,139,250,0.2)',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          }}>
            <div>
              <div style={{ fontSize: '12px', fontWeight: 700, color: '#a78bfa' }}>
                Pushed to NetSuite
              </div>
              <div style={{ fontSize: '10px', color: 'var(--text-label)' }}>
                NS Estimate #: {estimates.find(e => e.id === editingId)?.netsuite_estimate_number || 'N/A'}
              </div>
            </div>
            <div style={{ fontSize: '10px', color: 'var(--text-label)' }}>
              Edit below &amp; sync changes
            </div>
          </div>
        )}

        <div style={{ display: 'flex', gap: '6px' }}>
          <button
            onClick={() => saveEstimate(isPushed ? 'pushed' : 'draft')}
            disabled={saving}
            style={{
              flex: 1, padding: '12px', borderRadius: '10px',
              background: saving ? 'var(--subtle-bg)' : '#22c55e',
              color: '#fff', fontWeight: 800, fontSize: '13px', border: 'none', cursor: 'pointer',
              opacity: saving ? 0.5 : 1,
            }}
          >
            {saving ? 'Saving...' : (editingId ? 'Save Changes' : 'Save Draft')}
          </button>
          <button
            onClick={() => { setView('list'); }}
            style={{
              padding: '12px 20px', borderRadius: '10px',
              background: 'transparent', border: '1px solid var(--border)',
              color: 'var(--text-body)', fontWeight: 700, fontSize: '13px', cursor: 'pointer',
            }}
          >
            Cancel
          </button>
        </div>

        {/* Push or Sync to NetSuite */}
        {editingId && customerNsId && lines.length > 0 && (
          <button
            onClick={() => pushToNetSuite(!!isPushed)}
            disabled={pushing || syncing}
            style={{
              width: '100%', padding: '12px', borderRadius: '10px',
              background: (pushing || syncing) ? 'var(--subtle-bg)' : 'rgba(167,139,250,0.15)',
              border: '1px solid rgba(167,139,250,0.3)',
              color: '#a78bfa', fontWeight: 800, fontSize: '13px', cursor: 'pointer',
              opacity: (pushing || syncing) ? 0.5 : 1,
            }}
          >
            {pushing ? 'Pushing to NetSuite...' : syncing ? 'Syncing to NetSuite...' : isPushed ? 'Sync Changes to NetSuite' : 'Push to NetSuite as Estimate'}
          </button>
        )}

        {/* Delete — only for saved estimates */}
        {editingId && isAdmin && (
          <button
            onClick={() => deleteEstimate(editingId, !!isPushed)}
            disabled={deleting}
            style={{
              width: '100%', padding: '10px', borderRadius: '10px',
              background: deleting ? 'var(--subtle-bg)' : 'rgba(248,113,113,0.08)',
              border: '1px solid rgba(248,113,113,0.2)',
              color: '#f87171', fontWeight: 700, fontSize: '12px', cursor: 'pointer',
              opacity: deleting ? 0.5 : 1,
            }}
          >
            {deleting ? 'Deleting...' : isPushed ? '🗑️ Delete Estimate (Supabase + NetSuite)' : '🗑️ Delete Estimate'}
          </button>
        )}
      </div>
    </div>
  );
}
