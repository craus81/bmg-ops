'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';

interface UniversalSearchProps {
  open: boolean;
  onClose: () => void;
}

const GROUP_CONFIG: Record<string, { label: string; icon: string; color: string }> = {
  purchase_orders: { label: 'Purchase Orders', icon: '📋', color: '#60a5fa' },
  vehicles: { label: 'Vehicles', icon: '🚗', color: '#34d399' },
  graphics_jobs: { label: 'Graphics Jobs', icon: '🎨', color: '#a78bfa' },
  estimates: { label: 'Estimates', icon: '💰', color: '#fbbf24' },
  parts: { label: 'Parts Catalog', icon: '🔧', color: '#f97316' },
  customers: { label: 'Customers', icon: '🏢', color: '#06b6d4' },
  messages: { label: 'Messages', icon: '💬', color: '#3b82f6' },
  quotes: { label: 'Quotes', icon: '📊', color: '#8b5cf6' },
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
  if (['complete', 'pushed', 'accepted', 'shipped', 'installed', 'ready'].includes(s)) return '#4ade80';
  if (['cancelled', 'denied', 'rejected', 'expired'].includes(s)) return '#ef4444';
  if (['designing', 'printing', 'cutting', 'packing', 'outgassing'].includes(s)) return '#60a5fa';
  return '#dce6f0';
}

function renderResult(group: string, item: any, router: any, onClose: () => void) {
  const navigate = (path: string) => {
    onClose();
    router.push(path);
  };

  switch (group) {
    case 'purchase_orders': {
      const totalValue = (item.po_line_items || []).reduce((s: number, l: any) => s + (l.quantity * l.unit_price), 0);
      const lineCount = (item.po_line_items || []).length;
      return (
        <button key={item.id} onClick={() => navigate('/admin/pos')} style={resultBtnStyle}>
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
        <button key={item.id} onClick={() => navigate('/fleet')} style={resultBtnStyle}>
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
        <button key={item.id} onClick={() => navigate('/graphics')} style={resultBtnStyle}>
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
        <button key={item.id} onClick={() => navigate('/estimates')} style={resultBtnStyle}>
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
        <button key={item.id} onClick={() => navigate('/admin/pos')} style={resultBtnStyle}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
            <span style={titleStyle}>{item.part_number}</span>
            {item.price > 0 && <span style={valueStyle}>{formatCurrency(item.price)}</span>}
          </div>
          <div style={subtitleStyle}>
            {[item.end_customer, item.vehicle_type, item.graphic_package].filter(Boolean).join(' · ')}
          </div>
        </button>
      );

    case 'customers':
      return (
        <button key={item.id} onClick={() => navigate('/estimates')} style={resultBtnStyle}>
          <span style={titleStyle}>{item.company_name}</span>
          <div style={subtitleStyle}>{item.entity_id ? `ID: ${item.entity_id}` : ''}{item.netsuite_id ? ` · NS: ${item.netsuite_id}` : ''}</div>
        </button>
      );

    case 'messages':
      return (
        <button key={item.id} onClick={() => navigate('/messages')} style={resultBtnStyle}>
          <div style={{ ...subtitleStyle, fontSize: '12px', color: '#c8d6e5' }}>
            {(item.body || '').length > 120 ? item.body.substring(0, 120) + '...' : item.body}
          </div>
          <div style={{ ...subtitleStyle, fontSize: '10px', marginTop: '2px' }}>{formatDate(item.created_at)}</div>
        </button>
      );

    case 'quotes':
      return (
        <button key={item.id} onClick={() => navigate('/admin/quotes')} style={resultBtnStyle}>
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
  background: 'transparent', border: 'none', borderBottom: '1px solid rgba(30,45,61,0.5)',
  cursor: 'pointer', display: 'block',
};

const titleStyle: React.CSSProperties = {
  fontSize: '13px', fontWeight: 700, color: '#f5f8fc',
};

const subtitleStyle: React.CSSProperties = {
  fontSize: '11px', color: '#dce6f0', marginTop: '2px',
};

const statusBadge: React.CSSProperties = {
  fontSize: '10px', fontWeight: 700, marginLeft: '6px', textTransform: 'capitalize' as any,
};

const valueStyle: React.CSSProperties = {
  fontSize: '12px', fontWeight: 700, color: '#60a5fa', marginLeft: '8px',
};

export default function UniversalSearch({ open, onClose }: UniversalSearchProps) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Record<string, any[]>>({});
  const [searching, setSearching] = useState(false);
  const debounceRef = useRef<NodeJS.Timeout | null>(null);

  // Focus input when opened
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 100);
      // Reset state
      setQuery('');
      setResults({});
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
          background: '#0f1720',
        }}
      >
        {/* Search input */}
        <div style={{
          padding: '12px 16px', borderBottom: '1px solid #1e2d3d',
          display: 'flex', alignItems: 'center', gap: '10px',
          position: 'sticky', top: 0, background: '#0f1720', zIndex: 1,
        }}>
          <span style={{ fontSize: '18px', opacity: 0.5 }}>🔍</span>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => handleInput(e.target.value)}
            placeholder="Search POs, vehicles, jobs, parts, customers..."
            style={{
              flex: 1, background: 'transparent', border: 'none', outline: 'none',
              color: '#f5f8fc', fontSize: '16px', fontWeight: 600,
            }}
          />
          {query && (
            <button onClick={() => { setQuery(''); setResults({}); inputRef.current?.focus(); }} style={{
              background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: '50%',
              width: '24px', height: '24px', color: '#dce6f0', fontSize: '12px',
              cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>✕</button>
          )}
          <button onClick={onClose} style={{
            background: 'transparent', border: '1px solid #1e2d3d', borderRadius: '6px',
            padding: '4px 10px', color: '#dce6f0', fontSize: '11px', fontWeight: 700,
            cursor: 'pointer',
          }}>ESC</button>
        </div>

        {/* Results */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {searching && (
            <div style={{ padding: '32px', textAlign: 'center', color: '#e8f0f8', fontSize: '13px' }}>
              Searching...
            </div>
          )}

          {!searching && query.length >= 2 && totalResults === 0 && (
            <div style={{ padding: '40px 20px', textAlign: 'center' }}>
              <div style={{ fontSize: '32px', opacity: 0.3, marginBottom: '8px' }}>🔍</div>
              <div style={{ fontSize: '14px', fontWeight: 700, color: '#e8f0f8' }}>No results found</div>
              <div style={{ fontSize: '12px', color: '#3a4a5d', marginTop: '4px' }}>Try a different search term</div>
            </div>
          )}

          {!searching && query.length < 2 && (
            <div style={{ padding: '40px 20px', textAlign: 'center' }}>
              <div style={{ fontSize: '32px', opacity: 0.3, marginBottom: '8px' }}>🔍</div>
              <div style={{ fontSize: '14px', fontWeight: 700, color: '#e8f0f8' }}>Search everything</div>
              <div style={{ fontSize: '12px', color: '#3a4a5d', marginTop: '4px' }}>POs, vehicles, graphics jobs, estimates, parts, customers, messages, quotes</div>
            </div>
          )}

          {groupKeys.map((group) => {
            const config = GROUP_CONFIG[group] || { label: group, icon: '📄', color: '#dce6f0' };
            const items = results[group] || [];
            if (items.length === 0) return null;

            return (
              <div key={group}>
                {/* Group header */}
                <div style={{
                  padding: '10px 14px 6px', display: 'flex', alignItems: 'center', gap: '6px',
                  position: 'sticky', top: 0, background: '#0f1720', zIndex: 1,
                  borderBottom: '1px solid rgba(30,45,61,0.3)',
                }}>
                  <span style={{ fontSize: '14px' }}>{config.icon}</span>
                  <span style={{ fontSize: '11px', fontWeight: 800, color: config.color, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                    {config.label}
                  </span>
                  <span style={{ fontSize: '10px', color: '#e8f0f8', fontWeight: 600 }}>
                    ({items.length})
                  </span>
                </div>

                {/* Group results */}
                {items.map((item: any) => renderResult(group, item, router, onClose))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
