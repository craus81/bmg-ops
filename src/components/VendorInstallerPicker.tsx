'use client';

import { useState, useEffect } from 'react';
import { useDialog } from '@/components/DialogProvider';
import PhoneInput from '@/components/PhoneInput';
import { theme } from '@/lib/theme';

export interface VendorCompanyOption { id: string; name: string; netsuite_vendor_id?: string | null }

interface NsVendorHit { id: string; entityId: string; companyName: string }

/**
 * Vendor / installer box for the Scan Log (Bulk Upload + Edit Scan). Search
 * the FleetSuite installer companies; admins also see live NetSuite vendor
 * matches (click to link — never mints a duplicate NetSuite vendor) and a
 * "+ Add" row that creates the FleetSuite company and its NetSuite vendor.
 * Same /api/cni/create-vendor flow the Vendor Invoices tab uses.
 *
 * The value is the installer's name (what scan_logs.installer_name stores),
 * so a name stamped by an old invoice that matches no company still shows.
 */
export default function VendorInstallerPicker({
  companies,
  value,
  onChange,
  onCompanyAdded,
  canAdd,
  placeholder = 'Search vendors / installers…',
  emptyLabel = 'No vendor',
  inputStyle,
}: {
  companies: VendorCompanyOption[];
  value: string;
  onChange: (name: string, company: VendorCompanyOption | null) => void;
  /** A company was created or linked — add it to the caller's list. */
  onCompanyAdded: (company: VendorCompanyOption) => void;
  /** Linking and adding are admin-only (the routes refuse anyone else). */
  canAdd: boolean;
  placeholder?: string;
  emptyLabel?: string;
  inputStyle?: React.CSSProperties;
}) {
  const dialog = useDialog();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [nsVendors, setNsVendors] = useState<NsVendorHit[]>([]);
  const [nsState, setNsState] = useState<'idle' | 'searching' | 'done' | 'error'>('idle');
  const [nsError, setNsError] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [addName, setAddName] = useState('');
  const [addEmail, setAddEmail] = useState('');
  const [addPhone, setAddPhone] = useState('');
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const selected = value
    ? companies.find(c => c.name.trim().toLowerCase() === value.trim().toLowerCase()) || null
    : null;

  // Debounced NetSuite vendor search while typing (admins only — the
  // search route is admin-gated).
  const nsQuery = canAdd && open ? query.trim() : '';
  useEffect(() => {
    if (nsQuery.length < 2) { setNsVendors([]); setNsState('idle'); setNsError(null); return; }
    setNsState('searching');
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/cni/search-vendors?q=${encodeURIComponent(nsQuery)}`);
        const data = await res.json().catch(() => ({}));
        if (res.ok && !data.error) {
          setNsVendors(data.vendors || []);
          setNsError(null);
          setNsState('done');
        } else {
          setNsVendors([]);
          setNsError(data.error || `Search failed (${res.status})`);
          setNsState('error');
        }
      } catch (err: any) {
        setNsVendors([]);
        setNsError(err.message || 'Network error');
        setNsState('error');
      }
    }, 350);
    return () => clearTimeout(t);
  }, [nsQuery]);

  const pick = (c: VendorCompanyOption) => {
    onChange(c.name, c);
    setQuery('');
    setOpen(false);
  };

  const companyFrom = (data: any): VendorCompanyOption =>
    ({ id: data.companyId, name: data.companyName, netsuite_vendor_id: data.netsuiteVendorId || null });

  const linkNsVendor = async (v: NsVendorHit) => {
    setLinking(true);
    try {
      const res = await fetch('/api/cni/create-vendor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: v.companyName || v.entityId, netsuiteVendorId: v.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) {
        await dialog.alert(`Failed to link NetSuite vendor: ${data.error || 'unknown error'}`);
      } else {
        const company = companyFrom(data);
        onCompanyAdded(company);
        pick(company);
        setNotice(data.vendorError || `${company.name} linked to NetSuite vendor #${company.netsuite_vendor_id}.`);
      }
    } catch (err: any) {
      await dialog.alert(`Failed to link NetSuite vendor: ${err.message}`);
    }
    setLinking(false);
  };

  const openAdd = () => {
    setAddName(query.trim());
    setAddOpen(true);
    setOpen(false);
  };

  const handleAdd = async () => {
    if (!addName.trim()) return;
    setAdding(true);
    try {
      const res = await fetch('/api/cni/create-vendor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: addName.trim(),
          email: addEmail.trim() || undefined,
          phone: addPhone.trim() || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) {
        await dialog.alert(`Failed to add vendor / installer: ${data.error || 'unknown error'}`);
      } else {
        const company = companyFrom(data);
        onCompanyAdded(company);
        pick(company);
        setAddOpen(false);
        setAddEmail('');
        setAddPhone('');
        if (data.vendorError) {
          await dialog.alert(`${company.name} was added to FleetSuite, but the NetSuite vendor could not be created: ${data.vendorError}\n\nYou can add the vendor ID later on the company page.`);
        } else if (data.netsuiteVendorId) {
          setNotice(`${company.name} added · NetSuite vendor #${data.netsuiteVendorId}${data.alreadyExists ? ' (already existed)' : ' created'}.`);
        }
      }
    } catch (err: any) {
      await dialog.alert(`Failed to add vendor / installer: ${err.message}`);
    }
    setAdding(false);
  };

  const box: React.CSSProperties = {
    width: '100%', padding: '10px', borderRadius: '8px', border: `1px solid ${theme.border}`,
    background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '13px',
    ...inputStyle,
  };
  const smallLabel: React.CSSProperties = { fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '3px' };
  const rowBtn: React.CSSProperties = { display: 'block', width: '100%', padding: '7px 9px', textAlign: 'left', border: 'none', borderBottom: `1px solid ${theme.border}`, background: 'transparent', cursor: 'pointer', fontSize: '11px', color: 'var(--text-primary)' };

  const q = query.trim().toLowerCase();
  const matches = (q ? companies.filter(c => c.name.toLowerCase().includes(q)) : companies).slice(0, 8);
  const linkedNsIds = new Set(companies.map(c => c.netsuite_vendor_id).filter(Boolean));
  const nsMatches = nsVendors.filter(v => !linkedNsIds.has(v.id)).slice(0, 6);

  return (
    <div style={{ position: 'relative' }}>
      {value && !open ? (
        <div style={{ ...box, display: 'flex', alignItems: 'center', gap: '6px', borderColor: selected ? 'rgba(34,197,94,0.4)' : theme.border }}>
          <span style={{ flex: 1, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</span>
          {selected?.netsuite_vendor_id && (
            <span style={{ fontSize: '9px', fontWeight: 700, color: '#22c55e', background: 'rgba(34,197,94,0.12)', borderRadius: '4px', padding: '1px 5px' }}>NetSuite #{selected.netsuite_vendor_id}</span>
          )}
          <button type="button" onClick={() => { setQuery(''); setOpen(true); }} title="Change vendor / installer" style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '11px', fontWeight: 700, cursor: 'pointer', padding: '0 2px' }}>Change</button>
          <button type="button" onClick={() => onChange('', null)} title={`Set to ${emptyLabel.toLowerCase()}`} style={{ background: 'none', border: 'none', color: '#f87171', fontSize: '12px', cursor: 'pointer', padding: '0 2px' }}>✕</button>
        </div>
      ) : (
        <input
          value={query}
          autoFocus={open && !!value}
          onChange={e => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          placeholder={value ? `${value} (type to change)` : `${emptyLabel} · ${placeholder}`}
          style={box}
        />
      )}

      {open && (
        <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50, background: 'var(--card)', border: `1px solid ${theme.border}`, borderRadius: '6px', boxShadow: '0 4px 12px rgba(0,0,0,0.2)', maxHeight: '280px', overflowY: 'auto', marginTop: '2px' }}>
          {matches.map(c => (
            <button key={c.id} type="button" onMouseDown={e => e.preventDefault()} onClick={() => pick(c)} style={rowBtn}>
              <span style={{ fontWeight: 700 }}>{c.name}</span>
              {c.netsuite_vendor_id ? (
                <span style={{ fontSize: '9px', fontWeight: 700, color: '#22c55e', background: 'rgba(34,197,94,0.12)', borderRadius: '4px', padding: '1px 5px', marginLeft: '6px' }}>✓ NetSuite #{c.netsuite_vendor_id}</span>
              ) : (
                <span style={{ fontSize: '9px', fontWeight: 700, color: '#fbbf24', background: 'rgba(251,191,36,0.1)', borderRadius: '4px', padding: '1px 5px', marginLeft: '6px' }}>not linked to NetSuite</span>
              )}
            </button>
          ))}
          {q && matches.length === 0 && (
            <div style={{ padding: '6px 9px', fontSize: '10px', color: 'var(--text-muted)', borderBottom: `1px solid ${theme.border}` }}>
              No FleetSuite vendor / installer matches &quot;{query.trim()}&quot;
            </div>
          )}
          {nsMatches.map(v => (
            <button key={`ns-${v.id}`} type="button" onMouseDown={e => e.preventDefault()} onClick={() => linkNsVendor(v)} disabled={linking}
              style={{ ...rowBtn, background: 'rgba(96,165,250,0.04)', opacity: linking ? 0.6 : 1 }}>
              <span style={{ fontWeight: 700 }}>{v.companyName || v.entityId}</span>
              <span style={{ fontSize: '9px', fontWeight: 700, color: '#60a5fa', background: 'rgba(96,165,250,0.12)', borderRadius: '4px', padding: '1px 5px', marginLeft: '6px' }}>NetSuite #{v.id}</span>
              <div style={{ fontSize: '9px', color: 'var(--text-muted)' }}>{linking ? 'Linking…' : 'Already a NetSuite vendor · click to link'}</div>
            </button>
          ))}
          {nsState === 'searching' && (
            <div style={{ padding: '6px 9px', fontSize: '10px', color: 'var(--text-muted)', borderBottom: `1px solid ${theme.border}` }}>Searching NetSuite vendors…</div>
          )}
          {nsState === 'error' && (
            <div style={{ padding: '6px 9px', fontSize: '10px', fontWeight: 600, color: '#fbbf24', background: 'rgba(251,191,36,0.06)', borderBottom: `1px solid ${theme.border}` }}>
              ⚠ NetSuite vendor search unavailable: {nsError}. Showing FleetSuite installers only.
            </div>
          )}
          {canAdd && (
            <button type="button" onMouseDown={e => e.preventDefault()} onClick={openAdd}
              style={{ ...rowBtn, borderBottom: 'none', background: 'rgba(34,197,94,0.06)', fontWeight: 700, color: '#22c55e' }}>
              {q ? <>+ Add &quot;{query.trim()}&quot; as a new vendor / installer</> : '+ Add a new vendor / installer'}
            </button>
          )}
        </div>
      )}

      {notice && !addOpen && (
        <div style={{ fontSize: '10px', color: '#22c55e', marginTop: '3px', fontWeight: 600, display: 'flex', gap: '6px' }}>
          <span style={{ flex: 1 }}>{notice}</span>
          <button type="button" onClick={() => setNotice(null)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '10px' }}>✕</button>
        </div>
      )}

      {addOpen && (
        <div style={{ padding: '10px', borderRadius: '8px', marginTop: '6px', background: 'rgba(34,197,94,0.05)', border: '1px solid rgba(34,197,94,0.25)' }}>
          <div style={{ fontSize: '10px', fontWeight: 600, color: '#22c55e', marginBottom: '6px' }}>
            Creates the company in FleetSuite and a matching NetSuite vendor. If they might already be a NetSuite vendor, search their name above and link instead.
          </div>
          <div style={{ display: 'grid', gap: '6px' }}>
            <div>
              <div style={smallLabel}>Vendor / Installer Name</div>
              <input value={addName} onChange={e => setAddName(e.target.value)} autoFocus style={{ ...box, padding: '8px', fontSize: '12px' }} />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
              <div>
                <div style={smallLabel}>Email (optional)</div>
                <input value={addEmail} onChange={e => setAddEmail(e.target.value)} style={{ ...box, padding: '8px', fontSize: '12px' }} />
              </div>
              <div>
                <div style={smallLabel}>Phone (optional)</div>
                <PhoneInput value={addPhone} onChange={v => setAddPhone(v)} style={{ ...box, padding: '8px', fontSize: '12px' }} />
              </div>
            </div>
            <div style={{ display: 'flex', gap: '6px' }}>
              <button type="button" onClick={handleAdd} disabled={adding || !addName.trim()} style={{ padding: '8px 14px', borderRadius: '6px', fontSize: '11px', fontWeight: 700, background: '#22c55e', color: '#fff', border: 'none', cursor: 'pointer', opacity: adding || !addName.trim() ? 0.6 : 1 }}>
                {adding ? 'Adding…' : 'Add Vendor / Installer'}
              </button>
              <button type="button" onClick={() => setAddOpen(false)} style={{ padding: '8px 12px', borderRadius: '6px', fontSize: '11px', fontWeight: 700, background: 'transparent', border: `1px solid ${theme.border}`, color: 'var(--text-muted)', cursor: 'pointer' }}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
