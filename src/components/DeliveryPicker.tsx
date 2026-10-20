'use client';

/**
 * Delivery method picker + read-only summary (migration 414). One picker on
 * the estimate builder, the upfit project, the New Job form and the job's
 * Edit form, so every screen asks the same questions. See src/lib/delivery.ts.
 */
import { useState } from 'react';
import { createClient } from '@/lib/supabase-browser';
import {
  DELIVERY_METHOD_OPTIONS, DELIVERY_SHIP_SPEED_OPTIONS, DELIVERY_INSTALLER_OPTIONS,
  deliveryChipColor, deliveryChipLabel, deliveryLines, deliveryProblem, formatShipToBlock,
  type Delivery, type DeliveryMethod,
} from '@/lib/delivery';

const labelStyle: React.CSSProperties = {
  fontSize: '9px', fontWeight: 700, color: 'var(--text-label)',
  textTransform: 'uppercase', letterSpacing: '0.3px', marginBottom: '3px',
};
const inputStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px', borderRadius: '8px',
  border: '1px solid var(--border)', background: 'var(--bg)',
  color: 'var(--text-body)', fontSize: '12px',
};
const req = <span style={{ color: '#f87171' }}> *</span>;

/** The customer's address block for prefilling: default ship-to when set,
 *  else the company name over the NetSuite address. */
async function customerAddress(customerNetsuiteId?: string | null, customerName?: string | null): Promise<string | null> {
  if (!customerNetsuiteId && !customerName) return null;
  const supabase = createClient();
  let q = supabase.from('customers').select('company_name, address, default_ship_to').limit(1);
  q = customerNetsuiteId ? q.eq('netsuite_id', customerNetsuiteId) : q.eq('company_name', customerName!);
  const { data } = await q.maybeSingle();
  if (!data) return null;
  const ship = formatShipToBlock(data.default_ship_to as any);
  if (ship) return ship;
  const block = [data.company_name, data.address].map((x: any) => (x || '').trim()).filter(Boolean).join('\n');
  return block || null;
}

export function DeliveryPicker({
  value, onChange, required = false, showProblems = false, customerNetsuiteId, customerName,
}: {
  value: Delivery;
  onChange: (next: Delivery) => void;
  /** No method picked counts as a problem (new Production jobs). */
  required?: boolean;
  /** Show what's missing under the fields (after a save was tried). */
  showProblems?: boolean;
  /** Used to fill the address the first time a method needs one. */
  customerNetsuiteId?: string | null;
  customerName?: string | null;
}) {
  const [filling, setFilling] = useState(false);
  const set = (patch: Partial<Delivery>) => onChange({ ...value, ...patch });

  const pick = async (method: DeliveryMethod) => {
    const next: Delivery = { ...value, method };
    if (method === 'direct_ship' && !next.shipSpeed) next.shipSpeed = 'ups_ground';
    if (method === 'onsite_install' && !next.installer) next.installer = 'bmg_crew';
    onChange(next);
    if ((method === 'direct_ship' || method === 'onsite_install') && !value.address?.trim()) {
      setFilling(true);
      const addr = await customerAddress(customerNetsuiteId, customerName).catch(() => null);
      setFilling(false);
      if (addr) onChange({ ...next, address: addr });
    }
  };

  const problem = showProblems ? deliveryProblem(value, required) : null;
  const m = value.method;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <div>
        <div style={labelStyle}>Delivery Method{required && req}</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '6px' }}>
          {DELIVERY_METHOD_OPTIONS.map(o => {
            const on = m === o.value;
            return (
              <button
                key={o.value}
                type="button"
                aria-pressed={on}
                onClick={() => pick(o.value)}
                style={{
                  textAlign: 'left', padding: '8px 10px', borderRadius: '8px', cursor: 'pointer',
                  border: `1.5px solid ${on ? '#ee3120' : 'var(--border)'}`,
                  background: on ? 'rgba(238,49,32,0.10)' : 'var(--bg)',
                  color: 'var(--text-body)', display: 'flex', flexDirection: 'column', gap: '1px',
                }}
              >
                <span style={{ fontSize: '12px', fontWeight: 700 }}>{o.label}</span>
                <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{o.hint}</span>
              </button>
            );
          })}
        </div>
      </div>

      {m === 'direct_ship' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '8px' }}>
          <div>
            <div style={labelStyle}>Shipping Speed{req}</div>
            <select style={inputStyle} value={value.shipSpeed || ''} onChange={e => set({ shipSpeed: e.target.value || null })}>
              <option value="">Pick a speed</option>
              {DELIVERY_SHIP_SPEED_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div>
            <div style={labelStyle}>Ship-to Contact</div>
            <input style={inputStyle} value={value.contactName || ''} onChange={e => set({ contactName: e.target.value })} placeholder="Name (optional)" />
          </div>
          <div>
            <div style={labelStyle}>Contact Phone</div>
            <input style={inputStyle} value={value.contactPhone || ''} onChange={e => set({ contactPhone: e.target.value })} placeholder="Optional" />
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <div style={labelStyle}>Ship-to Address{req}</div>
            <textarea style={{ ...inputStyle, minHeight: '60px', resize: 'vertical' }} value={value.address || ''} onChange={e => set({ address: e.target.value })}
              placeholder={filling ? 'Filling from the customer…' : 'Company Name\n123 Street Address\nCity, State ZIP'} />
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <div style={labelStyle}>Shipping Notes</div>
            <input style={inputStyle} value={value.notes || ''} onChange={e => set({ notes: e.target.value })} placeholder="Optional" />
          </div>
        </div>
      )}

      {m === 'onsite_install' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '8px' }}>
          <div style={{ gridColumn: '1 / -1' }}>
            <div style={labelStyle}>Install Address{req}</div>
            <textarea style={{ ...inputStyle, minHeight: '60px', resize: 'vertical' }} value={value.address || ''} onChange={e => set({ address: e.target.value })}
              placeholder={filling ? 'Filling from the customer…' : 'Site name\nStreet address\nCity, State ZIP'} />
          </div>
          <div>
            <div style={labelStyle}>Installation Contact{req}</div>
            <input style={inputStyle} value={value.contactName || ''} onChange={e => set({ contactName: e.target.value })} placeholder="Who meets the installer" />
          </div>
          <div>
            <div style={labelStyle}>Contact Phone{req}</div>
            <input style={inputStyle} value={value.contactPhone || ''} onChange={e => set({ contactPhone: e.target.value })} placeholder="(314) 555-0100" />
          </div>
          <div>
            <div style={labelStyle}>Who Installs</div>
            <select style={inputStyle} value={value.installer || 'bmg_crew'} onChange={e => set({ installer: e.target.value as Delivery['installer'] })}>
              {DELIVERY_INSTALLER_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <div style={labelStyle}>Install Notes</div>
            <textarea style={{ ...inputStyle, minHeight: '44px', resize: 'vertical' }} value={value.notes || ''} onChange={e => set({ notes: e.target.value })}
              placeholder="Gate codes, parking, hours, anything the installer should know" />
          </div>
        </div>
      )}

      {m === 'customer_pickup' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '8px' }}>
          <div>
            <div style={labelStyle}>Who to Contact{req}</div>
            <input style={inputStyle} value={value.contactName || ''} onChange={e => set({ contactName: e.target.value })} placeholder="Name" />
          </div>
          <div>
            <div style={labelStyle}>Phone or Email{req}</div>
            <input style={inputStyle} value={value.contactPhone || ''} onChange={e => set({ contactPhone: e.target.value })} placeholder="How to reach them" />
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <div style={labelStyle}>Special Instructions</div>
            <textarea style={{ ...inputStyle, minHeight: '44px', resize: 'vertical' }} value={value.notes || ''} onChange={e => set({ notes: e.target.value })}
              placeholder="When they'll come, who picks up, anything else" />
          </div>
        </div>
      )}

      {m === 'bmg_shop' && (
        <div>
          <div style={{ fontSize: '10px', color: '#38bdf8', marginBottom: '6px' }}>Installed at our O&apos;Fallon shop. On a graphics job this puts the vehicle on the shop arrival schedule.</div>
          <div style={labelStyle}>Notes</div>
          <input style={inputStyle} value={value.notes || ''} onChange={e => set({ notes: e.target.value })} placeholder="Drop-off details (optional)" />
        </div>
      )}

      {problem && (
        <div style={{ fontSize: '11px', color: '#f87171', background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.2)', borderRadius: '6px', padding: '6px 8px' }}>{problem}</div>
      )}
    </div>
  );
}

/** Small colored chip for boards and headers. */
export function DeliveryChip({ value }: { value: Partial<Delivery> | null | undefined }) {
  const label = deliveryChipLabel(value);
  if (!label) return null;
  const color = deliveryChipColor(value?.method);
  return (
    <span style={{
      fontSize: '9px', fontWeight: 800, color, textTransform: 'uppercase', padding: '2px 7px',
      borderRadius: '4px', letterSpacing: '0.3px', background: `${color}1f`, whiteSpace: 'nowrap',
    }}>{label}</span>
  );
}

/** Read-only label/value list of a delivery. */
export function DeliverySummary({ value, emptyText = 'No delivery method set.' }: { value: Partial<Delivery> | null | undefined; emptyText?: string }) {
  const lines = deliveryLines(value);
  if (lines.length === 0) return <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{emptyText}</div>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <div><DeliveryChip value={value} /></div>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(80px, max-content) 1fr', gap: '3px 10px', fontSize: '11px' }}>
        {lines.slice(1).map(l => (
          <div key={l.label} style={{ display: 'contents' }}>
            <div style={{ color: 'var(--text-muted)' }}>{l.label}</div>
            <div style={{ color: 'var(--text-body)', whiteSpace: 'pre-wrap', minWidth: 0, overflowWrap: 'anywhere' }}>{l.value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
