import { describe, it, expect } from 'vitest';
import {
  ACCOUNT_FIELDS, COPY_KEYS, FIELDS, ITEM_ACCOUNT_KINDS, ITEM_KINDS, ITEM_TYPES_WITH_ACCOUNTS, REASON_MAX,
  accountText, choicesFor, fitsField, itemFacts, kindWords, parseAccountsItem, planItemAccounts, recordTypesFor,
  type AccountsItem, type ChartAccount, type ItemAccountsEdit, type ItemRecordType,
} from './item-accounts';

// An item's accounts changed in FleetSuite and sent on to NetSuite (Books part 46): reading the item as NetSuite's
// REST GET gives it, which accounts each kind of item posts to, and what a change sends NetSuite and says. Made-up data.

const acct = (id: string, number: string | null, name: string, type: string, companies: string[] = ['BMG']): ChartAccount =>
  ({ id, number, name, type, companies });

/** The chart as the route reads it: BMG's accounts that take postings, and a few that don't. */
const LIST = [
  acct('101', '40000', 'Sales', 'income'),
  acct('102', '4100', 'Install Labor', 'income'),
  acct('103', '49000', 'Other Income', 'other_income'),
  acct('104', '50000', 'Cost of Goods Sold', 'cost_of_goods_sold'),
  acct('105', '58000', 'Parts COGS', 'cost_of_goods_sold'),
  acct('106', '19000', 'Inventory Asset', 'other_current_asset'),
  acct('107', '10100', 'Checking', 'bank'),
  acct('108', '60000', 'Shop Supplies', 'expense'),
  acct('109', '70000', 'Bank Fees', 'other_expense'),
  acct('110', '40500', 'Old Sales', 'income', []),
  acct('111', '40600', 'Sister Co Sales', 'income', ['ELSE']),
  acct('112', null, 'Uncategorized Income', 'income'),
];
const CHART: ReadonlyMap<string, ChartAccount> = new Map(LIST.map((a) => [a.id, a]));

/** 51-2002 as GET inventoryItem/501 answers it: its cost of goods sold and inventory asset accounts swapped. */
const RECORD = {
  id: '501', itemId: '51-2002', displayName: 'Hitch ball mount', isInactive: false,
  incomeAccount: { id: '101', refName: 'Sales' },
  cogsAccount: { id: '106', refName: '19000 Inventory Asset' },
  assetAccount: { id: '105', refName: '58000 Parts COGS' },
  expenseAccount: { id: '108', refName: 'Shop Supplies' },
};
const item = parseAccountsItem('inventoryItem', '501', RECORD);
const plan = (edit: Partial<ItemAccountsEdit>, i: AccountsItem = item) => planItemAccounts(i, { reason: 'Swapped at set-up', ...edit }, { chart: CHART });
const DONE_NOTE = "Documents already made keep what they posted; the item's next ones post to the new accounts.";
/** An item of `recordType` with the accounts given, by field. */
const itemOf = (recordType: ItemRecordType, accounts: AccountsItem['accounts']): AccountsItem =>
  ({ id: '601', recordType, number: '06-1000', displayName: '', inactive: false, accounts });

describe('the kinds of item', () => {
  it('tries the record types a kind of item may be filed under, the likeliest first', () => {
    expect(recordTypesFor('InvtPart')).toEqual(['inventoryItem']);
    expect(recordTypesFor('Assembly')).toEqual(['assemblyItem']);
    expect(recordTypesFor('Kit')).toEqual(['kitItem']);
    expect(recordTypesFor('NonInvtPart')).toEqual(['nonInventoryResaleItem', 'nonInventorySaleItem', 'nonInventoryPurchaseItem']);
    expect(recordTypesFor('Service')).toEqual(['serviceSaleItem', 'serviceResaleItem', 'servicePurchaseItem']);
    expect(recordTypesFor('OthCharge')).toEqual(['otherChargeSaleItem', 'otherChargeResaleItem', 'otherChargePurchaseItem']);
    expect(ITEM_TYPES_WITH_ACCOUNTS).toEqual(['InvtPart', 'Assembly', 'Kit', 'NonInvtPart', 'Service', 'OthCharge']);
    for (const t of ITEM_TYPES_WITH_ACCOUNTS) for (const r of recordTypesFor(t)) expect(ITEM_KINDS[r]).toBeDefined();
  });

  it('has none for a kind whose accounts are not changed here, or for no kind at all', () => {
    for (const t of ['Discount', 'Subtotal', 'Description', 'invtpart', '', null, undefined]) expect(recordTypesFor(t)).toEqual([]);
  });

  it('posts each kind of item to its own accounts', () => {
    expect(Object.fromEntries(Object.entries(ITEM_KINDS).map(([k, v]) => [k, [v.name, ...v.fields]]))).toEqual({
      inventoryItem: ['Inventory item', 'incomeAccount', 'cogsAccount', 'assetAccount'],
      assemblyItem: ['Assembly', 'incomeAccount', 'cogsAccount', 'assetAccount'],
      kitItem: ['Kit', 'incomeAccount'],
      nonInventorySaleItem: ['Non-inventory item for sale', 'incomeAccount'],
      nonInventoryResaleItem: ['Non-inventory item for resale', 'incomeAccount', 'expenseAccount'],
      nonInventoryPurchaseItem: ['Non-inventory item for purchase', 'expenseAccount'],
      serviceSaleItem: ['Service for sale', 'incomeAccount'],
      serviceResaleItem: ['Service for resale', 'incomeAccount', 'expenseAccount'],
      servicePurchaseItem: ['Service for purchase', 'expenseAccount'],
      otherChargeSaleItem: ['Other charge for sale', 'incomeAccount'],
      otherChargeResaleItem: ['Other charge for resale', 'incomeAccount', 'expenseAccount'],
      otherChargePurchaseItem: ['Other charge for purchase', 'expenseAccount'],
    });
  });

  it('reads every kind of account an item can post to, and the copy keeps all but cost of goods sold', () => {
    expect(ACCOUNT_FIELDS).toEqual(['incomeAccount', 'cogsAccount', 'assetAccount', 'expenseAccount']);
    expect(ITEM_ACCOUNT_KINDS).toEqual(['income', 'other_income', 'cost_of_goods_sold', 'other_current_asset', 'expense', 'other_expense']);
    expect(COPY_KEYS).toEqual({ incomeAccount: 'income_account', assetAccount: 'asset_account', expenseAccount: 'expense_account' });
  });
});

describe('fitsField', () => {
  it('takes only the kinds of account each of an item\'s accounts can be', () => {
    const fits = (type: string) => ACCOUNT_FIELDS.filter((f) => fitsField(f, { type }));
    expect(fits('income')).toEqual(['incomeAccount']);
    expect(fits('other_income')).toEqual(['incomeAccount']);
    expect(fits('cost_of_goods_sold')).toEqual(['cogsAccount', 'expenseAccount']);
    expect(fits('other_current_asset')).toEqual(['assetAccount']);
    expect(fits('expense')).toEqual(['expenseAccount']);
    expect(fits('other_expense')).toEqual(['expenseAccount']);
    for (const t of ['bank', 'fixed_asset', 'accounts_payable', 'equity', 'deferred_revenue', 'credit_card']) expect(fits(t)).toEqual([]);
  });
});

describe('parseAccountsItem', () => {
  it('reads the item and the accounts its kind posts to, not the others', () => {
    expect(item).toEqual({
      id: '501', recordType: 'inventoryItem', number: '51-2002', displayName: 'Hitch ball mount', inactive: false,
      accounts: {
        incomeAccount: { id: '101', name: 'Sales' },
        cogsAccount: { id: '106', name: '19000 Inventory Asset' },
        assetAccount: { id: '105', name: '58000 Parts COGS' },
      },
    });
  });

  it('reads bare ids, the flags NetSuite writes as T and F, and what it leaves out', () => {
    expect(parseAccountsItem('nonInventoryResaleItem', '502', {
      itemId: ' 06-2000 ', displayName: { value: 'x' }, isInactive: 'T', incomeAccount: 103, expenseAccount: '108',
    })).toEqual({
      id: '502', recordType: 'nonInventoryResaleItem', number: '06-2000', displayName: '', inactive: true,
      accounts: { incomeAccount: { id: '103', name: null }, expenseAccount: { id: '108', name: null } },
    });
    expect(parseAccountsItem('kitItem', '503', null)).toEqual({
      id: '503', recordType: 'kitItem', number: 'Item 503', displayName: '', inactive: false, accounts: { incomeAccount: null },
    });
    expect(parseAccountsItem('kitItem', '503', { itemId: { id: 'x' }, isInactive: 'F' }).number).toBe('Item 503');
    expect(parseAccountsItem('kitItem', '503', { isInactive: 'true' }).inactive).toBe(false);
    expect(parseAccountsItem('kitItem', '503', { isInactive: true }).inactive).toBe(true);
  });

  it('holds no account where the field holds no id NetSuite could have', () => {
    for (const v of [null, undefined, '', { id: null }, { id: '' }, { refName: 'Sales' }, { id: '10a' }, '-4', 'Sales', 1.5]) {
      expect(parseAccountsItem('kitItem', '503', { incomeAccount: v }).accounts.incomeAccount).toBeNull();
    }
    expect(parseAccountsItem('kitItem', '503', { incomeAccount: { id: 7, refName: '' } }).accounts.incomeAccount).toEqual({ id: '7', name: null });
    expect(parseAccountsItem('kitItem', '503', { incomeAccount: { id: '7', refName: 40000 } }).accounts.incomeAccount).toEqual({ id: '7', name: '40000' });
  });
});

describe('itemFacts', () => {
  it('is what a change is worked out from, in a line', () => {
    expect(itemFacts(item)).toBe('["501","inventoryItem","51-2002","Hitch ball mount",false,["101","106","105"]]');
  });

  it('changes when NetSuite has changed the item, not when the accounts its kind lacks do', () => {
    const facts = itemFacts(item);
    expect(itemFacts({ ...item, number: '51-2003' })).not.toBe(facts);
    expect(itemFacts({ ...item, displayName: 'Ball mount' })).not.toBe(facts);
    expect(itemFacts({ ...item, inactive: true })).not.toBe(facts);
    expect(itemFacts({ ...item, id: '502' })).not.toBe(facts);
    expect(itemFacts({ ...item, recordType: 'assemblyItem' })).not.toBe(facts);
    expect(itemFacts({ ...item, accounts: { ...item.accounts, assetAccount: { id: '106', name: null } } })).not.toBe(facts);
    expect(itemFacts({ ...item, accounts: { ...item.accounts, assetAccount: null } })).toBe(
      '["501","inventoryItem","51-2002","Hitch ball mount",false,["101","106",null]]',
    );
    expect(itemFacts({ ...item, accounts: { ...item.accounts, incomeAccount: { id: '101', name: 'Renamed' } } })).toBe(facts);
    expect(itemFacts({ ...item, accounts: { ...item.accounts, expenseAccount: { id: '108', name: null } } })).toBe(facts);
  });
});

describe('accountText', () => {
  it('says an account by its number and name in the chart, else as NetSuite named it', () => {
    expect(accountText('101', CHART)).toBe('40000 Sales');
    expect(accountText('101', CHART, 'Something else')).toBe('40000 Sales');
    expect(accountText('112', CHART)).toBe('Uncategorized Income');
    expect(accountText('999', CHART, 'Retired Sales')).toBe('Retired Sales');
    expect(accountText('999', CHART, null)).toBe('NetSuite account 999');
    expect(accountText('999', CHART, '')).toBe('NetSuite account 999');
    expect(accountText('999', CHART)).toBe('NetSuite account 999');
    expect(accountText('113', new Map([['113', acct('113', null, '', 'income')]]), 'Said')).toBe('NetSuite account 113');
  });
});

describe('kindWords', () => {
  it('says each kind of account in the chart as people do', () => {
    expect(Object.fromEntries([
      'bank', 'accounts_receivable', 'other_current_asset', 'fixed_asset', 'other_asset', 'unbilled_receivable', 'deferred_expense',
      'accounts_payable', 'credit_card', 'other_current_liability', 'long_term_liability', 'deferred_revenue', 'equity', 'income',
      'other_income', 'cost_of_goods_sold', 'expense', 'other_expense', 'statistical', '',
    ].map((t) => [t, kindWords(t)]))).toEqual({
      bank: 'a bank account', accounts_receivable: 'an accounts receivable account', other_current_asset: 'a current asset account',
      fixed_asset: 'a fixed asset account', other_asset: 'an other asset account', unbilled_receivable: 'an unbilled receivable account',
      deferred_expense: 'a deferred expense account', accounts_payable: 'an accounts payable account', credit_card: 'a credit card account',
      other_current_liability: 'a liability account', long_term_liability: 'a long-term liability account',
      deferred_revenue: 'a deferred revenue account', equity: 'an equity account', income: 'an income account',
      other_income: 'an other income account', cost_of_goods_sold: 'a cost of goods sold account', expense: 'an expense account',
      other_expense: 'an other expense account', statistical: 'an account of another kind', '': 'an account of another kind',
    });
  });
});

describe('choicesFor', () => {
  it("offers BMG's accounts that take postings now, of a kind the account can be, by number", () => {
    const ids = (f: Parameters<typeof choicesFor>[0]) => choicesFor(f, CHART.values()).map((a) => a.id);
    expect(ids('incomeAccount')).toEqual(['112', '102', '101', '103']);
    expect(ids('cogsAccount')).toEqual(['104', '105']);
    expect(ids('assetAccount')).toEqual(['106']);
    expect(ids('expenseAccount')).toEqual(['104', '105', '108', '109']);
  });

  it('puts accounts with the same number by name, then by id', () => {
    const same = [acct('3', '40000', 'Sales B', 'income'), acct('2', '40000', 'Sales A', 'income'), acct('1', '40000', 'Sales A', 'income')];
    expect(choicesFor('incomeAccount', same).map((a) => a.id)).toEqual(['1', '2', '3']);
    expect(same.map((a) => a.id)).toEqual(['3', '2', '1']);
  });
});

describe('planItemAccounts', () => {
  it('swaps back the cost of goods sold and inventory asset accounts set up the wrong way round', () => {
    expect(plan({ accounts: { assetAccount: '106', cogsAccount: '105' } })).toEqual({
      body: { cogsAccount: { id: '105' }, assetAccount: { id: '106' } },
      changes: [
        'Cost of goods sold account 19000 Inventory Asset → 58000 Parts COGS',
        'Inventory asset account 58000 Parts COGS → 19000 Inventory Asset',
      ],
      problems: [],
      notes: [DONE_NOTE, "What it's worth on the shelf now stays on 58000 Parts COGS until a journal entry moves it."],
    });
  });

  it('says what a change leaves of the wrong kind, so it isn\'t missed', () => {
    expect(plan({ accounts: { cogsAccount: '105', incomeAccount: '101' } })).toEqual({
      body: { cogsAccount: { id: '105' } },
      changes: ['Cost of goods sold account 19000 Inventory Asset → 58000 Parts COGS'],
      problems: [],
      notes: [
        'Its inventory asset account stays 58000 Parts COGS, a cost of goods sold account, where it should be a current asset account.',
        DONE_NOTE,
      ],
    });
    expect(plan({ accounts: { incomeAccount: '102' } }).notes).toEqual([
      'Its cost of goods sold account stays 19000 Inventory Asset, a current asset account, where it should be a cost of goods sold account.',
      'Its inventory asset account stays 58000 Parts COGS, a cost of goods sold account, where it should be a current asset account.',
      DONE_NOTE,
    ]);
    const unknown = itemOf('inventoryItem', { incomeAccount: { id: '999', name: 'Retired Sales' }, cogsAccount: null, assetAccount: { id: '106', name: null } });
    expect(plan({ accounts: { cogsAccount: '104' } }, unknown).notes).toEqual([DONE_NOTE]);
  });

  it('changes an account the item has none of, and one the chart no longer has, saying each as NetSuite named it', () => {
    const resale = itemOf('nonInventoryResaleItem', { incomeAccount: { id: '999', name: 'Retired Sales' }, expenseAccount: null });
    expect(plan({ accounts: { expenseAccount: '108', incomeAccount: '103' } }, resale)).toEqual({
      body: { incomeAccount: { id: '103' }, expenseAccount: { id: '108' } },
      changes: ['Income account Retired Sales → 49000 Other Income', 'Expense account (none) → 60000 Shop Supplies'],
      problems: [],
      notes: [DONE_NOTE],
    });
    const unnamed = itemOf('kitItem', { incomeAccount: { id: '999', name: null } });
    expect(plan({ accounts: { incomeAccount: '101' } }, unnamed).changes).toEqual(['Income account NetSuite account 999 → 40000 Sales']);
  });

  it('says the shelf value stays put only when the asset account the item had changes', () => {
    const none = itemOf('assemblyItem', { incomeAccount: { id: '101', name: null }, cogsAccount: { id: '104', name: null }, assetAccount: null });
    expect(plan({ accounts: { assetAccount: '106' } }, none)).toEqual({
      body: { assetAccount: { id: '106' } }, changes: ['Inventory asset account (none) → 19000 Inventory Asset'], problems: [], notes: [DONE_NOTE],
    });
  });

  it('refuses an account the kind of item lacks', () => {
    expect(plan({ accounts: { expenseAccount: '108' } }).problems).toEqual(['An inventory item has no expense account.']);
    const say = (recordType: ItemRecordType, field: keyof typeof FIELDS) => plan({ accounts: { [field]: '104' } }, itemOf(recordType, {})).problems;
    expect(say('kitItem', 'cogsAccount')).toEqual(['A kit has no cost of goods sold account.']);
    expect(say('assemblyItem', 'expenseAccount')).toEqual(['An assembly has no expense account.']);
    expect(say('otherChargeSaleItem', 'expenseAccount')).toEqual(['An other charge for sale has no expense account.']);
    expect(say('servicePurchaseItem', 'incomeAccount')).toEqual(['A service for purchase has no income account.']);
    expect(say('nonInventoryPurchaseItem', 'assetAccount')).toEqual(['A non-inventory item for purchase has no inventory asset account.']);
  });

  it('refuses an empty account, one not in the chart, one of the wrong kind, and one BMG can\'t post to', () => {
    const p = plan({ accounts: { incomeAccount: '', cogsAccount: '999', assetAccount: '107' } });
    expect(p).toEqual({
      body: {},
      changes: [],
      problems: [
        "Its income account can't be left empty: pick the account it should be.",
        'Pick its cost of goods sold account from the chart of accounts.',
        "10100 Checking is a bank account: an item's inventory asset account is a current asset account.",
      ],
      notes: [
        'Its cost of goods sold account stays 19000 Inventory Asset, a current asset account, where it should be a cost of goods sold account.',
        'Its inventory asset account stays 58000 Parts COGS, a cost of goods sold account, where it should be a current asset account.',
      ],
    });
    expect(plan({ accounts: { incomeAccount: '110' } }).problems).toEqual([
      "40500 Old Sales can't take BMG's postings now: it's inactive, a summary account, or another company's.",
    ]);
    expect(plan({ accounts: { incomeAccount: '111' } }).problems).toEqual([
      "40600 Sister Co Sales can't take BMG's postings now: it's inactive, a summary account, or another company's.",
    ]);
    const closedBank = new Map([...CHART, ['114', acct('114', '10200', 'Old Checking', 'bank', [])]]);
    expect(planItemAccounts(item, { reason: 'x', accounts: { incomeAccount: '114' } }, { chart: closedBank }).problems).toEqual([
      "10200 Old Checking is a bank account: an item's income account is an income or other income account.",
    ]);
    expect(plan({ accounts: { expenseAccount: '107' } }, itemOf('servicePurchaseItem', {})).problems).toEqual([
      "10100 Checking is a bank account: an item's expense account is a cost of goods sold, expense or other expense account.",
    ]);
  });

  it('sends nothing for an account left as it is', () => {
    expect(plan({ accounts: { incomeAccount: '101', cogsAccount: '106' } })).toEqual({
      body: {}, changes: [], problems: ['Nothing has changed yet.'],
      notes: [
        'Its cost of goods sold account stays 19000 Inventory Asset, a current asset account, where it should be a cost of goods sold account.',
        'Its inventory asset account stays 58000 Parts COGS, a cost of goods sold account, where it should be a current asset account.',
      ],
    });
    expect(plan({ accounts: { incomeAccount: '' } }, itemOf('kitItem', { incomeAccount: null })).problems).toEqual(['Nothing has changed yet.']);
    expect(plan({ accounts: { incomeAccount: '' } }, itemOf('kitItem', {})).problems).toEqual(['Nothing has changed yet.']);
    expect(plan({}, itemOf('kitItem', {})).problems).toEqual(['Nothing has changed yet.']);
  });

  it('needs a reason, at most 300 characters', () => {
    const kit = itemOf('kitItem', { incomeAccount: { id: '101', name: null } });
    const edit = (reason: string) => planItemAccounts(kit, { reason, accounts: { incomeAccount: '102' } }, { chart: CHART });
    expect(edit('   ').problems).toEqual(["Say why it's being changed."]);
    expect(planItemAccounts(kit, { reason: '' }, { chart: CHART }).problems).toEqual(["Say why it's being changed."]);
    expect(REASON_MAX).toBe(300);
    expect(edit('x'.repeat(301)).problems).toEqual(['Why it\'s being changed takes 300 characters at most.']);
    expect(edit(` ${'x'.repeat(300)} `)).toEqual({
      body: { incomeAccount: { id: '102' } }, changes: ['Income account 40000 Sales → 4100 Install Labor'], problems: [], notes: [DONE_NOTE],
    });
  });
});
