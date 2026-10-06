'use client';

import { useEffect, useState } from 'react';
import VinScanner from '@/components/VinScanner';
import { createClient } from '@/lib/supabase-browser';
import { apiFetch } from '@/lib/api-client';
import { useDialog } from '@/components/DialogProvider';
import { decodeVIN, isValidVIN } from '@/lib/vin-decoder';
import { cleanImei, formatImei, type CameraInstall } from '@/lib/camera-install';
import { theme } from '@/lib/theme';

/**
 * Camera install capture (migration 343): customer → scan VIN → scan camera
 * IMEI → scan GO9B IMEI → review (odometer, plate) → save. Mirrors the
 * Verizon RFID capture (RfidCapture.tsx): the camera stays on between steps,
 * each read is shown for a Confirm before moving on, and every step can be
 * typed instead. IMEI steps only accept a 15-digit Luhn-valid number, so the
 * serial or a part-number barcode on the same label is ignored.
 *
 * Also used to edit a saved install (`initial` set): it opens on the review
 * step with every field filled, and any of the three scans can be redone.
 */

type ScanField = 'vin' | 'camera_imei' | 'go9b_imei';
type Stage = 'customer' | ScanField | 'review';

const SCAN_ORDER: ScanField[] = ['vin', 'camera_imei', 'go9b_imei'];
const LABELS: Record<ScanField, string> = { vin: 'VIN', camera_imei: 'Camera IMEI', go9b_imei: 'GO9B IMEI' };
const HINTS: Record<ScanField, string> = {
  vin: 'Door jamb sticker or the windshield VIN barcode.',
  camera_imei: 'The IMEI barcode on the Surfsight camera label or box.',
  go9b_imei: 'The IMEI barcode on the GO9B label (not the G9 serial).',
};

export interface CustomerPick {
  customer_id: string | null;
  customer_name: string;
  contact_name: string;
  contact_phone: string;
  contact_email: string;
}

interface Draft extends CustomerPick {
  vin: string;
  vehicle_year: string;
  vehicle_make: string;
  vehicle_model: string;
  odometer: string;
  license_plate: string;
  camera_imei: string;
  go9b_imei: string;
  notes: string;
}

const emptyDraft = (c?: Partial<CustomerPick>): Draft => ({
  customer_id: c?.customer_id ?? null,
  customer_name: c?.customer_name ?? '',
  contact_name: c?.contact_name ?? '',
  contact_phone: c?.contact_phone ?? '',
  contact_email: c?.contact_email ?? '',
  vin: '', vehicle_year: '', vehicle_make: '', vehicle_model: '',
  odometer: '', license_plate: '', camera_imei: '', go9b_imei: '', notes: '',
});

const fromInstall = (r: CameraInstall): Draft => ({
  customer_id: r.customer_id, customer_name: r.customer_name,
  contact_name: r.contact_name || '', contact_phone: r.contact_phone || '', contact_email: r.contact_email || '',
  vin: r.vin, vehicle_year: r.vehicle_year || '', vehicle_make: r.vehicle_make || '', vehicle_model: r.vehicle_model || '',
  odometer: r.odometer !== null && r.odometer !== undefined ? String(r.odometer) : '',
  license_plate: r.license_plate || '', camera_imei: r.camera_imei, go9b_imei: r.go9b_imei, notes: r.notes || '',
});

const validators: Record<ScanField, (raw: string) => string | null> = {
  vin: (raw) => { const v = (raw || '').trim().toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g, ''); return isValidVIN(v) ? v : null; },
  camera_imei: cleanImei,
  go9b_imei: cleanImei,
};

interface Props {
  /** Customer carried over from the last install ("Next vehicle"). */
  startCustomer?: CustomerPick | null;
  /** Edit an existing install instead of creating one. */
  initial?: CameraInstall | null;
  onSaved: (install: CameraInstall) => void;
  onCancel: () => void;
}

export default function CameraInstallCapture({ startCustomer, initial, onSaved, onCancel }: Props) {
  const supabase = createClient();
  const dialog = useDialog();
  const editing = !!initial;

  const [draft, setDraft] = useState<Draft>(initial ? fromInstall(initial) : emptyDraft(startCustomer || undefined));
  const [stage, setStage] = useState<Stage>(initial ? 'review' : startCustomer?.customer_name ? 'vin' : 'customer');
  // Rescanning one field from review returns to review rather than walking on.
  const [singleScan, setSingleScan] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [mode, setMode] = useState<'camera' | 'text'>('camera');
  const [manual, setManual] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [decoding, setDecoding] = useState(false);
  const [vehicleNote, setVehicleNote] = useState('');

  const [custMatches, setCustMatches] = useState<{ id: string; company_name: string; entity_id: string | null }[]>([]);
  const [showContact, setShowContact] = useState(false);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft(d => ({ ...d, [k]: v }));

  // Customer type-ahead over the synced NetSuite customers (same as check-in).
  useEffect(() => {
    if (stage !== 'customer') return;
    const q = draft.customer_name.trim();
    if (draft.customer_id || q.length < 2) { setCustMatches([]); return; }
    const t = setTimeout(async () => {
      const escaped = q.replace(/[%,()]/g, ' ');
      const { data } = await supabase
        .from('customers')
        .select('id, company_name, entity_id')
        .or(`company_name.ilike.%${escaped}%,entity_id.ilike.%${escaped}%`)
        .order('company_name')
        .limit(8);
      setCustMatches((data || []) as typeof custMatches);
    }, 250);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- supabase client is a stable singleton
  }, [draft.customer_name, draft.customer_id, stage]);

  const pickCustomer = async (c: { id: string; company_name: string; entity_id: string | null }) => {
    const name = c.company_name || c.entity_id || draft.customer_name;
    setDraft(d => ({ ...d, customer_id: c.id, customer_name: name }));
    setCustMatches([]);
    // Contact from this customer's last install, if any — techs doing a
    // fleet shouldn't retype it per van.
    try {
      const res = await apiFetch(`/api/camera-installs?customer=${encodeURIComponent(name)}`);
      const json = res.ok ? await res.json() : null;
      const last = (json?.installs || [])[0] as CameraInstall | undefined;
      if (last) {
        setDraft(d => ({
          ...d,
          contact_name: d.contact_name || last.contact_name || '',
          contact_phone: d.contact_phone || last.contact_phone || '',
          contact_email: d.contact_email || last.contact_email || '',
        }));
      }
    } catch { /* prefill is a convenience only */ }
  };

  const goScan = (f: ScanField, single = false) => {
    setPending(null); setManual(''); setError(''); setSingleScan(single); setStage(f);
  };

  /** VIN accepted: fill year/make/model from FleetSuite or the NHTSA decoder. */
  const fillVehicle = async (vin: string) => {
    setDecoding(true);
    setVehicleNote('');
    try {
      const { data: checkin } = await supabase
        .from('fleet_checkins')
        .select('vehicle_year, vehicle_make, vehicle_model, customer_name')
        .eq('vin', vin)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (checkin) {
        setDraft(d => ({
          ...d,
          vehicle_year: checkin.vehicle_year || d.vehicle_year,
          vehicle_make: checkin.vehicle_make || d.vehicle_make,
          vehicle_model: checkin.vehicle_model || d.vehicle_model,
        }));
        setVehicleNote('This vehicle is in FleetSuite. The install will link to its record.');
      }
      if (!checkin?.vehicle_make) {
        const v = await decodeVIN(vin);
        if (v.make) setDraft(d => ({ ...d, vehicle_year: v.year || d.vehicle_year, vehicle_make: v.make || d.vehicle_make, vehicle_model: v.model || d.vehicle_model }));
      }
    } catch { /* year/make/model stay editable on review */ }
    setDecoding(false);
  };

  const accept = (f: ScanField, value: string) => {
    if (f !== 'vin') {
      const other = f === 'camera_imei' ? draft.go9b_imei : draft.camera_imei;
      if (other && other === value) {
        setError(`That's the same number as the ${f === 'camera_imei' ? 'GO9B' : 'camera'} IMEI. Scan the ${LABELS[f]} barcode.`);
        setPending(null);
        return;
      }
    }
    set(f, value);
    if (f === 'vin' && value !== draft.vin) void fillVehicle(value);
    setPending(null); setManual(''); setError('');
    if (singleScan) { setStage('review'); setSingleScan(false); return; }
    const idx = SCAN_ORDER.indexOf(f);
    setStage(idx < SCAN_ORDER.length - 1 ? SCAN_ORDER[idx + 1] : 'review');
  };

  const submitManual = (f: ScanField) => {
    const v = validators[f](manual);
    if (!v) {
      setError(f === 'vin' ? 'That isn’t a valid 17-character VIN.' : `That isn’t a valid IMEI. It should be 15 digits.`);
      return;
    }
    accept(f, v);
  };

  const save = async (allowDuplicate = false) => {
    setError('');
    if (!draft.customer_name.trim()) { setError('Pick the customer.'); return; }
    const odo = draft.odometer.replace(/[^\d]/g, '');
    const body = {
      customer_id: draft.customer_id,
      customer_name: draft.customer_name.trim(),
      contact_name: draft.contact_name, contact_phone: draft.contact_phone, contact_email: draft.contact_email,
      vin: draft.vin,
      vehicle_year: draft.vehicle_year, vehicle_make: draft.vehicle_make, vehicle_model: draft.vehicle_model,
      odometer: odo ? Number(odo) : null,
      license_plate: draft.license_plate,
      camera_imei: draft.camera_imei, go9b_imei: draft.go9b_imei,
      notes: draft.notes,
      allowDuplicate,
    };
    setSaving(true);
    try {
      const res = await apiFetch(editing ? `/api/camera-installs/${initial!.id}` : '/api/camera-installs', {
        method: editing ? 'PATCH' : 'POST',
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      setSaving(false);
      if (res.status === 409 && json.duplicate) {
        const ok = await dialog.confirm(`${json.error}\n\nSave anyway? Only do this if the device was moved to this vehicle.`, { title: 'IMEI already used', confirmLabel: 'Save anyway' });
        if (ok) await save(true);
        return;
      }
      if (!res.ok) { setError(json.error || 'Could not save. Try again.'); return; }
      onSaved(json.install as CameraInstall);
    } catch (err: any) {
      setSaving(false);
      setError(err?.message || 'Network error');
    }
  };

  // ─── Styles ──────────────────────────────────────────────────
  const card: React.CSSProperties = { background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '14px', padding: '14px', marginBottom: '14px' };
  const input: React.CSSProperties = { width: '100%', padding: '12px', borderRadius: '10px', border: `1px solid ${theme.border}`, background: theme.inputBg, color: theme.textPrimary, fontSize: '16px', boxSizing: 'border-box' };
  const label: React.CSSProperties = { fontSize: '11px', fontWeight: 800, letterSpacing: '0.4px', textTransform: 'uppercase', color: theme.textMuted, marginBottom: '4px', display: 'block' };
  const primary: React.CSSProperties = { flex: 1, padding: '14px', borderRadius: '10px', fontSize: '15px', fontWeight: 800, background: '#22c55e', color: '#fff', border: 'none', cursor: 'pointer' };
  const secondary: React.CSSProperties = { padding: '14px 18px', borderRadius: '10px', fontSize: '13px', fontWeight: 700, background: 'transparent', border: `1px solid ${theme.border}`, color: theme.textMuted, cursor: 'pointer' };
  const errorBox = error ? (
    <div style={{ marginTop: '10px', padding: '10px 12px', borderRadius: '10px', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.35)', color: '#ef4444', fontSize: '13px', whiteSpace: 'pre-line' }}>{error}</div>
  ) : null;

  // ─── Progress chips ──────────────────────────────────────────
  const chips = !editing && stage !== 'customer' && (
    <div style={{ display: 'flex', gap: '6px', marginBottom: '10px' }}>
      {SCAN_ORDER.map(f => {
        const val = draft[f];
        const current = stage === f;
        return (
          <button key={f} type="button" disabled={!val && !current} onClick={() => goScan(f, stage === 'review')} style={{
            flex: '1 1 0', minWidth: 0, padding: '8px 6px', borderRadius: '8px', textAlign: 'left',
            border: `1px solid ${val ? 'rgba(34,197,94,0.4)' : current ? 'rgba(59,130,246,0.5)' : theme.border}`,
            background: val ? 'rgba(34,197,94,0.06)' : current ? 'rgba(59,130,246,0.08)' : theme.card,
            opacity: val || current ? 1 : 0.5, cursor: val ? 'pointer' : 'default',
          }}>
            <div style={{ fontSize: '9px', fontWeight: 800, letterSpacing: '0.4px', color: theme.textMuted, textTransform: 'uppercase' }}>{LABELS[f]}</div>
            <div style={{ fontSize: '11px', fontWeight: 700, fontFamily: 'monospace', color: val ? '#22c55e' : theme.textMuted, marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {val ? `…${val.slice(-6)}` : current ? 'scanning…' : '—'}
            </div>
          </button>
        );
      })}
    </div>
  );

  // ─── Customer step ───────────────────────────────────────────
  if (stage === 'customer') {
    return (
      <div style={card}>
        <div style={{ fontSize: '15px', fontWeight: 800, color: theme.textPrimary, marginBottom: '10px' }}>Who is this install for?</div>
        <label style={label}>Customer</label>
        <input
          style={input}
          value={draft.customer_name}
          placeholder="Search customers"
          autoComplete="off"
          onChange={e => setDraft(d => ({ ...d, customer_name: e.target.value, customer_id: null }))}
        />
        {custMatches.length > 0 && (
          <div style={{ border: `1px solid ${theme.border}`, borderRadius: '10px', marginTop: '6px', overflow: 'hidden' }}>
            {custMatches.map(c => (
              <button key={c.id} type="button" onClick={() => void pickCustomer(c)} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '11px 12px', background: theme.card, border: 'none', borderTop: `1px solid ${theme.border}`, color: theme.textPrimary, fontSize: '14px', cursor: 'pointer' }}>
                {c.company_name || c.entity_id}
              </button>
            ))}
          </div>
        )}
        {draft.customer_id && <div style={{ fontSize: '12px', color: '#22c55e', marginTop: '6px' }}>✓ Linked to the customer record</div>}

        <button type="button" onClick={() => setShowContact(s => !s)} style={{ marginTop: '12px', background: 'none', border: 'none', color: '#60a5fa', fontSize: '13px', fontWeight: 700, padding: 0, cursor: 'pointer' }}>
          {showContact ? '− Hide contact' : '+ Contact name, phone, email (optional)'}
        </button>
        {showContact && (
          <div style={{ display: 'grid', gap: '8px', marginTop: '8px' }}>
            <input style={input} placeholder="Contact name" value={draft.contact_name} onChange={e => set('contact_name', e.target.value)} />
            <input style={input} placeholder="Phone number" type="tel" value={draft.contact_phone} onChange={e => set('contact_phone', e.target.value)} />
            <input style={input} placeholder="Email address" type="email" value={draft.contact_email} onChange={e => set('contact_email', e.target.value)} />
          </div>
        )}
        {errorBox}
        <div style={{ display: 'flex', gap: '8px', marginTop: '14px' }}>
          <button type="button" style={secondary} onClick={onCancel}>Cancel</button>
          <button type="button" style={{ ...primary, background: draft.customer_name.trim() ? '#2563eb' : '#64748b' }} disabled={!draft.customer_name.trim()} onClick={() => (draft.vin ? setStage('review') : goScan('vin'))}>
            {draft.vin ? 'Done' : 'Next: scan the VIN'}
          </button>
        </div>
      </div>
    );
  }

  // ─── Scan steps ──────────────────────────────────────────────
  if (stage !== 'review') {
    const f = stage;
    return (
      <div>
        <div style={{ fontSize: '13px', color: theme.textMuted, marginBottom: '8px' }}>
          {draft.customer_name}
          {!editing && <> · <button type="button" onClick={() => setStage('customer')} style={{ background: 'none', border: 'none', color: '#60a5fa', fontSize: '13px', padding: 0, cursor: 'pointer' }}>change</button></>}
        </div>
        {chips}
        <div style={card}>
          <div style={{ display: 'flex', gap: '4px', marginBottom: '10px', background: theme.bg, borderRadius: '8px', padding: '3px' }}>
            {(['camera', 'text'] as const).map(m => (
              <button key={m} type="button" onClick={() => { setMode(m); setPending(null); setError(''); }} style={{
                flex: 1, padding: '8px', borderRadius: '6px', fontSize: '12px', fontWeight: 700, border: 'none', cursor: 'pointer',
                background: mode === m ? 'var(--tab-active-bg)' : 'transparent', color: mode === m ? 'var(--tab-active-color)' : theme.textMuted,
              }}>{m === 'camera' ? 'Camera' : 'Type it'}</button>
            ))}
          </div>
          <div style={{ fontSize: '15px', fontWeight: 800, color: theme.textPrimary }}>
            {singleScan || editing ? 'Rescan the' : `Step ${SCAN_ORDER.indexOf(f) + 1} of 3: scan the`} <span style={{ color: '#60a5fa' }}>{LABELS[f]}</span>
          </div>
          <div style={{ fontSize: '12px', color: theme.textMuted, margin: '2px 0 10px' }}>{HINTS[f]}</div>

          {mode === 'camera' ? (
            <>
              <VinScanner
                onScan={(val) => { setError(''); setPending(val); }}
                continuous
                paused={!!pending}
                validate={f === 'vin' ? undefined : validators[f]}
                scanLabel={LABELS[f]}
                theme={theme}
              />
              {pending && (
                <div style={{ marginTop: '10px', padding: '14px', borderRadius: '12px', background: 'rgba(34,197,94,0.06)', border: '1px solid rgba(34,197,94,0.3)' }}>
                  <div style={{ fontSize: '10px', fontWeight: 700, color: theme.textMuted, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '4px' }}>Captured {LABELS[f]}</div>
                  <div style={{ fontSize: '17px', fontWeight: 800, fontFamily: 'monospace', letterSpacing: '1px', color: theme.textPrimary, marginBottom: '10px', wordBreak: 'break-all' }}>
                    {f === 'vin' ? pending : formatImei(pending)}
                  </div>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button type="button" style={primary} onClick={() => accept(f, pending)}>
                      {singleScan || f === 'go9b_imei' ? 'Confirm' : 'Confirm & Next'}
                    </button>
                    <button type="button" style={secondary} onClick={() => { setPending(null); setError(''); }}>Rescan</button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <div style={{ display: 'flex', gap: '8px' }}>
              <input
                style={{ ...input, fontFamily: 'monospace' }}
                value={manual}
                inputMode={f === 'vin' ? 'text' : 'numeric'}
                autoCapitalize="characters"
                placeholder={f === 'vin' ? '17-character VIN' : '15-digit IMEI'}
                onChange={e => setManual(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') submitManual(f); }}
              />
              <button type="button" style={{ ...primary, flex: '0 0 auto', padding: '0 18px', background: '#2563eb' }} onClick={() => submitManual(f)}>OK</button>
            </div>
          )}
          {errorBox}
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button type="button" style={secondary} onClick={() => (singleScan || editing ? setStage('review') : onCancel())}>
            {singleScan || editing ? 'Back' : 'Cancel'}
          </button>
        </div>
      </div>
    );
  }

  // ─── Review ──────────────────────────────────────────────────
  const scanRow = (f: ScanField) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 0', borderTop: `1px solid ${theme.border}` }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={label}>{LABELS[f]}</div>
        <div style={{ fontFamily: 'monospace', fontSize: '15px', fontWeight: 800, color: theme.textPrimary, wordBreak: 'break-all' }}>
          {draft[f] ? (f === 'vin' ? draft[f] : formatImei(draft[f])) : '—'}
        </div>
      </div>
      <button type="button" style={{ ...secondary, padding: '8px 12px' }} onClick={() => goScan(f, true)}>Rescan</button>
    </div>
  );

  return (
    <div>
      {chips}
      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '8px', marginBottom: '6px' }}>
          <div style={{ fontSize: '15px', fontWeight: 800, color: theme.textPrimary }}>{draft.customer_name}</div>
          <button type="button" onClick={() => setStage('customer')} style={{ background: 'none', border: 'none', color: '#60a5fa', fontSize: '13px', fontWeight: 700, padding: 0, cursor: 'pointer' }}>Change</button>
        </div>
        {scanRow('vin')}
        {scanRow('camera_imei')}
        {scanRow('go9b_imei')}
      </div>

      <div style={card}>
        {vehicleNote && <div style={{ fontSize: '12px', color: '#22c55e', marginBottom: '8px' }}>✓ {vehicleNote}</div>}
        {decoding && <div style={{ fontSize: '12px', color: theme.textMuted, marginBottom: '8px' }}>Looking up the vehicle…</div>}
        <div style={{ display: 'grid', gridTemplateColumns: '80px 1fr 1fr', gap: '8px', marginBottom: '10px' }}>
          <div><label style={label}>Year</label><input style={input} inputMode="numeric" value={draft.vehicle_year} onChange={e => set('vehicle_year', e.target.value)} /></div>
          <div><label style={label}>Make</label><input style={input} value={draft.vehicle_make} onChange={e => set('vehicle_make', e.target.value)} /></div>
          <div><label style={label}>Model</label><input style={input} value={draft.vehicle_model} onChange={e => set('vehicle_model', e.target.value)} /></div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '10px' }}>
          <div><label style={label}>Odometer</label><input style={input} inputMode="numeric" placeholder="Miles" value={draft.odometer} onChange={e => set('odometer', e.target.value)} /></div>
          <div><label style={label}>License plate</label><input style={input} autoCapitalize="characters" value={draft.license_plate} onChange={e => set('license_plate', e.target.value)} /></div>
        </div>
        <label style={label}>Notes</label>
        <textarea style={{ ...input, minHeight: '60px', resize: 'vertical' }} value={draft.notes} onChange={e => set('notes', e.target.value)} />

        <button type="button" onClick={() => setShowContact(s => !s)} style={{ marginTop: '10px', background: 'none', border: 'none', color: '#60a5fa', fontSize: '13px', fontWeight: 700, padding: 0, cursor: 'pointer' }}>
          {showContact ? '− Hide contact' : `+ Contact${draft.contact_name ? `: ${draft.contact_name}` : ' (optional)'}`}
        </button>
        {showContact && (
          <div style={{ display: 'grid', gap: '8px', marginTop: '8px' }}>
            <input style={input} placeholder="Contact name" value={draft.contact_name} onChange={e => set('contact_name', e.target.value)} />
            <input style={input} placeholder="Phone number" type="tel" value={draft.contact_phone} onChange={e => set('contact_phone', e.target.value)} />
            <input style={input} placeholder="Email address" type="email" value={draft.contact_email} onChange={e => set('contact_email', e.target.value)} />
          </div>
        )}
        {errorBox}
      </div>

      <div style={{ display: 'flex', gap: '8px' }}>
        <button type="button" style={secondary} onClick={onCancel}>Cancel</button>
        <button type="button" style={{ ...primary, opacity: saving ? 0.6 : 1 }} disabled={saving || !draft.vin || !draft.camera_imei || !draft.go9b_imei} onClick={() => void save()}>
          {saving ? 'Saving…' : editing ? 'Save changes' : 'Save install'}
        </button>
      </div>
    </div>
  );
}
