/**
 * An item's accounts changed in FleetSuite and sent on to NetSuite (Books
 * part 46, migration 478, docs/books.md "Item accounts changed in
 * FleetSuite"; owner decisions 2026-10-31, thread "Replacing NetSuite with
 * FleetSuite": from January 1, 2027 the team works only in FleetSuite, apart
 * from payments, deposits and banking, and in the first quarter FleetSuite
 * becomes the master for items, with each item's income, cost and inventory
 * accounts).
 *
 * From More → Money & Books → Item Accounts, or Change accounts beside an
 * item set up wrong on Books → Stock by item: the accounts NetSuite posts an
 * item's documents to, as its kind of item has them:
 *
 *   - its income account, where its sales post (invoice@1 reads it from the
 *     copy of NetSuite's items);
 *   - an inventory item's or an assembly's cost of goods sold account, where
 *     what it cost goes when it ships, and its inventory asset account, where
 *     that sits while it's on the shelf;
 *   - the expense account of one bought for resale, or only bought, where its
 *     bills post.
 *
 * Each changes to an account of BMG's that takes postings now, and only of
 * the kind it posts as: an asset account is never a cost of goods sold
 * account, which is how two items came to have theirs swapped (docs/books.md
 * "Items set up wrong, and value left over").
 *
 * Pure, so the page and the route agree on what changes and what NetSuite is
 * sent.
 */

export const REASON_MAX = 300;

/** The company whose items these are: FleetSuite makes every item in BMG's subsidiary (createItem in netsuite.ts). */
export const ITEM_COMPANY = 'BMG';

/** The record types NetSuite's REST API files the kinds of item that post to accounts under. */
export type ItemRecordType =
  | 'inventoryItem' | 'assemblyItem' | 'kitItem'
  | 'nonInventorySaleItem' | 'nonInventoryResaleItem' | 'nonInventoryPurchaseItem'
  | 'serviceSaleItem' | 'serviceResaleItem' | 'servicePurchaseItem'
  | 'otherChargeSaleItem' | 'otherChargeResaleItem' | 'otherChargePurchaseItem';

/** NetSuite's names for an item's accounts on its record. */
export type AccountField = 'incomeAccount' | 'cogsAccount' | 'assetAccount' | 'expenseAccount';

/** In the order the screen and a change list them. */
export const ACCOUNT_FIELDS: readonly AccountField[] = ['incomeAccount', 'cogsAccount', 'assetAccount', 'expenseAccount'];

export interface FieldInfo {
  /** What it's called on the screen and in a change. */
  name: string;
  /** What posts to it, a sentence. */
  posts: string;
  /** The kinds of account (gl_accounts.account_type) it can be. */
  kinds: readonly string[];
  /** Those kinds in words, as a problem says them. */
  takes: string;
}

export const FIELDS: Readonly<Record<AccountField, FieldInfo>> = {
  incomeAccount: { name: 'Income account', posts: 'Its sales post here.', kinds: ['income', 'other_income'], takes: 'an income or other income account' },
  cogsAccount: { name: 'Cost of goods sold account', posts: 'What it cost goes here when it ships.', kinds: ['cost_of_goods_sold'], takes: 'a cost of goods sold account' },
  assetAccount: { name: 'Inventory asset account', posts: "What it cost sits here while it's on the shelf.", kinds: ['other_current_asset'], takes: 'a current asset account' },
  expenseAccount: {
    name: 'Expense account', posts: 'Its bills post here.', kinds: ['cost_of_goods_sold', 'expense', 'other_expense'],
    takes: 'a cost of goods sold, expense or other expense account',
  },
};

/** Every kind of account one of an item's accounts can be. */
export const ITEM_ACCOUNT_KINDS: readonly string[] = [...new Set(Object.values(FIELDS).flatMap((f) => f.kinds))];

/** Each kind of item: what it's called and the accounts it posts to. */
export const ITEM_KINDS: Readonly<Record<ItemRecordType, { name: string; fields: readonly AccountField[] }>> = {
  inventoryItem: { name: 'Inventory item', fields: ['incomeAccount', 'cogsAccount', 'assetAccount'] },
  assemblyItem: { name: 'Assembly', fields: ['incomeAccount', 'cogsAccount', 'assetAccount'] },
  kitItem: { name: 'Kit', fields: ['incomeAccount'] },
  nonInventorySaleItem: { name: 'Non-inventory item for sale', fields: ['incomeAccount'] },
  nonInventoryResaleItem: { name: 'Non-inventory item for resale', fields: ['incomeAccount', 'expenseAccount'] },
  nonInventoryPurchaseItem: { name: 'Non-inventory item for purchase', fields: ['expenseAccount'] },
  serviceSaleItem: { name: 'Service for sale', fields: ['incomeAccount'] },
  serviceResaleItem: { name: 'Service for resale', fields: ['incomeAccount', 'expenseAccount'] },
  servicePurchaseItem: { name: 'Service for purchase', fields: ['expenseAccount'] },
  otherChargeSaleItem: { name: 'Other charge for sale', fields: ['incomeAccount'] },
  otherChargeResaleItem: { name: 'Other charge for resale', fields: ['incomeAccount', 'expenseAccount'] },
  otherChargePurchaseItem: { name: 'Other charge for purchase', fields: ['expenseAccount'] },
};

/**
 * The record types an item may be filed under, by the kind the copy of NetSuite's items says it is (SuiteQL's
 * itemtype). SuiteQL doesn't say whether a non-inventory item, a service or an other charge is for sale, for resale
 * or for purchase, so each is tried in turn, the likeliest first.
 */
const RECORD_TYPES = new Map<string, readonly ItemRecordType[]>([
  ['InvtPart', ['inventoryItem']],
  ['Assembly', ['assemblyItem']],
  ['Kit', ['kitItem']],
  ['NonInvtPart', ['nonInventoryResaleItem', 'nonInventorySaleItem', 'nonInventoryPurchaseItem']],
  ['Service', ['serviceSaleItem', 'serviceResaleItem', 'servicePurchaseItem']],
  ['OthCharge', ['otherChargeSaleItem', 'otherChargeResaleItem', 'otherChargePurchaseItem']],
]);

/** The kinds of item, as the copy of NetSuite's items names them, whose accounts change here. */
export const ITEM_TYPES_WITH_ACCOUNTS: readonly string[] = [...RECORD_TYPES.keys()];

/** The record types to try for an item the copy says is `itemType`: none for a kind with no accounts to change here. */
export function recordTypesFor(itemType: string | null | undefined): readonly ItemRecordType[] {
  return RECORD_TYPES.get(itemType ?? '') ?? [];
}

/** Where the copy of NetSuite's items keeps each account (src/lib/books/netsuite-lists.ts): it can't read the cost of goods sold one. */
export const COPY_KEYS: Readonly<Partial<Record<AccountField, string>>> = {
  incomeAccount: 'income_account', assetAccount: 'asset_account', expenseAccount: 'expense_account',
};

export interface ItemAccount {
  /** NetSuite's id for the account. */
  id: string;
  /** How NetSuite named it, when it said. */
  name: string | null;
}

export interface AccountsItem {
  id: string;
  recordType: ItemRecordType;
  /** Its item number: NetSuite's itemId. */
  number: string;
  displayName: string;
  inactive: boolean;
  /** The account on each field its kind of item posts to, or null where NetSuite has none. */
  accounts: Partial<Record<AccountField, ItemAccount | null>>;
}

/** An account in the chart of accounts, as an item's accounts are picked from it. */
export interface ChartAccount {
  /** NetSuite's id. */
  id: string;
  number: string | null;
  name: string;
  /** gl_accounts.account_type. */
  type: string;
  /** The companies whose documents can post to it now: none when it's inactive or a summary account. */
  companies: string[];
}

/** What the page sends: each account changed, by field, as NetSuite's id for the account picked. */
export interface ItemAccountsEdit {
  reason: string;
  accounts?: Partial<Record<AccountField, string>>;
}

export interface ItemAccountsPlan {
  /** What NetSuite is sent. */
  body: Record<string, unknown>;
  /** What changes, a sentence each. */
  changes: string[];
  problems: string[];
  notes: string[];
}

const text = (v: unknown): string => (v === null || v === undefined ? '' : typeof v === 'object' ? '' : String(v).trim());

/** A select field: REST answers { id, refName }, or now and then the bare id. Null when it holds no account. */
function accountOf(v: any): ItemAccount | null {
  const id = v && typeof v === 'object' ? v.id : v;
  if (id === null || id === undefined || !/^\d+$/.test(String(id))) return null;
  return { id: String(id), name: v && typeof v === 'object' && v.refName ? String(v.refName) : null };
}

/** The item `id`'s record of type `recordType`, as NetSuite's REST GET gives it. */
export function parseAccountsItem(recordType: ItemRecordType, id: string, record: any): AccountsItem {
  const r = record ?? {};
  const accounts: Partial<Record<AccountField, ItemAccount | null>> = {};
  for (const field of ITEM_KINDS[recordType].fields) accounts[field] = accountOf(r[field]);
  return {
    id,
    recordType,
    number: text(r.itemId) || `Item ${id}`,
    displayName: text(r.displayName),
    inactive: r.isInactive === true || r.isInactive === 'T',
    accounts,
  };
}

/** What a change of the item is worked out from, in a line: anything different means it changed in NetSuite. */
export function itemFacts(item: AccountsItem): string {
  return JSON.stringify([
    item.id, item.recordType, item.number, item.displayName, item.inactive,
    ITEM_KINDS[item.recordType].fields.map((f) => item.accounts[f]?.id ?? null),
  ]);
}

/** An account as people read it: its number and name in the chart, else NetSuite's name for it. */
export function accountText(id: string, chart: ReadonlyMap<string, ChartAccount>, said?: string | null): string {
  const a = chart.get(id);
  if (a) return [a.number, a.name].filter(Boolean).join(' ') || `NetSuite account ${id}`;
  return said || `NetSuite account ${id}`;
}

/** The chart's kinds of account (migration 359), as people say them. */
const KIND_WORDS = new Map<string, string>([
  ['bank', 'a bank account'], ['accounts_receivable', 'an accounts receivable account'],
  ['other_current_asset', 'a current asset account'], ['fixed_asset', 'a fixed asset account'], ['other_asset', 'an other asset account'],
  ['unbilled_receivable', 'an unbilled receivable account'], ['deferred_expense', 'a deferred expense account'],
  ['accounts_payable', 'an accounts payable account'], ['credit_card', 'a credit card account'],
  ['other_current_liability', 'a liability account'], ['long_term_liability', 'a long-term liability account'],
  ['deferred_revenue', 'a deferred revenue account'], ['equity', 'an equity account'], ['income', 'an income account'],
  ['other_income', 'an other income account'], ['cost_of_goods_sold', 'a cost of goods sold account'],
  ['expense', 'an expense account'], ['other_expense', 'an other expense account'],
]);

export const kindWords = (type: string): string => KIND_WORDS.get(type) ?? 'an account of another kind';

/** Whether `account` is of a kind `field` can be. */
export const fitsField = (field: AccountField, account: Pick<ChartAccount, 'type'>): boolean => FIELDS[field].kinds.includes(account.type);

/** The accounts `field` can be changed to: BMG's that take postings now, of a kind it can be, by number. */
export function choicesFor(field: AccountField, chart: Iterable<ChartAccount>): ChartAccount[] {
  return [...chart]
    .filter((a) => a.companies.includes(ITEM_COMPANY) && fitsField(field, a))
    .sort((a, b) => (a.number ?? '').localeCompare(b.number ?? '', 'en', { numeric: true }) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const withA = (s: string) => `${/^[aeiou]/i.test(s) ? 'An' : 'A'} ${lower(s)}`;

/** Works out what changes and what NetSuite is sent, or what's in the way. */
export function planItemAccounts(
  item: AccountsItem,
  edit: ItemAccountsEdit,
  facts: { chart: ReadonlyMap<string, ChartAccount> },
): ItemAccountsPlan {
  const body: Record<string, unknown> = {};
  const changes: string[] = [];
  const problems: string[] = [];
  const notes: string[] = [];
  const kind = ITEM_KINDS[item.recordType];
  const named = (a: ItemAccount) => accountText(a.id, facts.chart, a.name);

  for (const field of ACCOUNT_FIELDS) {
    const picked = edit.accounts?.[field];
    if (picked === undefined) continue;
    const info = FIELDS[field];
    if (!kind.fields.includes(field)) {
      problems.push(`${withA(kind.name)} has no ${lower(info.name)}.`);
      continue;
    }
    const now = item.accounts[field] ?? null;
    if (picked === (now?.id ?? '')) continue;
    if (!picked) {
      problems.push(`Its ${lower(info.name)} can't be left empty: pick the account it should be.`);
      continue;
    }
    const account = facts.chart.get(picked);
    if (!account) {
      problems.push(`Pick its ${lower(info.name)} from the chart of accounts.`);
      continue;
    }
    const pickedText = accountText(picked, facts.chart);
    if (!fitsField(field, account)) {
      problems.push(`${pickedText} is ${kindWords(account.type)}: an item's ${lower(info.name)} is ${info.takes}.`);
      continue;
    }
    if (!account.companies.includes(ITEM_COMPANY)) {
      problems.push(`${pickedText} can't take BMG's postings now: it's inactive, a summary account, or another company's.`);
      continue;
    }
    body[field] = { id: picked };
    changes.push(`${info.name} ${now ? named(now) : '(none)'} → ${pickedText}`);
  }

  // An account of the wrong kind that this change leaves as it is, so it isn't missed.
  for (const field of kind.fields) {
    const now = item.accounts[field];
    const account = now ? facts.chart.get(now.id) : undefined;
    if (body[field] === undefined && now && account && !fitsField(field, account)) {
      notes.push(`Its ${lower(FIELDS[field].name)} stays ${named(now)}, ${kindWords(account.type)}, where it should be ${FIELDS[field].takes}.`);
    }
  }
  if (changes.length > 0) notes.push("Documents already made keep what they posted; the item's next ones post to the new accounts.");
  const shelf = item.accounts.assetAccount;
  if (body.assetAccount !== undefined && shelf) {
    notes.push(`What it's worth on the shelf now stays on ${named(shelf)} until a journal entry moves it.`);
  }

  const reason = edit.reason.trim();
  if (!reason) problems.push("Say why it's being changed.");
  else if (reason.length > REASON_MAX) problems.push(`Why it's being changed takes ${REASON_MAX} characters at most.`);
  if (changes.length === 0 && problems.length === 0) problems.push('Nothing has changed yet.');

  return { body, changes, problems, notes };
}
