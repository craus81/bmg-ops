import { dayText, OWN_CHECK_STATUSES, type OwnCheckStatus } from './own-invoice-check';
import {
  checkTaken, locationNameIn,
  type CopiesThrough, type FulfilPairData, type NetsuiteFulfillmentData, type PlaceData, type TakenCheck, type TakenWords,
} from './own-fulfillment-check';
import { invoiceCostLists, invoiceTakenLines, type InvoiceCostLists, type InvoiceCostPairsData, type OwnInvoiceCostLineData } from './own-invoice-cost-check';

/**
 * What Books' own credit memos put back on the shelf, next to NetSuite's
 * credit memos (migration 519, docs/books.md "Posting the stock a credit
 * memo puts back"; NetSuite Exit Checklist, "Gaps in what's built", thread
 * "Replacing NetSuite with FleetSuite", 2026-11-03).
 *
 * A credit memo FleetSuite makes against an invoice (src/lib/credit-memo.ts,
 * migration 466) puts each part credited with Back to stock on back on the
 * shelf at O'Fallon, the only location that keeps stock, and a kit's parts
 * for a kit; NetSuite books what that's worth on its credit memo's cost
 * lines. A part credited on the credit item stays with the customer and
 * puts nothing back.
 *
 * Each of Books' own copies of such a credit memo
 * (src/lib/books/own-credit-memos.ts) is put next to NetSuite's credit memo
 * as the copy of NetSuite's stock moves has it (migration 401), valued from
 * the copy of its general ledger, and checked the way an invoice's cost is
 * (checkTaken in own-fulfillment-check.ts), the other way round: its date,
 * where it put stock back, each item and how many, and what that was worth.
 * The copy's items are the parts it credits with Back to stock on that
 * NetSuite keeps in stock, a kit taken apart into its parts as the copy of
 * NetSuite's items has them; an item the copy of NetSuite's items doesn't
 * have may be one, and leaves the copy incomplete. Each comes back at
 * O'Fallon, and is worth its average there just before the credit memo, as
 * Stock by item counts it. NetSuite may value a return otherwise (at what
 * the invoice took it out at, say): then the two differ, and the books post
 * NetSuite's credit memo.
 *
 * A copy waits, is gone, differs, is incomplete or matches as an invoice's
 * cost does.
 *
 * Pure. Amounts are whole cents, what went back on the shelf positive.
 */

// ── What gl_own_credit_cost_pairs returns ──────────────────────────────────

/** A line of the copy that puts a part back on the shelf, of an item NetSuite may keep in stock. */
export type OwnCreditCostLineData = OwnInvoiceCostLineData;

export interface OwnCreditCostData {
  netsuite_id: string;
  number: string | null;
  /** The invoice it credits. */
  invoice_id: string;
  invoice_number: string | null;
  customer_netsuite_id: string | null;
  date: string;
  /** Where the parts it puts back come back to, as asked for (O'Fallon); null when it wasn't said. */
  location_id: string | null;
  made_at: string;
  lines: OwnCreditCostLineData[];
}

export interface CreditCostPairData {
  own: OwnCreditCostData;
  /** NetSuite's credit memo as the copy of its stock moves has it; null when the copy doesn't have it. */
  netsuite: NetsuiteFulfillmentData | null;
  /** Its cost lines in the copy of NetSuite's general ledger; null before that copy has the credit memo. */
  netsuite_gl: FulfilPairData['netsuite_gl'];
  before: PlaceData[];
  customer_name: string | null;
}

export interface CreditCostPairsData extends Omit<InvoiceCostPairsData, 'invoices'> {
  credit_memos: CreditCostPairData[];
}

// ── What the check says ────────────────────────────────────────────────────

export interface OwnCreditCostCheck extends Omit<TakenCheck, 'places' | 'tookApart'> {
  netsuiteId: string;
  number: string;
  date: string;
  /** The invoice it credits: NetSuite's id, and its number. */
  invoiceId: string;
  invoice: string;
  customer: string | null;
  /** Where the parts it puts back come back to, NetSuite's id for it; null when it puts nothing back. */
  locationId: string | null;
  /** How FleetSuite worked out what its copy put back, a sentence each. */
  workedOut: string[];
}

/** The words a credit memo's check uses. */
const CREDIT_WORDS: TakenWords = {
  theirs: "NetSuite's credit memo",
  the: 'the credit memo',
  notOnCopy: "FleetSuite's copy of the credit memo doesn't put it back",
  linesUnknown: 'what it put back on the shelf',
  whereUnknown: "FleetSuite didn't know where the credit memo put stock back.",
  whereDiffers: (ours, theirs) => `The credit memo screen puts every part that comes back on the shelf at ${ours}, and NetSuite put stock back at ${theirs}.`,
  back: true,
};

// ── One credit memo ────────────────────────────────────────────────────────

/** What Books' own credit memo put back on the shelf, next to what NetSuite's credit memo put back. */
export function checkOwnCreditCost(pair: CreditCostPairData, lists: InvoiceCostLists, copies: CopiesThrough): OwnCreditCostCheck {
  const own = pair.own;
  const number = own.number || pair.netsuite?.number || `NetSuite ${own.netsuite_id}`;
  const invoice = own.invoice_number || `NetSuite ${own.invoice_id}`;
  const customer = pair.customer_name ?? null;
  const lines = invoiceTakenLines(own.lines ?? [], lists.listed);
  // A credit memo that puts nothing back puts it nowhere.
  const locationId = lines.length ? own.location_id : null;
  const { tookApart, ...taken } = (({ places: _places, ...rest }) => rest)(checkTaken({
    own: { netsuite_id: own.netsuite_id, date: own.date, location_id: locationId, unknowns: [], made_at: own.made_at, lines },
    netsuite: pair.netsuite,
    netsuite_gl: pair.netsuite_gl,
    before: pair.before,
  }, lists, copies, CREDIT_WORDS));

  const at = locationNameIn(lists, locationId);
  const workedOut = lines.length
    ? [
      `Made on ${dayText(own.date)} against ${invoice}: a part credited with Back to stock on goes back on the shelf, as NetSuite's credit memo puts it back.`,
      "Its items are the parts it credits with Back to stock on, as the copy of NetSuite's items has them. A part credited on the credit item stays with the customer.",
      ...(tookApart
        ? ["A kit is taken apart into its parts, each the kit's quantity times what one kit holds, as the copy of NetSuite's items has them. "
          + "NetSuite puts a kit's parts back on the shelf, not the kit."]
        : []),
      locationId
        ? `Back at ${at}, where the credit memo screen puts every part that comes back on the shelf: it's the only location that keeps stock.`
        : "Where it put stock back isn't known.",
      "Each item is worth its average at that location just before the credit memo: the value FleetSuite counted of it there over the count, "
        + "from its count and value on December 31, 2024 and every NetSuite document since that comes before it, as Stock by item counts them. "
        + 'A line is worth its quantity at that average, to the cent. Where NetSuite valued it otherwise, the two differ and the books post NetSuite\'s credit memo.',
    ]
    : [`Made on ${dayText(own.date)} against ${invoice}. It puts nothing back on the shelf: none of its parts is credited with Back to stock on.`];

  return {
    netsuiteId: own.netsuite_id,
    number,
    date: own.date,
    invoiceId: own.invoice_id,
    invoice,
    customer,
    locationId,
    ...taken,
    workedOut,
  };
}

export interface OwnCreditCostsChecked {
  creditMemos: OwnCreditCostCheck[];
  counts: Record<OwnCheckStatus, number>;
}

/** Every own credit memo gl_own_credit_cost_pairs returned, each checked. */
export function checkOwnCreditCosts(data: CreditCostPairsData, copies: CopiesThrough): OwnCreditCostsChecked {
  const lists = invoiceCostLists(data);
  const creditMemos = (data.credit_memos ?? []).map((pair) => checkOwnCreditCost(pair, lists, copies));
  const counts = Object.fromEntries(OWN_CHECK_STATUSES.map((s) => [s, 0])) as Record<OwnCheckStatus, number>;
  for (const c of creditMemos) counts[c.status]++;
  return { creditMemos, counts };
}
