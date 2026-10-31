'use client';

/**
 * A vendor's credit, entered in FleetSuite and made in NetSuite (Books part
 * 35, docs/books.md "Vendor credits made in FleetSuite"; owner decisions
 * 2026-10-31: from January 1, 2027 the team works only in FleetSuite, apart
 * from payments). Opened from More → Purchasing → Vendor Credits.
 *
 * Enter the vendor's credit by its own number and date, then what it's for:
 * money back to an account, or a part going back to the vendor by quantity
 * and rate. Apply it to the vendor's open bills, oldest first or by hand;
 * what isn't applied stays open on the vendor for NetSuite to apply when the
 * vendor is paid. The rules are src/lib/vendor-credit.ts, the same ones
 * /api/purchasing/vendor-credit works the credit out by before it makes it.
 * Built switched off (Books → Switches): until it's on, super admins see
 * what it would send and nothing goes to NetSuite.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';
import TopSaveBar from '@/components/TopSaveBar';
import { apiFetch } from '@/lib/api-client';
import { theme } from '@/lib/theme';
import {
  CREDIT_NUMBER_MAX, MAX_VENDOR_CREDIT_LINES, PART_COMPANY, accountName, applyOldestFirst, formatCents, workOutVendorCredit,
  type CreditAccount, type CreditCompany, type CreditLineDraft, type CreditPart, type OpenBill, type VendorCreditDraft,
} from '@/lib/vendor-credit';

const API = '/api/purchasing/vendor-credit';

interface Recent {
  id: string;
  vendorName: string | null;
  number: string;
  date: string;
  totalCents: number | null;
  vendorCreditId: string | null;
  state: 'made' | 'making' | 'refused';
  error: string | null;
  at: string;
}

interface Loaded {
  companies: CreditCompany[];
  accounts: CreditAccount[];
  today: string;
  stockLocationId: string;
  recent: Recent[];
  switchedOn: boolean;
  offText: string | null;
}

/** The vendor's bills and credits NetSuite has open now, for one company. */
interface VendorOpen {
  vendorId: string;
  company: string;
  expenseAccountId: string | null;
  openBills: OpenBill[] | null;
  openCredits: OpenBill[] | null;
  openError: string | null;
}

/** What's typed on one line. */
type Line =
  | { key: number; kind: 'account'; accountId: string; amountText: string; memo: string }
  | { key: number; kind: 'part'; itemId: string | null; query: string; quantityText: string; rateText: string; rateFromCost: boolean };

interface Done {
  vendorCreditId: string;
  number: string;
  vendorName: string | null;
  totalCents: number | null;
  appliedCents: number | null;
  already?: boolean;
  warning?: string;
}

const newRequestId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));

/** A typed amount or quantity; blank is 0. */
const typed = (text: string) => (text.trim() === '' ? 0 : Number(text.replace(/[$,\s]/g, '')));

const moneyBox = (cents: number) => (cents / 100).toFixed(2);

const day = (ymd: string | null) => (ymd ? new Date(`${ymd.slice(0, 10)}T12:00:00`).toLocaleDateString() : '');

/** O'Fallon for the company that keeps stock; otherwise its only location, or none. */
const startingLocation = (company: CreditCompany | undefined, stockLocationId: string) => {
  if (!company) return null;
  if (company.locations.some((l) => l.id === stockLocationId)) return stockLocationId;
  return company.locations.length === 1 ? company.locations[0].id : null;
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
const num: React.CSSProperties = { textAlign: 'right', fontVariantNumeric: 'tabular-nums' };
const muted: React.CSSProperties = { fontSize: '12px', color: theme.textMuted };
const heading: React.CSSProperties = { fontSize: '15px', fontWeight: 800, color: theme.textPrimary };
/** Two lines at most, so a long description doesn't push the boxes off the screen. */
const twoLines: React.CSSProperties = {
  fontSize: '13px', color: theme.textSecondary, overflow: 'hidden', display: '-webkit-box',
  WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
};
const hitList: React.CSSProperties = {
  position: 'absolute', zIndex: 5, left: 0, right: 0, marginTop: '2px', border: `1px solid ${theme.border}`,
  borderRadius: '8px', background: theme.card, boxShadow: '0 6px 20px rgba(0,0,0,0.35)', maxHeight: '280px', overflowY: 'auto',
};
const hit: React.CSSProperties = {
  display: 'block', width: '100%', textAlign: 'left', padding: '9px 10px', border: 'none', background: 'none',
  color: theme.textPrimary, fontSize: '14px', cursor: 'pointer', fontFamily: 'inherit',
};

export default function VendorCreditPage() {
  const router = useRouter();
  const dialog = useDialog();
  const { hasFeature, canSeeMoney, loading: authLoading } = useAuth();

  const [requestId, setRequestId] = useState(newRequestId);
  const [data, setData] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [company, setCompany] = useState('');
  const [vendorId, setVendorId] = useState<string | null>(null);
  const [vendorName, setVendorName] = useState('');
  const [vendorHits, setVendorHits] = useState<Array<{ id: string; name: string }>>([]);
  const [vendorSearchError, setVendorSearchError] = useState('');
  const [number, setNumber] = useState('');
  const [date, setDate] = useState('');
  const [locationId, setLocationId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [nextKey, setNextKey] = useState(1);
  const [parts, setParts] = useState<Record<string, CreditPart>>({});
  const [partHits, setPartHits] = useState<{ key: number; parts: CreditPart[]; error: string } | null>(null);
  const [open, setOpen] = useState<VendorOpen | null>(null);
  const [openLoading, setOpenLoading] = useState(false);
  /** The bills picked, by NetSuite id, with what's typed to apply to each. */
  const [applied, setApplied] = useState<Record<string, string>>({});

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);

  const vendorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const partTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const allowed = !authLoading && hasFeature('parts_ordering') && canSeeMoney;

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await apiFetch(API);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Couldn't open vendor credits (${res.status}).`);
      const loaded = body as Loaded;
      setData(loaded);
      const first = loaded.companies.find((c) => c.code === PART_COMPANY) ?? loaded.companies[0];
      setCompany((was) => was || first?.code || '');
      setDate((was) => was || loaded.today);
      setLocationId((was) => was ?? startingLocation(first, loaded.stockLocationId));
    } catch (e: any) {
      setLoadError(e?.message || "Couldn't open vendor credits.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (allowed) load(); }, [allowed, load]);

  // The vendor's open bills and credits in NetSuite, read again whenever the vendor or the company changes.
  useEffect(() => {
    setApplied({});
    setOpen(null);
    if (!vendorId || !company) { setOpenLoading(false); return; }
    let cancelled = false;
    setOpenLoading(true);
    (async () => {
      try {
        const res = await apiFetch(`${API}?${new URLSearchParams({ vendor: vendorId, company })}`);
        const body = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) {
          setOpen({ vendorId, company, expenseAccountId: null, openBills: null, openCredits: null, openError: body.error || `NetSuite didn't answer (${res.status}).` });
        } else {
          setOpen({
            vendorId, company, expenseAccountId: body.vendor?.expenseAccountId ?? null,
            openBills: body.openBills ?? null, openCredits: body.openCredits ?? null, openError: body.openError ?? null,
          });
        }
      } catch {
        if (!cancelled) setOpen({ vendorId, company, expenseAccountId: null, openBills: null, openCredits: null, openError: "Couldn't reach FleetSuite." });
      } finally {
        if (!cancelled) setOpenLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [vendorId, company]);

  const companyRow = data?.companies.find((c) => c.code === company);
  const accounts = useMemo(() => new Map((data?.accounts ?? []).map((a) => [a.id, a])), [data]);
  const companyAccounts = (data?.accounts ?? []).filter((a) => a.companies.includes(company));
  const openBills = open?.openBills ?? null;

  const draftLines: CreditLineDraft[] = lines.map((l): CreditLineDraft => (l.kind === 'account'
    ? { kind: 'account', accountId: l.accountId || null, amount: typed(l.amountText), ...(l.memo.trim() ? { memo: l.memo } : {}) }
    : { kind: 'part', itemId: l.itemId, quantity: typed(l.quantityText), rate: typed(l.rateText) }));
  const order = new Map((openBills ?? []).map((b, i) => [b.id, i]));
  const draftApplied = Object.entries(applied)
    .sort(([a], [b]) => (order.get(a) ?? Infinity) - (order.get(b) ?? Infinity))
    .map(([billId, text]) => ({ billId, amount: typed(text) }));
  const draft: VendorCreditDraft = {
    company, vendorId, number, date, locationId, reason, lines: draftLines, applied: draftApplied,
  };
  const worked = data
    ? workOutVendorCredit(draft, {
      today: data.today,
      companies: data.companies,
      accounts,
      parts: new Map(Object.entries(parts)),
      vendor: vendorId ? { id: vendorId, name: vendorName } : null,
      openBills: open ? openBills : [],
    })
    : null;

  const searchVendors = (text: string) => {
    if (vendorTimer.current) clearTimeout(vendorTimer.current);
    if (text.trim().length < 2) { setVendorHits([]); return; }
    vendorTimer.current = setTimeout(async () => {
      try {
        const res = await apiFetch(`${API}?${new URLSearchParams({ vendors: text })}`);
        const body = await res.json().catch(() => ({}));
        setVendorHits(res.ok ? body.vendors ?? [] : []);
        setVendorSearchError(res.ok ? '' : body.error || `Vendor search failed (${res.status}).`);
      } catch {
        setVendorSearchError("Couldn't reach FleetSuite to search the vendors.");
      }
    }, 300);
  };

  const searchParts = (key: number, text: string) => {
    if (partTimer.current) clearTimeout(partTimer.current);
    if (text.trim().length < 2) { setPartHits(null); return; }
    partTimer.current = setTimeout(async () => {
      try {
        const res = await apiFetch(`${API}?${new URLSearchParams({ parts: text })}`);
        const body = await res.json().catch(() => ({}));
        setPartHits({ key, parts: res.ok ? body.parts ?? [] : [], error: res.ok ? '' : body.error || `Part search failed (${res.status}).` });
      } catch {
        setPartHits({ key, parts: [], error: "Couldn't reach FleetSuite to search the parts." });
      }
    }, 300);
  };

  const pickCompany = (code: string) => {
    setCompany(code);
    setLocationId(startingLocation(data?.companies.find((c) => c.code === code), data?.stockLocationId ?? ''));
  };

  const patchLine = (key: number, p: Partial<Line>) =>
    setLines((prev) => prev.map((l) => (l.key === key ? ({ ...l, ...p } as Line) : l)));
  const addAccountLine = () => {
    // The vendor's usual expense account, when this company can use it.
    const usual = open?.expenseAccountId && accounts.get(open.expenseAccountId)?.companies.includes(company) ? open.expenseAccountId : '';
    setLines((prev) => [...prev, { key: nextKey, kind: 'account', accountId: usual, amountText: '', memo: '' }]);
    setNextKey((k) => k + 1);
  };
  const addPartLine = () => {
    setLines((prev) => [...prev, { key: nextKey, kind: 'part', itemId: null, query: '', quantityText: '', rateText: '', rateFromCost: true }]);
    setNextKey((k) => k + 1);
  };
  // The rate starts at what BMG pays for the part, and follows the part picked until someone types a rate.
  const pickPart = (key: number, part: CreditPart) => {
    setParts((prev) => ({ ...prev, [part.id]: part }));
    setPartHits(null);
    setLines((prev) => prev.map((l) => (l.key === key && l.kind === 'part'
      ? {
        ...l, itemId: part.id, query: part.itemNumber,
        quantityText: l.quantityText || '1',
        ...(l.rateFromCost || !l.rateText.trim()
          ? { rateText: part.cost != null ? String(Number(part.cost.toFixed(5))) : '', rateFromCost: true }
          : {}),
      }
      : l)));
  };

  const toggleBill = (bill: OpenBill, on: boolean) => {
    setApplied((prev) => {
      const next = { ...prev };
      if (!on) { delete next[bill.id]; return next; }
      // What's left of the credit, up to what the bill has open; all of the bill when nothing's left.
      const left = (worked?.totalCents ?? 0) - (worked?.appliedCents ?? 0);
      next[bill.id] = moneyBox(left > 0 ? Math.min(left, bill.openCents) : bill.openCents);
      return next;
    });
  };
  const applyOldest = () => {
    if (!openBills || !worked) return;
    setApplied(Object.fromEntries(applyOldestFirst(openBills, worked.totalCents).map((a) => [a.billId, a.amount.toFixed(2)])));
  };

  const startOver = () => {
    const first = data?.companies.find((c) => c.code === PART_COMPANY) ?? data?.companies[0];
    setRequestId(newRequestId());
    setCompany(first?.code || '');
    setVendorId(null);
    setVendorName('');
    setVendorHits([]);
    setNumber('');
    setDate(data?.today || '');
    setLocationId(startingLocation(first, data?.stockLocationId ?? ''));
    setReason('');
    setLines([]);
    setApplied({});
    setError(null);
    setDone(null);
    load();
  };

  const make = async () => {
    if (!data || !worked || worked.problems.length > 0 || !data.switchedOn) return;
    const bills = worked.applied.length;
    const back = worked.lines.filter((l) => l.stock).length;
    const ok = await dialog.confirm(
      `Make vendor credit ${number.trim()} from ${vendorName} in NetSuite for ${formatCents(worked.totalCents)}?`
        + (bills > 0 ? ` ${formatCents(worked.appliedCents)} goes against ${bills === 1 ? 'one bill' : `${bills} bills`}.` : '')
        + (worked.leftCents > 0 ? ` ${formatCents(worked.leftCents)} stays open on the vendor.` : '')
        + (back > 0 ? ` ${back === 1 ? 'One part comes' : `${back} parts come`} off the shelf at O'Fallon.` : ''),
      { confirmLabel: 'Make vendor credit', title: 'Make vendor credit' },
    );
    if (!ok) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiFetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId, ...draft, expectedTotalCents: worked.totalCents }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.success) throw new Error(body.error || `NetSuite didn't make the vendor credit (${res.status}).`);
      setDone({
        vendorCreditId: body.vendorCreditId, number: body.number, vendorName: body.vendorName,
        totalCents: body.totalCents ?? null, appliedCents: body.appliedCents ?? null, already: body.already, warning: body.warning,
      });
    } catch (e: any) {
      setError(e?.message || "NetSuite didn't make the vendor credit.");
    } finally {
      setSubmitting(false);
    }
  };

  if (!authLoading && (!hasFeature('parts_ordering') || !canSeeMoney)) {
    return <div style={{ padding: '24px', color: theme.error }}>You need the Parts Ordering permission and price access to enter vendor credits.</div>;
  }

  const back = () => router.push('/more');
  const started = !!vendorId || number.trim() !== '' || reason.trim() !== '' || lines.length > 0;
  const appliedIds = new Set(Object.keys(applied));

  return (
    <div style={{ maxWidth: '820px', margin: '0 auto', padding: '16px', display: 'grid', gap: '14px' }}>
      {!done && data && worked && (
        <TopSaveBar
          title="Vendor credit"
          subtitle={vendorId ? vendorName : 'Purchasing'}
          error={error || undefined}
          onSave={make}
          saving={submitting}
          disabled={!data.switchedOn || worked.problems.length > 0}
          saveLabel={data.switchedOn ? 'Make vendor credit' : 'Switched off'}
          savingLabel="Making vendor credit…"
          onCancel={back}
        />
      )}
      <div>
        <button onClick={back} style={{ ...btn, padding: '4px 0', border: 'none', background: 'none', color: theme.textMuted, fontSize: '13px' }}>← More</button>
        <h1 style={{ margin: '4px 0 0', fontSize: '22px', fontWeight: 800, color: theme.textPrimary }}>Vendor credit</h1>
        <div style={{ fontSize: '13px', color: theme.textMuted }}>A vendor&apos;s credit, made in NetSuite and applied to their open bills.</div>
      </div>

      {data?.offText && !done && (
        <div style={{ ...card, borderColor: theme.warningBorder, background: theme.warningBg, color: theme.warning, fontSize: '14px', fontWeight: 700 }}>
          {data.offText}
        </div>
      )}

      {loading && !data ? (
        <div style={{ ...card, color: theme.textMuted, fontSize: '14px' }}>Opening vendor credits…</div>
      ) : loadError || !data || !worked ? (
        <div style={{ ...card, display: 'grid', gap: '10px' }}>
          <div style={{ color: theme.error, fontSize: '14px', fontWeight: 700 }}>{loadError || "Couldn't open vendor credits."}</div>
          <div><button onClick={load} style={btn}>Try again</button></div>
        </div>
      ) : done ? (
        <div style={{ ...card, borderColor: theme.successBorder, background: theme.successBg, display: 'grid', gap: '10px' }}>
          <div style={{ fontSize: '17px', fontWeight: 800, color: theme.success }}>
            Vendor credit {done.number} {done.already ? 'was already made' : 'made'} in NetSuite
          </div>
          <div style={{ fontSize: '14px', color: theme.textPrimary }}>
            {[done.vendorName, done.totalCents != null ? formatCents(done.totalCents) : '',
              done.appliedCents ? `${formatCents(done.appliedCents)} applied to bills` : ''].filter(Boolean).join(' · ')}
          </div>
          {done.warning && <div style={{ fontSize: '13px', color: theme.error, fontWeight: 700 }}>{done.warning}</div>}
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <button onClick={startOver} style={btn}>Enter another</button>
            <button onClick={back} style={btn}>Back to More</button>
          </div>
        </div>
      ) : (
        <>
          <div style={{ ...card, display: 'grid', gap: '12px' }}>
            {data.companies.length > 1 && (
              <div>
                <div style={label}>Company</div>
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                  {data.companies.map((c) => (
                    <button key={c.code} type="button" onClick={() => pickCompany(c.code)} aria-pressed={c.code === company}
                      style={{ ...small, borderColor: c.code === company ? theme.successBorder : theme.border, background: c.code === company ? theme.successBg : theme.card }}>
                      {c.name}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div>
              <label style={label} htmlFor="vc-vendor">Vendor</label>
              <div style={{ position: 'relative' }}>
                <input id="vc-vendor" style={input} value={vendorName} autoComplete="off" placeholder="Type to find the vendor in NetSuite"
                  onChange={(e) => { setVendorName(e.target.value); setVendorId(null); searchVendors(e.target.value); }} />
                {!vendorId && vendorHits.length > 0 && (
                  <div style={hitList}>
                    {vendorHits.map((v) => (
                      <button key={v.id} type="button" style={hit} onClick={() => { setVendorHits([]); setVendorId(v.id); setVendorName(v.name); }}>
                        {v.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {vendorSearchError && <div style={{ ...muted, color: theme.error, fontWeight: 700 }}>{vendorSearchError}</div>}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '10px' }}>
              <div>
                <label style={label} htmlFor="vc-number">Vendor&apos;s credit number</label>
                <input id="vc-number" style={input} value={number} maxLength={CREDIT_NUMBER_MAX} autoComplete="off" placeholder="On the vendor's credit"
                  onChange={(e) => setNumber(e.target.value)} />
              </div>
              <div>
                <label style={label} htmlFor="vc-date">Date on the credit</label>
                <input id="vc-date" type="date" style={input} value={date} max={data.today} onChange={(e) => setDate(e.target.value)} />
              </div>
              <div>
                <label style={label} htmlFor="vc-location">Location</label>
                <select id="vc-location" style={input} value={locationId ?? ''} onChange={(e) => setLocationId(e.target.value || null)}>
                  <option value="">No location</option>
                  {(companyRow?.locations ?? []).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
              </div>
            </div>

            <div>
              <label style={label} htmlFor="vc-reason">Why the vendor gave the credit</label>
              <input id="vc-reason" style={input} value={reason} maxLength={999} placeholder="Returned part, damaged in shipping, priced wrong…"
                onChange={(e) => setReason(e.target.value)} />
              <div style={muted}>Goes on the vendor credit in NetSuite as its memo.</div>
            </div>
          </div>

          <div style={{ ...card, display: 'grid', gap: '10px' }}>
            <div style={heading}>What it&apos;s for</div>
            {lines.length === 0 && <div style={muted}>Money back to an account, or a part going back to the vendor.</div>}
            {lines.map((l, i) => {
              const w = worked.lines[i];
              if (l.kind === 'account') {
                return (
                  <div key={l.key} style={{ border: `1px solid ${theme.border}`, borderRadius: '10px', padding: '10px', display: 'grid', gap: '8px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'baseline' }}>
                      <span style={{ fontWeight: 800, color: theme.textPrimary }}>Money back to an account</span>
                      <span style={{ ...num, fontWeight: 800, color: w?.cents ? theme.success : theme.textMuted }}>{w?.cents ? formatCents(w.cents) : ''}</span>
                    </div>
                    <div>
                      <label style={label} htmlFor={`vc-acct-${l.key}`}>Account</label>
                      <select id={`vc-acct-${l.key}`} style={input} value={l.accountId} onChange={(e) => patchLine(l.key, { accountId: e.target.value })}>
                        <option value="">Pick the account</option>
                        {l.accountId && !companyAccounts.some((a) => a.id === l.accountId) && accounts.get(l.accountId) && (
                          <option value={l.accountId}>{accountName(accounts.get(l.accountId)!)}</option>
                        )}
                        {companyAccounts.map((a) => <option key={a.id} value={a.id}>{accountName(a)}</option>)}
                      </select>
                    </div>
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
                      <div style={{ width: '140px' }}>
                        <label style={label} htmlFor={`vc-amt-${l.key}`}>Amount $</label>
                        <input id={`vc-amt-${l.key}`} style={{ ...input, ...num }} inputMode="decimal" value={l.amountText}
                          onChange={(e) => patchLine(l.key, { amountText: e.target.value })} />
                      </div>
                      <div style={{ flex: 1, minWidth: '160px' }}>
                        <label style={label} htmlFor={`vc-memo-${l.key}`}>What it&apos;s for</label>
                        <input id={`vc-memo-${l.key}`} style={input} value={l.memo} maxLength={300} placeholder="Optional"
                          onChange={(e) => patchLine(l.key, { memo: e.target.value })} />
                      </div>
                      <button onClick={() => setLines((prev) => prev.filter((x) => x.key !== l.key))} aria-label={`Remove line ${i + 1}`}
                        style={{ ...btn, color: theme.error, borderColor: theme.errorBorder }}>Remove</button>
                    </div>
                  </div>
                );
              }
              const part = l.itemId ? parts[l.itemId] : undefined;
              const qty = typed(l.quantityText);
              const short = part?.stock && part.onHand != null && qty > part.onHand;
              return (
                <div key={l.key} style={{ border: `1px solid ${theme.border}`, borderRadius: '10px', padding: '10px', display: 'grid', gap: '8px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'baseline' }}>
                    <span style={{ fontWeight: 800, color: theme.textPrimary }}>Part going back</span>
                    <span style={{ ...num, fontWeight: 800, color: w?.cents ? theme.success : theme.textMuted }}>{w?.cents ? formatCents(w.cents) : ''}</span>
                  </div>
                  <div style={{ position: 'relative' }}>
                    <label style={label} htmlFor={`vc-part-${l.key}`}>Part</label>
                    <input id={`vc-part-${l.key}`} style={input} value={l.query} autoComplete="off" placeholder="Type the part number or name"
                      onChange={(e) => { patchLine(l.key, { query: e.target.value, itemId: null }); searchParts(l.key, e.target.value); }} />
                    {!l.itemId && partHits?.key === l.key && partHits.parts.length > 0 && (
                      <div style={hitList}>
                        {partHits.parts.map((p) => (
                          <button key={p.id} type="button" style={hit} onClick={() => pickPart(l.key, p)}>
                            <b>{p.itemNumber}</b>
                            {p.description && <span style={{ color: theme.textMuted }}> · {p.description}</span>}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  {!l.itemId && partHits?.key === l.key && partHits.error && (
                    <div style={{ ...muted, color: theme.error, fontWeight: 700 }}>{partHits.error}</div>
                  )}
                  {part && (
                    <div>
                      {part.description && <div style={twoLines}>{part.description}</div>}
                      <div style={muted}>
                        {part.stock
                          ? `Comes off the shelf at O'Fallon${part.onHand != null ? ` · ${part.onHand} on hand` : ''}`
                          : 'Not a stock part, so no stock changes'}
                        {part.cost != null ? ` · costs ${formatCents(Math.round(part.cost * 100))}` : ''}
                      </div>
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
                    <div style={{ width: '90px' }}>
                      <label style={label} htmlFor={`vc-qty-${l.key}`}>Qty</label>
                      <input id={`vc-qty-${l.key}`} style={{ ...input, ...num }} inputMode="decimal" value={l.quantityText}
                        onChange={(e) => patchLine(l.key, { quantityText: e.target.value })} />
                    </div>
                    <div style={{ width: '130px' }}>
                      <label style={label} htmlFor={`vc-rate-${l.key}`}>Credit each $</label>
                      <input id={`vc-rate-${l.key}`} style={{ ...input, ...num }} inputMode="decimal" value={l.rateText}
                        onChange={(e) => patchLine(l.key, { rateText: e.target.value, rateFromCost: false })} />
                    </div>
                    <button onClick={() => setLines((prev) => prev.filter((x) => x.key !== l.key))} aria-label={`Remove line ${i + 1}`}
                      style={{ ...btn, marginLeft: 'auto', color: theme.error, borderColor: theme.errorBorder }}>Remove</button>
                  </div>
                  {short && (
                    <div style={{ fontSize: '12px', color: theme.warning, fontWeight: 700 }}>
                      FleetSuite shows {part.onHand} on hand, fewer than are going back. Check the shelf before making it.
                    </div>
                  )}
                </div>
              );
            })}
            {lines.length < MAX_VENDOR_CREDIT_LINES && (
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                <button onClick={addAccountLine} style={small}>+ Account line</button>
                {company === PART_COMPANY && <button onClick={addPartLine} style={small}>+ Part going back</button>}
              </div>
            )}
          </div>

          <div style={{ ...card, display: 'grid', gap: '10px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <div style={heading}>Apply to open bills</div>
              {openBills && openBills.length > 0 && (
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button onClick={applyOldest} disabled={worked.totalCents <= 0} style={small}>Apply oldest first</button>
                  {appliedIds.size > 0 && <button onClick={() => setApplied({})} style={small}>Clear</button>}
                </div>
              )}
            </div>
            {!vendorId ? (
              <div style={muted}>Pick the vendor to see their bills NetSuite has open.</div>
            ) : openLoading || !open ? (
              <div style={muted}>Reading {vendorName}&apos;s open bills from NetSuite…</div>
            ) : open.openError || !openBills ? (
              <div style={{ fontSize: '13px', color: theme.error, fontWeight: 700 }}>
                Couldn&apos;t read {vendorName}&apos;s open bills from NetSuite: {open.openError || 'no answer'}. The credit can still be made and left open.
              </div>
            ) : openBills.length === 0 ? (
              <div style={muted}>{vendorName} has no open bills{companyRow ? ` for ${companyRow.name}` : ''} in NetSuite. The credit stays open on them.</div>
            ) : (
              openBills.map((b) => {
                const on = appliedIds.has(b.id);
                return (
                  <div key={b.id} style={{ border: `1px solid ${on ? theme.successBorder : theme.border}`, borderRadius: '10px', padding: '10px', display: 'grid', gap: '8px' }}>
                    <label style={{ display: 'flex', gap: '10px', alignItems: 'flex-start', cursor: 'pointer' }}>
                      <input type="checkbox" checked={on} onChange={(e) => toggleBill(b, e.target.checked)}
                        aria-label={`Apply to bill ${b.number || b.id}`} style={{ width: '20px', height: '20px', marginTop: '1px', flexShrink: 0 }} />
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'baseline' }}>
                          <span style={{ fontWeight: 800, color: theme.textPrimary }}>Bill {b.number || b.id}</span>
                          <span style={{ ...num, fontWeight: 800, color: theme.textPrimary }}>{formatCents(b.openCents)} open</span>
                        </div>
                        <div style={muted}>{[day(b.date), b.dueDate ? `due ${day(b.dueDate)}` : ''].filter(Boolean).join(' · ')}</div>
                      </div>
                    </label>
                    {on && (
                      <div style={{ paddingLeft: '30px', width: '170px' }}>
                        <label style={label} htmlFor={`vc-apply-${b.id}`}>Apply $</label>
                        <input id={`vc-apply-${b.id}`} style={{ ...input, ...num }} inputMode="decimal" value={applied[b.id] ?? ''}
                          onChange={(e) => setApplied((prev) => ({ ...prev, [b.id]: e.target.value }))} />
                      </div>
                    )}
                  </div>
                );
              })
            )}
            {open?.openCredits && open.openCredits.length > 0 && (
              <div style={{ display: 'grid', gap: '4px', borderTop: `1px solid ${theme.border}`, paddingTop: '8px' }}>
                <div style={{ fontSize: '13px', fontWeight: 800, color: theme.textPrimary }}>Credits already open on {vendorName}</div>
                {open.openCredits.map((c) => (
                  <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', fontSize: '13px', color: theme.textPrimary }}>
                    <span><b>{c.number || c.id}</b><span style={{ color: theme.textMuted }}> · {day(c.date)}</span></span>
                    <span style={num}>{formatCents(c.openCents)}</span>
                  </div>
                ))}
                <div style={muted}>Check the one you&apos;re entering isn&apos;t one of these.</div>
              </div>
            )}
          </div>

          <div style={{ ...card, display: 'grid', gap: '6px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '18px', fontWeight: 800, color: theme.textPrimary }}>
              <span>Total credit</span><span style={num}>{formatCents(worked.totalCents)}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '14px', color: theme.textSecondary }}>
              <span>Applied to bills</span><span style={num}>{formatCents(worked.appliedCents)}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '14px', color: theme.textSecondary }}>
              <span>Left open on the vendor</span><span style={num}>{formatCents(worked.leftCents)}</span>
            </div>
            <div style={muted}>
              What&apos;s left stays open on {vendorId ? vendorName : 'the vendor'} in NetSuite, to apply when you next pay them. Vendor credits carry no sales tax.
            </div>
          </div>

          {started && worked.problems.length > 0 && (
            <div style={{ color: theme.error, fontSize: '14px', fontWeight: 700, display: 'grid', gap: '2px' }}>
              {worked.problems.map((p, i) => <div key={`${i}-${p}`}>{p}</div>)}
            </div>
          )}
        </>
      )}

      {data && data.recent.length > 0 && (
        <div style={{ ...card, display: 'grid', gap: '6px' }}>
          <div style={heading}>Entered lately</div>
          {data.recent.map((r) => (
            <div key={r.id} style={{ display: 'grid', gap: '2px', fontSize: '13px', color: theme.textPrimary }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px' }}>
                <span style={{ minWidth: 0 }}>
                  <b>{r.number}</b>
                  <span style={{ color: theme.textMuted }}> · {r.vendorName || 'Vendor'} · {day(r.date)}</span>
                </span>
                <span style={num}>{r.totalCents != null ? formatCents(r.totalCents) : ''}</span>
              </div>
              <div style={{ ...muted, color: r.state === 'refused' ? theme.error : theme.textMuted, fontWeight: r.state === 'refused' ? 700 : 400 }}>
                {r.state === 'made' ? 'Made in NetSuite' : r.state === 'making' ? 'Being made now' : `NetSuite refused it: ${r.error || 'no reason given'}`}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
