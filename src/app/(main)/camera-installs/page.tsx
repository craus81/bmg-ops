'use client';

/**
 * Camera Installs (owner ask 2026-10-06, migration 343): Surfsight camera +
 * GO9B installs for T-Mobile programs, kept apart from check-in, sales
 * orders and the upfit flow. A shop tech taps New install, picks the
 * customer and scans the VIN, camera IMEI and GO9B IMEI; the list exports
 * CSV and prints each install as the filled-in install form (PDF). When the
 * VIN is already in FleetSuite, the install links to that vehicle.
 *
 * URL: ?new=1 opens the capture, ?id=<install> opens one install.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';
import CameraInstallCapture, { type CustomerPick } from '@/components/CameraInstallCapture';
import { apiFetch } from '@/lib/api-client';
import { downloadCsv } from '@/lib/csv';
import { exportCameraInstallPDF } from '@/lib/camera-install-pdf';
import { CAMERA_INSTALL_CSV_HEADERS, cameraInstallCsvRow, formatImei, vehicleLabel, type CameraInstall } from '@/lib/camera-install';
import { deepLinks } from '@/lib/deep-links';
import { theme } from '@/lib/theme';

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', year: 'numeric' });

export default function CameraInstallsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const dialog = useDialog();
  const { user, isAdmin, hasFeature, loading } = useAuth();

  const [installs, setInstalls] = useState<CameraInstall[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [search, setSearch] = useState('');
  const [customerFilter, setCustomerFilter] = useState('');
  const [nextCustomer, setNextCustomer] = useState<CustomerPick | null>(null);
  const [justSaved, setJustSaved] = useState<CameraInstall | null>(null);
  const [editing, setEditing] = useState(false);

  const isNew = searchParams.get('new') === '1';
  const openId = searchParams.get('id');

  useEffect(() => {
    if (loading || !user) return;
    if (!hasFeature('in_shop')) router.replace('/home');
  }, [loading, user, hasFeature, router]);

  const load = useCallback(async () => {
    setLoadError('');
    try {
      const res = await apiFetch('/api/camera-installs');
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Could not load installs');
      setInstalls(json.installs || []);
    } catch (err: any) {
      setLoadError(err?.message || 'Could not load installs');
    }
    setLoadingList(false);
  }, []);

  useEffect(() => { if (user) void load(); }, [user, load]);

  const customers = useMemo(
    () => Array.from(new Set(installs.map(i => i.customer_name))).sort((a, b) => a.localeCompare(b)),
    [installs],
  );

  const shown = useMemo(() => {
    const q = search.trim().toUpperCase().replace(/\s+/g, '');
    return installs.filter(i => {
      if (customerFilter && i.customer_name !== customerFilter) return false;
      if (!q) return true;
      return [i.vin, i.camera_imei, i.go9b_imei, i.customer_name, i.license_plate || '', vehicleLabel(i)]
        .some(v => v.toUpperCase().replace(/\s+/g, '').includes(q));
    });
  }, [installs, search, customerFilter]);

  const selected = openId ? installs.find(i => i.id === openId) || null : null;

  const go = (params: Record<string, string> | null) => {
    setEditing(false);
    const qs = params ? `?${new URLSearchParams(params).toString()}` : '';
    router.push(`${deepLinks.cameraInstalls()}${qs}`);
  };

  const onSaved = (install: CameraInstall) => {
    setInstalls(prev => [install, ...prev.filter(p => p.id !== install.id)]);
    if (editing) { setEditing(false); return; }
    setJustSaved(install);
    setNextCustomer({
      customer_id: install.customer_id, customer_name: install.customer_name,
      contact_name: install.contact_name || '', contact_phone: install.contact_phone || '', contact_email: install.contact_email || '',
    });
  };

  const remove = async (install: CameraInstall) => {
    const ok = await dialog.confirm(`Delete the camera install on VIN ${install.vin}? This can't be undone.`, { title: 'Delete install', confirmLabel: 'Delete', destructive: true });
    if (!ok) return;
    const res = await apiFetch(`/api/camera-installs/${install.id}`, { method: 'DELETE' });
    if (!res.ok) { const j = await res.json().catch(() => ({})); await dialog.alert(j.error || 'Could not delete.'); return; }
    setInstalls(prev => prev.filter(p => p.id !== install.id));
    go(null);
  };

  const exportCsv = () => {
    const stamp = new Date().toISOString().slice(0, 10);
    const who = customerFilter ? `-${customerFilter.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}` : '';
    downloadCsv(`camera-installs${who}-${stamp}.csv`, CAMERA_INSTALL_CSV_HEADERS, shown.map(cameraInstallCsvRow));
  };

  const card: React.CSSProperties = { background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '14px', padding: '14px', marginBottom: '14px' };
  const btn: React.CSSProperties = { padding: '10px 14px', borderRadius: '10px', fontSize: '13px', fontWeight: 700, border: `1px solid ${theme.border}`, background: 'transparent', color: theme.textPrimary, cursor: 'pointer' };
  const primaryBtn: React.CSSProperties = { ...btn, background: '#2563eb', border: 'none', color: '#fff' };
  const label: React.CSSProperties = { fontSize: '11px', fontWeight: 800, letterSpacing: '0.4px', textTransform: 'uppercase', color: theme.textMuted };

  const header = (title: string, sub?: string) => (
    <div style={{ marginBottom: '14px' }}>
      <h1 style={{ margin: '0 0 4px', fontSize: '22px', fontWeight: 800, color: theme.textPrimary }}>{title}</h1>
      {sub && <div style={{ fontSize: '13px', color: theme.textMuted }}>{sub}</div>}
    </div>
  );

  // ─── New install ──────────────────────────────────────────────
  if (isNew) {
    if (justSaved) {
      return (
        <div style={{ maxWidth: '560px', margin: '0 auto' }}>
          {header('Install saved')}
          <div style={{ ...card, borderColor: 'rgba(34,197,94,0.4)' }}>
            <div style={{ fontSize: '15px', fontWeight: 800, color: '#22c55e', marginBottom: '6px' }}>✓ {justSaved.customer_name}</div>
            <div style={{ fontSize: '13px', color: theme.textPrimary }}>{vehicleLabel(justSaved) || 'Vehicle'} · <span style={{ fontFamily: 'monospace' }}>{justSaved.vin}</span></div>
            <div style={{ fontSize: '12px', color: theme.textMuted, marginTop: '6px', fontFamily: 'monospace' }}>
              Camera {formatImei(justSaved.camera_imei)}<br />GO9B {formatImei(justSaved.go9b_imei)}
            </div>
          </div>
          <div style={{ display: 'grid', gap: '8px' }}>
            <button type="button" style={{ ...primaryBtn, padding: '14px', fontSize: '15px' }} onClick={() => setJustSaved(null)}>
              Next vehicle for {justSaved.customer_name}
            </button>
            <button type="button" style={{ ...btn, padding: '14px' }} onClick={() => exportCameraInstallPDF([justSaved])}>Download PDF</button>
            <button type="button" style={{ ...btn, padding: '14px' }} onClick={() => { setJustSaved(null); setNextCustomer(null); go(null); }}>Done</button>
          </div>
        </div>
      );
    }
    return (
      <div style={{ maxWidth: '560px', margin: '0 auto' }}>
        {header('New Camera Install', 'Scan the VIN, the camera IMEI and the GO9B IMEI.')}
        <CameraInstallCapture
          key={nextCustomer ? `next-${installs.length}` : 'first'}
          startCustomer={nextCustomer}
          onSaved={onSaved}
          onCancel={() => { setNextCustomer(null); go(null); }}
        />
      </div>
    );
  }

  // ─── One install ──────────────────────────────────────────────
  if (openId) {
    if (!selected) {
      return (
        <div style={{ maxWidth: '560px', margin: '0 auto' }}>
          {header('Camera Install')}
          <div style={{ ...card, color: theme.textMuted, fontSize: '14px' }}>{loadingList ? 'Loading…' : 'That install wasn’t found.'}</div>
          <button type="button" style={btn} onClick={() => go(null)}>← All installs</button>
        </div>
      );
    }
    const canEdit = isAdmin || selected.installed_by === user?.id;
    if (editing) {
      return (
        <div style={{ maxWidth: '560px', margin: '0 auto' }}>
          {header('Edit Camera Install')}
          <CameraInstallCapture initial={selected} onSaved={onSaved} onCancel={() => setEditing(false)} />
        </div>
      );
    }
    const row = (k: string, v: string | number | null | undefined, mono = false) => (
      <div style={{ display: 'flex', gap: '10px', padding: '8px 0', borderTop: `1px solid ${theme.border}` }}>
        <div style={{ ...label, width: '110px', flexShrink: 0, paddingTop: '2px' }}>{k}</div>
        <div style={{ fontSize: '14px', color: v || v === 0 ? theme.textPrimary : theme.textMuted, fontFamily: mono ? 'monospace' : undefined, fontWeight: mono ? 700 : 400, wordBreak: 'break-all' }}>
          {v || v === 0 ? v : '—'}
        </div>
      </div>
    );
    return (
      <div style={{ maxWidth: '560px', margin: '0 auto' }}>
        <button type="button" style={{ ...btn, marginBottom: '12px' }} onClick={() => go(null)}>← All installs</button>
        {header(selected.customer_name, `Installed ${fmtDate(selected.installed_at)}${selected.installed_by_name ? ` by ${selected.installed_by_name}` : ''}`)}
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '14px' }}>
          <button type="button" style={primaryBtn} onClick={() => exportCameraInstallPDF([selected])}>Download PDF</button>
          <button type="button" style={btn} onClick={() => exportCameraInstallPDF([selected], { print: true })}>Print</button>
          {selected.checkin_id && <button type="button" style={btn} onClick={() => router.push(deepLinks.vehicle(selected.checkin_id!))}>Open vehicle</button>}
          {canEdit && <button type="button" style={btn} onClick={() => setEditing(true)}>Edit</button>}
          {isAdmin && <button type="button" style={{ ...btn, color: '#ef4444' }} onClick={() => void remove(selected)}>Delete</button>}
        </div>
        <div style={card}>
          <div style={{ ...label, marginBottom: '4px' }}>Device identifiers</div>
          {row('Camera IMEI', formatImei(selected.camera_imei), true)}
          {row('GO9B IMEI', formatImei(selected.go9b_imei), true)}
        </div>
        <div style={card}>
          <div style={{ ...label, marginBottom: '4px' }}>Vehicle</div>
          {row('VIN', selected.vin, true)}
          {row('Vehicle', vehicleLabel(selected))}
          {row('Odometer', selected.odometer !== null ? selected.odometer.toLocaleString('en-US') : null)}
          {row('License plate', selected.license_plate)}
        </div>
        <div style={card}>
          <div style={{ ...label, marginBottom: '4px' }}>Customer</div>
          {row('Customer', selected.customer_name)}
          {row('Contact', selected.contact_name)}
          {row('Phone', selected.contact_phone)}
          {row('Email', selected.contact_email)}
          {selected.notes && row('Notes', selected.notes)}
        </div>
      </div>
    );
  }

  // ─── List ─────────────────────────────────────────────────────
  return (
    <div style={{ maxWidth: '760px', margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '10px', flexWrap: 'wrap' }}>
        {header('Camera Installs', 'Surfsight camera + GO9B installs, scanned at install.')}
        <button type="button" style={{ ...primaryBtn, padding: '12px 18px', fontSize: '14px' }} onClick={() => { setNextCustomer(null); setJustSaved(null); go({ new: '1' }); }}>
          + New install
        </button>
      </div>

      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '12px' }}>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search VIN, IMEI, plate…"
          style={{ flex: '1 1 200px', minWidth: 0, padding: '10px 12px', borderRadius: '10px', border: `1px solid ${theme.border}`, background: theme.inputBg, color: theme.textPrimary, fontSize: '16px' }}
        />
        <select
          value={customerFilter}
          onChange={e => setCustomerFilter(e.target.value)}
          style={{ flex: '1 1 180px', minWidth: 0, padding: '10px 12px', borderRadius: '10px', border: `1px solid ${theme.border}`, background: theme.inputBg, color: theme.textPrimary, fontSize: '16px' }}
        >
          <option value="">All customers</option>
          {customers.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: '10px' }}>
        <div style={{ fontSize: '13px', color: theme.textMuted }}>
          {loadingList ? 'Loading…' : `${shown.length} install${shown.length === 1 ? '' : 's'}`}
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button type="button" style={btn} disabled={shown.length === 0} onClick={exportCsv}>Download CSV</button>
          <button type="button" style={btn} disabled={shown.length === 0} onClick={() => exportCameraInstallPDF(shown, {
            fileName: `camera-installs${customerFilter ? `-${customerFilter.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}` : ''}.pdf`,
          })}>PDF of these</button>
        </div>
      </div>

      {loadError && <div style={{ ...card, color: '#ef4444', fontSize: '14px' }}>{loadError}</div>}

      {!loadingList && shown.length === 0 && !loadError && (
        <div style={{ ...card, color: theme.textMuted, fontSize: '14px', textAlign: 'center' }}>
          {installs.length === 0 ? 'No camera installs yet. Tap New install to scan the first one.' : 'No installs match.'}
        </div>
      )}

      {shown.length > 0 && (
        <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
          {shown.map((i, n) => (
            <button key={i.id} type="button" onClick={() => go({ id: i.id })} style={{
              display: 'block', width: '100%', textAlign: 'left', padding: '12px 14px', background: 'none', border: 'none',
              borderTop: n === 0 ? 'none' : `1px solid ${theme.border}`, cursor: 'pointer', color: theme.textPrimary,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px' }}>
                <div style={{ fontSize: '14px', fontWeight: 700, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {vehicleLabel(i) || 'Vehicle'} <span style={{ fontFamily: 'monospace', color: theme.textMuted, fontWeight: 600 }}>…{i.vin.slice(-8)}</span>
                </div>
                <div style={{ fontSize: '12px', color: theme.textMuted, flexShrink: 0 }}>{fmtDate(i.installed_at)}</div>
              </div>
              <div style={{ fontSize: '12px', color: theme.textMuted, marginTop: '2px' }}>
                {i.customer_name}{i.installed_by_name ? ` · ${i.installed_by_name}` : ''}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
