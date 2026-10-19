import type { GlTotals } from './differences';
import { toCents } from './netsuite-gl';
import { detailDocuments, type AccountDocumentsData, type DetailDocument } from './report-detail';

/**
 * Customer and vendor balances (migration 406, docs/books.md "Customer and
 * vendor balances"; owner decision 2026-10-19, thread "Replacing NetSuite
 * with FleetSuite", "Balance checks"): what each customer owes and each
 * vendor is owed in FleetSuite's books, next to NetSuite's, so a balance
 * that drifts shows up by name. Both start from where NetSuite's receivable
 * and payable accounts stood before 2025, split by name
 * (gl_netsuite_opening_parties, read with the copy of NetSuite's ledger),
 * then every document since: FleetSuite's journal on one side, the copy of
 * NetSuite's general ledger on the other.
 *
 * A customer is the FleetSuite customer a line names; NetSuite's lines name
 * one through the customer the ledger mirror matched by its NetSuite id.
 * The lines that name no customer, or one the mirror hasn't matched, make
 * one group, since FleetSuite's books can't tell them apart; NetSuite's
 * names among them are listed under it. A vendor is NetSuite's id for it.
 * Amounts are whole cents, as each reads: what a customer owes, what a
 * vendor is owed.
 */

export type PartyKind = 'customer' | 'vendor';
export const PARTY_KINDS: readonly PartyKind[] = ['customer', 'vendor'];

export const isPartyKind = (v: unknown): v is PartyKind => v === 'customer' || v === 'vendor';

/** A customer's balance reads debit positive, what it owes; a vendor's credit positive, what it's owed. */
export const signOf = (kind: PartyKind): 1 | -1 => (kind === 'customer' ? 1 : -1);

/** FleetSuite's id for a customer. */
export const CUSTOMER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A party as a page or link names it: a customer's FleetSuite id, a vendor's NetSuite id, or '' for the lines FleetSuite can't name. */
export function isParty(kind: PartyKind, party: string): boolean {
  return party === '' || (kind === 'customer' ? CUSTOMER_ID_RE.test(party) : /^\d+$/.test(party));
}

/** One NetSuite name among the customers FleetSuite's books can't name, as gl_party_balances returns it. */
export interface PartyMemberData {
  entity_id: string;
  name: string | null;
  opening: string;
  netsuite: string;
}

/** One customer or vendor as gl_party_balances returns it: amounts are decimal strings, debit positive. */
export interface PartyBalanceData {
  party: string;
  name: string | null;
  netsuite_ids: string[];
  opening: string;
  netsuite: string;
  fleetsuite: string;
  documents: number;
  differing: number;
  members: PartyMemberData[] | null;
  members_count: number | null;
}

export interface PartyBalancesData {
  accounts: Array<{ netsuite_account_id: string | null; number: string | null; name: string }>;
  opening: { total: string; named: string; complete: boolean };
  parties: PartyBalanceData[];
}

/** The documents behind one balance, as gl_party_documents returns them. */
export interface PartyDocumentsData extends AccountDocumentsData {
  party: string;
  name: string | null;
  netsuite_ids: string[];
  opening: string;
}

/** What the group of lines FleetSuite can't name is called. */
export const UNNAMED: Readonly<Record<PartyKind, string>> = {
  customer: 'Not matched to a FleetSuite customer',
  vendor: 'No vendor named',
};

/** A party's name, or what stands in for one. */
export function partyName(kind: PartyKind, party: string, name: string | null): string {
  if (party === '') return UNNAMED[kind];
  const named = name?.trim();
  if (named) return named;
  return kind === 'customer' ? 'Customer with no name' : `NetSuite vendor ${party}`;
}

/** One NetSuite name among the customers FleetSuite can't name. */
export interface PartyMember {
  /** NetSuite's id for it; '' for the lines that name no customer. */
  entityId: string;
  name: string;
  /** What it owes in NetSuite's books. */
  balance: number;
}

/** One customer's or vendor's balance, each side. */
export interface PartyBalance {
  /** A customer's FleetSuite id, a vendor's NetSuite id; '' for the lines FleetSuite can't name. */
  party: string;
  name: string;
  /** NetSuite's ids for it: a customer's every NetSuite customer matched to it. */
  netsuiteIds: string[];
  /** Where NetSuite's receivable or payable accounts stood for it before 2025, the same on both sides. */
  opening: number;
  /** Its balance now: the opening and every document since. */
  fleetsuite: number;
  netsuite: number;
  /** Documents that moved it, either side, and how many of them differ. */
  documents: number;
  differing: number;
  /** Its two balances differ. */
  differs: boolean;
  /** The customers FleetSuite can't name: NetSuite's names among them, the largest balances first, at most 200. */
  members: PartyMember[];
  membersCount: number;
}

export interface PartyBalances {
  kind: PartyKind;
  /** The chart's receivable (payable) accounts counted. */
  accounts: Array<{ number: string | null; name: string }>;
  /**
   * Every customer (vendor) with a balance on either side or a document that differs: those whose balances differ
   * first, the largest difference first, then by name, the lines FleetSuite can't name last.
   */
  parties: PartyBalance[];
  /** What of the starting entry isn't split by name, when NetSuite's names before 2025 couldn't all be read; both sides. */
  unsplit: number;
  /** The split by name adds up to the starting entry on every account. */
  openingComplete: boolean;
  /** Every party with what isn't split by name, each side: the receivable (payable) accounts' balance. */
  totals: { fleetsuite: number; netsuite: number };
  /** How many parties' balances differ. */
  differing: number;
}

const byName = (a: PartyBalance, b: PartyBalance) =>
  Number(a.party === '') - Number(b.party === '') || a.name.localeCompare(b.name, 'en-US', { sensitivity: 'base' }) || a.party.localeCompare(b.party);

/** gl_party_balances' answer for one kind, as the page shows it. */
export function partyBalances(data: PartyBalancesData | null, kind: PartyKind): PartyBalances {
  const sign = signOf(kind);
  const read = (v: string | null | undefined) => sign * toCents(v ?? 0) || 0;
  const parties = (data?.parties ?? []).map((p): PartyBalance => {
    const opening = read(p.opening);
    const fleetsuite = opening + read(p.fleetsuite);
    const netsuite = opening + read(p.netsuite);
    return {
      party: p.party,
      name: partyName(kind, p.party, p.name),
      netsuiteIds: p.netsuite_ids ?? [],
      opening,
      fleetsuite,
      netsuite,
      documents: Number(p.documents) || 0,
      differing: Number(p.differing) || 0,
      differs: fleetsuite !== netsuite,
      members: (p.members ?? []).map((m) => ({
        entityId: m.entity_id,
        name: m.name?.trim() || (m.entity_id ? `NetSuite customer ${m.entity_id}` : 'No customer named'),
        balance: read(m.opening) + read(m.netsuite),
      })),
      membersCount: Number(p.members_count) || 0,
    };
  });
  parties.sort((a, b) => Number(b.differs) - Number(a.differs)
    || (a.differs ? Math.abs(b.fleetsuite - b.netsuite) - Math.abs(a.fleetsuite - a.netsuite) : 0)
    || byName(a, b));
  const unsplit = read(data?.opening.total) - read(data?.opening.named);
  const sum = (side: 'fleetsuite' | 'netsuite') => parties.reduce((total, p) => total + p[side], unsplit);
  return {
    kind,
    accounts: (data?.accounts ?? []).map((a) => ({ number: a.number, name: a.name })),
    parties,
    unsplit,
    openingComplete: data?.opening.complete ?? true,
    totals: { fleetsuite: sum('fleetsuite'), netsuite: sum('netsuite') },
    differing: parties.filter((p) => p.differs).length,
  };
}

/** One customer's or vendor's balance and the documents behind it. */
export interface PartyDetail {
  kind: PartyKind;
  party: string;
  name: string;
  netsuiteIds: string[];
  opening: number;
  /** What its documents came to, each side. */
  moved: { fleetsuite: number; netsuite: number };
  /** Its balance now. */
  balance: { fleetsuite: number; netsuite: number };
  documents: number;
  differing: number;
  /** Those that differ first, then the newest; amounts as the balance reads. */
  rows: DetailDocument[];
}

/** gl_party_documents' answer, as the page shows it. */
export function partyDetail(data: PartyDocumentsData, kind: PartyKind): PartyDetail {
  const sign = signOf(kind);
  const read = (v: string | null | undefined) => sign * toCents(v ?? 0) || 0;
  const opening = read(data.opening);
  const moved = { fleetsuite: read(data.fleetsuite), netsuite: read(data.netsuite) };
  return {
    kind,
    party: data.party,
    name: partyName(kind, data.party, data.name),
    netsuiteIds: data.netsuite_ids ?? [],
    opening,
    moved,
    balance: { fleetsuite: opening + moved.fleetsuite, netsuite: opening + moved.netsuite },
    documents: Number(data.documents) || 0,
    differing: Number(data.differing) || 0,
    rows: detailDocuments(data, sign),
  };
}

/**
 * Whether the copy of NetSuite's ledger holds everything NetSuite's own
 * totals say moved these accounts, month by month; null when those totals
 * haven't been read yet. Until it does, NetSuite's side of a balance may be
 * short.
 */
export function copyHoldsAccounts(totals: GlTotals | null | undefined, accounts: Array<string | null>): boolean | null {
  if (!totals?.netsuite?.length) return null;
  const ids = new Set(accounts.filter((a): a is string => !!a));
  const gap = new Map<string, number>();
  const add = (rows: GlTotals['netsuite'], sign: number) => {
    for (const r of rows ?? []) {
      if (!ids.has(r.netsuite_account_id)) continue;
      const key = `${r.netsuite_account_id}|${r.month ?? ''}`;
      gap.set(key, (gap.get(key) ?? 0) + sign * (toCents(r.debit) - toCents(r.credit)));
    }
  };
  add(totals.netsuite, 1);
  add(totals.copied, -1);
  return [...gap.values()].every((cents) => cents === 0);
}
