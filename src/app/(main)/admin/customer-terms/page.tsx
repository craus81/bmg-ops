'use client';

/**
 * A customer's terms and credit limit, changed in FleetSuite and sent on to
 * NetSuite (Books part 41, docs/books.md "Customer and vendor details
 * changed in FleetSuite"; owner decisions 2026-10-31: from January 1, 2027
 * the team works only in FleetSuite). Opened from More → Sales → Customer
 * Terms, which finds the customer by name, or from Change beside the terms
 * on a customer's page.
 *
 * What changes and what NetSuite is sent are src/lib/customer-terms.ts, the
 * same rules /api/customer-terms works the change out by before it sends it.
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
  REASON_MAX, formatCents, planCustomerTerms,
  type CustomerTermsEdit, type TermsCustomer, type TermsOption,
} from '@/lib/customer-terms';

const API = '/api/customer-terms';

interface Loaded {
  customer: TermsCustomer;
  terms: TermsOption[];
  signature: string;
  changes: DetailChange[];
  switchedOn: boolean;
  offText: string | null;
}

/** A customer the search found, from the copy of NetSuite's customer list. */
interface FoundCustomer {
  id: string;
  name: string;
  entityId: string | null;
  active: boolean;
}

const newRequestId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));

/** The limit typed: blank is none, anything else a number (NaN when it isn't one). */
const typedLimit = (t: string): number | null => (t.trim() === '' ? null : Number(t.replace(/[$,\s]/g, '')));
const limitBox = (cents: number | null) => (cents === null ? '' : (cents / 100).toFixed(2));

const day = (iso: string) => new Date(iso).toLocaleDateString();

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
const num: React.CSSProperties = { textAlign: 'right', fontVariantNumeric: 'tabular-nums' };
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

export default function CustomerTermsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const dialog = useDialog();
  const { hasFeature, canSeeMoney, loading: authLoading } = useAuth();
  const customerId = (searchParams.get('customer') || '').trim();
  const allowed = !authLoading && hasFeature('credit_applications') && canSeeMoney;

  // Made when the customer is read: the same form pressed twice is one change.
  const [requestId, setRequestId] = useState(newRequestId);
  const [data, setData] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [termsId, setTermsId] = useState('');
  const [limitText, setLimitText] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadNeeded, setReloadNeeded] = useState(false);
  const [done, setDone] = useState<{ changes: string[]; already: boolean; terms: boolean } | null>(null);
  const [find, setFind] = useState('');
  const [found, setFound] = useState<FoundCustomer[] | null>(null);
  const [findError, setFindError] = useState('');

  const load = useCallback(async () => {
    if (!/^\d+$/.test(customerId)) { setLoading(false); return; }
    setLoading(true);
    setLoadError(null);
    try {
      const res = await apiFetch(`${API}?${new URLSearchParams({ customer: customerId })}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Couldn't read the customer from NetSuite (${res.status}).`);
      const loaded = body as Loaded;
      setData(loaded);
      setTermsId(loaded.customer.termsId ?? '');
      setLimitText(limitBox(loaded.customer.creditLimitCents));
      setReason('');
      setError(null);
      setReloadNeeded(false);
      setDone(null);
      setRequestId(newRequestId());
    } catch (e: any) {
      setLoadError(e?.message || "Couldn't read the customer from NetSuite.");
    } finally {
      setLoading(false);
    }
  }, [customerId]);

  useEffect(() => { if (allowed) load(); }, [allowed, load]);

  // With no customer open: find one by name.
  useEffect(() => {
    if (customerId || !allowed) return;
    const t = setTimeout(async () => {
      try {
        const res = await apiFetch(`${API}?${new URLSearchParams({ find: find.trim() })}`);
        const body = await res.json().catch(() => ({}));
        setFound(res.ok ? body.customers ?? [] : []);
        setFindError(res.ok ? '' : body.error || `Couldn't search the customers (${res.status}).`);
      } catch {
        setFindError("Couldn't reach FleetSuite to search the customers.");
      }
    }, 300);
    return () => clearTimeout(t);
  }, [find, customerId, allowed]);

  const customer = data?.customer;
  const termsList = useMemo(() => new Map((data?.terms ?? []).map((t) => [t.id, t])), [data]);

  // Only what was changed goes: a box left as NetSuite has it isn't sent.
  const edit: CustomerTermsEdit = { reason };
  if (customer) {
    if (termsId !== (customer.termsId ?? '')) edit.termsId = termsId;
    if (limitText !== limitBox(customer.creditLimitCents)) edit.creditLimit = typedLimit(limitText);
  }
  const plan = useMemo(
    () => (customer ? planCustomerTerms(customer, edit, { terms: termsList }) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- edit derives from the boxes
    [customer, termsId, limitText, reason, termsList],
  );
  const started = edit.termsId !== undefined || edit.creditLimit !== undefined;

  const send = async () => {
    if (!data || !customer || !plan || plan.problems.length > 0 || !data.switchedOn) return;
    const ok = await dialog.confirm(
      `Change ${customer.name} in NetSuite? ${plan.changes.join('. ')}.`,
      { confirmLabel: 'Save to NetSuite', title: 'Change terms' },
    );
    if (!ok) return;
    setSubmitting(true);
    setError(null);
    setReloadNeeded(false);
    try {
      const res = await apiFetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId, customerId: customer.id, signature: data.signature, ...edit }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.success) {
        if (body.stale || body.unsure) setReloadNeeded(true);
        throw new Error(body.error || `NetSuite didn't take the change (${res.status}).`);
      }
      setDone({ changes: Array.isArray(body.changes) ? body.changes : plan.changes, already: !!body.already, terms: plan.body.terms !== undefined });
    } catch (e: any) {
      setError(e?.message || "NetSuite didn't take the change.");
    } finally {
      setSubmitting(false);
    }
  };

  if (!authLoading && (!hasFeature('credit_applications') || !canSeeMoney)) {
    return <div style={{ padding: '24px', color: theme.error }}>You need the Credit Applications permission and price access to change a customer&apos;s terms.</div>;
  }

  const back = () => router.push('/more');
  const balanceUsed = customer && customer.creditLimitCents && customer.balanceCents !== null
    ? Math.round((customer.balanceCents / customer.creditLimitCents) * 100) : null;

  return (
    <div style={{ maxWidth: '720px', margin: '0 auto', padding: '16px', display: 'grid', gap: '14px' }}>
      {!done && customer && plan && (
        <TopSaveBar
          title="Change terms"
          subtitle={customer.name}
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
        <h1 style={{ margin: '4px 0 0', fontSize: '22px', fontWeight: 800, color: theme.textPrimary }}>Customer terms</h1>
        <div style={{ fontSize: '13px', color: theme.textMuted }}>A customer&apos;s terms and credit limit, changed in NetSuite as you save them here.</div>
      </div>

      {data?.offText && !done && (
        <div style={{ ...card, borderColor: theme.warningBorder, background: theme.warningBg, color: theme.warning, fontSize: '14px', fontWeight: 700 }}>
          {data.offText}
        </div>
      )}

      {!/^\d+$/.test(customerId) ? (
        <div style={{ ...card, display: 'grid', gap: '10px' }}>
          <div>
            <label style={label} htmlFor="ct-find">Find the customer</label>
            <input id="ct-find" style={input} value={find} autoComplete="off" placeholder="The customer's name"
              onChange={(e) => setFind(e.target.value)} />
          </div>
          {findError && <div style={{ fontSize: '13px', color: theme.error, fontWeight: 700 }}>{findError}</div>}
          {found === null && !findError && <div style={muted}>Reading the customers…</div>}
          {found && found.length === 0 && !findError && <div style={muted}>No customer in the copy of NetSuite&apos;s customers matches that.</div>}
          {found && found.map((f) => (
            <button key={f.id} type="button" onClick={() => router.push(deepLinks.customerTerms(f.id))} style={{
              display: 'grid', gap: '2px', textAlign: 'left', padding: '10px', borderRadius: '10px', border: `1px solid ${theme.border}`,
              background: theme.card, color: theme.textPrimary, cursor: 'pointer', fontFamily: 'inherit',
            }}>
              <b>{f.name}</b>
              <span style={muted}>{[f.entityId, f.active ? '' : 'Inactive in NetSuite'].filter(Boolean).join(' · ') || `NetSuite customer ${f.id}`}</span>
            </button>
          ))}
          <div style={muted}>The copy of NetSuite&apos;s customers catches up every two hours; the customer opens as NetSuite has it now.</div>
        </div>
      ) : loading ? (
        <div style={{ ...card, color: theme.textMuted, fontSize: '14px' }}>Reading the customer from NetSuite…</div>
      ) : loadError || !customer || !plan ? (
        <div style={{ ...card, display: 'grid', gap: '10px' }}>
          <div style={{ color: theme.error, fontSize: '14px', fontWeight: 700 }}>{loadError || "Couldn't read the customer from NetSuite."}</div>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <button onClick={load} style={btn}>Try again</button>
            <button onClick={() => router.push(deepLinks.customerTerms())} style={btn}>Find another customer</button>
          </div>
        </div>
      ) : done ? (
        <div style={{ ...card, borderColor: theme.successBorder, background: theme.successBg, display: 'grid', gap: '10px' }}>
          <div style={{ fontSize: '17px', fontWeight: 800, color: theme.success }}>
            {customer.name} {done.already ? 'was already changed' : 'changed in NetSuite'}
          </div>
          <div style={{ display: 'grid', gap: '2px', fontSize: '14px', color: theme.textPrimary }}>
            {done.changes.map((c) => <div key={c}>{c}</div>)}
          </div>
          {done.terms && <div style={muted}>Its open invoices keep the terms they were made with; new ones take these.</div>}
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <button onClick={load} style={btn}>Change something else</button>
            <button onClick={() => router.push(deepLinks.customerByNetsuiteId(customer.id))} style={btn}>Open the customer</button>
            <button onClick={() => router.push(deepLinks.customerTerms())} style={btn}>Find another customer</button>
          </div>
        </div>
      ) : (
        <>
          <div style={{ ...card, display: 'grid', gap: '4px' }}>
            <div style={{ fontSize: '17px', fontWeight: 800, color: theme.textPrimary }}>{customer.name}</div>
            <div style={muted}>
              {[customer.entityId !== customer.name ? customer.entityId : '', customer.inactive ? 'Inactive in NetSuite' : '',
                customer.balanceCents === null ? '' : `Owes ${formatCents(customer.balanceCents)} now`,
                balanceUsed === null ? '' : `${balanceUsed}% of its limit`,
              ].filter(Boolean).join(' · ')}
            </div>
          </div>

          <div style={{ ...card, display: 'grid', gap: '12px' }}>
            <div>
              <label style={label} htmlFor="ct-terms">Terms</label>
              <select id="ct-terms" style={input} value={termsId} onChange={(e) => setTermsId(e.target.value)}>
                {!customer.termsId && <option value="">None</option>}
                {customer.termsId && !termsList.has(customer.termsId) && (
                  <option value={customer.termsId}>{customer.termsName || `Terms ${customer.termsId}`} (not in NetSuite&apos;s list now)</option>
                )}
                {(data?.terms ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
              <div style={{ ...muted, marginTop: '3px' }}>What its new invoices are due by. Invoices already made keep theirs.</div>
            </div>
            <div style={{ maxWidth: '240px' }}>
              <label style={label} htmlFor="ct-limit">Credit limit $</label>
              <input id="ct-limit" style={{ ...input, ...num }} inputMode="decimal" value={limitText} placeholder="No limit"
                onChange={(e) => setLimitText(e.target.value)} />
              <div style={{ ...muted, marginTop: '3px' }}>Leave it blank for no limit.</div>
            </div>
          </div>

          <div style={{ ...card, display: 'grid', gap: '4px' }}>
            <label style={label} htmlFor="ct-reason">Why it&apos;s being changed</label>
            <input id="ct-reason" style={input} value={reason} maxLength={REASON_MAX} placeholder="Credit application approved at Net 30, raised after a year of paying on time…"
              onChange={(e) => setReason(e.target.value)} />
            <div style={muted}>Kept with the change in FleetSuite, for whoever looks at the customer next.</div>
          </div>

          {plan.changes.length > 0 && (
            <div style={{ ...card, display: 'grid', gap: '4px' }}>
              <div style={heading}>What changes</div>
              {plan.changes.map((c) => <div key={c} style={{ fontSize: '14px', color: theme.textPrimary }}>{c}</div>)}
            </div>
          )}
          {started && plan.problems.length > 0 && (
            <div style={{ color: theme.error, fontSize: '14px', fontWeight: 700, display: 'grid', gap: '2px' }}>
              {plan.problems.map((p) => <div key={p}>{p}</div>)}
            </div>
          )}
          {error && reloadNeeded && <div><button onClick={load} style={btn}>Reload the customer</button></div>}

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
