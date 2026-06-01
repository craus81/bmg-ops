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

export async function getOpenSalesOrdersByCustomer(customerName: string): Promise<{
  found: boolean;
  count: number;
  data: SalesOrder[] | null;
  error?: string;
}> {
  const searchTerm = customerName.trim().replace(/'/g, "''");
  if (!searchTerm) {
    return { found: false, count: 0, data: null, error: 'Customer name cannot be empty' };
  }

  const statusConditions = OPEN_STATUSES.map(s => `t.status = '${s}'`).join(' OR ');

  const query = `
    SELECT
      t.id,
      t.tranid AS sales_order_number,
      t.trandate,
      t.type,
      t.status,
      t.entity AS customer_id,
      c.companyname AS customer_name,
      t.memo,
      t.total,
      t.custbody_vin_number_ AS vin
    FROM transaction t
    LEFT JOIN customer c ON t.entity = c.id
    WHERE t.type IN ('SalesOrd', 'CustInvc', 'Estimate')
    AND (
      (t.type = 'SalesOrd' AND (${statusConditions}))
      OR (t.type = 'CustInvc' AND t.status IN ('A', 'B'))
      OR (t.type = 'Estimate' AND t.status IN ('A', 'B', 'E', 'X'))
    )
    AND (
      UPPER(c.companyname) LIKE UPPER('%${searchTerm}%')
      OR UPPER(c.entityid) LIKE UPPER('%${searchTerm}%')
    )
    ORDER BY c.companyname, t.trandate DESC
  `;

  const result = await suiteqlQuery(query);
  const items = result?.items || [];

  if (items.length === 0) {
    return {
      found: false,
      count: 0,
      data: null,
      error: `No sales orders, invoices, or estimates found for "${customerName}"`,
    };
  }

  // Get line items for each order
  const detailedOrders: SalesOrder[] = [];

  for (const so of items) {
    const typeLabel = so.type === 'CustInvc' ? 'Invoice' : so.type === 'Estimate' ? 'Estimate' : 'Sales Order';
    const order: SalesOrder = {
      id: so.id,
      sales_order_number: so.sales_order_number,
      record_type: typeLabel as SalesOrder['record_type'],
      date: so.trandate,
      vin: so.vin || null,
      status: so.status,
      customer_id: so.customer_id,
      customer_name: so.customer_name,
      memo: so.memo || null,
      total: so.total ? parseFloat(so.total) : null,
      line_items: [],
    };

    try {
      const linesQuery = `
        SELECT
          tl.linesequencenumber,
          tl.memo AS description,
          tl.quantity,
          tl.rate,
          tl.netamount,
          i.itemid AS item_name
        FROM transactionline tl
        LEFT JOIN item i ON tl.item = i.id
        WHERE tl.transaction = ${so.id}
        AND tl.mainline = 'F'
        AND tl.taxline = 'F'
        ORDER BY tl.linesequencenumber
      `;
      const linesResult = await suiteqlQuery(linesQuery);

      if (linesResult?.items) {
        order.line_items = linesResult.items.map((line: any) => ({
          line_number: line.linesequencenumber,
          item_name: line.item_name || null,
          description: line.description || null,
          quantity: Math.abs(parseFloat(line.quantity || '0')),
          rate: Math.abs(parseFloat(line.rate || '0')),
          amount: Math.abs(parseFloat(line.netamount || '0')),
        }));
      }
    } catch {
      // Line items fetch failed, continue with empty
    }

    detailedOrders.push(order);
  }

  return {
    found: true,
    count: detailedOrders.length,
    data: detailedOrders,
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
  };

  if (payload.email) body.email = payload.email;
  if (payload.phone) body.phone = payload.phone;
  if (payload.website) body.url = payload.website;

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
 * Sends a deliberately minimal field set (itemId + names + description).
 * If the account requires more (income account, tax schedule, subsidiary),
 * NetSuite's rejection message is returned verbatim so the caller can show it.
 */
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

  // Build line items for NetSuite
  const items = payload.lineItems.map((li) => ({
    item: { id: li.itemId },
    quantity: li.quantity,
    rate: li.rate,
    ...(li.description ? { description: li.description } : {}),
  }));

  const body: any = {
    entity: { id: payload.customerId },
    otherRefNum: payload.poNumber,
    item: { items },
    ...(payload.locationId ? { location: { id: payload.locationId } } : {}),
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

  const body: any = {
    entity: { id: payload.customerId },
    item: { items },
    ...(payload.locationId ? { location: { id: payload.locationId } } : {}),
    ...(payload.poNumber ? { otherRefNum: payload.poNumber } : {}),
    ...(payload.memo ? { memo: payload.memo } : {}),
    ...(payload.otherrefnum ? { otherrefnum: payload.otherrefnum } : {}),
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

    return { success: true, invoiceId, invoiceNumber };
  } catch (e: any) {
    return { success: false, error: `Failed to create invoice: ${e.message}` };
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
  memo?: string;
}): Promise<{
  success: boolean;
  invoiceId?: string;
  invoiceNumber?: string;
  error?: string;
}> {
  const config = getConfig();
  const baseUrl = getBaseUrl(config.accountId);

  // Step 1: Initialize an Invoice from a Sales Order
  // NetSuite REST API uses 'init' (not 'transform') to create from existing record
  const transformUrl = `${baseUrl}/services/rest/record/v1/invoice?init=salesOrder&id=${payload.salesOrderId}&replace=item`;
  const { oauth, token } = createOAuth(config);
  const authHeader = getAuthHeader(oauth, token, { url: transformUrl, method: 'POST' });

  // First, get the SO line items to build the invoice with installed quantities
  let lineOverrides: any[] | undefined;

  if (payload.installedQuantities && Object.keys(payload.installedQuantities).length > 0) {
    // Get SO line details first to map line numbers to items
    try {
      const linesQuery = `
        SELECT tl.linesequencenumber, tl.item, tl.quantity, tl.rate
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
          ...(rate > 0 ? { rate } : {}),
        };
      });
    } catch (e) {
      console.warn('Could not fetch SO lines for partial invoice, will invoice full SO:', e);
    }
  }

  const body: any = {};
  if (payload.memo) {
    body.memo = payload.memo;
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
 * Fetch a transaction PDF from the NetSuite RESTlet.
 * Supports: salesOrder, invoice (matches the RESTlet's query params).
 */
export async function getNetSuitePdf(
  type: 'salesOrder' | 'invoice',
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
    const paramKey = type === 'invoice' ? 'invoiceId' : 'salesOrderId';
    const result = await callRestlet(restletUrl, 'GET', { [paramKey]: recordId });

    if (result?.success && result?.pdfBase64) {
      let pdf64 = result.pdfBase64;

      // Detect double-encoding: a valid PDF base64 starts with JVBERi0 (%PDF-).
      // If it starts with SlZCRVJp, it's been base64-encoded twice.
      if (pdf64.startsWith('SlZCRVJp')) {
        // Double-encoded — decode one layer
        pdf64 = Buffer.from(pdf64, 'base64').toString('utf-8');
      }

      const prefix = type === 'invoice' ? 'Invoice' : 'SalesOrder';
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

/** @deprecated Use getNetSuitePdf('salesOrder', id) instead */
export async function getSalesOrderPdf(salesOrderId: string) {
  return getNetSuitePdf('salesOrder', salesOrderId);
}

/** @deprecated Use getNetSuitePdf('invoice', id) instead */
export async function getInvoicePdf(invoiceId: string) {
  return getNetSuitePdf('invoice', invoiceId);
}
