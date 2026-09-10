/**
 * NetSuite RESTlet — Financials (account balances + customer payment history)
 *
 * Runs under its own deployment role so the app can read financial data its
 * SuiteQL integration role cannot see. The SuiteQL role reads customer
 * invoices (so A/R works) but NOT payment records (CustPymt), credit memos'
 * applications, bill payments, or credit-card charges, and it can't query the
 * `account` table at all. Summing transaction lines therefore never
 * reconciles to the Chart of Accounts (an A/P account whose real balance is
 * ~$3.5k summed to ~$2.6M — the gross of every bill, with no payments
 * netted). Searches here run with THIS deployment's role and return exactly
 * the answers the app needs, keeping the API token's own role narrow.
 *
 * GET modes:
 *
 * 1) Account balances (original mode — unchanged):
 *      ?accounts=1,111,227
 *    → { success: true, balances: [ { id, name, type, balance }, ... ] }
 *    `balance` is the account's current balance (assets positive; a
 *    liability shows positive when owed, negative when in credit).
 *
 * 2) Customer payments + credit memos, newest first:
 *      ?action=customerPayments&customerId=123[&limit=50]
 *    → { success: true, transactions: [ { id, tranid, date, type, amount,
 *        memo }, ... ] }   with type 'CustPymt' | 'CustCred'
 *    `amount` is the transaction total as searches report it (payments are
 *    typically negative — the app displays magnitudes).
 *
 * 3) Income statement totals (P&L unlock, R5-5): posting-transaction sums
 *    for a date range, grouped per account (the app buckets by account
 *    type and its configured payroll group):
 *      ?action=incomeStatement&from=YYYY-MM-DD&to=YYYY-MM-DD[&groupBy=class|department]
 *    → { success: true, mode: 'incomeStatement', from, to, groupBy,
 *        rows: [ { accountId, accountName, accountType, segment, amount }, ... ] }
 *    `amount` is the raw search SUM — income accounts usually come back
 *    credit-normal (negative); the app detects orientation and normalizes.
 *
 * 4) Collections (company-wide customer payments + deposits) for a range:
 *      ?action=collections&from=YYYY-MM-DD&to=YYYY-MM-DD[&limit=200]
 *    → { success: true, mode: 'collections', from, to, total, count,
 *        collections: [ { id, tranid, date, customer, amount }, ... ] }
 *    total/count cover the WHOLE range even when the list is capped.
 *
 * Setup in NetSuite (same as the item / PDF RESTlets):
 *   1. Upload this file to the File Cabinet (e.g. SuiteScripts/bmg-financials-restlet.js)
 *   2. Create a Script record: Type = RESTlet, Entry Points: GET = get
 *   3. Deploy with a role that can view the chart of accounts / financials
 *      (payment history additionally needs Transactions > Customer Payment
 *      and Credit Memo view; incomeStatement/collections additionally need
 *      Transactions > Find Transaction plus view on the posting transaction
 *      types — see docs/pnl-restlet-deploy.md), and note the External URL
 *   4. Set NETSUITE_FINANCIALS_RESTLET_URL in your env to that URL
 *   NOTE: after editing this file, re-upload it over the existing File
 *   Cabinet copy — the deployment picks up the new code automatically.
 *
 * @NApiVersion 2.1
 * @NScriptType Restlet
 */
define(['N/search'], function (search) {

  // Bump on every functional edit to this file. The app's Integration
  // Checkup (Connections tab on System Health) compares this against the
  // version it expects and reports a stale deployment, so a re-upload that
  // silently didn't take is visible instead of being discovered months
  // later by a wrong number. src/lib/restlet-versions.ts holds the expected
  // value and a test fails the build when the two drift apart.
  var SCRIPT_VERSION = '2026-09-10.1';

  function accountBalances(context) {
    var raw = context && context.accounts ? String(context.accounts) : '';
    var ids = raw
      .split(',')
      .map(function (s) { return s.trim(); })
      .filter(function (s) { return /^[0-9]+$/.test(s); });

    if (ids.length === 0) {
      return { success: true, balances: [] };
    }

    var balances = [];
    var accountSearch = search.create({
      type: search.Type.ACCOUNT,
      filters: [['internalid', 'anyof'].concat(ids)],
      columns: ['internalid', 'name', 'type', 'balance'],
    });

    accountSearch.run().each(function (result) {
      balances.push({
        id: result.getValue({ name: 'internalid' }),
        name: result.getValue({ name: 'name' }),
        type: result.getValue({ name: 'type' }),
        balance: parseFloat(result.getValue({ name: 'balance' }) || '0'),
      });
      return true;
    });

    return { success: true, balances: balances };
  }

  function customerPayments(context) {
    var custId = context && context.customerId ? String(context.customerId) : '';
    if (!/^[0-9]+$/.test(custId)) {
      return { success: false, error: 'customerId (numeric internal id) required' };
    }
    var limit = parseInt(context.limit, 10);
    if (!limit || limit < 1 || limit > 200) limit = 50;

    var txnSearch = search.create({
      type: search.Type.TRANSACTION,
      filters: [
        ['type', 'anyof', 'CustPymt', 'CustCred'], 'AND',
        ['entity', 'anyof', custId], 'AND',
        ['mainline', 'is', 'T'],
      ],
      columns: [
        'internalid',
        'tranid',
        'type',
        search.createColumn({ name: 'trandate', sort: search.Sort.DESC }),
        'total',
        'memo',
      ],
    });

    var out = [];
    var results = txnSearch.run().getRange({ start: 0, end: limit });
    for (var i = 0; i < results.length; i++) {
      var r = results[i];
      out.push({
        id: r.getValue({ name: 'internalid' }),
        tranid: r.getValue({ name: 'tranid' }),
        date: r.getValue({ name: 'trandate' }),
        type: r.getValue({ name: 'type' }),
        amount: parseFloat(r.getValue({ name: 'total' }) || '0'),
        memo: r.getValue({ name: 'memo' }) || null,
      });
    }
    return { success: true, transactions: out };
  }

  // Search date filters take the account's date format — normalize the ISO
  // params the app sends to MM/DD/YYYY deterministically.
  function usDate(iso) {
    var p = String(iso || '').split('-');
    return p.length === 3 ? p[1] + '/' + p[2] + '/' + p[0] : '';
  }
  function validRange(context) {
    var from = context && context.from ? String(context.from) : '';
    var to = context && context.to ? String(context.to) : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return null;
    return { from: from, to: to };
  }

  function incomeStatement(context) {
    var range = validRange(context);
    if (!range) return { success: false, error: 'from/to (YYYY-MM-DD) required' };
    var groupBy = (context.groupBy === 'class' || context.groupBy === 'department') ? context.groupBy : null;

    var columns = [
      search.createColumn({ name: 'account', summary: search.Summary.GROUP }),
      search.createColumn({ name: 'type', join: 'account', summary: search.Summary.GROUP }),
      search.createColumn({ name: 'amount', summary: search.Summary.SUM }),
    ];
    if (groupBy) {
      columns.push(search.createColumn({ name: groupBy, summary: search.Summary.GROUP }));
    }

    var s = search.create({
      type: search.Type.TRANSACTION,
      filters: [
        ['posting', 'is', 'T'], 'AND',
        ['trandate', 'within', usDate(range.from), usDate(range.to)], 'AND',
        ['accounttype', 'anyof', 'Income', 'COGS', 'Expense', 'OthIncome', 'OthExpense'],
      ],
      columns: columns,
    });

    var rows = [];
    s.run().each(function (r) {
      rows.push({
        accountId: r.getValue({ name: 'account', summary: search.Summary.GROUP }),
        accountName: r.getText({ name: 'account', summary: search.Summary.GROUP }),
        accountType: r.getValue({ name: 'type', join: 'account', summary: search.Summary.GROUP }),
        segment: groupBy ? (r.getText({ name: groupBy, summary: search.Summary.GROUP }) || null) : null,
        amount: parseFloat(r.getValue({ name: 'amount', summary: search.Summary.SUM }) || '0'),
      });
      // Grouped per account (x segment) — a CoA-sized result. Guardrail only.
      return rows.length < 900;
    });

    return { success: true, mode: 'incomeStatement', from: range.from, to: range.to, groupBy: groupBy, rows: rows };
  }

  function collections(context) {
    var range = validRange(context);
    if (!range) return { success: false, error: 'from/to (YYYY-MM-DD) required' };
    var limit = parseInt(context.limit, 10);
    if (!limit || limit < 1 || limit > 200) limit = 200;

    var filters = [
      ['type', 'anyof', 'CustPymt', 'CustDep'], 'AND',
      ['trandate', 'within', usDate(range.from), usDate(range.to)], 'AND',
      ['mainline', 'is', 'T'],
    ];

    // Whole-range total/count from a summary search, so a capped list can't
    // understate the period.
    var total = 0;
    var count = 0;
    search.create({
      type: search.Type.TRANSACTION,
      filters: filters,
      columns: [
        search.createColumn({ name: 'total', summary: search.Summary.SUM }),
        search.createColumn({ name: 'internalid', summary: search.Summary.COUNT }),
      ],
    }).run().each(function (r) {
      total = parseFloat(r.getValue({ name: 'total', summary: search.Summary.SUM }) || '0');
      count = parseInt(r.getValue({ name: 'internalid', summary: search.Summary.COUNT }), 10) || 0;
      return false;
    });

    var out = [];
    var results = search.create({
      type: search.Type.TRANSACTION,
      filters: filters,
      columns: [
        'internalid',
        'tranid',
        search.createColumn({ name: 'trandate', sort: search.Sort.DESC }),
        'entity',
        'total',
      ],
    }).run().getRange({ start: 0, end: limit });
    for (var i = 0; i < results.length; i++) {
      var row = results[i];
      out.push({
        id: row.getValue({ name: 'internalid' }),
        tranid: row.getValue({ name: 'tranid' }),
        date: row.getValue({ name: 'trandate' }),
        customer: row.getText({ name: 'entity' }) || null,
        amount: parseFloat(row.getValue({ name: 'total' }) || '0'),
      });
    }

    return { success: true, mode: 'collections', from: range.from, to: range.to, total: total, count: count, collections: out };
  }

  function get(context) {
    try {
      if (context && context.action === 'ping') {
        return { success: true, mode: 'ping', version: SCRIPT_VERSION };
      }
      if (context && context.action === 'customerPayments') {
        return customerPayments(context);
      }
      if (context && context.action === 'incomeStatement') {
        return incomeStatement(context);
      }
      if (context && context.action === 'collections') {
        return collections(context);
      }
      return accountBalances(context);
    } catch (e) {
      return { success: false, error: (e && e.message) ? e.message : String(e) };
    }
  }

  return { get: get };

});
