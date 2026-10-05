'use client';

import CustomerPicker from '@/components/CustomerPicker';
import { theme } from '@/lib/theme';
import { matchesBillableCustomer, type BillableCustomer } from '@/lib/billable-customers';

/**
 * Quick-pick chips for the billable_customers shortlist (Masterack, Reading…)
 * so the common customers stay one click; clicking the active chip clears it.
 */
export function BillableCustomerChips({ current, billableCustomers, onPick }: {
  current: string;
  billableCustomers: BillableCustomer[];
  onPick: (name: string) => void;
}) {
  return (
    <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', marginTop: '4px' }}>
      {billableCustomers.map(c => {
        const active = matchesBillableCustomer(c, current);
        return (
          <button
            key={c.name}
            type="button"
            onMouseDown={e => e.preventDefault()}
            onClick={() => onPick(active ? '' : c.name)}
            style={{
              padding: '3px 8px', borderRadius: '6px', fontSize: '10px', fontWeight: 700, cursor: 'pointer',
              border: `1px solid ${active ? 'rgba(167,139,250,0.5)' : theme.border}`,
              background: active ? 'rgba(167,139,250,0.12)' : 'transparent',
              color: active ? '#a78bfa' : 'var(--text-muted)',
            }}
          >{c.label}</button>
        );
      })}
    </div>
  );
}

/**
 * Billable customer field for scans: a search over every NetSuite customer
 * (the `customers` mirror) plus the shortlist chips. Pick-only — scans store
 * the customer name, so creating a NetSuite customer belongs on the PO forms.
 */
export default function BillableCustomerField({ value, onChange, billableCustomers, placeholder, chips = true }: {
  value: string;
  onChange: (name: string) => void;
  billableCustomers: BillableCustomer[];
  placeholder?: string;
  chips?: boolean;
}) {
  return (
    <div>
      <CustomerPicker
        value={value}
        onChange={r => onChange(r.customer)}
        placeholder={placeholder || 'Search customers…'}
        allowCreate={false}
      />
      {chips && <BillableCustomerChips current={value} billableCustomers={billableCustomers} onPick={onChange} />}
    </div>
  );
}
