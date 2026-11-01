'use client';

import { Fragment, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { apiFetch } from '@/lib/api-client';
import { deepLinks } from '@/lib/deep-links';
import { docName, unsplitReason, type Payee1099, type Payment1099, type PaymentType, type Year1099 } from '@/lib/books/1099s';

/**
 * Books → 1099s (part 50, migration 481, src/lib/books/1099s.ts,
 * docs/books.md "1099s"; the NetSuite Exit Checklist, thread "Replacing
 * NetSuite with FleetSuite", 2026-10-31): the 1099 dry run.
 *
 * What each vendor NetSuite marks to get a 1099 was paid in one company's
 * year on the accounts that count toward one, by category, worked out from
 * FleetSuite's copy of NetSuite the way NetSuite counts it: checks on their
 * own lines' accounts, bill payments on the accounts of the bills they paid.
 * Card payments are left out and listed, with whoever was paid on an
 * account that counts without being marked, whoever is marked but was paid
 * only on other accounts, and the payments FleetSuite can't split. Tap a
 * vendor for its payments. Nothing is filed or sent. Super admins only, as
 * the books are.
 */

type Copy = { at: string | null; tried: string | null; error: string | null } | null;

interface Payload extends Year1099 {
  companies: Array<{ code: string; name: string }>;
  company: string;
  year: number;
  years: number[];
  copies: {
    chart: Copy;
    accounts1099: { received?: number; error?: string } | null;
    lists: Copy;
    vendors: { error: string | null; missing: string[] } | null;
    ledger: Copy;
    billPayments: Copy;
    spending: Copy;
  };
}

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', currencySign: 'accounting' });
const fmt = (cents: number) => money.format(cents / 100);

function ago(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

const count = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const shortDate = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

const TYPE_NAMES: Record<PaymentType, string> = {
  Check: 'Check', VendPymt: 'Bill payment', CardChrg: 'Card charge', CardRfnd: 'Card refund',
};
const RED = '#ef4444';
const AMBER = '#fbbf24';

const banner = (color: string): React.CSSProperties => ({
  padding: '10px 14px', borderRadius: '8px', marginBottom: '10px', fontSize: '12px', fontWeight: 600,
  background: `${color}10`, border: `1px solid ${color}40`, color,
});

const note: React.CSSProperties = { fontSize: '12px', color: 'var(--text-muted)', marginBottom: '10px' };

const button = (active: boolean): React.CSSProperties => ({
  padding: '6px 12px', borderRadius: '8px', border: `1px solid ${active ? 'var(--text-primary)' : 'var(--border)'}`,
  background: 'var(--card)', color: 'var(--text-primary)', fontSize: '12px', fontWeight: active ? 800 : 600, cursor: 'pointer',
});

const cell: React.CSSProperties = { padding: '6px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
const labelCell: React.CSSProperties = { ...cell, textAlign: 'left', whiteSpace: 'normal' };
const tableBox: React.CSSProperties = { overflowX: 'auto', border: '1px solid var(--border)', borderRadius: '8px', marginBottom: '14px' };
const table: React.CSSProperties = { width: '100%', borderCollapse: 'collapse', fontSize: '12px', background: 'var(--card)' };
const muted: React.CSSProperties = { fontSize: '11px', color: 'var(--text-muted)', overflowWrap: 'anywhere' };
const section: React.CSSProperties = { border: '1px solid var(--border)', borderRadius: '8px', background: 'var(--card)', marginBottom: '10px' };
const summary: React.CSSProperties = { padding: '10px 14px', fontSize: '13px', fontWeight: 700, cursor: 'pointer' };

/**
 * A row of a table: its label, then `amounts` amounts. On a phone the label
 * takes a row of its own above them (.rep-label-row in globals.css), as on
 * Reports, spanning the amounts, since the label's own cell is hidden there.
 */
function Row({ label, amounts, style, onClick, children }: {
  label: React.ReactNode; amounts: number; style?: React.CSSProperties; onClick?: () => void; children: React.ReactNode;
}) {
  const clickable = onClick ? { ...style, cursor: 'pointer' } : style;
  return (
    <>
      <tr className="rep-label-row" style={clickable} onClick={onClick}><td colSpan={amounts} style={labelCell}>{label}</td></tr>
      <tr className="rep-amounts" style={clickable} onClick={onClick}>
        <td className="rep-label" style={labelCell}>{label}</td>
        {children}
      </tr>
    </>
  );
}

const amount = (cents: number | undefined, strong?: boolean) => (
  <td style={{ ...cell, fontWeight: strong ? 800 : 400, color: cents ? 'var(--text-primary)' : 'var(--text-muted)' }}>
    {cents ? fmt(cents) : '—'}
  </td>
);

/** One payment: when, what, how much, and where it went or why it's left out. */
function PaymentLine({ p, categories }: { p: Payment1099; categories: string[] }) {
  const boxes = categories.filter((c) => p.boxes[c]).map((c) => `${fmt(p.boxes[c])} ${c}`);
  return (
    <div style={{ padding: '6px 0', borderTop: '1px solid var(--border)', fontSize: '12px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px' }}>
        <span>{shortDate(p.date)} · {TYPE_NAMES[p.type]}{p.number ? ` ${p.number}` : ''}</span>
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmt(p.cents)}</span>
      </div>
      <div style={{ ...muted, color: p.unsplit ? RED : 'var(--text-muted)' }}>
        {p.byCard ? 'Paid by card, so left out.'
          : p.unsplit ? `Can't split: ${unsplitReason(p.unsplit)}`
            : boxes.length ? `On accounts that count: ${boxes.join(', ')}` : 'Nothing on an account that counts toward a 1099.'}
        {p.paid.length > 0 && !p.byCard && ` Paid ${p.paid.map(docName).join(', ')}.`}
      </div>
    </div>
  );
}

function Payments({ payee, categories }: { payee: Payee1099; categories: string[] }) {
  return (
    <div style={{ padding: '0 10px 8px' }}>
      {payee.payments.map((p) => <PaymentLine key={p.netsuiteId} p={p} categories={categories} />)}
    </div>
  );
}

/** A vendor's name, its legal name under it when that differs, and what else there is to know. */
function PayeeLabel({ p, open, extra }: { p: Payee1099; open: boolean; extra?: string }) {
  const about = [
    p.legalName ? `Legal name ${p.legalName}` : '',
    count(p.payments.length, 'payment', 'payments'),
    extra ?? '',
  ].filter(Boolean).join(' · ');
  return (
    <div>
      <span className="rep-link" style={{ fontWeight: 700 }}>{p.name}</span>
      <span style={{ ...muted, marginLeft: '6px' }}>{open ? '▴' : '▾'}</span>
      <div style={muted}>{about}</div>
      {p.unsplit !== 0 && <div style={{ ...muted, color: RED }}>FleetSuite can&apos;t split {fmt(p.unsplit)} of what it was paid.</div>}
    </div>
  );
}

/** A list of vendors, each with its amounts, that opens to its payments. */
function PayeeTable({ payees, heading, columns, amounts, extra, categories }: {
  payees: Payee1099[];
  heading: string;
  columns: string[];
  amounts: (p: Payee1099) => Array<number | undefined>;
  extra?: (p: Payee1099) => string;
  categories: string[];
}) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div style={tableBox}>
      <table className="rep-table" style={table}>
        <thead>
          <tr style={{ color: 'var(--text-secondary)', textAlign: 'right' }}>
            <th className="rep-label" style={{ ...cell, textAlign: 'left' }}>{heading}</th>
            {columns.map((c) => <th key={c} style={{ ...cell, whiteSpace: 'normal' }}>{c}</th>)}
          </tr>
        </thead>
        <tbody>
          {payees.map((p) => {
            const isOpen = open === p.payee;
            const values = amounts(p);
            return (
              <Fragment key={p.payee || 'none'}>
                <Row
                  amounts={columns.length}
                  style={{ borderTop: '1px solid var(--border)' }}
                  onClick={() => setOpen(isOpen ? null : p.payee)}
                  label={<PayeeLabel p={p} open={isOpen} extra={extra?.(p)} />}
                >
                  {values.map((v, i) => <Fragment key={columns[i]}>{amount(v, i === values.length - 1)}</Fragment>)}
                </Row>
                {isOpen && (
                  <tr><td colSpan={columns.length + 1}><Payments payee={p} categories={categories} /></td></tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const WHY_NOT_MARKED = (p: Payee1099) =>
  !p.vendor ? "Not a vendor in NetSuite's list" : p.marked === false ? 'Not marked to get a 1099' : "NetSuite hasn't said whether it gets one";

export default function Books1099sPage() {
  const router = useRouter();
  const { hasRole, loading: authLoading } = useAuth();
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [introOpen, setIntroOpen] = useState(false);

  const load = useCallback(async (company: string, year: string) => {
    try {
      const params = new URLSearchParams();
      if (company) params.set('company', company);
      if (year) params.set('year', year);
      const res = await apiFetch(`/api/admin/books/1099s?${params}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      setData(json);
      setError('');
      // Keep the address on what's shown, so going back here opens it again.
      window.history.replaceState(null, '', deepLinks.books1099s(json.company, json.year));
    } catch (e: any) {
      setError(e?.message || "Could not load the year's 1099s");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!hasRole('super_admin')) { router.push('/home'); return; }
    const q = new URLSearchParams(window.location.search);
    load(q.get('company') ?? '', q.get('year') ?? '');
  // eslint-disable-next-line react-hooks/exhaustive-deps -- hasRole identity changes per render; auth state covers it
  }, [authLoading, router, load]);

  const pick = (company: string, year: number) => {
    setLoading(true);
    load(company, String(year));
  };

  const companyName = data?.companies.find((c) => c.code === data.company)?.name ?? data?.company;
  const categories = data?.categories ?? [];
  // One column per category, and a total when there's more than one.
  const columns = categories.length > 1 ? [...categories, 'Total'] : categories.length ? categories : ['On accounts that count'];
  const boxAmounts = (p: Payee1099) => (categories.length > 1
    ? [...categories.map((c) => p.boxes[c]), p.total]
    : [categories.length ? p.boxes[categories[0]] : p.total]);
  const copies = data?.copies;
  const failed = copies ? ([
    ['ledger', copies.ledger], ['bill payments', copies.billPayments], ['checks and card charges', copies.spending],
  ] as Array<[string, Copy]>).filter(([, c]) => c?.error) : [];

  return (
    <div>
      <div style={{ marginBottom: '14px' }}>
        <div style={{ fontSize: '20px', fontWeight: 800 }}>1099s</div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
          {/* Two lines until More opens the rest below them. */}
          <div style={introOpen ? undefined : { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
            What each vendor NetSuite marks to get a 1099 was paid in the year, worked out from FleetSuite&apos;s copy of NetSuite, to
            check against NetSuite&apos;s 1099s. It counts what was paid by check or bill payment, by the date paid, on the accounts
            NetSuite gives a 1099-MISC category, each category a box of the form. A bill payment counts on the accounts of the bills it
            paid, split in proportion to the cent. Card payments are left out, as the card company reports them, and every vendor is
            shown whatever the amount. Tap a vendor for its payments. Nothing is filed or sent. Visible only to super admins.
          </div>
          <button
            onClick={() => setIntroOpen(!introOpen)}
            style={{ padding: 0, border: 'none', background: 'none', color: 'var(--text-secondary)', fontSize: '12px', fontWeight: 600, cursor: 'pointer', textDecoration: 'underline' }}
          >
            {introOpen ? 'Less' : 'More'}
          </button>
          {' · '}
          <Link href="/admin/books/lists" style={{ color: 'var(--text-secondary)' }}>NetSuite lists</Link>
          {' · '}
          <Link href="/admin/books" style={{ color: 'var(--text-secondary)' }}>Chart of accounts</Link>
          {' · '}
          <Link href="/admin/vendor-details" style={{ color: 'var(--text-secondary)' }}>Vendor Details</Link>
        </div>
      </div>

      {error && <div style={banner(RED)}>{error}</div>}

      {data && copies && (
        <>
          {copies.vendors?.error && (
            <div style={banner(RED)}>NetSuite wouldn&apos;t list its vendors the last time FleetSuite copied its lists: {copies.vendors.error}</div>
          )}
          {!copies.vendors?.error && copies.vendors?.missing.includes('is_1099') && (
            <div style={banner(RED)}>
              NetSuite wouldn&apos;t say which vendors get a 1099 the last time FleetSuite copied its lists, so a vendor copied before
              then shows as it was, and one since as not saying.
            </div>
          )}
          {!data.flagsCopied && !copies.vendors?.missing.includes('is_1099') && (
            <div style={banner(AMBER)}>
              NetSuite&apos;s vendors haven&apos;t been copied with their 1099 flags yet, so no vendor shows as marked to get one. The copy of
              NetSuite&apos;s lists brings them every two hours, or press Sync now on NetSuite lists.
            </div>
          )}
          {copies.accounts1099?.error && (
            <div style={banner(RED)}>
              NetSuite wouldn&apos;t say which accounts count toward a 1099 the last time FleetSuite copied the chart of accounts:
              {' '}{copies.accounts1099.error}
            </div>
          )}
          {!copies.accounts1099 && (
            <div style={banner(AMBER)}>
              FleetSuite hasn&apos;t read which accounts count toward a 1099 yet, so nothing shows on them. The copy of the chart of
              accounts reads them every two hours, or press Sync now on the Chart of accounts.
            </div>
          )}
          {copies.accounts1099 && !copies.accounts1099.error && !data.accounts.length && (
            <div style={banner(AMBER)}>
              NetSuite gives no account a 1099-MISC category, so nothing counts toward a 1099. In NetSuite an account&apos;s 1099-MISC
              Category says which box of the form what&apos;s paid on it goes in.
            </div>
          )}
          {failed.map(([what, c]) => (
            <div key={what} style={banner(RED)}>The last copy of NetSuite&apos;s {what} failed{c?.tried ? ` ${ago(c.tried)}` : ''}: {c?.error}</div>
          ))}
          {data.notCopied.length > 0 && (
            <div style={banner(AMBER)}>
              {count(data.notCopied.length, 'check or bill payment', 'checks and bill payments')} in NetSuite&apos;s ledger for {data.year}
              {' '}{data.notCopied.length === 1 ? "isn't" : "aren't"} in FleetSuite&apos;s copies of the payments yet, so{' '}
              {data.notCopied.length === 1 ? "it isn't" : "they aren't"} counted: {data.notCopied.slice(0, 10).map((d) => d.number || d.netsuite_id).join(', ')}
              {data.notCopied.length > 10 ? ' and more' : ''}. The copies run every two hours.
            </div>
          )}

          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '10px' }}>
            {data.companies.length > 1 && data.companies.map((c) => (
              <button key={c.code} onClick={() => pick(c.code, data.year)} disabled={loading} style={button(c.code === data.company)}>
                {c.name}
              </button>
            ))}
            {data.companies.length > 1 && <span style={{ width: '8px' }} />}
            {data.years.map((y) => (
              <button key={y} onClick={() => pick(data.company, y)} disabled={loading} style={button(y === data.year)}>{y}</button>
            ))}
          </div>

          <div style={note}>
            {data.forms.length
              ? `${companyName}, ${data.year}: ${count(data.forms.length, 'vendor', 'vendors')} marked to get a 1099 ${data.forms.length === 1 ? 'was' : 'were'} paid ${fmt(data.totals.total)} on accounts that count toward one.`
              : `${companyName}, ${data.year}: no vendor marked to get a 1099 was paid on an account that counts toward one.`}
            {copies.ledger?.at ? ` NetSuite's ledger copied ${ago(copies.ledger.at)}.` : ''}
            {copies.billPayments?.at ? ` Bill payments ${ago(copies.billPayments.at)}.` : ''}
            {copies.spending?.at ? ` Checks and card charges ${ago(copies.spending.at)}.` : ''}
          </div>

          {data.forms.length > 0 && (
            <PayeeTable
              payees={data.forms}
              heading={`${companyName}'s 1099s for ${data.year}`}
              columns={columns}
              amounts={boxAmounts}
              categories={categories}
            />
          )}

          {data.notMarked.length > 0 && (
            <details style={section}>
              <summary style={{ ...summary, color: RED }}>
                Paid on accounts that count, not marked to get a 1099 ({data.notMarked.length.toLocaleString('en-US')})
              </summary>
              <div style={{ ...note, padding: '0 14px' }}>
                Each was paid on an account NetSuite counts toward a 1099. One that should get a 1099 needs it ticked on its vendor
                record (Vendor Details); one that shouldn&apos;t, an employee say, was likely paid on the wrong account.
              </div>
              <PayeeTable
                payees={data.notMarked}
                heading="Paid on accounts that count"
                columns={columns}
                amounts={boxAmounts}
                extra={WHY_NOT_MARKED}
                categories={categories}
              />
            </details>
          )}

          {data.unsplit.length > 0 && (
            <details style={section}>
              <summary style={{ ...summary, color: RED }}>Payments FleetSuite can&apos;t split ({data.unsplit.length.toLocaleString('en-US')})</summary>
              <div style={{ padding: '0 14px 8px' }}>
                {data.unsplit.map((p) => (
                  <div key={p.netsuiteId}>
                    <div style={{ ...muted, paddingTop: '6px', fontWeight: 700, color: 'var(--text-secondary)' }}>
                      {p.name}{p.marked === true ? ' · marked to get a 1099' : ''}
                    </div>
                    <PaymentLine p={p} categories={categories} />
                  </div>
                ))}
              </div>
            </details>
          )}

          {data.nothingCounted.length > 0 && (
            <details style={section}>
              <summary style={summary}>Marked to get a 1099, paid only on other accounts ({data.nothingCounted.length.toLocaleString('en-US')})</summary>
              <div style={{ ...note, padding: '0 14px' }}>
                Nothing they were paid went to an account NetSuite counts toward a 1099, so NetSuite&apos;s 1099s leave them out too.
              </div>
              <PayeeTable
                payees={data.nothingCounted}
                heading="Marked, paid on other accounts"
                columns={['Paid']}
                amounts={(p) => [p.paid]}
                categories={categories}
              />
            </details>
          )}

          {data.byCard.length > 0 && (
            <details style={section}>
              <summary style={summary}>Marked to get a 1099, paid by card ({data.byCard.length.toLocaleString('en-US')})</summary>
              <div style={{ ...note, padding: '0 14px' }}>
                Left out of the totals above: the card company reports card payments, on a 1099-K.
              </div>
              <PayeeTable
                payees={data.byCard}
                heading="Paid by card"
                columns={['By card']}
                amounts={(p) => [p.byCard]}
                categories={categories}
              />
            </details>
          )}

          {data.accounts.length > 0 && (
            <details style={section}>
              <summary style={summary}>Accounts that count toward a 1099 ({data.accounts.length.toLocaleString('en-US')})</summary>
              <div style={{ padding: '0 14px 10px' }}>
                {data.accounts.map((a) => (
                  <div key={a.netsuiteId} style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', padding: '5px 0', borderTop: '1px solid var(--border)', fontSize: '12px' }}>
                    <span>{[a.number, a.name].filter(Boolean).join(' ')}</span>
                    <span style={{ color: 'var(--text-muted)', textAlign: 'right' }}>{a.category}</span>
                  </div>
                ))}
              </div>
            </details>
          )}
        </>
      )}
      {loading && !error && <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '10px' }}>Loading…</div>}
    </div>
  );
}
