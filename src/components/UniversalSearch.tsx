'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { pathFor, PopoutType } from '@/components/Popout';
import { useAuth } from '@/components/AuthProvider';
import { estimateHeadlineNumber, estimateAltNumber } from '@/lib/estimate-number';

interface UniversalSearchProps {
  open: boolean;
  onClose: () => void;
}

const GROUP_CONFIG: Record<string, { label: string; icon: string; color: string }> = {
  invoices: { label: 'Invoices', icon: '', color: '#34d399' },
  purchase_orders: { label: 'Purchase Orders', icon: '', color: '#60a5fa' },
  vehicles: { label: 'Vehicles', icon: '', color: '#34d399' },
  graphics_jobs: { label: 'Graphics Jobs', icon: '', color: '#a78bfa' },
  estimates: { label: 'Estimates', icon: '', color: '#fbbf24' },
  parts: { label: 'Parts Catalog', icon: '', color: '#f97316' },
  customers: { label: 'Customers', icon: '', color: '#06b6d4' },
  messages: { label: 'Messages', icon: '', color: '#3b82f6' },
  quotes: { label: 'Quotes', icon: '', color: '#8b5cf6' },
};

// Where "View all N →" lands, with the query prefilled — only groups whose
// list page actually applies a search param (deep-link rule: never a dead
// click). Quotes/messages have no searchable list page yet, so their
// headers show the total without a link.
const VIEW_ALL: Record<string, (q: string) => string> = {
  purchase_orders: q => `/admin/pos?q=${encodeURIComponent(q)}`,
  vehicles: q => `/tracking?q=${encodeURIComponent(q)}`,
  graphics_jobs: q => `/graphics?q=${encodeURIComponent(q)}`,
  estimates: q => `/estimates?q=${encodeURIComponent(q)}`,
  parts: q => `/parts?q=${encodeURIComponent(q)}`,
  customers: q => `/admin/prospects?q=${encodeURIComponent(q)}`,
  invoices: q => `/invoices?invoice=${encodeURIComponent(q)}`,
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

function renderResult(group: string, item: any, onSelect: (group: string, item: any) => void, onLogCall?: (item: any) => void) {
  // Tapping a result pops out the shared detail view instead of navigating away.
  const select = () => onSelect(group, item);

  switch (group) {
    case 'invoices': {
      const sourceLabel = item.source === 'po'
        ? `PO #${item.po_number || '?'}`
        : item.source === 'graphics'
          ? (item.job_title || 'Graphics job')
          : `Scan batch${item.po_number ? ` · PO #${item.po_number}` : ''}`;
      return (
        <button key={item.id} onClick={select} style={resultBtnStyle}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
            <span style={titleStyle}>INV #{item.invoice_number}</span>
            {item.date && <span style={{ ...subtitleStyle, fontSize: '10px' }}>{formatDate(item.date)}</span>}
          </div>
          <div style={subtitleStyle}>{item.customer || ''}{item.customer ? ' · ' : ''}{sourceLabel}</div>
        </button>
      );
    }

    case 'purchase_orders': {
      const totalValue = (item.po_line_items || []).reduce((s: number, l: any) => s + (l.quantity * l.unit_price), 0);
      const lineCount = (item.po_line_items || []).length;
      return (
        <button key={item.id} onClick={select} style={resultBtnStyle}>
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
        <button key={item.id} onClick={select} style={resultBtnStyle}>
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
        <button key={item.id} onClick={select} style={resultBtnStyle}>
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
        <button key={item.id} onClick={select} style={resultBtnStyle}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
            <span style={titleStyle}>{estimateHeadlineNumber(item) || 'Estimate'}</span>
            <div>
              <span style={{ ...statusBadge, color: statusColor(item.status) }}>{item.status}</span>
              {item.total > 0 && <span style={valueStyle}>{formatCurrency(item.total)}</span>}
            </div>
          </div>
          <div style={subtitleStyle}>
            {[item.title || '', estimateAltNumber(item), item.created_at ? formatDate(item.created_at) : ''].filter(Boolean).join(' · ')}
          </div>
        </button>
      );

    case 'parts':
      return (
        <button key={item.id} onClick={select} style={resultBtnStyle}>
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
        <div key={item.id} style={{ display: 'flex', alignItems: 'stretch', gap: '6px' }}>
          <button onClick={select} style={{ ...resultBtnStyle, flex: 1 }}>
            <span style={titleStyle}>{item.company_name}</span>
            <div style={subtitleStyle}>
              {[item.contact_name, item.email, item.phone].filter(Boolean).join(' · ')}
            </div>
          </button>
          {onLogCall && (
            <button
              onClick={() => onLogCall(item)}
              title="Log a call against this record without leaving the search"
              style={{
                flex: '0 0 auto', padding: '0 12px', borderRadius: '8px', cursor: 'pointer',
                background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.3)',
                color: '#60a5fa', fontSize: '11px', fontWeight: 700, whiteSpace: 'nowrap',
              }}
            >Log call</button>
          )}
        </div>
      );

    case 'messages':
      return (
        <button key={item.id} onClick={select} style={resultBtnStyle}>
          <div style={{ ...subtitleStyle, fontSize: '12px', color: 'var(--text-secondary)' }}>
            {(item.body || '').length > 120 ? item.body.substring(0, 120) + '...' : item.body}
          </div>
          <div style={{ ...subtitleStyle, fontSize: '10px', marginTop: '2px' }}>{formatDate(item.created_at)}</div>
        </button>
      );

    case 'quotes':
      return (
        <button key={item.id} onClick={select} style={resultBtnStyle}>
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

export default function UniversalSearch({ open, onClose }: UniversalSearchProps) {
  const router = useRouter();
  const { isAdmin, isSales, hasFeature } = useAuth();
  // A "View all" link only renders when the viewer can open its list page —
  // the gated destinations bounce to /home and discard the search otherwise.
  const canViewAll = (group: string): boolean => {
    switch (group) {
      case 'vehicles': return hasFeature('in_shop') || hasFeature('fleet_checkin');
      case 'purchase_orders': return hasFeature('purchase_orders');
      case 'graphics_jobs': return hasFeature('graphics');
      case 'estimates': return hasFeature('estimates');
      case 'parts': return isAdmin || isSales || hasFeature('parts_catalog');
      case 'customers': return hasFeature('prospects');
      case 'invoices': return isAdmin || isSales;
      default: return true;
    }
  };
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Record<string, any[]>>({});
  const [totals, setTotals] = useState<Record<string, number>>({});
  const [searching, setSearching] = useState(false);
  const debounceRef = useRef<NodeJS.Timeout | null>(null);

  // ── One-tap call logging (R6-3) ──────────────────────────────────────
  // The search already answers "who is calling"; this answers "what was
  // the call" in the same overlay, before the note evaporates.
  const [callFor, setCallFor] = useState<any | null>(null);
  const [callForm, setCallForm] = useState({ direction: 'inbound', summary: '', details: '', followUpDate: '' });
  const [callBusy, setCallBusy] = useState(false);
  const [callMsg, setCallMsg] = useState<string | null>(null);

  const openLogCall = useCallback((item: any) => {
    setCallFor(item);
    setCallForm({ direction: 'inbound', summary: '', details: '', followUpDate: '' });
    setCallMsg(null);
  }, []);

  const submitCall = async () => {
    if (!callFor || callBusy || !callForm.summary.trim()) return;
    setCallBusy(true);
    setCallMsg(null);
    try {
      const res = await fetch('/api/prospects/log-call', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prospectId: callFor.id,
          direction: callForm.direction,
          summary: callForm.summary.trim(),
          details: callForm.details.trim() || undefined,
          followUpDate: callForm.followUpDate || undefined,
        }),
      });
      const body = await res.json();
      if (!res.ok) { setCallMsg(body?.error || 'Could not log the call.'); return; }
      setCallMsg('saved');
    } catch (e: any) {
      setCallMsg(e?.message || 'Could not log the call.');
    } finally {
      setCallBusy(false);
    }
  };

  // Tapping a result closes the search and goes straight to the record's own
  // page. It used to stop at the shared popout preview first — a few fields
  // and an "Open full page" button — which was a wasted tap now that every
  // entity here has a real page; customers already skipped it for that reason.
  const openDetail = useCallback((group: string, item: any) => {
    onClose();
    router.push(pathFor(group as PopoutType, item));
  }, [onClose, router]);

  // Focus input when opened
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 100);
      // Reset state
      setQuery('');
      setResults({});
      setTotals({});
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
      setTotals(data.totals || {});
    } catch {
      setResults({});
      setTotals({});
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
          maxHeight: 'calc(100vh / var(--ts))', display: 'flex', flexDirection: 'column',
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
            placeholder="Search POs, invoices, vehicles, jobs, parts, customers..."
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
              <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '4px' }}>POs, invoices, vehicles, graphics jobs, estimates, parts, customers, messages, quotes</div>
            </div>
          )}

          {groupKeys.map((group) => {
            const config = GROUP_CONFIG[group] || { label: group, icon: '', color: 'var(--text-body)' };
            const items = results[group] || [];
            if (items.length === 0) return null;
            const total = totals[group] ?? items.length;
            const hasMore = total > items.length;
            const viewAllUrl = hasMore && VIEW_ALL[group] && canViewAll(group) ? VIEW_ALL[group](query) : null;

            return (
              <div key={group}>
                {/* Group header — true match count; capped lists link to the
                    full, pre-filtered list page. */}
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
                    ({total}{hasMore ? `, showing ${items.length}` : ''})
                  </span>
                  {viewAllUrl && (
                    <button
                      onClick={() => { onClose(); router.push(viewAllUrl); }}
                      style={{
                        marginLeft: 'auto', background: 'transparent', border: 'none',
                        color: config.color, fontSize: '11px', fontWeight: 800, cursor: 'pointer',
                        padding: '2px 4px', whiteSpace: 'nowrap',
                      }}
                    >
                      View all {total} →
                    </button>
                  )}
                </div>

                {/* Group results */}
                {items.map((item: any) => renderResult(group, item, openDetail, group === 'customers' ? openLogCall : undefined))}
              </div>
            );
          })}
        </div>
      </div>

      {/* Log-call sheet (R6-3) — sits over the overlay so the number you
          just found is still on screen while you write what the call was. */}
      {callFor && (
        <div
          onClick={() => setCallFor(null)}
          style={{ position: 'fixed', inset: 0, background: 'var(--overlay)', zIndex: 400, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}
        >
          <div onClick={e => e.stopPropagation()} style={{
            background: 'var(--card)', borderRadius: '14px', padding: '18px', width: '100%', maxWidth: '420px',
            maxHeight: 'calc(88vh / var(--ts))', overflowY: 'auto', boxShadow: '0 8px 30px rgba(0,0,0,0.3)',
          }}>
            <div style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text-primary)' }}>Log a call</div>
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '12px' }}>
              {callFor.company_name}{callFor.phone ? ` · ${callFor.phone}` : ''}
            </div>

            {callMsg === 'saved' ? (
              <>
                <div style={{ background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.35)', color: '#22c55e', borderRadius: '8px', padding: '10px 12px', fontSize: '12.5px', fontWeight: 700, marginBottom: '12px' }}>
                  ✓ Logged to the timeline{callForm.followUpDate ? ` · follow-up set for ${callForm.followUpDate}` : ''}.
                </div>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button
                    onClick={() => { const item = callFor; setCallFor(null); openDetail('customers', item); }}
                    style={{ flex: 1, padding: '10px', borderRadius: '9px', fontSize: '13px', fontWeight: 800, background: '#3b82f6', color: '#fff', border: 'none', cursor: 'pointer' }}
                  >Open record</button>
                  <button onClick={() => setCallFor(null)}
                    style={{ padding: '10px 14px', borderRadius: '9px', fontSize: '13px', fontWeight: 700, background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-body)', cursor: 'pointer' }}
                  >Done</button>
                </div>
              </>
            ) : (
              <>
                <div style={{ display: 'flex', gap: '6px', marginBottom: '10px' }}>
                  {(['inbound', 'outbound'] as const).map(d => (
                    <button key={d} onClick={() => setCallForm(f => ({ ...f, direction: d }))} style={{
                      flex: 1, padding: '7px', borderRadius: '8px', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
                      background: callForm.direction === d ? 'rgba(59,130,246,0.12)' : 'transparent',
                      border: `1px solid ${callForm.direction === d ? 'rgba(59,130,246,0.4)' : 'var(--border)'}`,
                      color: callForm.direction === d ? '#60a5fa' : 'var(--text-muted)',
                    }}>{d === 'inbound' ? 'They called' : 'We called'}</button>
                  ))}
                </div>
                <input
                  autoFocus
                  value={callForm.summary}
                  onChange={e => setCallForm(f => ({ ...f, summary: e.target.value }))}
                  onKeyDown={e => { if (e.key === 'Enter' && callForm.summary.trim()) submitCall(); }}
                  placeholder="One line — what was it about?"
                  maxLength={300}
                  style={{ width: '100%', boxSizing: 'border-box', padding: '10px', borderRadius: '9px', fontSize: '13px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-primary)', marginBottom: '8px' }}
                />
                <textarea
                  value={callForm.details}
                  onChange={e => setCallForm(f => ({ ...f, details: e.target.value }))}
                  placeholder="Details (optional)"
                  rows={3}
                  maxLength={2000}
                  style={{ width: '100%', boxSizing: 'border-box', padding: '10px', borderRadius: '9px', fontSize: '13px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-primary)', resize: 'vertical', fontFamily: 'inherit', marginBottom: '8px' }}
                />
                <div style={{ marginBottom: '12px' }}>
                  <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '3px' }}>Follow up on (optional)</div>
                  <input
                    type="date"
                    value={callForm.followUpDate}
                    onChange={e => setCallForm(f => ({ ...f, followUpDate: e.target.value }))}
                    style={{ padding: '9px 10px', borderRadius: '9px', fontSize: '13px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-primary)' }}
                  />
                </div>
                {callMsg && <div style={{ fontSize: '12px', color: '#ef4444', marginBottom: '10px' }}>{callMsg}</div>}
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button onClick={() => setCallFor(null)}
                    style={{ padding: '10px 14px', borderRadius: '9px', fontSize: '13px', fontWeight: 700, background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-body)', cursor: 'pointer' }}
                  >Cancel</button>
                  <button
                    onClick={submitCall}
                    disabled={callBusy || !callForm.summary.trim()}
                    style={{
                      flex: 1, padding: '10px', borderRadius: '9px', fontSize: '13px', fontWeight: 800, border: 'none',
                      background: callBusy || !callForm.summary.trim() ? 'var(--border)' : '#22c55e',
                      color: callBusy || !callForm.summary.trim() ? 'var(--text-muted)' : '#fff',
                      cursor: callBusy || !callForm.summary.trim() ? 'default' : 'pointer',
                    }}
                  >{callBusy ? 'Saving…' : 'Log call'}</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

    </div>
  );
}
