'use client';

/**
 * App-wide "pop-out" detail view. Any list/card/reference can call
 * usePopout().open(type, idOrItem) to pop a record's details into a modal,
 * with an "Open full page →" button that deep-links to the full screen.
 *
 * Pass an id (string) to fetch the record, or a fully-shaped item object
 * (e.g. from global search) to skip the fetch.
 */

import { createContext, useContext, useState, useCallback, ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';

export type PopoutType =
  | 'purchase_orders'
  | 'vehicles'
  | 'graphics_jobs'
  | 'estimates'
  | 'parts'
  | 'customers'
  | 'messages'
  | 'quotes'
  | 'invoices';

const LABELS: Record<PopoutType, { label: string; color: string }> = {
  invoices: { label: 'Invoice', color: '#34d399' },
  purchase_orders: { label: 'Purchase Order', color: '#60a5fa' },
  vehicles: { label: 'Vehicle', color: '#34d399' },
  graphics_jobs: { label: 'Graphics Job', color: '#a78bfa' },
  estimates: { label: 'Estimate', color: '#fbbf24' },
  parts: { label: 'Part', color: '#f97316' },
  customers: { label: 'Customer', color: '#06b6d4' },
  messages: { label: 'Message', color: '#3b82f6' },
  quotes: { label: 'Quote', color: '#8b5cf6' },
};

function formatDate(dateStr: string) {
  if (!dateStr) return '';
  const d = new Date(dateStr.includes('T') ? dateStr : dateStr + 'T00:00:00');
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatCurrency(val: number) {
  return '$' + (val || 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// Full-page deep-link path for the "Open full page" button.
export function pathFor(type: PopoutType, item: any): string {
  switch (type) {
    case 'purchase_orders': return `/admin/pos?id=${item.id}`;
    case 'vehicles': return `/tracking?vehicle=${item.id}`;
    case 'graphics_jobs': return `/graphics?id=${item.id}`;
    case 'estimates': return `/estimates?id=${item.id}`;
    case 'parts': return `/parts?catalog=${item.catalog || 'upfit'}&q=${encodeURIComponent(item.part_number || '')}`;
    case 'customers': return `/admin/prospects?id=${item.id}`;
    case 'messages': return `/messages?conversation=${item.conversation_id}`;
    case 'quotes': return `/admin/wrap-quote?id=${item.id}`;
    // Invoices live in NetSuite — deep-link to whichever record in the app
    // references this one (PO, graphics job, or the sent-invoices list).
    case 'invoices':
      if (item.po_id) return `/admin/pos?id=${item.po_id}`;
      if (item.job_id) return `/graphics?id=${item.job_id}`;
      return '/invoices?tab=sent';
    default: return '/';
  }
}

// Fetch a record by id and shape it for renderDetail.
async function fetchItem(
  supabase: ReturnType<typeof createClient>,
  type: PopoutType,
  id: string,
): Promise<any | null> {
  switch (type) {
    case 'purchase_orders': {
      const { data } = await supabase
        .from('purchase_orders')
        .select('id, po_number, customer, status, ordered_date, ship_to, po_line_items(id, part_number, description, quantity, unit_price, installed)')
        .eq('id', id).maybeSingle();
      return data;
    }
    case 'vehicles': {
      const { data } = await supabase
        .from('fleet_checkins')
        .select('id, vin, vehicle_year, vehicle_make, vehicle_model, customer_name, sales_order_number, status')
        .eq('id', id).maybeSingle();
      return data;
    }
    case 'graphics_jobs': {
      const { data } = await supabase
        .from('graphics_jobs')
        .select('id, job_number, title, customer, part_number, status, due_date')
        .eq('id', id).maybeSingle();
      return data;
    }
    case 'estimates': {
      const { data } = await supabase
        .from('estimates')
        .select('id, estimate_number, title, status, total')
        .eq('id', id).maybeSingle();
      return data;
    }
    case 'quotes': {
      const { data } = await supabase
        .from('wrap_quotes')
        .select('id, quote_number, customer, vehicle_description, status, total')
        .eq('id', id).maybeSingle();
      if (!data) return null;
      return { ...data, customer_name: (data as any).customer?.name || null, total_price: (data as any).total };
    }
    case 'parts': {
      const { data } = await supabase
        .from('netsuite_parts')
        .select('id, item_number, display_name, sales_price, billable_customer, vehicle_type, graphic_package, catalog')
        .eq('id', id).maybeSingle();
      if (!data) return null;
      return {
        id: data.id, catalog: data.catalog, part_number: data.item_number,
        display_name: data.display_name, price: data.sales_price || 0,
        end_customer: data.billable_customer, vehicle_type: data.vehicle_type,
        graphic_package: data.graphic_package,
      };
    }
    case 'customers': {
      const { data } = await supabase
        .from('prospects')
        .select('id, company_name, contact_name, email, phone, status')
        .eq('id', id).maybeSingle();
      return data;
    }
    case 'messages': {
      const { data } = await supabase
        .from('messages')
        .select('id, conversation_id, body, created_at')
        .eq('id', id).maybeSingle();
      return data;
    }
    default:
      return null;
  }
}

function detailRow(label: string, value: any) {
  if (value === null || value === undefined || value === '') return null;
  return (
    <div key={label} style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', padding: '8px 0', borderBottom: '1px solid rgba(var(--border-rgb),0.4)' }}>
      <span style={{ fontSize: '11px', color: 'var(--text-label)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.3px' }}>{label}</span>
      <span style={{ fontSize: '13px', color: 'var(--text-body)', fontWeight: 600, textAlign: 'right' }}>{value}</span>
    </div>
  );
}

export function renderDetail(type: PopoutType, item: any) {
  switch (type) {
    case 'invoices':
      return (
        <div>
          {detailRow('Invoice #', item.invoice_number)}
          {detailRow('Customer', item.customer)}
          {detailRow('PO #', item.po_number)}
          {detailRow('Graphics Job', item.job_title)}
          {detailRow('Source', item.source === 'po' ? 'Purchase order' : item.source === 'graphics' ? 'Graphics job' : 'Scan batch')}
          {detailRow('Date', item.date ? formatDate(item.date) : null)}
        </div>
      );
    case 'purchase_orders': {
      const lines = item.po_line_items || item.line_items || [];
      const total = lines.reduce((s: number, l: any) => s + (l.quantity * l.unit_price), 0);
      const totalQty = lines.reduce((s: number, l: any) => s + (l.quantity || 0), 0);
      const totalDone = lines.reduce((s: number, l: any) => s + (l.installed || 0), 0);
      // Green when fully done, amber when partway, muted when nothing's done yet.
      const doneColor = (done: number, qty: number) =>
        qty > 0 && done >= qty ? '#34d399' : done > 0 ? '#fbbf24' : 'var(--text-label)';
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
                  <div style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <div style={{ fontSize: '11px', color: 'var(--text-body)' }}>{l.quantity} × {formatCurrency(l.unit_price)}</div>
                    <div style={{ fontSize: '10px', fontWeight: 700, color: doneColor(l.installed || 0, l.quantity || 0) }}>{l.installed || 0} of {l.quantity || 0} done</div>
                  </div>
                </div>
              ))}
              {totalQty > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0 0' }}>
                  <span style={{ fontSize: '12px', color: 'var(--text-label)', fontWeight: 800 }}>QUANTITY</span>
                  <span style={{ fontSize: '13px', fontWeight: 800 }}>
                    <span style={{ color: doneColor(totalDone, totalQty) }}>{totalDone}</span>
                    <span style={{ color: 'var(--text-label)' }}> / {totalQty} done</span>
                  </span>
                </div>
              )}
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

interface PopoutState { type: PopoutType; item: any | null; loading: boolean; }

interface PopoutContextValue {
  /** Pop out a record. Pass an id to fetch it, or a complete item object. */
  open: (type: PopoutType, idOrItem: string | Record<string, any>) => void;
}

const PopoutContext = createContext<PopoutContextValue>({ open: () => {} });

export function usePopout() {
  return useContext(PopoutContext);
}

export function PopoutProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [supabase] = useState(() => createClient());
  const [state, setState] = useState<PopoutState | null>(null);

  const open = useCallback((type: PopoutType, idOrItem: string | Record<string, any>) => {
    if (idOrItem && typeof idOrItem === 'object') {
      setState({ type, item: idOrItem, loading: false });
      return;
    }
    const id = String(idOrItem);
    setState({ type, item: null, loading: true });
    fetchItem(supabase, type, id).then((item) => {
      setState((cur) => (cur && cur.type === type ? { type, item, loading: false } : cur));
    });
  }, [supabase]);

  const close = useCallback(() => setState(null), []);

  return (
    <PopoutContext.Provider value={{ open }}>
      {children}
      {state && (
        <div
          style={{ position: 'fixed', inset: 0, zIndex: 310, background: 'rgba(0,0,0,0.8)', backdropFilter: 'blur(6px)', display: 'flex', flexDirection: 'column', padding: '16px' }}
          onClick={close}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ width: '100%', maxWidth: '500px', margin: 'auto', maxHeight: '90vh', display: 'flex', flexDirection: 'column', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '14px', overflow: 'hidden' }}
          >
            <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: '12px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.5px', color: LABELS[state.type]?.color || 'var(--text-body)' }}>
                {LABELS[state.type]?.label || state.type}
              </span>
              <button onClick={close} style={{ background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: '50%', width: '26px', height: '26px', color: 'var(--text-body)', fontSize: '13px', cursor: 'pointer' }}>✕</button>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '14px 16px' }}>
              {state.loading && (
                <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-label)', fontSize: '13px' }}>Loading…</div>
              )}
              {!state.loading && !state.item && (
                <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-label)', fontSize: '13px' }}>Not found.</div>
              )}
              {!state.loading && state.item && renderDetail(state.type, state.item)}
            </div>
            {!state.loading && state.item && (
              <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border)' }}>
                <button
                  onClick={() => { const p = pathFor(state.type, state.item); close(); router.push(p); }}
                  style={{ width: '100%', padding: '12px', borderRadius: '10px', background: '#60a5fa', color: '#fff', fontSize: '13px', fontWeight: 800, border: 'none', cursor: 'pointer' }}
                >
                  Open full page →
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </PopoutContext.Provider>
  );
}
