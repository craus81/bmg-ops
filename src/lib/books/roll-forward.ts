import { toCents } from './netsuite-gl';
import { lineSpan, type Pair, type ReportData } from './reports';

/**
 * Fixed assets and loans in the year-end package (part 79, docs/books.md
 * "The CPA's yearly entries"): each fixed asset, other asset and long term
 * liability account over the months, as the balance sheet has it, assets
 * debit positive and liabilities credit positive: where it stood before the
 * first month, FleetSuite's debits and credits in the months, and where it
 * stood at the last month's end, next to NetSuite's. Every part's total is
 * the balance sheet's at both ends. The CPA ties its schedules of
 * depreciation and loans to it, and books the year's depreciation and loan
 * interest from them on its adjustments journal. Amounts are whole cents.
 */

/** The balance sheet's parts the package rolls forward, in its order, each with the account types in it. */
export const ROLL_FORWARD_PARTS: ReadonlyArray<{ label: string; types: readonly string[] }> = [
  { label: 'Fixed assets', types: ['fixed_asset'] },
  { label: 'Other assets', types: ['other_asset'] },
  { label: 'Long term liabilities', types: ['long_term_liability'] },
];

export interface RollForwardAmounts {
  /** Where it stood the day before the first month, both sides. */
  starting: Pair;
  /** FleetSuite's debits and credits in the months. */
  debits: number;
  credits: number;
  /** Where it stood at the last month's end, both sides. */
  ending: Pair;
}

export interface RollForwardLine extends RollForwardAmounts {
  /** Its NetSuite id, or fs:<id> for one NetSuite doesn't have. */
  key: string;
  number: string | null;
  name: string;
}

export interface RollForwardPart {
  label: string;
  lines: RollForwardLine[];
  total: RollForwardAmounts;
}

type Range = { from: string; to: string };

const collator = new Intl.Collator('en', { numeric: true });
const keyOf = (a: ReportData['accounts'][number]) => a.netsuite_account_id ?? `fs:${a.id}`;
const plus = (a: Pair, b: Pair): Pair => ({ fleetsuite: a.fleetsuite + b.fleetsuite, netsuite: a.netsuite + b.netsuite });
const ZERO: Pair = { fleetsuite: 0, netsuite: 0 };

/**
 * The parts with anything in them for the months from `from` through `to`
 * ('YYYY-MM-01'): an account shows with a balance at either end on either
 * side, or anything FleetSuite debited or credited to it in the months, by
 * number and name.
 */
export function rollForward(data: ReportData, range: Range): RollForwardPart[] {
  const moved = new Map<string, { debits: number; credits: number }>();
  for (const r of data.fleetsuite) {
    if (r.month < range.from || r.month > range.to) continue;
    const m = moved.get(r.account) ?? { debits: 0, credits: 0 };
    moved.set(r.account, { debits: m.debits + toCents(r.debit), credits: m.credits + toCents(r.credit) });
  }
  return ROLL_FORWARD_PARTS.map(({ label, types }): RollForwardPart => {
    const lines = data.accounts
      .filter((a) => types.includes(a.account_type))
      .sort((x, y) => Number(x.number === null) - Number(y.number === null)
        || collator.compare(x.number ?? '', y.number ?? '')
        || collator.compare(x.name, y.name))
      .map((a): RollForwardLine => {
        const key = keyOf(a);
        const span = lineSpan(data, 'balance_sheet', key, range);
        const { debits, credits } = moved.get(key) ?? { debits: 0, credits: 0 };
        // One the chart keeps on the income statement starts from nothing, as the trial balance has it.
        return { key, number: a.number, name: a.name, starting: span.starting ?? ZERO, debits, credits, ending: span.ending };
      })
      .filter((l) => l.debits || l.credits || l.starting.fleetsuite || l.starting.netsuite || l.ending.fleetsuite || l.ending.netsuite);
    const total = lines.reduce((sum, l): RollForwardAmounts => ({
      starting: plus(sum.starting, l.starting),
      debits: sum.debits + l.debits,
      credits: sum.credits + l.credits,
      ending: plus(sum.ending, l.ending),
    }), { starting: ZERO, debits: 0, credits: 0, ending: ZERO });
    return { label, lines, total };
  }).filter((p) => p.lines.length);
}
