'use client';

/**
 * A vendor's details, changed in FleetSuite and sent on to NetSuite (Books
 * part 41, docs/books.md "Customer and vendor details changed in
 * FleetSuite"; owner decisions 2026-10-31: from January 1, 2027 the team
 * works only in FleetSuite). Opened from More → Money & Books → Vendor
 * Details, which finds the vendor by name.
 *
 * Its email and phone, its terms, its addresses (one changed, one added, and
 * which one is its billing address), and its 1099 details: whether it gets a
 * 1099, its legal name and its tax ID. A tax ID typed goes to NetSuite and
 * isn't kept; the screen only ever shows the four digits it ends with. What
 * changes and what NetSuite is sent are src/lib/vendor-details.ts, the same
 * rules /api/vendor-details works the change out by before it sends it.
 * Built switched off (Books → Switches): until it's on, super admins see what
 * a change would send and nothing goes to NetSuite.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';
import TopSaveBar from '@/components/TopSaveBar';
import { apiFetch } from '@/lib/api-client';
import { theme } from '@/lib/theme';
import { deepLinks } from '@/lib/deep-links';
import type { DetailChange } from '@/lib/detail-changes';
import {
  ADDRESS_FIELDS, ADDRESS_MAX, EMAIL_MAX, LEGAL_NAME_MAX, NEW_LINE, PHONE_MAX, REASON_MAX, addressLine, billingLine,
  planVendorDetails,
  type AddressField, type AddressText, type DetailsVendor, type TermsOption, type VendorAddressEdit, type VendorDetailsEdit,
} from '@/lib/vendor-details';

const API = '/api/vendor-details';

interface Loaded {
  vendor: DetailsVendor;
  terms: TermsOption[];
  signature: string;
  changes: DetailChange[];
  switchedOn: boolean;
  offText: string | null;
}

/** A vendor the search found, from the copy of NetSuite's vendor list. */
interface FoundVendor {
  id: string;
  name: string;
  entityId: string | null;
  active: boolean;
}

const newRequestId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));

const EMPTY: AddressText = { addressee: '', attention: '', addr1: '', addr2: '', city: '', state: '', zip: '' };
const textOf = (a: AddressText): AddressText => Object.fromEntries(ADDRESS_FIELDS.map((f) => [f, a[f]])) as AddressText;
const same = (a: AddressText, b: AddressText) => ADDRESS_FIELDS.every((f) => a[f].trim() === b[f]);

const day = (iso: string) => new Date(iso).toLocaleDateString();

const FIELD_LABELS: Record<AddressField, string> = {
  addressee: 'Name on it', attention: 'Attention', addr1: 'Street', addr2: 'Second line', city: 'City', state: 'State', zip: 'Zip',
};
const FIELD_WIDTHS: Record<AddressField, string> = {
  addressee: '100%', attention: '100%', addr1: '100%', addr2: '100%', city: '200px', state: '90px', zip: '120px',
};

const card: React.CSSProperties = {
  background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '12px', padding: '16px',
};
const label: React.CSSProperties = {
  display: 'block', fontSize: '11px', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase',
  color: theme.textMuted, marginBottom: '3px',
};
const input: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: '7px',
  border: `1px solid ${theme.border}`, background: theme.inputBg, color: theme.textPrimary, fontSize: '15px',
};
const btn: React.CSSProperties = {
  padding: '9px 14px', borderRadius: '8px', border: `1px solid ${theme.border}`, background: theme.card,
  color: theme.textPrimary, fontSize: '14px', fontWeight: 700, cursor: 'pointer',
};
const small: React.CSSProperties = { ...btn, padding: '6px 10px', fontSize: '13px' };
const muted: React.CSSProperties = { fontSize: '12px', color: theme.textMuted };
const heading: React.CSSProperties = { fontSize: '15px', fontWeight: 800, color: theme.textPrimary };
/** Two lines at most. */
const twoLines: React.CSSProperties = {
  fontSize: '13px', color: theme.textSecondary, overflow: 'hidden', display: '-webkit-box',
  WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
};

const STATUS_TEXT: Record<DetailChange['status'], string> = {
  changed: 'Changed',
  refused: 'NetSuite refused it',
  unsure: "Couldn't tell whether it went in",
  sending: 'Being sent now',
};

/** An address's boxes. */
function AddressBoxes({ id, value, onChange }: { id: string; value: AddressText; onChange: (v: AddressText) => void }) {
  return (
    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
      {ADDRESS_FIELDS.map((f) => (
        <div key={f} style={{ width: FIELD_WIDTHS[f], maxWidth: '100%' }}>
          <label style={label} htmlFor={`vd-${id}-${f}`}>{FIELD_LABELS[f]}</label>
          <input id={`vd-${id}-${f}`} style={input} value={value[f]} maxLength={ADDRESS_MAX[f]} autoComplete="off"
            onChange={(e) => onChange({ ...value, [f]: e.target.value })} />
        </div>
      ))}
    </div>
  );
}

export default function VendorDetailsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const dialog = useDialog();
  const { hasFeature, canSeeMoney, loading: authLoading } = useAuth();
  const vendorId = (searchParams.get('vendor') || '').trim();
  const allowed = !authLoading && hasFeature('vendor_payments') && canSeeMoney;

  // Made when the vendor is read: the same form pressed twice is one change.
  const [requestId, setRequestId] = useState(newRequestId);
  const [data, setData] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [termsId, setTermsId] = useState('');
  const [gets1099, setGets1099] = useState(false);
  const [legalName, setLegalName] = useState('');
  const [taxId, setTaxId] = useState('');
  const [changingTaxId, setChangingTaxId] = useState(false);
  const [boxes, setBoxes] = useState<Record<string, AddressText>>({});
  const [editing, setEditing] = useState<Record<string, boolean>>({});
  const [added, setAdded] = useState<AddressText | null>(null);
  const [billingId, setBillingId] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadNeeded, setReloadNeeded] = useState(false);
  const [done, setDone] = useState<{ changes: string[]; already: boolean; terms: boolean } | null>(null);
  const [find, setFind] = useState('');
  const [found, setFound] = useState<FoundVendor[] | null>(null);
  const [findError, setFindError] = useState('');

  /** The boxes as NetSuite has the vendor, so a box left alone changes nothing. */
  const fill = useCallback((v: DetailsVendor) => {
    setEmail(v.email);
    setPhone(v.phone);
    setTermsId(v.termsId ?? '');
    setGets1099(v.is1099 === true);
    setLegalName(v.legalName);
    setTaxId('');
    setChangingTaxId(false);
    setBoxes(Object.fromEntries(v.addresses.filter((a) => a.lineId).map((a) => [a.lineId!, textOf(a)])));
    setEditing({});
    setAdded(null);
    setBillingId(billingLine(v)?.lineId ?? '');
  }, []);

  const load = useCallback(async () => {
    if (!/^\d+$/.test(vendorId)) { setLoading(false); return; }
    setLoading(true);
    setLoadError(null);
    try {
      const res = await apiFetch(`${API}?${new URLSearchParams({ vendor: vendorId })}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Couldn't read the vendor from NetSuite (${res.status}).`);
      const loaded = body as Loaded;
      setData(loaded);
      fill(loaded.vendor);
      setReason('');
      setError(null);
      setReloadNeeded(false);
      setDone(null);
      setRequestId(newRequestId());
    } catch (e: any) {
      setLoadError(e?.message || "Couldn't read the vendor from NetSuite.");
    } finally {
      setLoading(false);
    }
  }, [vendorId, fill]);

  useEffect(() => { if (allowed) load(); }, [allowed, load]);

  // With no vendor open: find one by name.
  useEffect(() => {
    if (vendorId || !allowed) return;
    const t = setTimeout(async () => {
      try {
        const res = await apiFetch(`${API}?${new URLSearchParams({ find: find.trim() })}`);
        const body = await res.json().catch(() => ({}));
        setFound(res.ok ? body.vendors ?? [] : []);
        setFindError(res.ok ? '' : body.error || `Couldn't search the vendors (${res.status}).`);
      } catch {
        setFindError("Couldn't reach FleetSuite to search the vendors.");
      }
    }, 300);
    return () => clearTimeout(t);
  }, [find, vendorId, allowed]);

  const vendor = data?.vendor;
  const termsList = useMemo(() => new Map((data?.terms ?? []).map((t) => [t.id, t])), [data]);
  const startBilling = vendor ? billingLine(vendor)?.lineId ?? '' : '';

  // Only what was changed goes: a box left as NetSuite has it isn't sent.
  const edit: VendorDetailsEdit = { reason };
  if (vendor) {
    if (email !== vendor.email) edit.email = email;
    if (phone !== vendor.phone) edit.phone = phone;
    if (termsId !== (vendor.termsId ?? '')) edit.termsId = termsId;
    if (gets1099 !== (vendor.is1099 === true)) edit.is1099 = gets1099;
    if (legalName !== vendor.legalName) edit.legalName = legalName;
    if (taxId.trim()) edit.taxId = taxId;
    const addresses: VendorAddressEdit[] = [];
    for (const a of vendor.addresses) {
      const b = a.lineId ? boxes[a.lineId] : undefined;
      if (a.lineId && b && !same(b, a)) addresses.push({ lineId: a.lineId, ...b });
    }
    if (added) addresses.push({ lineId: NEW_LINE, ...added });
    if (addresses.length) edit.addresses = addresses;
    if (billingId !== startBilling) edit.billingLineId = billingId;
  }
  const plan = useMemo(
    () => (vendor ? planVendorDetails(vendor, edit, { terms: termsList }) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- edit derives from the boxes
    [vendor, email, phone, termsId, gets1099, legalName, taxId, boxes, added, billingId, reason, termsList],
  );
  const started = Object.keys(edit).length > 1;

  const send = async () => {
    if (!data || !vendor || !plan || plan.problems.length > 0 || !data.switchedOn) return;
    const n = plan.changes.length;
    const ok = await dialog.confirm(
      `Change ${vendor.name} in NetSuite? ${n === 1 ? 'One change' : `${n} changes`}.`,
      { confirmLabel: 'Save to NetSuite', title: 'Change vendor' },
    );
    if (!ok) return;
    setSubmitting(true);
    setError(null);
    setReloadNeeded(false);
    try {
      const res = await apiFetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId, vendorId: vendor.id, signature: data.signature, ...edit }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.success) {
        if (body.stale || body.unsure) setReloadNeeded(true);
        throw new Error(body.error || `NetSuite didn't take the change (${res.status}).`);
      }
      setTaxId('');
      setDone({ changes: Array.isArray(body.changes) ? body.changes : plan.changes, already: !!body.already, terms: plan.body.terms !== undefined });
    } catch (e: any) {
      setError(e?.message || "NetSuite didn't take the change.");
    } finally {
      setSubmitting(false);
    }
  };

  if (!authLoading && (!hasFeature('vendor_payments') || !canSeeMoney)) {
    return <div style={{ padding: '24px', color: theme.error }}>You need the Vendor Payments permission and price access to change a vendor&apos;s details.</div>;
  }

  const back = () => router.push('/more');
  const startOver = () => { if (vendor) fill(vendor); };

  const billingChoice = (id: string, text: string) => (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '13px', fontWeight: 700, color: theme.textSecondary, cursor: 'pointer' }}>
      <input type="radio" name="vd-billing" checked={billingId === id} onChange={() => setBillingId(id)} />
      {text}
    </label>
  );

  return (
    <div style={{ maxWidth: '760px', margin: '0 auto', padding: '16px', display: 'grid', gap: '14px' }}>
      {!done && vendor && plan && (
        <TopSaveBar
          title="Change vendor"
          subtitle={vendor.name}
          error={error || undefined}
          onSave={send}
          saving={submitting}
          disabled={!data?.switchedOn || plan.problems.length > 0}
          saveLabel={data?.switchedOn ? 'Save to NetSuite' : 'Switched off'}
          savingLabel="Saving to NetSuite…"
          onCancel={back}
        />
      )}
      <div>
        <button onClick={back} style={{ ...btn, padding: '4px 0', border: 'none', background: 'none', color: theme.textMuted, fontSize: '13px' }}>← More</button>
        <h1 style={{ margin: '4px 0 0', fontSize: '22px', fontWeight: 800, color: theme.textPrimary }}>Vendor details</h1>
        <div style={{ fontSize: '13px', color: theme.textMuted }}>A vendor&apos;s email, phone, terms, addresses and 1099 details, changed in NetSuite as you save them here.</div>
      </div>

      {data?.offText && !done && (
        <div style={{ ...card, borderColor: theme.warningBorder, background: theme.warningBg, color: theme.warning, fontSize: '14px', fontWeight: 700 }}>
          {data.offText}
        </div>
      )}

      {!/^\d+$/.test(vendorId) ? (
        <div style={{ ...card, display: 'grid', gap: '10px' }}>
          <div>
            <label style={label} htmlFor="vd-find">Find the vendor</label>
            <input id="vd-find" style={input} value={find} autoComplete="off" placeholder="The vendor's name"
              onChange={(e) => setFind(e.target.value)} />
          </div>
          {findError && <div style={{ fontSize: '13px', color: theme.error, fontWeight: 700 }}>{findError}</div>}
          {found === null && !findError && <div style={muted}>Reading the vendors…</div>}
          {found && found.length === 0 && !findError && <div style={muted}>No vendor in the copy of NetSuite&apos;s vendors matches that.</div>}
          {found && found.map((f) => (
            <button key={f.id} type="button" onClick={() => router.push(deepLinks.vendorDetails(f.id))} style={{
              display: 'grid', gap: '2px', textAlign: 'left', padding: '10px', borderRadius: '10px', border: `1px solid ${theme.border}`,
              background: theme.card, color: theme.textPrimary, cursor: 'pointer', fontFamily: 'inherit',
            }}>
              <b>{f.name}</b>
              <span style={muted}>{[f.entityId, f.active ? '' : 'Inactive in NetSuite'].filter(Boolean).join(' · ') || `NetSuite vendor ${f.id}`}</span>
            </button>
          ))}
          <div style={muted}>The copy of NetSuite&apos;s vendors catches up every two hours; the vendor opens as NetSuite has it now.</div>
        </div>
      ) : loading ? (
        <div style={{ ...card, color: theme.textMuted, fontSize: '14px' }}>Reading the vendor from NetSuite…</div>
      ) : loadError || !vendor || !plan ? (
        <div style={{ ...card, display: 'grid', gap: '10px' }}>
          <div style={{ color: theme.error, fontSize: '14px', fontWeight: 700 }}>{loadError || "Couldn't read the vendor from NetSuite."}</div>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <button onClick={load} style={btn}>Try again</button>
            <button onClick={() => router.push(deepLinks.vendorDetails())} style={btn}>Find another vendor</button>
          </div>
        </div>
      ) : done ? (
        <div style={{ ...card, borderColor: theme.successBorder, background: theme.successBg, display: 'grid', gap: '10px' }}>
          <div style={{ fontSize: '17px', fontWeight: 800, color: theme.success }}>
            {vendor.name} {done.already ? 'was already changed' : 'changed in NetSuite'}
          </div>
          <div style={{ display: 'grid', gap: '2px', fontSize: '14px', color: theme.textPrimary }}>
            {done.changes.map((c) => <div key={c}>{c}</div>)}
          </div>
          {done.terms && <div style={muted}>Its bills already made keep their terms; new ones take these.</div>}
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <button onClick={load} style={btn}>Change something else</button>
            <button onClick={() => router.push(deepLinks.vendorDetails())} style={btn}>Find another vendor</button>
            <button onClick={back} style={btn}>Back to More</button>
          </div>
        </div>
      ) : (
        <>
          <div style={{ ...card, display: 'grid', gap: '4px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'baseline' }}>
              <div style={{ fontSize: '17px', fontWeight: 800, color: theme.textPrimary }}>{vendor.name}</div>
              {started && <button onClick={startOver} style={small}>Start over</button>}
            </div>
            <div style={muted}>
              {[vendor.entityId !== vendor.name ? vendor.entityId : '', vendor.isPerson ? 'A person' : '', vendor.inactive ? 'Inactive in NetSuite' : '']
                .filter(Boolean).join(' · ') || `NetSuite vendor ${vendor.id}`}
            </div>
          </div>

          <div style={{ ...card, display: 'grid', gap: '10px' }}>
            <div style={heading}>Contact and terms</div>
            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
              <div style={{ flex: '1 1 260px' }}>
                <label style={label} htmlFor="vd-email">Email</label>
                <input id="vd-email" style={input} type="email" value={email} maxLength={EMAIL_MAX} autoComplete="off"
                  onChange={(e) => setEmail(e.target.value)} />
              </div>
              <div style={{ flex: '0 1 200px' }}>
                <label style={label} htmlFor="vd-phone">Phone</label>
                <input id="vd-phone" style={input} type="tel" value={phone} maxLength={PHONE_MAX} autoComplete="off"
                  onChange={(e) => setPhone(e.target.value)} />
              </div>
            </div>
            <div>
              <label style={label} htmlFor="vd-terms">Terms</label>
              <select id="vd-terms" style={input} value={termsId} onChange={(e) => setTermsId(e.target.value)}>
                {!vendor.termsId && <option value="">None</option>}
                {vendor.termsId && !termsList.has(vendor.termsId) && (
                  <option value={vendor.termsId}>{vendor.termsName || `Terms ${vendor.termsId}`} (not in NetSuite&apos;s list now)</option>
                )}
                {(data?.terms ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
              <div style={{ ...muted, marginTop: '3px' }}>What its new bills are due by. Bills already made keep theirs.</div>
            </div>
          </div>

          <div style={{ ...card, display: 'grid', gap: '10px' }}>
            <div style={heading}>Addresses</div>
            {vendor.addresses.length === 0 && !added && <div style={muted}>NetSuite has no address for this vendor.</div>}
            {vendor.addresses.map((a, i) => {
              if (!a.lineId) {
                return (
                  <div key={`noid-${i}`} style={{ padding: '10px', borderRadius: '10px', border: `1px solid ${theme.border}`, display: 'grid', gap: '2px' }}>
                    <div style={{ fontSize: '14px', color: theme.textPrimary }}>{addressLine(a)}</div>
                    <div style={muted}>NetSuite gave this address no id, so FleetSuite can&apos;t change it.</div>
                  </div>
                );
              }
              const id = a.lineId;
              const b = boxes[id] ?? textOf(a);
              const changed = !same(b, a);
              return (
                <div key={id} style={{
                  padding: '10px', borderRadius: '10px', border: `1px solid ${changed ? theme.successBorder : theme.border}`, display: 'grid', gap: '8px',
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'flex-start' }}>
                    <div style={{ minWidth: 0 }}>
                      {a.label && a.label !== a.addr1 && <div style={{ ...muted, fontWeight: 700 }}>{a.label}</div>}
                      <div style={{ fontSize: '14px', color: theme.textPrimary }}>{addressLine(b)}</div>
                      {changed && <div style={{ ...muted, textDecoration: 'line-through' }}>{addressLine(a)}</div>}
                    </div>
                    {!editing[id] && <button onClick={() => setEditing((p) => ({ ...p, [id]: true }))} style={small}>Change</button>}
                  </div>
                  {editing[id] && <AddressBoxes id={id} value={b} onChange={(v) => setBoxes((p) => ({ ...p, [id]: v }))} />}
                  <div>{billingChoice(id, 'Billing address')}</div>
                </div>
              );
            })}
            {added ? (
              <div style={{ padding: '10px', borderRadius: '10px', border: `1px solid ${theme.successBorder}`, display: 'grid', gap: '8px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'baseline' }}>
                  <span style={{ fontWeight: 800, color: theme.textPrimary }}>New address</span>
                  <button onClick={() => { setAdded(null); if (billingId === NEW_LINE) setBillingId(startBilling); }}
                    style={{ ...small, color: theme.error, borderColor: theme.errorBorder }}>Remove</button>
                </div>
                <AddressBoxes id="new" value={added} onChange={setAdded} />
                {vendor.addresses.length > 0
                  ? <div>{billingChoice(NEW_LINE, 'Billing address')}</div>
                  : <div style={muted}>Its first address is its billing address.</div>}
              </div>
            ) : (
              <div><button onClick={() => setAdded({ ...EMPTY })} style={small}>+ Address</button></div>
            )}
            <div style={muted}>The one marked is its billing address in NetSuite. No address is taken off here.</div>
          </div>

          <div style={{ ...card, display: 'grid', gap: '10px' }}>
            <div style={heading}>1099</div>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', fontSize: '14px', fontWeight: 700, color: theme.textPrimary, cursor: 'pointer' }}>
              <input type="checkbox" checked={gets1099} onChange={(e) => setGets1099(e.target.checked)} />
              Gets a 1099
              {vendor.is1099 === null && <span style={{ ...muted, fontWeight: 600 }}>(NetSuite didn&apos;t say)</span>}
            </label>
            <div>
              <label style={label} htmlFor="vd-legal">Legal name</label>
              <input id="vd-legal" style={input} value={legalName} maxLength={LEGAL_NAME_MAX} autoComplete="off" placeholder="As on its W-9"
                onChange={(e) => setLegalName(e.target.value)} />
            </div>
            <div>
              <label style={label} htmlFor="vd-tax">Tax ID</label>
              {changingTaxId ? (
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                  <input id="vd-tax" style={{ ...input, width: '200px' }} value={taxId} maxLength={20} autoComplete="off" inputMode="numeric"
                    placeholder="12-3456789" onChange={(e) => setTaxId(e.target.value)} />
                  <button onClick={() => { setTaxId(''); setChangingTaxId(false); }} style={small}>Keep the one it has</button>
                </div>
              ) : (
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '14px', color: theme.textPrimary }}>
                    {vendor.taxIdEnding ? `Ending ${vendor.taxIdEnding}` : vendor.hasTaxId ? 'On file in NetSuite'
                      : vendor.hasTaxId === false ? 'None in NetSuite' : "NetSuite didn't say"}
                  </span>
                  <button onClick={() => setChangingTaxId(true)} style={small}>{vendor.hasTaxId ? 'Change' : 'Add'}</button>
                </div>
              )}
              <div style={{ ...muted, marginTop: '3px' }}>FleetSuite never keeps a tax ID: it goes to NetSuite, and only the four digits it ends with show here.</div>
            </div>
          </div>

          <div style={{ ...card, display: 'grid', gap: '4px' }}>
            <label style={label} htmlFor="vd-reason">Why it&apos;s being changed</label>
            <input id="vd-reason" style={input} value={reason} maxLength={REASON_MAX} placeholder="New W-9, moved to a new remit address, new terms agreed…"
              onChange={(e) => setReason(e.target.value)} />
            <div style={muted}>Kept with the change in FleetSuite, for whoever looks at the vendor next.</div>
          </div>

          {plan.changes.length > 0 && (
            <div style={{ ...card, display: 'grid', gap: '4px' }}>
              <div style={heading}>What changes</div>
              {plan.changes.map((c) => <div key={c} style={{ fontSize: '14px', color: theme.textPrimary }}>{c}</div>)}
              {plan.notes.map((n) => <div key={n} style={muted}>{n}</div>)}
            </div>
          )}
          {started && plan.problems.length > 0 && (
            <div style={{ color: theme.error, fontSize: '14px', fontWeight: 700, display: 'grid', gap: '2px' }}>
              {plan.problems.map((p) => <div key={p}>{p}</div>)}
            </div>
          )}
          {error && reloadNeeded && <div><button onClick={load} style={btn}>Reload the vendor</button></div>}

          {data.changes.length > 0 && (
            <div style={{ ...card, display: 'grid', gap: '8px' }}>
              <div style={heading}>Changed before</div>
              {data.changes.map((x) => (
                <div key={x.id} style={{ display: 'grid', gap: '2px', fontSize: '13px', color: theme.textPrimary }}>
                  <span style={{ minWidth: 0 }}>
                    <b style={{ color: x.status === 'changed' ? theme.textPrimary : x.status === 'sending' ? theme.warning : theme.error }}>
                      {STATUS_TEXT[x.status]}
                    </b>
                    <span style={{ color: theme.textMuted }}> · {day(x.at)}{x.by ? ` · ${x.by}` : ''} · {x.reason}</span>
                  </span>
                  <div style={twoLines}>{x.changes.join(' · ')}</div>
                  {x.error && x.status !== 'changed' && <div style={{ fontSize: '12px', color: theme.error }}>{x.error}</div>}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
