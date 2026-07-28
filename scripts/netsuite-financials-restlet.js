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
 * Setup in NetSuite (same as the item / PDF RESTlets):
 *   1. Upload this file to the File Cabinet (e.g. SuiteScripts/bmg-financials-restlet.js)
 *   2. Create a Script record: Type = RESTlet, Entry Points: GET = get
 *   3. Deploy with a role that can view the chart of accounts / financials
 *      (payment history additionally needs Transactions > Customer Payment
 *      and Credit Memo view), and note the External URL
 *   4. Set NETSUITE_FINANCIALS_RESTLET_URL in your env to that URL
 *   NOTE: after editing this file, re-upload it over the existing File
 *   Cabinet copy — the deployment picks up the new code automatically.
 *
 * @NApiVersion 2.1
 * @NScriptType Restlet
 */
define(['N/search'], function (search) {

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

  function get(context) {
    try {
      if (context && context.action === 'customerPayments') {
        return customerPayments(context);
      }
      return accountBalances(context);
    } catch (e) {
      return { success: false, error: (e && e.message) ? e.message : String(e) };
    }
  }

  return { get: get };

});
