'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';

interface UniversalSearchProps {
  open: boolean;
  onClose: () => void;
}

const GROUP_CONFIG: Record<string, { label: string; icon: string; color: string }> = {
  purchase_orders: { label: 'Purchase Orders', icon: '', color: '#60a5fa' },
  vehicles: { label: 'Vehicles', icon: '', color: '#34d399' },
  graphics_jobs: { label: 'Graphics Jobs', icon: '', color: '#a78bfa' },
  estimates: { label: 'Estimates', icon: '', color: '#fbbf24' },
  parts: { label: 'Parts Catalog', icon: '', color: '#f97316' },
  customers: { label: 'Customers', icon: '', color: '#06b6d4' },
  messages: { label: 'Messages', icon: '', color: '#3b82f6' },
  quotes: { label: 'Quotes', icon: '', color: '#8b5cf6' },
};

function formatDate(dateStr: string) {
  if (!dateStr) return '';
  const d = new Date(dateStr.includes('T') ? dateStr : dateStr + 'T00:00:00');
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatCurrency(val: number) {
  return '$' + (val || 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function statusColor(status: string): string {
  const s = (status || '').toLowerCase();
  if (['open', 'draft', 'pending', 'flagged', 'received'].includes(s)) return '#fbbf24';
  if (['complete', 'pushed', 'accepted', 'shipped', 'picked_up', 'installed', 'ready'].includes(s)) return '#4ade80';
  if (['cancelled', 'denied', 'rejected', 'expired'].includes(s)) return '#ef4444';
  if (['designing', 'printing', 'cutting', 'packing', 'outgassing'].includes(s)) return '#60a5fa';
  return 'var(--text-body)';
}

// Full-page deep-link path for a result (used by the "Open full page" action).
function pathFor(group: string, item: any): string {
  switch (group) {
    case 'purchase_orders': return `/admin/pos?id=${item.id}`;
    case 'vehicles': return `/tracking?vehicle=${item.id}`;
    case 'graphics_jobs': return `/graphics?id=${item.id}`;
    case 'estimates': return `/estimates?id=${item.id}`;
    case 'parts': return `/parts?catalog=${item.catalog || 'upfit'}&q=${encodeURIComponent(item.part_number)}`;
    case 'customers': return `/admin/prospects?id=${item.id}`;
    case 'messages': return `/messages?conversation=${item.conversation_id}`;
    case 'quotes': return `/admin/quotes?id=${item.id}`;
    default: return '/';
  }
}

function renderResult(group: string, item: any, onSelect: (group: string, item: any) => void) {
  // Tapping a result pops out an in-place detail view instead of navigating away.
  const navigate = (_path?: string) => { void _path; onSelect(group, item); };

  switch (group) {
    case 'purchase_orders': {
      const totalValue = (item.po_line_items || []).reduce((s: number, l: any) => s + (l.quantity * l.unit_price), 0);
      const lineCount = (item.po_line_items || []).length;
      return (
        <button key={item.id} onClick={() => navigate(`/admin/pos?id=${item.id}`)} style={resultBtnStyle}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
            <div>
              <span style={titleStyle}>PO #{item.po_number}</span>
              <span style={{ ...statusBadge, color: statusColor(item.status) }}>{item.status}</span>
            </div>
            {totalValue > 0 && <span style={valueStyle}>{formatCurrency(totalValue)}</span>}
          </div>
          <div style={subtitleStyle}>
            {item.customer}{lineCount > 0 ? ` · ${lineCount} items` : ''}{item.ordered_date ? ` · ${formatDate(item.ordered_date)}` : ''}
          </div>
          {item.ship_to?.city && (
            <div style={{ ...subtitleStyle, fontSize: '10px' }}>Ship To: {item.ship_to.name || ''} {item.ship_to.city}, {item.ship_to.state}</div>
          )}
        </button>
      );
    }

    case 'vehicles':
      return (
        <button key={item.id} onClick={() => navigate(`/tracking?vehicle=${item.id}`)} style={resultBtnStyle}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
            <span style={titleStyle}>{item.vehicle_year} {item.vehicle_make} {item.vehicle_model}</span>
            <span style={{ ...statusBadge, color: statusColor(item.status) }}>{item.status}</span>
          </div>
          <div style={subtitleStyle}>
            VIN: {item.vin}{item.customer_name ? ` · ${item.customer_name}` : ''}{item.sales_order_number ? ` · SO ${item.sales_order_number}` : ''}
          </div>
        </button>
      );

    case 'graphics_jobs':
      return (
        <button key={item.id} onClick={() => navigate(`/graphics?id=${item.id}`)} style={resultBtnStyle}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
            <span style={titleStyle}>{item.job_number ? `#${item.job_number} ` : ''}{item.title || item.part_number}</span>
            <span style={{ ...statusBadge, color: statusColor(item.status) }}>{item.status}</span>
          </div>
          <div style={subtitleStyle}>
            {item.customer}{item.part_number ? ` · ${item.part_number}` : ''}{item.due_date ? ` · Due ${formatDate(item.due_date)}` : ''}
          </div>
        </button>
      );

    case 'estimates':
      return (
        <button key={item.id} onClick={() => navigate(`/estimates?id=${item.id}`)} style={resultBtnStyle}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
            <span style={titleStyle}>{item.estimate_number || 'Estimate'}</span>
            <div>
              <span style={{ ...statusBadge, color: statusColor(item.status) }}>{item.status}</span>
              {item.total > 0 && <span style={valueStyle}>{formatCurrency(item.total)}</span>}
            </div>
          </div>
          <div style={subtitleStyle}>{item.title || ''}{item.created_at ? ` · ${formatDate(item.created_at)}` : ''}</div>
        </button>
      );

    case 'parts':
      return (
        <button key={item.id} onClick={() => navigate(`/parts?catalog=${item.catalog || 'upfit'}&q=${encodeURIComponent(item.part_number)}`)} style={resultBtnStyle}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
            <span style={titleStyle}>{item.part_number}</span>
            {item.price > 0 && <span style={valueStyle}>{formatCurrency(item.price)}</span>}
          </div>
          <div style={subtitleStyle}>
            {[item.end_customer, item.vehicle_type, item.graphic_package].filter(Boolean).join(' · ') || item.display_name || ''}
          </div>
        </button>
      );

    case 'customers':
      return (
        <button key={item.id} onClick={() => navigate(`/admin/prospects?id=${item.id}`)} style={resultBtnStyle}>
          <span style={titleStyle}>{item.company_name}</span>
          <div style={subtitleStyle}>
            {item.contact_name || ''}{item.email ? ` · ${item.email}` : ''}{item.status === 'converted' ? ' · Customer' : item.status === 'active' ? ' · Prospect' : ''}
          </div>
        </button>
      );

    case 'messages':
      return (
        <button key={item.id} onClick={() => navigate(`/messages?conversation=${item.conversation_id}`)} style={resultBtnStyle}>
          <div style={{ ...subtitleStyle, fontSize: '12px', color: 'var(--text-secondary)' }}>
            {(item.body || '').length > 120 ? item.body.substring(0, 120) + '...' : item.body}
          </div>
          <div style={{ ...subtitleStyle, fontSize: '10px', marginTop: '2px' }}>{formatDate(item.created_at)}</div>
        </button>
      );

    case 'quotes':
      return (
        <button key={item.id} onClick={() => navigate(`/admin/quotes?id=${item.id}`)} style={resultBtnStyle}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
            <span style={titleStyle}>{item.quote_number}</span>
            <div>
              <span style={{ ...statusBadge, color: statusColor(item.status) }}>{item.status}</span>
              {item.total_price > 0 && <span style={valueStyle}>{formatCurrency(item.total_price)}</span>}
            </div>
          </div>
          <div style={subtitleStyle}>{item.customer_name}{item.vehicle_description ? ` · ${item.vehicle_description}` : ''}</div>
        </button>
      );

    default:
      return null;
  }
}

// Styles
const resultBtnStyle: React.CSSProperties = {
  width: '100%', textAlign: 'left', padding: '10px 14px',
  background: 'transparent', border: 'none', borderBottom: '1px solid rgba(var(--border-rgb),0.5)',
  cursor: 'pointer', display: 'block',
};

const titleStyle: React.CSSProperties = {
  fontSize: '13px', fontWeight: 700, color: 'var(--text-body)',
};

const subtitleStyle: React.CSSProperties = {
  fontSize: '11px', color: 'var(--text-body)', marginTop: '2px',
};

const statusBadge: React.CSSProperties = {
  fontSize: '10px', fontWeight: 700, marginLeft: '6px', textTransform: 'capitalize' as any,
};

const valueStyle: React.CSSProperties = {
  fontSize: '12px', fontWeight: 700, color: '#60a5fa', marginLeft: '8px',
};

// Detail body for the pop-out view, per result type.
function detailRow(label: string, value: any) {
  if (value === null || value === undefined || value === '') return null;
  return (
    <div key={label} style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', padding: '8px 0', borderBottom: '1px solid rgba(var(--border-rgb),0.4)' }}>
      <span style={{ fontSize: '11px', color: 'var(--text-label)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.3px' }}>{label}</span>
      <span style={{ fontSize: '13px', color: 'var(--text-body)', fontWeight: 600, textAlign: 'right' }}>{value}</span>
    </div>
  );
}

function renderDetail(group: string, item: any) {
  switch (group) {
    case 'purchase_orders': {
      const lines = item.po_line_items || [];
      const total = lines.reduce((s: number, l: any) => s + (l.quantity * l.unit_price), 0);
      return (
        <div>
          {detailRow('PO #', item.po_number)}
          {detailRow('Status', item.status)}
          {detailRow('Customer', item.customer)}
          {detailRow('Ordered', item.ordered_date ? formatDate(item.ordered_date) : null)}
          {item.ship_to?.city && detailRow('Ship To', `${item.ship_to.name ? item.ship_to.name + ' · ' : ''}${item.ship_to.city}, ${item.ship_to.state || ''}`)}
          {lines.length > 0 && (
            <div style={{ marginTop: '12px' }}>
              <div style={{ fontSize: '11px', color: 'var(--text-label)', fontWeight: 800, textTransform: 'uppercase', marginBottom: '4px' }}>Line Items ({lines.length})</div>
              {lines.map((l: any) => (
                <div key={l.id} style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', padding: '7px 0', borderBottom: '1px solid rgba(var(--border-rgb),0.3)' }}>
                  <div>
                    <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-body)' }}>{l.part_number}</div>
                    {l.description && <div style={{ fontSize: '10px', color: 'var(--text-label)' }}>{l.description}</div>}
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--text-body)', whiteSpace: 'nowrap' }}>{l.quantity} × {formatCurrency(l.unit_price)}</div>
                </div>
              ))}
              {total > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0 0' }}>
                  <span style={{ fontSize: '12px', color: 'var(--text-label)', fontWeight: 800 }}>TOTAL</span>
                  <span style={{ fontSize: '14px', color: '#60a5fa', fontWeight: 800 }}>{formatCurrency(total)}</span>
                </div>
              )}
            </div>
          )}
        </div>
      );
    }
    case 'parts':
      return (
        <div>
          {detailRow('Part #', item.part_number)}
          {detailRow('Name', item.display_name)}
          {detailRow('Price', item.price > 0 ? formatCurrency(item.price) : null)}
          {detailRow('Customer', item.end_customer)}
          {detailRow('Vehicle', item.vehicle_type)}
          {detailRow('Package', item.graphic_package)}
          {detailRow('Catalog', item.catalog)}
        </div>
      );
    case 'vehicles':
      return (
        <div>
          {detailRow('Vehicle', `${item.vehicle_year || ''} ${item.vehicle_make || ''} ${item.vehicle_model || ''}`.trim())}
          {detailRow('VIN', item.vin)}
          {detailRow('Customer', item.customer_name)}
          {detailRow('Sales Order', item.sales_order_number)}
          {detailRow('Status', item.status)}
        </div>
      );
    case 'graphics_jobs':
      return (
        <div>
          {detailRow('Job #', item.job_number)}
          {detailRow('Title', item.title)}
          {detailRow('Customer', item.customer)}
          {detailRow('Part #', item.part_number)}
          {detailRow('Status', item.status)}
          {detailRow('Due', item.due_date ? formatDate(item.due_date) : null)}
        </div>
      );
    case 'estimates':
      return (
        <div>
          {detailRow('Estimate #', item.estimate_number)}
          {detailRow('Title', item.title)}
          {detailRow('Status', item.status)}
          {detailRow('Total', item.total > 0 ? formatCurrency(item.total) : null)}
        </div>
      );
    case 'customers':
      return (
        <div>
          {detailRow('Company', item.company_name)}
          {detailRow('Contact', item.contact_name)}
          {detailRow('Email', item.email)}
          {detailRow('Phone', item.phone)}
          {detailRow('Status', item.status)}
        </div>
      );
    case 'messages':
      return (
        <div>
          <div style={{ fontSize: '13px', color: 'var(--text-body)', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{item.body}</div>
          <div style={{ fontSize: '11px', color: 'var(--text-label)', marginTop: '8px' }}>{formatDate(item.created_at)}</div>
        </div>
      );
    case 'quotes':
      return (
        <div>
          {detailRow('Quote #', item.quote_number)}
          {detailRow('Customer', item.customer_name)}
          {detailRow('Vehicle', item.vehicle_description)}
          {detailRow('Status', item.status)}
          {detailRow('Total', item.total_price > 0 ? formatCurrency(item.total_price) : null)}
        </div>
      );
    default:
      return null;
  }
}

export default function UniversalSearch({ open, onClose }: UniversalSearchProps) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Record<string, any[]>>({});
  const [searching, setSearching] = useState(false);
  const [detail, setDetail] = useState<{ group: string; item: any } | null>(null);
  const openDetail = useCallback((group: string, item: any) => setDetail({ group, item }), []);
  const debounceRef = useRef<NodeJS.Timeout | null>(null);

  // Focus input when opened
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 100);
      // Reset state
      setQuery('');
      setResults({});
      setDetail(null);
    }
  }, [open]);

  // Close on Escape
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    if (open) document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open, onClose]);

  const doSearch = useCallback(async (q: string) => {
    if (q.length < 2) {
      setResults({});
      setSearching(false);
      return;
    }

    setSearching(true);
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      setResults(data.results || {});
    } catch {
      setResults({});
    } finally {
      setSearching(false);
    }
  }, []);

  const handleInput = (val: string) => {
    setQuery(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => doSearch(val), 300);
  };

  if (!open) return null;

  const groupKeys = Object.keys(results);
  const totalResults = groupKeys.reduce((sum, k) => sum + (results[k]?.length || 0), 0);

  return (
    <>
    <div style={{
      position: 'fixed', inset: 0, zIndex: 300,
      background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(6px)',
      display: 'flex', flexDirection: 'column',
    }} onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: '500px', margin: '0 auto',
          maxHeight: '100vh', display: 'flex', flexDirection: 'column',
          background: 'var(--bg)',
        }}
      >
        {/* Search input */}
        <div style={{
          padding: '12px 16px', borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', gap: '10px',
          position: 'sticky', top: 0, background: 'var(--bg)', zIndex: 1,
        }}>
          <span style={{ fontSize: '14px', opacity: 0.5, fontWeight: 700 }}>Search</span>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => handleInput(e.target.value)}
            placeholder="Search POs, vehicles, jobs, parts, prospects..."
            style={{
              flex: 1, background: 'transparent', border: 'none', outline: 'none',
              color: 'var(--text-body)', fontSize: '16px', fontWeight: 600,
            }}
          />
          {query && (
            <button onClick={() => { setQuery(''); setResults({}); inputRef.current?.focus(); }} style={{
              background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: '50%',
              width: '24px', height: '24px', color: 'var(--text-body)', fontSize: '12px',
              cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>✕</button>
          )}
          <button onClick={onClose} style={{
            background: 'transparent', border: '1px solid var(--border)', borderRadius: '6px',
            padding: '4px 10px', color: 'var(--text-body)', fontSize: '11px', fontWeight: 700,
            cursor: 'pointer',
          }}>ESC</button>
        </div>

        {/* Results */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {searching && (
            <div style={{ padding: '32px', textAlign: 'center', color: 'var(--text-label)', fontSize: '13px' }}>
              Searching...
            </div>
          )}

          {!searching && query.length >= 2 && totalResults === 0 && (
            <div style={{ padding: '40px 20px', textAlign: 'center' }}>
              <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-label)' }}>No results found</div>
              <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '4px' }}>Try a different search term</div>
            </div>
          )}

          {!searching && query.length < 2 && (
            <div style={{ padding: '40px 20px', textAlign: 'center' }}>
              <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-label)' }}>Search everything</div>
              <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '4px' }}>POs, vehicles, graphics jobs, estimates, parts, customers, messages, quotes</div>
            </div>
          )}

          {groupKeys.map((group) => {
            const config = GROUP_CONFIG[group] || { label: group, icon: '', color: 'var(--text-body)' };
            const items = results[group] || [];
            if (items.length === 0) return null;

            return (
              <div key={group}>
                {/* Group header */}
                <div style={{
                  padding: '10px 14px 6px', display: 'flex', alignItems: 'center', gap: '6px',
                  position: 'sticky', top: 0, background: 'var(--bg)', zIndex: 1,
                  borderBottom: '1px solid rgba(var(--border-rgb),0.3)',
                }}>
                  <span style={{ fontSize: '14px' }}>{config.icon}</span>
                  <span style={{ fontSize: '11px', fontWeight: 800, color: config.color, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                    {config.label}
                  </span>
                  <span style={{ fontSize: '10px', color: 'var(--text-label)', fontWeight: 600 }}>
                    ({items.length})
                  </span>
                </div>

                {/* Group results */}
                {items.map((item: any) => renderResult(group, item, openDetail))}
              </div>
            );
          })}
        </div>
      </div>
    </div>

    {detail && (
      <div
        style={{ position: 'fixed', inset: 0, zIndex: 310, background: 'rgba(0,0,0,0.8)', backdropFilter: 'blur(6px)', display: 'flex', flexDirection: 'column', padding: '16px' }}
        onClick={() => setDetail(null)}
      >
        <div
          onClick={(e) => e.stopPropagation()}
          style={{ width: '100%', maxWidth: '500px', margin: 'auto', maxHeight: '90vh', display: 'flex', flexDirection: 'column', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '14px', overflow: 'hidden' }}
        >
          <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: '12px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.5px', color: GROUP_CONFIG[detail.group]?.color || 'var(--text-body)' }}>
              {GROUP_CONFIG[detail.group]?.label || detail.group}
            </span>
            <button onClick={() => setDetail(null)} style={{ background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: '50%', width: '26px', height: '26px', color: 'var(--text-body)', fontSize: '13px', cursor: 'pointer' }}>✕</button>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '14px 16px' }}>
            {renderDetail(detail.group, detail.item)}
          </div>
          <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border)' }}>
            <button
              onClick={() => { const p = pathFor(detail.group, detail.item); setDetail(null); onClose(); router.push(p); }}
              style={{ width: '100%', padding: '12px', borderRadius: '10px', background: '#60a5fa', color: '#fff', fontSize: '13px', fontWeight: 800, border: 'none', cursor: 'pointer' }}
            >
              Open full page →
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  );
}
