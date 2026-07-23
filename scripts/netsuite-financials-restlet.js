/**
 * NetSuite RESTlet — Account Balances
 *
 * Returns current GL balances for specific accounts so the app's Executive
 * Financials tab (Home → Financials) can show cash, A/P, and credit-card
 * balances that match the Chart of Accounts.
 *
 * Why a RESTlet (and not SuiteQL): the app's SuiteQL integration role can't
 * see the full ledger — it reads customer invoices (so A/R works) but not bill
 * payments or credit-card charges, and it can't query the `account` table at
 * all. Summing transaction lines therefore never reconciles to the Chart of
 * Accounts (an A/P account whose real balance is ~$3.5k summed to ~$2.6M — the
 * gross of every bill, with no payments netted). An account search here runs
 * with THIS deployment's role and returns the same Balance the Chart of
 * Accounts shows, sidestepping the SuiteQL limits entirely.
 *
 * GET params:
 *   accounts = comma-separated account internal IDs, e.g. "1,111,227,229"
 * Returns JSON:
 *   { success: true, balances: [ { id, name, type, balance }, ... ] }
 *          or: { success: false, error: "..." }
 * `balance` is the account's current balance (assets positive; a liability
 * shows positive when owed, negative when in credit — same as the CoA).
 *
 * Setup in NetSuite (same as the item / PDF RESTlets):
 *   1. Upload this file to the File Cabinet (e.g. SuiteScripts/bmg-financials-restlet.js)
 *   2. Create a Script record: Type = RESTlet, Entry Points: GET = get
 *   3. Deploy with a role that can view the chart of accounts / financials,
 *      and note the External URL
 *   4. Set NETSUITE_FINANCIALS_RESTLET_URL in your env to that URL
 *
 * @NApiVersion 2.1
 * @NScriptType Restlet
 */
define(['N/search'], function (search) {

  function get(context) {
    try {
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
    } catch (e) {
      return { success: false, error: (e && e.message) ? e.message : String(e) };
    }
  }

  return { get: get };

});
