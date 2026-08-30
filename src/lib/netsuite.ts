/**
 * NetSuite REST API Client for Next.js
 * Uses OAuth 1.0a Token-Based Authentication for SuiteQL queries and RESTlet calls
 */

import OAuth from 'oauth-1.0a';
import CryptoJS from 'crypto-js';
import { safeStringLiteral } from './sql-safe';

interface NetSuiteConfig {
  accountId: string;
  consumerKey: string;
  consumerSecret: string;
  tokenId: string;
  tokenSecret: string;
}

function getConfig(): NetSuiteConfig {
  const accountId = process.env.NETSUITE_ACCOUNT_ID;
  const consumerKey = process.env.NETSUITE_CONSUMER_KEY;
  const consumerSecret = process.env.NETSUITE_CONSUMER_SECRET;
  const tokenId = process.env.NETSUITE_TOKEN_ID;
  const tokenSecret = process.env.NETSUITE_TOKEN_SECRET;

  if (!accountId || !consumerKey || !consumerSecret || !tokenId || !tokenSecret) {
    throw new Error('Missing NetSuite environment variables');
  }

  return { accountId, consumerKey, consumerSecret, tokenId, tokenSecret };
}

function createOAuth(config: NetSuiteConfig) {
  const oauth = new OAuth({
    consumer: {
      key: config.consumerKey,
      secret: config.consumerSecret,
    },
    signature_method: 'HMAC-SHA256',
    hash_function(baseString: string, key: string) {
      return CryptoJS.HmacSHA256(baseString, key).toString(CryptoJS.enc.Base64);
    },
    realm: config.accountId,
  });

  const token = {
    key: config.tokenId,
    secret: config.tokenSecret,
  };

  return { oauth, token };
}

function getBaseUrl(accountId: string): string {
  // NetSuite account IDs with underscores use dashes in the URL
  const formatted = accountId.toLowerCase().replace(/_/g, '-');
  return `https://${formatted}.suitetalk.api.netsuite.com`;
}

function getAuthHeader(oauth: OAuth, token: { key: string; secret: string }, request: { url: string; method: string }): string {
  const authData = oauth.authorize(request, token);
  const params = oauth.toHeader(authData);
  return params.Authorization;
}

/**
 * Execute a SuiteQL query against NetSuite
 */
export async function suiteqlQuery(query: string, limit: number = 1000, offset: number = 0): Promise<any> {
  const config = getConfig();
  const baseUrl = getBaseUrl(config.accountId);
  const url = `${baseUrl}/services/rest/query/v1/suiteql?limit=${limit}&offset=${offset}`;
  const { oauth, token } = createOAuth(config);

  const authHeader = getAuthHeader(oauth, token, { url, method: 'POST' });

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': authHeader,
      'Content-Type': 'application/json',
      'Prefer': 'transient',
    },
    body: JSON.stringify({ q: query }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`NetSuite SuiteQL error (${response.status}): ${text}`);
  }

  return response.json();
}

/**
 * Execute a paginated SuiteQL query — fetches all rows across multiple pages
 */
export async function suiteqlQueryAll(query: string, pageSize: number = 1000): Promise<any[]> {
  let allItems: any[] = [];
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const result = await suiteqlQuery(query, pageSize, offset);
    const items = result?.items || [];
    allItems = allItems.concat(items);

    if (items.length < pageSize) {
      hasMore = false;
    } else {
      offset += pageSize;
    }
  }

  return allItems;
}

/**
 * Call a NetSuite RESTlet
 */
export async function callRestlet(
  restletUrl: string,
  method: string = 'GET',
  params?: Record<string, string>,
  jsonData?: any
): Promise<any> {
  const config = getConfig();
  const { oauth, token } = createOAuth(config);

  // Parse and build URL with params
  const url = new URL(restletUrl);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
  }

  const fullUrl = url.toString();
  const authHeader = getAuthHeader(oauth, token, { url: fullUrl, method: method.toUpperCase() });

  const headers: Record<string, string> = {
    'Authorization': authHeader,
    'Content-Type': 'application/json',
  };

  const fetchOptions: RequestInit = {
    method: method.toUpperCase(),
    headers,
  };

  if (method.toUpperCase() === 'POST' && jsonData) {
    fetchOptions.body = JSON.stringify(jsonData);
  }

  const response = await fetch(fullUrl, fetchOptions);

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`NetSuite RESTlet error (${response.status}): ${text}`);
  }

  return response.json();
}

// ─── Sales Order Specific Functions ────────────────────────────

const OPEN_STATUSES = ['A', 'B', 'D', 'E', 'F'];

export interface SalesOrder {
  id: string;
  sales_order_number: string;
  record_type: 'Sales Order' | 'Invoice' | 'Estimate';
  date: string;
  vin: string | null;
  status: string;
  // Human-readable status from NetSuite (BUILTIN.DF, type prefix stripped).
  // Status keys are per-type — 'B' is Pending Fulfillment on an SO, Paid In
  // Full on an invoice, Processed on an estimate — so display this, not a
  // letter-to-label map.
  status_label: string;
  customer_id: string;
  customer_name: string;
  memo: string | null;
  total: number | null;
  line_items: SalesOrderLineItem[];
}

export interface SalesOrderLineItem {
  line_number: number;
  item_name: string | null;
  description: string | null;
  quantity: number;
  rate: number;
  amount: number;
}

export const SALES_ORDER_SEARCH_TYPES = ['SalesOrd', 'CustInvc', 'Estimate'] as const;
export type SalesOrderSearchType = typeof SALES_ORDER_SEARCH_TYPES[number];

export interface SalesOrderSearchOptions {
  /** Page size (default 20, max 100). Big customers can have hundreds of
   *  open transactions — pages keep the search fast and the list scannable. */
  limit?: number;
  /** Rows to skip (for "load 20 more"). */
  offset?: number;
  /** Restrict to these record types; omit for all three. */
  types?: SalesOrderSearchType[];
}

export async function getOpenSalesOrdersByCustomer(
  customerName: string,
  opts: SalesOrderSearchOptions = {},
): Promise<{
  found: boolean;
  count: number;
  data: SalesOrder[] | null;
  hasMore: boolean;
  error?: string;
}> {
  const searchTerm = customerName.trim().replace(/'/g, "''");
  if (!searchTerm) {
    return { found: false, count: 0, data: null, hasMore: false, error: 'Customer name cannot be empty' };
  }

  const limit = Math.min(Math.max(Math.floor(opts.limit ?? 20), 1), 100);
  const offset = Math.max(Math.floor(opts.offset ?? 0), 0);
  const types = (opts.types || []).filter(t => (SALES_ORDER_SEARCH_TYPES as readonly string[]).includes(t));
  const effectiveTypes: readonly string[] = types.length > 0 ? types : SALES_ORDER_SEARCH_TYPES;

  const statusConditions = OPEN_STATUSES.map(s => `t.status = '${s}'`).join(' OR ');
  // Open-record status logic is per-type; only include the requested types.
  const typeConditions = [
    effectiveTypes.includes('SalesOrd') ? `(t.type = 'SalesOrd' AND (${statusConditions}))` : null,
    effectiveTypes.includes('CustInvc') ? `(t.type = 'CustInvc' AND t.status IN ('A', 'B'))` : null,
    effectiveTypes.includes('Estimate') ? `(t.type = 'Estimate' AND t.status IN ('A', 'B', 'E', 'X'))` : null,
  ].filter(Boolean).join('\n      OR ');

  // Fetch one extra row past the page to learn whether more exist.
  const query = `
    SELECT
      t.id,
      t.tranid AS sales_order_number,
      t.trandate,
      t.type,
      t.status,
      BUILTIN.DF(t.status) AS status_label,
      t.entity AS customer_id,
      c.companyname AS customer_name,
      t.memo,
      t.total,
      t.custbody_vin_number_ AS vin
    FROM transaction t
    LEFT JOIN customer c ON t.entity = c.id
    WHERE t.type IN (${effectiveTypes.map(t => `'${t}'`).join(', ')})
    AND (
      ${typeConditions}
    )
    AND (
      UPPER(c.companyname) LIKE UPPER('%${searchTerm}%')
      OR UPPER(c.entityid) LIKE UPPER('%${searchTerm}%')
    )
    ORDER BY c.companyname, t.trandate DESC, t.id DESC
    OFFSET ${offset} ROWS FETCH NEXT ${limit + 1} ROWS ONLY
  `;

  const result = await suiteqlQuery(query);
  const allItems = result?.items || [];
  const hasMore = allItems.length > limit;
  const items = hasMore ? allItems.slice(0, limit) : allItems;

  if (items.length === 0) {
    return {
      found: false,
      count: 0,
      data: null,
      hasMore: false,
      error: offset > 0
        ? 'No more results.'
        : `No sales orders, invoices, or estimates found for "${customerName}"`,
    };
  }

  const detailedOrders: SalesOrder[] = items.map((so: any) => {
    const typeLabel = so.type === 'CustInvc' ? 'Invoice' : so.type === 'Estimate' ? 'Estimate' : 'Sales Order';
    return {
      id: so.id,
      sales_order_number: so.sales_order_number,
      record_type: typeLabel as SalesOrder['record_type'],
      date: so.trandate,
      vin: so.vin || null,
      status: so.status,
      // BUILTIN.DF comes back type-prefixed ("Sales Order : Pending
      // Fulfillment") — strip the prefix, keep the label.
      status_label: (so.status_label || '').replace(/^[^:]+:\s*/, ''),
      customer_id: so.customer_id,
      customer_name: so.customer_name,
      memo: so.memo || null,
      total: so.total ? parseFloat(so.total) : null,
      line_items: [],
    };
  });

  // One batched line-item query for the whole page — this used to be one
  // SuiteQL round trip per transaction, which is what made big customers
  // (hundreds of open orders) take forever to load.
  const numericIds = detailedOrders
    .map(o => String(o.id))
    .filter(id => /^\d+$/.test(id));
  if (numericIds.length > 0) {
    try {
      const linesQuery = `
        SELECT
          tl.transaction,
          tl.linesequencenumber,
          tl.memo AS description,
          tl.quantity,
          tl.rate,
          tl.netamount,
          i.itemid AS item_name
        FROM transactionline tl
        LEFT JOIN item i ON tl.item = i.id
        WHERE tl.transaction IN (${numericIds.join(', ')})
        AND tl.mainline = 'F'
        AND tl.taxline = 'F'
        ORDER BY tl.transaction, tl.linesequencenumber
      `;
      const linesResult = await suiteqlQuery(linesQuery);
      const byTx = new Map<string, SalesOrderLineItem[]>();
      for (const line of linesResult?.items || []) {
        const key = String(line.transaction);
        const list = byTx.get(key) || [];
        list.push({
          line_number: line.linesequencenumber,
          item_name: line.item_name || null,
          description: line.description || null,
          quantity: Math.abs(parseFloat(line.quantity || '0')),
          rate: Math.abs(parseFloat(line.rate || '0')),
          amount: Math.abs(parseFloat(line.netamount || '0')),
        });
        byTx.set(key, list);
      }
      for (const order of detailedOrders) {
        order.line_items = byTx.get(String(order.id)) || [];
      }
    } catch {
      // Line items fetch failed, continue with empty
    }
  }

  return {
    found: true,
    count: detailedOrders.length,
    data: detailedOrders,
    hasMore,
  };
}

/**
 * Create a Sales Order in NetSuite from a bmg-ops Purchase Order
 * Uses the REST Record API: POST /services/rest/record/v1/salesOrder
 */
/**
 * Look up a NetSuite location by name
 */
export async function findLocation(name: string): Promise<{ id: string; name: string } | null> {
  const searchTerm = name.trim().replace(/'/g, "''");
  const query = `
    SELECT l.id, l.name
    FROM location l
    WHERE UPPER(l.name) LIKE UPPER('%${searchTerm}%')
    FETCH FIRST 1 ROWS ONLY
  `;

  const result = await suiteqlQuery(query);
  const items = result?.items || [];
  if (items.length > 0) {
    return { id: items[0].id?.toString(), name: items[0].name };
  }
  return null;
}

/**
 * Resolve the default NetSuite location for transactions when a caller
 * doesn't specify one. NetSuite accounts that make Location mandatory
 * reject invoices with a "Please enter value(s) for: Location" error,
 * so we fall back to a sensible default: an explicit env override, then
 * the O'Fallon location (BMG's primary location), then any location.
 */
export async function resolveDefaultLocationId(): Promise<string | null> {
  const envDefault = process.env.NETSUITE_DEFAULT_LOCATION_ID;
  if (envDefault) return envDefault.toString();

  const fallon = await findLocation('Fallon');
  if (fallon) return fallon.id;

  try {
    const result = await suiteqlQuery(
      "SELECT id FROM location WHERE isinactive = 'F' FETCH FIRST 1 ROWS ONLY"
    );
    const id = result?.items?.[0]?.id;
    if (id) return id.toString();
  } catch {
    // Location table may be inaccessible — fall through to null
  }
  return null;
}

/**
 * Business-card scans feed raw OCR text into customer creates, and NetSuite
 * hard-rejects the whole record over one cosmetic field — a Web Address
 * without a scheme ("www.acme.com") fails the create with
 * "Error while accessing a resource. Invalid URL." Normalize what's fixable
 * (prepend https://), drop what isn't — the raw value still lives on the
 * local prospect row, so nothing is lost by omitting it here.
 */
export function normalizeWebsiteUrl(raw?: string | null): string | undefined {
  if (!raw) return undefined;
  const site = raw.trim().replace(/\s+/g, '');
  if (!site) return undefined;
  const withScheme = /^https?:\/\//i.test(site) ? site : `https://${site}`;
  try {
    const parsed = new URL(withScheme);
    if (!parsed.hostname.includes('.')) return undefined;
    return withScheme;
  } catch {
    return undefined;
  }
}

/**
 * Create a Customer or Lead record in NetSuite
 * Uses the REST Record API: POST /services/rest/record/v1/customer
 * The 'stage' field determines Customer vs Lead/Prospect
 */
export async function createCustomerOrLead(payload: {
  companyName: string;
  contactName?: string;
  title?: string;
  email?: string;
  phone?: string;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  website?: string;
  type: 'customer' | 'lead' | 'prospect';
}): Promise<{
  success: boolean;
  customerId?: string;
  entityId?: string;
  netsuiteUrl?: string;
  error?: string;
}> {
  const config = getConfig();
  const baseUrl = getBaseUrl(config.accountId);
  const url = `${baseUrl}/services/rest/record/v1/customer`;
  const { oauth, token } = createOAuth(config);
  const authHeader = getAuthHeader(oauth, token, { url, method: 'POST' });

  // Map type to NetSuite stage value
  const stageMap: Record<string, string> = {
    customer: 'CUSTOMER',
    lead: 'LEAD',
    prospect: 'PROSPECT',
  };

  const body: any = {
    companyName: payload.companyName,
    stage: stageMap[payload.type] || 'LEAD',
    isPerson: false,
    // Subsidiary is required on every customer-entity record in this OneWorld
    // account — NetSuite does NOT derive it, so a create without it fails with
    // "Please enter value(s) for: Subsid." Hardcoded internal id 2 (BMG Fleet
    // Installations) like the vendor / vendor-bill flows; the integration role
    // can't SuiteQL the subsidiary table. Single-select shape (same as
    // createVendor), not the item record's multi-select. Override via
    // NETSUITE_SUBSIDIARY_ID. See docs/cni-vendor-bills.md.
    subsidiary: { id: process.env.NETSUITE_SUBSIDIARY_ID || '2' },
  };

  // Same omit-over-fail rule for the other validated fields: a malformed
  // scanned email or a partial phone must not block the customer create.
  const email = payload.email?.trim();
  if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) body.email = email;
  if (payload.phone && payload.phone.replace(/\D/g, '').length >= 7) body.phone = payload.phone;
  const website = normalizeWebsiteUrl(payload.website);
  if (website) body.url = website;

  // Default address
  if (payload.address || payload.city || payload.state || payload.zip) {
    body.addressBook = {
      items: [
        {
          defaultBilling: true,
          defaultShipping: true,
          addressBookAddress: {
            addr1: payload.address || '',
            city: payload.city || '',
            state: payload.state || '',
            zip: payload.zip || '',
            country: { id: 'US' },
          },
        },
      ],
    };
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
        'Prefer': 'respondAsync=false',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error('NetSuite create customer error:', response.status, text);
      return { success: false, error: `NetSuite error ${response.status}: ${text.slice(0, 200)}` };
    }

    // NetSuite returns the new record location in the header
    const location = response.headers.get('location') || '';
    const idMatch = location.match(/\/customer\/(\d+)/);
    const customerId = idMatch ? idMatch[1] : undefined;

    // Build the NetSuite URL
    const accountForUrl = config.accountId.replace(/-/g, '_').toUpperCase();
    const netsuiteUrl = customerId
      ? `https://${accountForUrl}.app.netsuite.com/app/common/entity/custjob.nl?id=${customerId}`
      : undefined;

    // Fetch entity ID
    let entityId: string | undefined;
    if (customerId) {
      try {
        const q = `SELECT entityid FROM customer WHERE id = ${customerId}`;
        const result = await suiteqlQuery(q);
        entityId = result?.items?.[0]?.entityid;
      } catch { /* non-critical */ }
    }

    return { success: true, customerId, entityId, netsuiteUrl };
  } catch (error: any) {
    console.error('NetSuite create customer exception:', error);
    return { success: false, error: error?.message || 'Unknown error' };
  }
}

/**
 * Create an item record in NetSuite.
 * Uses the REST Record API: POST /services/rest/record/v1/{recordType}
 * Sends a deliberately minimal field set (itemId + names + description +
 * the BMG Fleet Installations subsidiary). If the account requires more
 * (income account, tax schedule), NetSuite's rejection message is returned
 * verbatim so the caller can show it.
 */
/** NetSuite UI link for an item record, given its numeric internal id. */
export function itemUrl(internalId: string | number): string {
  const accountForUrl = getConfig().accountId.replace(/-/g, '_').toUpperCase();
  return `https://${accountForUrl}.app.netsuite.com/app/common/item/item.nl?id=${internalId}`;
}

/** NetSuite UI link for a transaction record (customer invoice, vendor bill). */
export function transactionUrl(page: 'custinvc' | 'vendbill', internalId: string | number): string {
  const accountForUrl = getConfig().accountId.replace(/-/g, '_').toUpperCase();
  return `https://${accountForUrl}.app.netsuite.com/app/accounting/transactions/${page}.nl?id=${internalId}`;
}

export async function createItem(payload: {
  itemId: string;
  recordType: string; // e.g. 'serviceSaleItem', 'nonInventoryResaleItem', 'inventoryItem'
  displayName?: string;
  description?: string;
}): Promise<{
  success: boolean;
  internalId?: string;
  netsuiteUrl?: string;
  error?: string;
}> {
  const config = getConfig();
  const baseUrl = getBaseUrl(config.accountId);
  // Guard against a bad recordType injecting into the path
  const recordType = payload.recordType.replace(/[^a-zA-Z]/g, '');
  if (!recordType) return { success: false, error: 'Invalid item type' };
  const url = `${baseUrl}/services/rest/record/v1/${recordType}`;
  const { oauth, token } = createOAuth(config);
  const authHeader = getAuthHeader(oauth, token, { url, method: 'POST' });

  const body: any = { itemId: payload.itemId };
  if (payload.displayName) body.displayName = payload.displayName;
  if (payload.description) body.salesDescription = payload.description;
  // Items must belong to the "Parent Company : BMG Fleet Installations"
  // subsidiary (internal id 2) or downstream transactions reject them
  // ("Invalid Field Value … for the following field: item" on invoices/SOs).
  // Hardcoded like the vendor-bill flow because the integration role cannot
  // SuiteQL the subsidiary table (see docs/cni-vendor-bills.md); override via
  // NETSUITE_SUBSIDIARY_ID. Item subsidiary is a multi-select in REST.
  body.subsidiary = { items: [{ id: process.env.NETSUITE_SUBSIDIARY_ID || '2' }] };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
        'Prefer': 'respondAsync=false',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error('NetSuite create item error:', response.status, text);
      // Surface NetSuite's own message — usually names the missing required field
      let detail = text.slice(0, 400);
      try {
        const parsed = JSON.parse(text);
        detail = parsed?.['o:errorDetails']?.[0]?.detail || parsed?.title || detail;
      } catch { /* keep raw text */ }
      return { success: false, error: `NetSuite ${response.status}: ${detail}` };
    }

    const location = response.headers.get('location') || '';
    const idMatch = location.match(/\/(\d+)(?:\?|$)/);
    const internalId = idMatch ? idMatch[1] : undefined;

    const accountForUrl = config.accountId.replace(/-/g, '_').toUpperCase();
    const netsuiteUrl = internalId
      ? `https://${accountForUrl}.app.netsuite.com/app/common/item/item.nl?id=${internalId}`
      : undefined;

    return { success: true, internalId, netsuiteUrl };
  } catch (error: any) {
    console.error('NetSuite create item exception:', error);
    return { success: false, error: error?.message || 'Unknown error' };
  }
}

/**
 * Search NetSuite vendors by name/entity id. Note: unlike customer/item,
 * vendor-table SuiteQL access is not guaranteed for the integration role —
 * failures return an error string instead of throwing so callers can fall
 * back to local data.
 */
export interface VendorAddress { street: string; city: string; state: string; zip: string }

export interface VendorAddressLookup {
  map: Record<string, VendorAddress>;
  /** Which queries produced addresses, '+'-joined in run order (null = none did). */
  strategy: string | null;
  /** Short per-strategy failure notes, for surfacing to the admin UI. */
  errors: string[];
}

const shortSuiteqlError = (e: any): string => {
  let detail = String(e?.message || 'query failed');
  const m = detail.match(/"detail"\s*:\s*"([^"]+)"/);
  if (m) detail = m[1];
  return detail.slice(0, 160);
};

/**
 * Addresses for a set of vendor ids, one per vendor. NetSuite exposes
 * vendor addresses several ways depending on account config and role
 * permissions, so strategies run in authority order and each only fills
 * vendors the previous ones missed (no short-circuiting):
 *   1. the vendor's defaultbillingaddress subrecord — THE billing address,
 *   2. the address book, preferring entries flagged default-billing
 *      (retried without the flag column if the account rejects it),
 *   3. BUILTIN.DF(defaultbillingaddress) — a formatted one-line string
 *      (lands in `street` unsplit; customer-sync's fallback trick).
 * Never throws; diagnostics say which strategies contributed and what
 * failed. Vendor bills mail to these addresses, so billing-authority
 * order matters more than raw coverage.
 */
export async function getVendorAddresses(ids: string[]): Promise<VendorAddressLookup> {
  const clean = ids.filter(id => /^\d+$/.test(id));
  const out: VendorAddressLookup = { map: {}, strategy: null, errors: [] };
  if (clean.length === 0) return out;

  const used: string[] = [];
  const missing = () => clean.filter(id => !out.map[id]);
  const toAddress = (a: any): VendorAddress => ({
    street: [a.addr1, a.addr2].filter(Boolean).join(', '),
    city: a.city || '',
    state: a.state || '',
    zip: a.zip || '',
  });
  const absorb = (items: any[], strategyName: string) => {
    let added = false;
    for (const a of items) {
      const vid = a.vendor_id?.toString();
      if (!vid || out.map[vid]) continue;
      out.map[vid] = toAddress(a);
      added = true;
    }
    if (added) used.push(strategyName);
    else out.errors.push(`${strategyName}: no rows`);
  };

  // 1. The vendor row's default billing address subrecord — authoritative.
  try {
    const res = await suiteqlQuery(`
      SELECT v.id AS vendor_id, ea.addr1, ea.addr2, ea.city, ea.state, ea.zip
      FROM vendor v
      JOIN entityAddress ea ON ea.nkey = v.defaultbillingaddress
      WHERE v.id IN (${clean.join(',')})`);
    absorb(res?.items || [], 'default_billing');
  } catch (e: any) {
    out.errors.push(`default_billing: ${shortSuiteqlError(e)}`);
  }

  // 2. Address book for whoever's still missing — prefer the entry flagged
  //    default-billing; fall back to a flag-less query if the column errors.
  if (missing().length > 0) {
    const idList = missing().join(',');
    const pickPerVendor = (items: any[]): any[] => {
      const best = new Map<string, any>();
      for (const a of items) {
        const vid = a.vendor_id?.toString();
        if (!vid) continue;
        if (!best.has(vid) || (a.defaultbilling === 'T' && best.get(vid).defaultbilling !== 'T')) best.set(vid, a);
      }
      return [...best.values()];
    };
    try {
      const res = await suiteqlQuery(`
        SELECT va.entity AS vendor_id, va.defaultbilling, ea.addr1, ea.addr2, ea.city, ea.state, ea.zip
        FROM vendorAddressbook va
        JOIN entityAddress ea ON ea.nkey = va.addressbookaddress
        WHERE va.entity IN (${idList})`);
      absorb(pickPerVendor(res?.items || []), 'addressbook');
    } catch (e: any) {
      out.errors.push(`addressbook: ${shortSuiteqlError(e)}`);
      try {
        const res = await suiteqlQuery(`
          SELECT va.entity AS vendor_id, ea.addr1, ea.addr2, ea.city, ea.state, ea.zip
          FROM vendorAddressbook va
          JOIN entityAddress ea ON ea.nkey = va.addressbookaddress
          WHERE va.entity IN (${idList})`);
        absorb(pickPerVendor(res?.items || []), 'addressbook_any');
      } catch (e2: any) {
        out.errors.push(`addressbook_any: ${shortSuiteqlError(e2)}`);
      }
    }
  }

  // 3. Formatted-string fallback for the stragglers.
  if (missing().length > 0) {
    try {
      const res = await suiteqlQuery(`
        SELECT v.id AS vendor_id, BUILTIN.DF(v.defaultbillingaddress) AS addr
        FROM vendor v
        WHERE v.id IN (${missing().join(',')}) AND v.defaultbillingaddress IS NOT NULL`);
      let added = false;
      for (const a of res?.items || []) {
        const vid = a.vendor_id?.toString();
        if (!vid || out.map[vid] || !a.addr || /^\d+$/.test(a.addr)) continue;
        out.map[vid] = { street: a.addr, city: '', state: '', zip: '' };
        added = true;
      }
      if (added) used.push('formatted');
      else out.errors.push('formatted: no rows');
    } catch (e: any) {
      out.errors.push(`formatted: ${shortSuiteqlError(e)}`);
    }
  }

  out.strategy = used.length > 0 ? used.join('+') : null;
  if (!out.strategy) {
    console.warn('NetSuite vendor address lookup found nothing:', out.errors.join(' | '));
  }
  return out;
}

/** Current contact info for one vendor — powers "Refresh from NetSuite". */
export async function getVendorContact(id: string): Promise<{
  found: boolean;
  companyName?: string;
  email?: string | null;
  phone?: string | null;
  address?: VendorAddress | null;
  /** How (or why not) the address was found — for admin-facing messages. */
  addressLookup?: { strategy: string | null; errors: string[] };
  error?: string;
}> {
  if (!/^\d+$/.test(id)) return { found: false, error: 'Invalid vendor id' };
  try {
    const q = `SELECT id, entityid, companyname, email, phone FROM vendor WHERE id = ${id}`;
    const result = await suiteqlQuery(q);
    const v = result?.items?.[0];
    if (!v) return { found: false, error: 'Vendor not found in NetSuite' };
    const addresses = await getVendorAddresses([id]);
    return {
      found: true,
      companyName: v.companyname || v.entityid || '',
      email: v.email || null,
      phone: v.phone || null,
      address: addresses.map[id] || null,
      addressLookup: { strategy: addresses.strategy, errors: addresses.errors },
    };
  } catch (e: any) {
    return { found: false, error: shortSuiteqlError(e) };
  }
}

export async function findVendors(name: string): Promise<{
  found: boolean;
  vendors: { id: string; entityId: string; companyName: string; email: string | null; phone: string | null; address: VendorAddress | null }[];
  error?: string;
}> {
  try {
    const term = name.replace(/'/g, "''").slice(0, 80);
    const q = `SELECT id, entityid, companyname, email, phone FROM vendor WHERE isinactive = 'F' AND (UPPER(companyname) LIKE UPPER('%${term}%') OR UPPER(entityid) LIKE UPPER('%${term}%')) FETCH FIRST 10 ROWS ONLY`;
    const result = await suiteqlQuery(q);
    const rows = result?.items || [];

    // Addresses come from a strategy chain (address book → default billing
    // subrecord → formatted string) — one extra round trip for the batch.
    const addressLookup = rows.length > 0
      ? await getVendorAddresses(rows.map((v: any) => String(v.id)))
      : { map: {} as Record<string, VendorAddress>, strategy: null, errors: [] };

    const vendors = rows.map((v: any) => ({
      id: String(v.id),
      entityId: v.entityid || '',
      companyName: v.companyname || v.entityid || '',
      email: v.email || null,
      phone: v.phone || null,
      address: addressLookup.map[String(v.id)] || null,
    }));
    return { found: vendors.length > 0, vendors };
  } catch (e: any) {
    console.error('NetSuite vendor search failed:', e?.message);
    // Keep the message short enough for inline UI display — the usual cause
    // is the integration role lacking vendor-table access.
    let detail = String(e?.message || 'Vendor search failed');
    const m = detail.match(/"detail"\s*:\s*"([^"]+)"/);
    if (m) detail = m[1];
    return { found: false, vendors: [], error: detail.slice(0, 160) };
  }
}

/**
 * Every active NetSuite vendor, names only — for dropdowns that must stay
 * in lockstep with NetSuite's vendor list (e.g. the vendor-asset import's
 * "tag matched parts" picker). No address lookups; one cheap query.
 */
export async function listVendors(): Promise<{ vendors: { id: string; name: string }[]; error?: string }> {
  try {
    const q = `SELECT id, entityid, companyname FROM vendor WHERE isinactive = 'F' ORDER BY COALESCE(companyname, entityid) FETCH FIRST 1000 ROWS ONLY`;
    const result = await suiteqlQuery(q);
    const rows = result?.items || [];
    return { vendors: rows.map((v: any) => ({ id: String(v.id), name: v.companyname || v.entityid || String(v.id) })) };
  } catch (e: any) {
    console.error('NetSuite vendor list failed:', e?.message);
    let detail = String(e?.message || 'Vendor list failed');
    const m = detail.match(/"detail"\s*:\s*"([^"]+)"/);
    if (m) detail = m[1];
    return { vendors: [], error: detail.slice(0, 160) };
  }
}

/** NetSuite UI link for a vendor record, given its numeric internal id. */
export function vendorUrl(internalId: string | number): string {
  const accountForUrl = getConfig().accountId.replace(/-/g, '_').toUpperCase();
  return `https://${accountForUrl}.app.netsuite.com/app/common/entity/vendor.nl?id=${internalId}`;
}

/**
 * Create a contact record in NetSuite, attached to a customer.
 * `companyId` is the customer's numeric Internal ID. NetSuite requires a
 * name (it derives the contact's entity id from it); other fields optional.
 * NetSuite's own rejection message is returned verbatim — common cases are
 * a missing Lists > Contacts permission on the integration role, or a
 * single-word name where the account requires a last name.
 */
export async function createContact(payload: {
  companyId: string;
  firstName: string;
  lastName?: string;
  email?: string;
  phone?: string;
  title?: string;
}): Promise<{ success: boolean; internalId?: string; error?: string }> {
  const body: any = {
    firstName: payload.firstName,
    company: { id: payload.companyId },
    // Same hardcoded-with-override subsidiary as vendor/customer creates —
    // the integration role cannot SuiteQL the subsidiary table.
    subsidiary: { id: process.env.NETSUITE_SUBSIDIARY_ID || '2' },
  };
  if (payload.lastName) body.lastName = payload.lastName;
  if (payload.email) body.email = payload.email;
  if (payload.phone) body.phone = payload.phone;
  if (payload.title) body.title = payload.title;

  try {
    const config = getConfig();
    const baseUrl = getBaseUrl(config.accountId);
    const url = `${baseUrl}/services/rest/record/v1/contact`;
    const { oauth, token } = createOAuth(config);
    const authHeader = getAuthHeader(oauth, token, { url, method: 'POST' });

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
        'Prefer': 'respondAsync=false',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error('NetSuite create contact error:', response.status, text);
      let detail = text.slice(0, 400);
      try {
        const parsed = JSON.parse(text);
        detail = parsed?.['o:errorDetails']?.[0]?.detail || parsed?.title || detail;
      } catch { /* keep raw text */ }
      return { success: false, error: `NetSuite ${response.status}: ${detail}` };
    }

    const location = response.headers.get('location') || '';
    const idMatch = location.match(/\/contact\/(\d+)/) || location.match(/\/(\d+)(?:\?|$)/);
    return { success: true, internalId: idMatch ? idMatch[1] : undefined };
  } catch (error: any) {
    console.error('NetSuite create contact exception:', error);
    return { success: false, error: error?.message || 'Unknown error' };
  }
}

/**
 * Update fields on an existing NetSuite contact.
 * PATCH /services/rest/record/v1/contact/{id} — only the provided fields are
 * sent; NetSuite's rejection message is returned verbatim.
 */
export async function updateContact(
  contactId: string,
  fields: { firstName?: string; lastName?: string; email?: string; phone?: string; title?: string },
): Promise<{ success: boolean; error?: string }> {
  const body: any = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) body[k] = v;
  }

  const config = getConfig();
  const baseUrl = getBaseUrl(config.accountId);
  const url = `${baseUrl}/services/rest/record/v1/contact/${contactId}`;
  const { oauth, token } = createOAuth(config);
  const authHeader = getAuthHeader(oauth, token, { url, method: 'PATCH' });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const response = await fetch(url, {
      method: 'PATCH',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
        'Prefer': 'respondAsync=false',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      let detail = text.slice(0, 400);
      try {
        const parsed = JSON.parse(text);
        detail = parsed?.['o:errorDetails']?.[0]?.detail || parsed?.title || detail;
      } catch { /* keep raw text */ }
      return { success: false, error: `NetSuite ${response.status}: ${detail}` };
    }

    return { success: true };
  } catch (e: any) {
    const msg = e?.name === 'AbortError' ? 'NetSuite request timed out' : e?.message || 'Unknown error';
    return { success: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Delete a NetSuite contact record.
 * DELETE /services/rest/record/v1/contact/{id}. A 404 counts as success —
 * the contact is already gone, which is the state the caller wants.
 */
export async function deleteContact(contactId: string): Promise<{ success: boolean; error?: string }> {
  const config = getConfig();
  const baseUrl = getBaseUrl(config.accountId);
  const url = `${baseUrl}/services/rest/record/v1/contact/${contactId}`;
  const { oauth, token } = createOAuth(config);
  const authHeader = getAuthHeader(oauth, token, { url, method: 'DELETE' });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const response = await fetch(url, {
      method: 'DELETE',
      headers: { 'Authorization': authHeader, 'Prefer': 'respondAsync=false' },
      signal: controller.signal,
    });

    if (!response.ok && response.status !== 404) {
      const text = await response.text();
      let detail = text.slice(0, 400);
      try {
        const parsed = JSON.parse(text);
        detail = parsed?.['o:errorDetails']?.[0]?.detail || parsed?.title || detail;
      } catch { /* keep raw text */ }
      return { success: false, error: `NetSuite ${response.status}: ${detail}` };
    }

    return { success: true };
  } catch (e: any) {
    const msg = e?.name === 'AbortError' ? 'NetSuite request timed out' : e?.message || 'Unknown error';
    return { success: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Delete a NetSuite customer record.
 * DELETE /services/rest/record/v1/customer/{id}. A 404 counts as success —
 * the customer is already gone, which is the state the caller wants.
 * NetSuite refuses to delete a customer with transactions (estimates,
 * SOs, invoices); callers should fall back to deactivateCustomer then.
 */
export async function deleteCustomer(customerId: string): Promise<{ success: boolean; error?: string }> {
  const config = getConfig();
  const baseUrl = getBaseUrl(config.accountId);
  const url = `${baseUrl}/services/rest/record/v1/customer/${customerId}`;
  const { oauth, token } = createOAuth(config);
  const authHeader = getAuthHeader(oauth, token, { url, method: 'DELETE' });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const response = await fetch(url, {
      method: 'DELETE',
      headers: { 'Authorization': authHeader, 'Prefer': 'respondAsync=false' },
      signal: controller.signal,
    });

    if (!response.ok && response.status !== 404) {
      const text = await response.text();
      let detail = text.slice(0, 400);
      try {
        const parsed = JSON.parse(text);
        detail = parsed?.['o:errorDetails']?.[0]?.detail || parsed?.title || detail;
      } catch { /* keep raw text */ }
      return { success: false, error: `NetSuite ${response.status}: ${detail}` };
    }

    return { success: true };
  } catch (e: any) {
    const msg = e?.name === 'AbortError' ? 'NetSuite request timed out' : e?.message || 'Unknown error';
    return { success: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Mark a NetSuite customer inactive — the fallback when deleteCustomer is
 * refused (the record has transactions). Both syncs filter
 * isinactive = 'F', so an inactive customer stops flowing back into the
 * local mirror.
 * PATCH /services/rest/record/v1/customer/{id} with {isInactive: true}.
 */
export async function deactivateCustomer(customerId: string): Promise<{ success: boolean; error?: string }> {
  const config = getConfig();
  const baseUrl = getBaseUrl(config.accountId);
  const url = `${baseUrl}/services/rest/record/v1/customer/${customerId}`;
  const { oauth, token } = createOAuth(config);
  const authHeader = getAuthHeader(oauth, token, { url, method: 'PATCH' });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const response = await fetch(url, {
      method: 'PATCH',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
        'Prefer': 'respondAsync=false',
      },
      body: JSON.stringify({ isInactive: true }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      let detail = text.slice(0, 400);
      try {
        const parsed = JSON.parse(text);
        detail = parsed?.['o:errorDetails']?.[0]?.detail || parsed?.title || detail;
      } catch { /* keep raw text */ }
      return { success: false, error: `NetSuite ${response.status}: ${detail}` };
    }

    return { success: true };
  } catch (e: any) {
    const msg = e?.name === 'AbortError' ? 'NetSuite request timed out' : e?.message || 'Unknown error';
    return { success: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Create a vendor record in NetSuite (for CNI installer payouts / bills).
 * The returned internalId is the numeric Internal ID that vendor-bill
 * creation needs in `entity.id` — store THAT, never the Entity ID/name
 * (see docs/cni-vendor-bills.md).
 */
export async function createVendor(payload: {
  companyName: string;
  email?: string;
  phone?: string;
}): Promise<{
  success: boolean;
  internalId?: string;
  netsuiteUrl?: string;
  error?: string;
}> {
  const body: any = {
    companyName: payload.companyName,
    isPerson: false,
    // Subsidiary is required and hardcoded like the vendor-bill flow — the
    // integration role cannot SuiteQL the subsidiary table. Single-select
    // shape (like vendorBill), not the item record's multi-select.
    subsidiary: { id: process.env.NETSUITE_SUBSIDIARY_ID || '2' },
  };
  if (payload.email) body.email = payload.email;
  if (payload.phone) body.phone = payload.phone;

  try {
    // Inside the try so missing NETSUITE_* env vars surface as
    // { success: false } per this function's contract, not a throw.
    const config = getConfig();
    const baseUrl = getBaseUrl(config.accountId);
    const url = `${baseUrl}/services/rest/record/v1/vendor`;
    const { oauth, token } = createOAuth(config);
    const authHeader = getAuthHeader(oauth, token, { url, method: 'POST' });

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
        'Prefer': 'respondAsync=false',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error('NetSuite create vendor error:', response.status, text);
      let detail = text.slice(0, 400);
      try {
        const parsed = JSON.parse(text);
        detail = parsed?.['o:errorDetails']?.[0]?.detail || parsed?.title || detail;
      } catch { /* keep raw text */ }
      return { success: false, error: `NetSuite ${response.status}: ${detail}` };
    }

    const location = response.headers.get('location') || '';
    const idMatch = location.match(/\/vendor\/(\d+)/) || location.match(/\/(\d+)(?:\?|$)/);
    const internalId = idMatch ? idMatch[1] : undefined;

    return {
      success: true,
      internalId,
      netsuiteUrl: internalId ? vendorUrl(internalId) : undefined,
    };
  } catch (error: any) {
    console.error('NetSuite create vendor exception:', error);
    return { success: false, error: error?.message || 'Unknown error' };
  }
}

export async function createSalesOrder(payload: {
  customerId: string | number;
  poNumber: string;
  locationId?: string | number;
  orderDate?: string;
  shipTo?: {
    name?: string;
    address?: string;
    city?: string;
    state?: string;
    zip?: string;
  };
  memo?: string;
  /** Written to custbody_vin_number_ — the same custom field the SuiteQL
   *  reads select as `vin`, so the SO shows the VIN wherever we display it. */
  vin?: string | null;
  lineItems: {
    itemId: string | number;
    quantity: number;
    rate: number;
    description?: string;
  }[];
}): Promise<{
  success: boolean;
  salesOrderId?: string;
  salesOrderNumber?: string;
  error?: string;
}> {
  const config = getConfig();
  const baseUrl = getBaseUrl(config.accountId);
  const url = `${baseUrl}/services/rest/record/v1/salesOrder`;
  const { oauth, token } = createOAuth(config);

  const authHeader = getAuthHeader(oauth, token, { url, method: 'POST' });

  // Build line items for NetSuite. For any line with an explicit rate, pin the
  // price level to "Custom" (internal id -1) so NetSuite keeps our rate instead
  // of re-sourcing it from the item's / customer's default price level. Lines
  // with no rate fall through to NetSuite's normal price-level sourcing.
  const items = payload.lineItems.map((li) => ({
    item: { id: li.itemId },
    quantity: li.quantity,
    ...(li.rate > 0 ? { price: { id: '-1' }, rate: li.rate } : {}),
    ...(li.description ? { description: li.description } : {}),
  }));

  const body: any = {
    entity: { id: payload.customerId },
    otherRefNum: payload.poNumber,
    item: { items },
    ...(payload.locationId ? { location: { id: payload.locationId } } : {}),
    ...(payload.vin ? { custbody_vin_number_: payload.vin } : {}),
  };

  if (payload.orderDate) {
    body.tranDate = payload.orderDate;
  }

  if (payload.memo) {
    body.memo = payload.memo;
  }

  // Ship-to address if provided
  if (payload.shipTo) {
    body.shippingAddress = {
      addressee: payload.shipTo.name || '',
      addr1: payload.shipTo.address || '',
      city: payload.shipTo.city || '',
      state: payload.shipTo.state || '',
      zip: payload.shipTo.zip || '',
      country: { id: 'US' },
    };
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
        'Prefer': 'respondAsync=false',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error('NetSuite create SO error:', text);
      return { success: false, error: `NetSuite error (${response.status}): ${text}` };
    }

    // NetSuite returns 204 with Location header on success, or the record
    const location = response.headers.get('Location');
    let soId = '';

    if (location) {
      // Extract ID from Location header: .../salesOrder/12345
      const match = location.match(/\/(\d+)$/);
      soId = match?.[1] || '';
    }

    // Try to get the response body if present
    let soNumber = '';
    try {
      const result = await response.json();
      soId = soId || result.id?.toString() || '';
      soNumber = result.tranId || result.tranid || '';
    } catch {
      // 204 No Content — that's fine, we have the ID from Location
    }

    // If we got an ID, look up the SO number via SuiteQL
    if (soId && !soNumber) {
      try {
        const lookup = await suiteqlQuery(`SELECT tranid FROM transaction WHERE id = ${soId}`);
        soNumber = lookup?.items?.[0]?.tranid || '';
      } catch {
        // Non-critical
      }
    }

    return {
      success: true,
      salesOrderId: soId,
      salesOrderNumber: soNumber,
    };
  } catch (e: any) {
    return { success: false, error: `Failed to create sales order: ${e.message}` };
  }
}

/**
 * Look up a NetSuite customer by name (partial match)
 */
export async function findCustomer(name: string): Promise<{
  found: boolean;
  customers: { id: string; name: string; entityId: string }[];
}> {
  const searchTerm = name.trim().replace(/'/g, "''");
  const query = `
    SELECT c.id, c.companyname, c.entityid
    FROM customer c
    WHERE UPPER(c.companyname) LIKE UPPER('%${searchTerm}%')
    OR UPPER(c.entityid) LIKE UPPER('%${searchTerm}%')
    ORDER BY c.companyname
    FETCH FIRST 10 ROWS ONLY
  `;

  const result = await suiteqlQuery(query);
  const items = result?.items || [];

  return {
    found: items.length > 0,
    customers: items.map((c: any) => ({
      id: c.id?.toString(),
      name: c.companyname,
      entityId: c.entityid,
    })),
  };
}

/**
 * Look up NetSuite items by part number
 */
/**
 * Look up NetSuite items by part number. Intentionally NOT cached: the only
 * callers are invoice / sales-order creation flows, and caching a negative
 * result (part not yet in NetSuite) would mask a part that was added moments
 * ago — the lookup must reflect NetSuite's current state every time.
 *
 * Only matches ACTIVE items: an inactive duplicate sharing the same itemid
 * would otherwise get picked and rejected by NetSuite ("Invalid Field Value
 * <id> for the field: item") when used on an invoice line.
 */
export async function findItems(
  partNumbers: string[],
): Promise<Record<string, { id: string; name: string; displayName: string; description: string; type: string }>> {
  if (partNumbers.length === 0) return {};

  const conditions = partNumbers
    .map((p) => `UPPER(i.itemid) = UPPER('${safeStringLiteral(p, 80)}')`)
    .join(' OR ');
  const query = `
    SELECT i.id, i.itemid, i.displayname, i.description, i.itemtype, i.isinactive
    FROM item i
    WHERE (${conditions})
    AND i.isinactive = 'F'
  `;

  const result = await suiteqlQuery(query);
  const items = result?.items || [];
  const map: Record<string, { id: string; name: string; displayName: string; description: string; type: string }> = {};

  for (const item of items) {
    const key = item.itemid?.toUpperCase();
    // If duplicates somehow remain, keep the first active match deterministically
    if (key && map[key]) continue;
    map[key] = {
      id: item.id?.toString(),
      name: item.itemid,
      displayName: item.displayname || item.itemid,
      description: item.description || item.displayname || item.itemid,
      type: item.itemtype || '',
    };
  }

  return map;
}

/**
 * Look up the base (price level 1) sales price for the given NetSuite item IDs.
 * Tries the `pricing` matrix table first, falls back to `itemPrice`, then to
 * the item record's `baseprice` field (table names / fields vary by account).
 * Returns a map of itemId -> price for items that have a non-zero price.
 */
export async function getItemBasePrices(
  itemIds: (string | number)[]
): Promise<Record<string, number>> {
  const ids = Array.from(
    new Set(itemIds.map((id) => id?.toString()).filter(Boolean))
  );
  const priceMap: Record<string, number> = {};
  if (ids.length === 0) return priceMap;

  const idList = ids.join(',');
  const sources = [
    `SELECT p.item AS item_id, p.unitprice AS sales_price FROM pricing p WHERE p.pricelevel = 1 AND p.item IN (${idList})`,
    `SELECT ip.item AS item_id, ip.unitprice AS sales_price FROM itemPrice ip WHERE ip.pricelevel = 1 AND ip.item IN (${idList})`,
    `SELECT i.id AS item_id, i.baseprice AS sales_price FROM item i WHERE i.id IN (${idList})`,
  ];

  for (const sql of sources) {
    // Stop once every requested item already has a price
    if (ids.every((id) => id in priceMap)) break;
    try {
      const result = await suiteqlQuery(sql);
      for (const row of result?.items || []) {
        const id = row.item_id?.toString();
        const price = parseFloat(row.sales_price || '0');
        if (id && price > 0 && !(id in priceMap)) {
          priceMap[id] = price;
        }
      }
    } catch (e) {
      // Table/column may not exist in this account — fall through to next source
    }
  }

  return priceMap;
}

/**
 * Create a standalone Invoice in NetSuite (no SO required)
 * Used for direct invoicing of scanned vehicles without PO/SO flow
 */
export async function createDirectInvoice(payload: {
  customerId: string | number;
  locationId?: string | number;
  poNumber?: string;
  memo?: string;
  otherrefnum?: string;
  /** Written to custbody_vin_number_ — same field the SO/estimate writes
   *  set, so direct invoices carry the vehicle like transformed ones do. */
  vin?: string | null;
  lineItems: {
    itemId: string | number;
    quantity: number;
    rate: number;
    description?: string;
  }[];
}): Promise<{
  success: boolean;
  invoiceId?: string;
  invoiceNumber?: string;
  error?: string;
}> {
  const config = getConfig();
  const baseUrl = getBaseUrl(config.accountId);
  const url = `${baseUrl}/services/rest/record/v1/invoice`;
  const { oauth, token } = createOAuth(config);
  const authHeader = getAuthHeader(oauth, token, { url, method: 'POST' });

  // When a line has no rate, look up the item's base price in NetSuite and send
  // it explicitly. NetSuite does not always auto-populate the Amount from the
  // item default for every item type, and a line with no Amount fails the whole
  // request ("Please enter a value for Amount"). If an item has no price
  // anywhere we surface a clear error instead of the cryptic NetSuite one.
  const missingRateIds = payload.lineItems
    .filter((li) => !(li.rate > 0))
    .map((li) => li.itemId);
  const basePrices = missingRateIds.length > 0
    ? await getItemBasePrices(missingRateIds)
    : {};

  const noPriceItems: (string | number)[] = [];
  const items = payload.lineItems.map((li) => {
    const rate = li.rate > 0 ? li.rate : basePrices[li.itemId?.toString()] || 0;
    if (!(rate > 0)) noPriceItems.push(li.itemId);
    return {
      item: { id: li.itemId },
      quantity: li.quantity,
      // Pin the line's price level to "Custom" (internal id -1) so NetSuite
      // honors the rate we send. Without this, NetSuite re-sources the rate
      // from the item's / customer's default price level, which can differ
      // from the catalog price and silently change the invoice total
      // (e.g. billing 160.00 when the catalog price is 177.50).
      price: { id: '-1' },
      rate,
      // Omit description when not provided so NetSuite falls back to the item
      // record's standard description instead of blanking the line.
      ...(li.description ? { description: li.description } : {}),
    };
  });

  if (noPriceItems.length > 0) {
    return {
      success: false,
      error: `No price found in NetSuite for item(s): ${noPriceItems.join(', ')}. Set a base price on the NetSuite item (or add it to the parts catalog) before invoicing.`,
    };
  }

  // NetSuite may require a Location on the invoice header. Use the
  // caller's location if given, otherwise fall back to the account default.
  const locationId = payload.locationId ?? (await resolveDefaultLocationId());

  const body: any = {
    entity: { id: payload.customerId },
    item: { items },
    ...(locationId ? { location: { id: locationId } } : {}),
    ...(payload.poNumber ? { otherRefNum: payload.poNumber } : {}),
    ...(payload.memo ? { memo: payload.memo } : {}),
    ...(payload.otherrefnum ? { otherrefnum: payload.otherrefnum } : {}),
    ...(payload.vin ? { custbody_vin_number_: payload.vin } : {}),
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
        'Prefer': 'respondAsync=false',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error('NetSuite create direct invoice error:', text);
      // "Invalid Field Value <id> for the following field: item" almost always
      // means the item isn't shared with the invoice's subsidiary. Surface an
      // actionable hint instead of the raw NetSuite error.
      const itemSubsidiaryError = /Invalid Field Value\s+\d+\s+for the following field:\s*item/i.test(text);
      const hint = itemSubsidiaryError
        ? ' — This usually means the item is not assigned to the invoice\'s subsidiary in NetSuite. Set the item\'s subsidiary to BMG Fleet Installations and retry.'
        : '';
      return { success: false, error: `NetSuite error (${response.status}): ${text}${hint}` };
    }

    const location = response.headers.get('Location');
    let invoiceId = '';
    if (location) {
      const match = location.match(/\/(\d+)$/);
      invoiceId = match?.[1] || '';
    }

    let invoiceNumber = '';
    try {
      const result = await response.json();
      invoiceId = invoiceId || result.id?.toString() || '';
      invoiceNumber = result.tranId || result.tranid || '';
    } catch {
      // 204 No Content
    }

    if (invoiceId && !invoiceNumber) {
      try {
        const lookup = await suiteqlQuery(`SELECT tranid FROM transaction WHERE id = ${invoiceId}`);
        invoiceNumber = lookup?.items?.[0]?.tranid || '';
      } catch {
        // Non-critical
      }
    }

    return { success: true, invoiceId, invoiceNumber };
  } catch (e: any) {
    return { success: false, error: `Failed to create invoice: ${e.message}` };
  }
}

/**
 * Create an Estimate (NetSuite's quote record). Same line shape as
 * createDirectInvoice: rates are pinned to the Custom price level (-1) so
 * NetSuite honors the amounts we send, and taxes are left entirely to
 * NetSuite's own tax engine — no tax lines are sent.
 */
export async function createEstimate(payload: {
  customerId: string | number;
  memo?: string;
  locationId?: string | number;
  lineItems: {
    itemId: string | number;
    quantity: number;
    rate: number;
    description?: string;
  }[];
}): Promise<{
  success: boolean;
  estimateId?: string;
  estimateNumber?: string;
  error?: string;
}> {
  const config = getConfig();
  const baseUrl = getBaseUrl(config.accountId);
  const url = `${baseUrl}/services/rest/record/v1/estimate`;
  const { oauth, token } = createOAuth(config);
  const authHeader = getAuthHeader(oauth, token, { url, method: 'POST' });

  const items = payload.lineItems.map((li) => ({
    item: { id: li.itemId },
    quantity: li.quantity,
    price: { id: '-1' },
    rate: li.rate,
    ...(li.description ? { description: li.description } : {}),
  }));

  const locationId = payload.locationId ?? (await resolveDefaultLocationId());

  const body: any = {
    entity: { id: payload.customerId },
    item: { items },
    ...(locationId ? { location: { id: locationId } } : {}),
    ...(payload.memo ? { memo: payload.memo } : {}),
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
        'Prefer': 'respondAsync=false',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error('NetSuite create estimate error:', text);
      const itemSubsidiaryError = /Invalid Field Value\s+\d+\s+for the following field:\s*item/i.test(text);
      const hint = itemSubsidiaryError
        ? ' — This usually means the item is not assigned to the estimate\'s subsidiary in NetSuite. Set the item\'s subsidiary and retry.'
        : '';
      return { success: false, error: `NetSuite error (${response.status}): ${text}${hint}` };
    }

    const location = response.headers.get('Location');
    let estimateId = '';
    if (location) {
      const match = location.match(/\/(\d+)$/);
      estimateId = match?.[1] || '';
    }

    let estimateNumber = '';
    try {
      const result = await response.json();
      estimateId = estimateId || result.id?.toString() || '';
      estimateNumber = result.tranId || result.tranid || '';
    } catch {
      // 204 No Content
    }

    if (estimateId && !estimateNumber) {
      try {
        const lookup = await suiteqlQuery(`SELECT tranid FROM transaction WHERE id = ${estimateId}`);
        estimateNumber = lookup?.items?.[0]?.tranid || '';
      } catch {
        // Non-critical
      }
    }

    return { success: true, estimateId, estimateNumber };
  } catch (e: any) {
    return { success: false, error: `Failed to create estimate: ${e.message}` };
  }
}

/**
 * Resolve a GL account's NetSuite internal id from its account number and/or
 * name (e.g. number "53000" / name "Subcontractors"). The internal id is what
 * the REST Record API needs on a transaction line — the account NUMBER is not
 * it. An explicit env override wins; otherwise we match the account number
 * exactly first, then fall back to a name contains-match. Active accounts only.
 */
export async function findExpenseAccount(opts: { number?: string; name?: string }): Promise<{ id: string; name: string; number: string | null } | null> {
  const envId = process.env.NETSUITE_SUBCONTRACTOR_ACCOUNT_ID;
  if (envId) return { id: envId.toString(), name: opts.name || 'Subcontractors', number: opts.number || null };

  const num = (opts.number || '').trim().replace(/'/g, "''");
  const name = (opts.name || '').trim().replace(/'/g, "''");
  const conds: string[] = [];
  if (num) conds.push(`acctnumber = '${num}'`);
  if (name) conds.push(`UPPER(acctname) LIKE UPPER('%${name}%')`);
  if (conds.length === 0) return null;

  const query = `
    SELECT id, acctname, acctnumber
    FROM account
    WHERE isinactive = 'F' AND (${conds.join(' OR ')})
    ORDER BY CASE WHEN acctnumber = '${num}' THEN 0 ELSE 1 END
    FETCH FIRST 1 ROWS ONLY
  `;
  const result = await suiteqlQuery(query);
  const row = result?.items?.[0];
  return row ? { id: row.id?.toString(), name: row.acctname, number: row.acctnumber ?? null } : null;
}

/**
 * Resolve a NetSuite subsidiary's internal id by name (e.g. "BMG Fleet
 * Installations"). An explicit env override (NETSUITE_SUBSIDIARY_ID) wins.
 */
export async function findSubsidiary(name: string): Promise<{ id: string; name: string } | null> {
  const envId = process.env.NETSUITE_SUBSIDIARY_ID;
  if (envId) return { id: envId.toString(), name };

  const term = name.trim().replace(/'/g, "''");
  const query = `
    SELECT id, name
    FROM subsidiary
    WHERE UPPER(name) LIKE UPPER('%${term}%')
    FETCH FIRST 1 ROWS ONLY
  `;
  const result = await suiteqlQuery(query);
  const row = result?.items?.[0];
  return row ? { id: row.id?.toString(), name: row.name } : null;
}

/**
 * Create a Vendor Bill in NetSuite for an installer payout.
 * Uses the REST Record API: POST /services/rest/record/v1/vendorBill
 * Books a single expense line (the payout total) to the given GL account.
 */
export async function createVendorBill(payload: {
  vendorId: string | number;
  accountId: string | number;
  amount: number;
  referenceNo?: string;
  subsidiaryId?: string | number;
  locationId?: string | number;
  memo?: string;
  lineMemo?: string;
}): Promise<{ success: boolean; billId?: string; billNumber?: string; error?: string }> {
  const config = getConfig();
  const baseUrl = getBaseUrl(config.accountId);
  const url = `${baseUrl}/services/rest/record/v1/vendorBill`;
  const { oauth, token } = createOAuth(config);
  const authHeader = getAuthHeader(oauth, token, { url, method: 'POST' });

  // tranId is the vendor bill's "Reference No." — required when the account
  // doesn't auto-number bills, so always send one. Location is HEADER only
  // (one location per bill); a line-level location triggers a 500 unless
  // per-line locations are on, so keep the line minimal: account + amount.
  const body: any = {
    entity: { id: payload.vendorId },
    ...(payload.referenceNo ? { tranId: payload.referenceNo } : {}),
    ...(payload.subsidiaryId ? { subsidiary: { id: payload.subsidiaryId } } : {}),
    ...(payload.locationId ? { location: { id: payload.locationId } } : {}),
    expense: {
      items: [
        {
          account: { id: payload.accountId },
          amount: payload.amount,
          ...(payload.lineMemo ? { memo: payload.lineMemo } : {}),
        },
      ],
    },
    ...(payload.memo ? { memo: payload.memo } : {}),
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
        'Prefer': 'respondAsync=false',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error('NetSuite create vendor bill error:', text, '\nrequest body:', JSON.stringify(body));
      // Include the exact body we sent so an opaque UNEXPECTED_ERROR can be
      // diagnosed against what NetSuite actually received.
      return { success: false, error: `NetSuite error (${response.status}): ${text} | sent: ${JSON.stringify(body)}` };
    }

    // The created record's id comes back in the Location header (and/or body).
    const location = response.headers.get('Location');
    let billId = '';
    if (location) {
      const match = location.match(/\/(\d+)$/);
      billId = match?.[1] || '';
    }
    let billNumber = '';
    try {
      const result = await response.json();
      billId = billId || result.id?.toString() || '';
      billNumber = result.tranId || result.tranid || '';
    } catch {
      // 204 No Content
    }
    if (billId && !billNumber) {
      try {
        const lookup = await suiteqlQuery(`SELECT tranid FROM transaction WHERE id = ${billId}`);
        billNumber = lookup?.items?.[0]?.tranid || '';
      } catch {
        // Non-critical — the internal id is enough to record the bill.
      }
    }
    return { success: true, billId, billNumber };
  } catch (e: any) {
    return { success: false, error: `Failed to create vendor bill: ${e.message}` };
  }
}

/**
 * Create a Vendor Bill in NetSuite from a Purchase Order.
 * Uses: POST /services/rest/record/v1/purchaseOrder/{poId}/!transform/vendorBill
 * (same transform pattern as createInvoiceFromSO — the old `?init=…&id=…`
 * form is rejected by the account's current NetSuite release) so the bill
 * carries the PO's vendor, items, and amounts — nothing is re-keyed.
 * referenceNo becomes the bill's tranId (the vendor's invoice number).
 */
export async function createBillFromPo(payload: {
  purchaseOrderId: string | number;
  referenceNo?: string;
  memo?: string;
}): Promise<{ success: boolean; billId?: string; billNumber?: string; error?: string }> {
  const config = getConfig();
  const baseUrl = getBaseUrl(config.accountId);
  const url = `${baseUrl}/services/rest/record/v1/purchaseOrder/${payload.purchaseOrderId}/!transform/vendorBill`;
  const { oauth, token } = createOAuth(config);
  const authHeader = getAuthHeader(oauth, token, { url, method: 'POST' });

  const body: any = {
    ...(payload.referenceNo ? { tranId: payload.referenceNo } : {}),
    ...(payload.memo ? { memo: payload.memo } : {}),
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
        'Prefer': 'respondAsync=false',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error('NetSuite bill-from-PO error:', text, '\nrequest body:', JSON.stringify(body));
      return { success: false, error: `NetSuite error (${response.status}): ${text} | sent: ${JSON.stringify(body)}` };
    }

    const location = response.headers.get('Location');
    let billId = '';
    if (location) {
      const match = location.match(/\/(\d+)$/);
      billId = match?.[1] || '';
    }
    let billNumber = '';
    try {
      const result = await response.json();
      billId = billId || result.id?.toString() || '';
      billNumber = result.tranId || result.tranid || '';
    } catch {
      // 204 No Content
    }
    if (billId && !billNumber) {
      try {
        const lookup = await suiteqlQuery(`SELECT tranid FROM transaction WHERE id = ${billId}`);
        billNumber = lookup?.items?.[0]?.tranid || '';
      } catch {
        // Non-critical — the internal id is enough to record the bill.
      }
    }
    return { success: true, billId, billNumber };
  } catch (e: any) {
    return { success: false, error: `Failed to create bill from PO: ${e.message}` };
  }
}

/**
 * Create an Invoice in NetSuite by transforming a Sales Order
 * Uses: POST /services/rest/record/v1/invoice
 * The transform endpoint creates an invoice from an existing SO
 * If installedQuantities is provided, only those quantities are billed
 */
export async function createInvoiceFromSO(payload: {
  salesOrderId: string;
  installedQuantities?: Record<number, number>; // lineNumber -> installed qty
  locationId?: string | number;
  memo?: string;
}): Promise<{
  success: boolean;
  invoiceId?: string;
  invoiceNumber?: string;
  error?: string;
}> {
  const config = getConfig();
  const baseUrl = getBaseUrl(config.accountId);

  // First, get the SO line items to build the invoice with installed quantities
  let lineOverrides: any[] | undefined;

  if (payload.installedQuantities && Object.keys(payload.installedQuantities).length > 0) {
    // Get SO line details first to map line numbers to items
    try {
      // tl.memo is the SO line's Description field. It must ride along into
      // the rebuilt lines below: ?replace=item resets every line, and a line
      // sent without a description reverts to the item record's default —
      // silently dropping estimate/SO-level notes (placement notes etc.).
      const linesQuery = `
        SELECT tl.linesequencenumber, tl.item, tl.quantity, tl.rate, tl.memo
        FROM transactionline tl
        WHERE tl.transaction = ${payload.salesOrderId}
        AND tl.mainline = 'F'
        AND tl.taxline = 'F'
        ORDER BY tl.linesequencenumber
      `;
      const linesResult = await suiteqlQuery(linesQuery);
      const soLines = linesResult?.items || [];

      const billableLines = soLines.filter((line: any) => {
        const lineNum = parseInt(line.linesequencenumber);
        const installedQty = payload.installedQuantities![lineNum];
        return installedQty !== undefined && installedQty > 0;
      });

      // For lines whose SO rate is 0, look up the item's base price so the
      // invoice line has an Amount. NetSuite does not reliably auto-populate
      // the Amount from the item default, and a line with no Amount fails the
      // whole request ("Please enter a value for Amount").
      const missingRateIds = billableLines
        .filter((line: any) => !(parseFloat(line.rate || '0') > 0))
        .map((line: any) => line.item);
      const basePrices = missingRateIds.length > 0
        ? await getItemBasePrices(missingRateIds)
        : {};

      lineOverrides = billableLines.map((line: any) => {
        const lineNum = parseInt(line.linesequencenumber);
        const soRate = parseFloat(line.rate || '0');
        const rate = soRate > 0 ? soRate : basePrices[line.item?.toString()] || 0;
        return {
          item: { id: line.item },
          quantity: payload.installedQuantities![lineNum],
          // Pin "Custom" price level (id -1) so NetSuite keeps the rate we send
          // rather than re-sourcing it from the item's / customer's price level.
          ...(rate > 0 ? { price: { id: '-1' }, rate } : {}),
          ...(line.memo ? { description: line.memo } : {}),
        };
      });
    } catch (e) {
      console.warn('Could not fetch SO lines for partial invoice, will invoice full SO:', e);
    }
  }

  // SO→invoice via NetSuite's documented transform endpoint — the source id
  // rides in the URL path. The old `invoice?init=salesOrder&id=` form was
  // undocumented and the account's NetSuite upgrade started rejecting it
  // ("Invalid query parameter name 'id'. Use one of the following valid
  // query parameters: init, replace."), which broke vehicle invoicing.
  // ?replace=item goes on ONLY when line overrides are sent: replace makes
  // the sublist exactly what the body carries, so a full-SO invoice (empty
  // body) must omit it or the transform would wipe the inherited lines.
  const transformUrl = `${baseUrl}/services/rest/record/v1/salesOrder/${payload.salesOrderId}/!transform/invoice`
    + (lineOverrides && lineOverrides.length > 0 ? '?replace=item' : '');
  const { oauth, token } = createOAuth(config);
  const authHeader = getAuthHeader(oauth, token, { url: transformUrl, method: 'POST' });

  const body: any = {};
  if (payload.memo) {
    body.memo = payload.memo;
  }
  // Override the location the SO→invoice transform would otherwise inherit, so
  // the invoice books to the location our PO rules resolved (header-level, the
  // same field createDirectInvoice/createSalesOrder set).
  if (payload.locationId) {
    body.location = { id: payload.locationId };
  }
  if (lineOverrides && lineOverrides.length > 0) {
    body.item = { items: lineOverrides };
  }

  try {
    const response = await fetch(transformUrl, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
        'Prefer': 'respondAsync=false',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error('NetSuite create invoice error:', text);
      return { success: false, error: `NetSuite error (${response.status}): ${text}` };
    }

    const location = response.headers.get('Location');
    let invoiceId = '';

    if (location) {
      const match = location.match(/\/(\d+)$/);
      invoiceId = match?.[1] || '';
    }

    let invoiceNumber = '';
    try {
      const result = await response.json();
      invoiceId = invoiceId || result.id?.toString() || '';
      invoiceNumber = result.tranId || result.tranid || '';
    } catch {
      // 204 No Content
    }

    if (invoiceId && !invoiceNumber) {
      try {
        const lookup = await suiteqlQuery(`SELECT tranid FROM transaction WHERE id = ${invoiceId}`);
        invoiceNumber = lookup?.items?.[0]?.tranid || '';
      } catch {
        // Non-critical
      }
    }

    return {
      success: true,
      invoiceId,
      invoiceNumber,
    };
  } catch (e: any) {
    return { success: false, error: `Failed to create invoice: ${e.message}` };
  }
}

/**
 * Update the header Location on an existing NetSuite invoice.
 * PATCH /services/rest/record/v1/invoice/{id} with { location: { id } }.
 *
 * Used by the retroactive location backfill. NetSuite rejects edits to an
 * invoice in a closed/locked accounting period; that error is returned
 * verbatim so the caller can record it and move on rather than abort the run.
 */
export async function updateInvoiceLocation(
  invoiceId: string | number,
  locationId: string | number,
): Promise<{ success: boolean; error?: string }> {
  const config = getConfig();
  const baseUrl = getBaseUrl(config.accountId);
  const url = `${baseUrl}/services/rest/record/v1/invoice/${invoiceId}`;
  const { oauth, token } = createOAuth(config);
  const authHeader = getAuthHeader(oauth, token, { url, method: 'PATCH' });

  // Bound each PATCH so one slow/hung NetSuite call fails just this invoice
  // rather than stalling a whole backfill batch into a gateway timeout.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const response = await fetch(url, {
      method: 'PATCH',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
        'Prefer': 'respondAsync=false',
      },
      body: JSON.stringify({ location: { id: locationId.toString() } }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      // Surface NetSuite's own message — for a closed period it names the
      // period; for permissions it names the missing right.
      let detail = text.slice(0, 400);
      try {
        const parsed = JSON.parse(text);
        detail = parsed?.['o:errorDetails']?.[0]?.detail || parsed?.title || detail;
      } catch { /* keep raw text */ }
      return { success: false, error: `NetSuite ${response.status}: ${detail}` };
    }

    return { success: true };
  } catch (e: any) {
    const msg = e?.name === 'AbortError' ? 'NetSuite request timed out' : e?.message || 'Unknown error';
    return { success: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Recent customer payments + credit memos via the financials RESTlet — the
 * SuiteQL integration role cannot see CustPymt at all (see the RESTlet
 * header), so the RESTlet's own role answers instead. Requires the updated
 * scripts/netsuite-financials-restlet.js to be re-uploaded in NetSuite; an
 * old deployment ignores `action` and answers the balances shape, which is
 * detected and reported as a redeploy hint rather than an empty history.
 */
export async function getCustomerPaymentsFromRestlet(customerId: string, limit = 50): Promise<{
  success: boolean;
  transactions?: { id: string; tranid: string; date: string; type: string; amount: number; memo: string | null }[];
  error?: string;
}> {
  const restletUrl = process.env.NETSUITE_FINANCIALS_RESTLET_URL;
  if (!restletUrl) return { success: false, error: 'Financials RESTlet URL not configured' };
  if (!/^\d{1,15}$/.test(customerId)) return { success: false, error: 'Invalid customer id' };

  try {
    const result = await callRestlet(restletUrl, 'GET', {
      action: 'customerPayments',
      customerId,
      limit: String(Math.max(1, Math.min(limit, 200))),
    });
    if (!result?.success) {
      return { success: false, error: result?.error || 'RESTlet error' };
    }
    if (!Array.isArray(result.transactions)) {
      return { success: false, error: 'Payment history needs the updated financials RESTlet — re-upload scripts/netsuite-financials-restlet.js in NetSuite' };
    }
    return {
      success: true,
      transactions: result.transactions.map((t: any) => ({
        id: String(t.id),
        tranid: String(t.tranid || t.id),
        date: String(t.date || ''),
        type: String(t.type || ''),
        amount: Number(t.amount) || 0,
        memo: t.memo ? String(t.memo) : null,
      })),
    };
  } catch (e: any) {
    return { success: false, error: e?.message || 'RESTlet call failed' };
  }
}

/**
 * Fetch a transaction PDF from the NetSuite RESTlet.
 * Supports: salesOrder, invoice, estimate (matches the RESTlet's query
 * params — estimate requires the updated scripts/netsuite-pdf-restlet.js
 * to be redeployed in NetSuite).
 */
export async function getNetSuitePdf(
  type: 'salesOrder' | 'invoice' | 'estimate',
  recordId: string
): Promise<{
  success: boolean;
  pdfBase64?: string;
  filename?: string;
  error?: string;
}> {
  const restletUrl = process.env.NETSUITE_PDF_RESTLET_URL;
  if (!restletUrl) {
    return { success: false, error: 'PDF RESTlet URL not configured' };
  }

  try {
    const paramKey = type === 'invoice' ? 'invoiceId' : type === 'estimate' ? 'estimateId' : 'salesOrderId';
    const result = await callRestlet(restletUrl, 'GET', { [paramKey]: recordId });

    if (result?.success && result?.pdfBase64) {
      let pdf64 = result.pdfBase64;

      // Detect double-encoding: a valid PDF base64 starts with JVBERi0 (%PDF-).
      // If it starts with SlZCRVJp, it's been base64-encoded twice.
      if (pdf64.startsWith('SlZCRVJp')) {
        // Double-encoded — decode one layer
        pdf64 = Buffer.from(pdf64, 'base64').toString('utf-8');
      }

      const prefix = type === 'invoice' ? 'Invoice' : type === 'estimate' ? 'Quote' : 'SalesOrder';
      return {
        success: true,
        pdfBase64: pdf64,
        filename: result.filename || `${prefix}_${recordId}.pdf`,
      };
    }

    return { success: false, error: result?.error || 'Failed to generate PDF' };
  } catch (e: any) {
    return { success: false, error: `Error generating PDF: ${e.message}` };
  }
}

/**
 * Update an item's description in NetSuite via the item RESTlet.
 *
 * NetSuite is the source of truth for the parts catalog (the sync overwrites
 * description on every run), so a description edit only sticks if it's written
 * back to NetSuite. We use a RESTlet rather than the REST Record API because
 * updating via REST requires the exact item record-type endpoint, which we
 * don't store; the RESTlet resolves it from the internal id (see
 * scripts/netsuite-item-restlet.js).
 */
export async function updateItemDescription(
  internalId: string | number,
  description: string,
): Promise<{ success: boolean; recordType?: string; error?: string }> {
  const restletUrl = process.env.NETSUITE_ITEM_RESTLET_URL;
  if (!restletUrl) {
    return {
      success: false,
      error: 'Item RESTlet not configured. Set NETSUITE_ITEM_RESTLET_URL (deploy scripts/netsuite-item-restlet.js).',
    };
  }

  try {
    const result = await callRestlet(restletUrl, 'POST', undefined, {
      itemId: String(internalId),
      description,
    });
    if (result?.success) {
      return { success: true, recordType: result.recordType };
    }
    return { success: false, error: result?.error || 'NetSuite update failed' };
  } catch (e: any) {
    return { success: false, error: e?.message || 'NetSuite update failed' };
  }
}

/**
 * Fetch current GL account balances from NetSuite via the financials RESTlet
 * (scripts/netsuite-financials-restlet.js). SuiteQL can't read these for the
 * integration role (it only sees part of the ledger), so balances come from a
 * role-scoped account search that matches the Chart of Accounts. Returns a map
 * of account internal id → { balance, type, name }.
 */
export async function getAccountBalancesFromRestlet(
  accountIds: string[],
): Promise<{ success: boolean; balances?: Record<string, { balance: number; type: string; name: string }>; error?: string }> {
  const restletUrl = process.env.NETSUITE_FINANCIALS_RESTLET_URL;
  if (!restletUrl) {
    return { success: false, error: 'Financials RESTlet not configured. Set NETSUITE_FINANCIALS_RESTLET_URL (deploy scripts/netsuite-financials-restlet.js).' };
  }
  const ids = accountIds.filter(id => /^\d{1,18}$/.test(id));
  if (ids.length === 0) return { success: true, balances: {} };
  try {
    const result = await callRestlet(restletUrl, 'GET', { accounts: ids.join(',') });
    if (!result?.success) return { success: false, error: result?.error || 'NetSuite balance lookup failed' };
    const map: Record<string, { balance: number; type: string; name: string }> = {};
    for (const row of result.balances || []) {
      map[String(row.id)] = { balance: Number(row.balance) || 0, type: String(row.type || ''), name: String(row.name || '') };
    }
    return { success: true, balances: map };
  } catch (e: any) {
    return { success: false, error: e?.message || 'NetSuite balance lookup failed' };
  }
}

/**
 * Update editable fields on an item in NetSuite via the item RESTlet.
 *
 * NetSuite is the source of truth for the parts catalog (the sync overwrites
 * these fields on every run), so an edit only sticks if it's written back to
 * NetSuite. Send only the fields that changed. `fieldsSet` echoes the NetSuite
 * fields actually written, so the caller can confirm the edit landed (e.g.
 * detect a RESTlet deployment that predates a field and needs re-uploading).
 *
 * Requires the extended scripts/netsuite-item-restlet.js to be deployed.
 */
export async function updateItemFields(
  internalId: string | number,
  fields: {
    itemNumber?: string;
    description?: string;
    displayName?: string;
    salesPrice?: number;
    purchasePrice?: number;
  },
): Promise<{ success: boolean; recordType?: string; fieldsSet?: string[]; error?: string }> {
  const restletUrl = process.env.NETSUITE_ITEM_RESTLET_URL;
  if (!restletUrl) {
    return {
      success: false,
      error: 'Item RESTlet not configured. Set NETSUITE_ITEM_RESTLET_URL (deploy scripts/netsuite-item-restlet.js).',
    };
  }

  const payload: Record<string, unknown> = { itemId: String(internalId) };
  if (fields.itemNumber !== undefined) payload.itemNumber = fields.itemNumber;
  if (fields.description !== undefined) payload.description = fields.description;
  if (fields.displayName !== undefined) payload.displayName = fields.displayName;
  if (fields.salesPrice !== undefined) payload.salesPrice = fields.salesPrice;
  if (fields.purchasePrice !== undefined) payload.purchasePrice = fields.purchasePrice;

  try {
    const result = await callRestlet(restletUrl, 'POST', undefined, payload);
    if (result?.success) {
      return { success: true, recordType: result.recordType, fieldsSet: result.fieldsSet || [] };
    }
    return { success: false, error: result?.error || 'NetSuite update failed' };
  } catch (e: any) {
    return { success: false, error: e?.message || 'NetSuite update failed' };
  }
}
