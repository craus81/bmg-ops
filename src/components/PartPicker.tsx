'use client';

import { useState, useEffect } from 'react';
import { createClient } from '@/lib/supabase-browser';

export interface PickedPart {
  part_number: string;
  part_description: string | null;
  billable_customer: string | null;
}

interface PartOption extends PickedPart {
  item_number: string;
  graphics: boolean;
}

interface PartPickerProps {
  value: PickedPart | null;
  onChange: (part: PickedPart | null) => void;
  /** Inline CSS vars-based styling to match the host form. */
  inputStyle?: React.CSSProperties;
}

// Part numbers visually conflate O/0; normalize both sides of search.
const norm = (s: string) => (s || '').toLowerCase().replace(/o/g, '0');

/**
 * Single-part picker that merges the two catalogs the scan flow uses
 * (netsuite_parts + the graphics `catalog`), de-duped by item number. Pick a
 * part to drive part-specific behavior (e.g. the Verizon RFID device capture).
 */
export default function PartPicker({ value, onChange, inputStyle }: PartPickerProps) {
  const supabase = createClient();
  const [parts, setParts] = useState<PartOption[]>([]);
  const [search, setSearch] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const byItem = new Map<string, PartOption>();

      // Graphics catalog first so netsuite_parts wins on collision.
      for (let offset = 0; ; offset += 1000) {
        const { data } = await supabase
          .from('catalog')
          .select('part_number, customer, end_customer, vehicle_type, graphic_package, active')
          .eq('active', true).order('part_number').range(offset, offset + 999);
        if (!data || data.length === 0) break;
        for (const c of data as any[]) {
          byItem.set((c.part_number || '').toUpperCase(), {
            item_number: c.part_number,
            part_number: c.part_number,
            part_description: [c.vehicle_type, c.graphic_package].filter(Boolean).join(' · ') || null,
            billable_customer: c.end_customer || c.customer || null,
            graphics: true,
          });
        }
        if (data.length < 1000) break;
      }

      for (let offset = 0; ; offset += 1000) {
        const { data } = await supabase
          .from('netsuite_parts')
          .select('item_number, display_name, description, billable_customer')
          .eq('is_active', true).order('item_number').range(offset, offset + 999);
        if (!data || data.length === 0) break;
        for (const p of data as any[]) {
          byItem.set((p.item_number || '').toUpperCase(), {
            item_number: p.item_number,
            part_number: p.item_number,
            part_description: p.display_name || p.description || null,
            billable_customer: p.billable_customer || null,
            graphics: false,
          });
        }
        if (data.length < 1000) break;
      }

      if (!cancelled) {
        setParts([...byItem.values()].sort((a, b) => a.item_number.localeCompare(b.item_number)));
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- load once
  }, []);

  const filtered = search
    ? (() => {
        const s = norm(search);
        return parts.filter(p =>
          norm(p.item_number).includes(s) ||
          norm(p.part_description || '').includes(s) ||
          norm(p.billable_customer || '').includes(s)
        ).slice(0, 30);
      })()
    : [];

  if (value) {
    return (
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px',
        padding: '12px 14px', borderRadius: '10px',
        background: 'var(--success-bg)', border: '1px solid var(--success-border)',
      }}>
        <div>
          <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)', fontFamily: 'monospace' }}>{value.part_number}</div>
          {value.part_description && <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{value.part_description}</div>}
          {value.billable_customer && <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>Bill: {value.billable_customer}</div>}
        </div>
        <button type="button" onClick={() => { onChange(null); setSearch(''); }} style={{
          fontSize: '11px', fontWeight: 700, color: 'var(--error)', background: 'transparent', border: 'none', cursor: 'pointer', flexShrink: 0,
        }}>Change</button>
      </div>
    );
  }

  return (
    <div>
      <input
        value={search}
        onChange={e => setSearch(e.target.value)}
        placeholder="Search part by number, name, or customer..."
        style={inputStyle || {
          width: '100%', padding: '12px 14px', borderRadius: '10px',
          border: '1px solid var(--border)', background: 'var(--input-bg)',
          color: 'var(--text-body)', fontSize: '14px',
        }}
      />
      {filtered.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '6px', maxHeight: '260px', overflowY: 'auto' }}>
          {filtered.map(p => (
            <button key={p.item_number} type="button" onClick={() => {
              onChange({ part_number: p.part_number, part_description: p.part_description, billable_customer: p.billable_customer });
              setSearch('');
            }} style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px',
              padding: '10px 12px', borderRadius: '8px', textAlign: 'left', width: '100%',
              background: 'var(--input-bg)', border: '1px solid var(--border)', cursor: 'pointer',
            }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>{p.item_number}</span>
                  {p.graphics && <span style={{ fontSize: '9px', fontWeight: 700, padding: '1px 5px', borderRadius: '4px', background: 'var(--orange-soft)', color: 'var(--orange)' }}>GRAPHICS</span>}
                </div>
                {p.part_description && <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{p.part_description}</div>}
              </div>
              {p.billable_customer && <span style={{ fontSize: '10px', color: 'var(--text-secondary)', flexShrink: 0 }}>{p.billable_customer}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
