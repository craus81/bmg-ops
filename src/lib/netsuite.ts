/**
 * NetSuite REST API Client for Next.js
 * Uses OAuth 1.0a Token-Based Authentication for SuiteQL queries and RESTlet calls
 */

import OAuth from 'oauth-1.0a';
import CryptoJS from 'crypto-js';

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
      t.status,
      t.entity AS customer_id,
      c.companyname AS customer_name,
      t.memo,
      t.total,
      t.custbody_vin_number_ AS vin
    FROM transaction t
    LEFT JOIN customer c ON t.entity = c.id
    WHERE t.type = 'SalesOrd'
    AND (${statusConditions})
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
      error: `No open sales orders found for "${customerName}"`,
    };
  }

  // Get line items for each order
  const detailedOrders: SalesOrder[] = [];

  for (const so of items) {
    const order: SalesOrder = {
      id: so.id,
      sales_order_number: so.sales_order_number,
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
export async function findItems(partNumbers: string[]): Promise<Record<string, { id: string; name: string; displayName: string; description: string }>> {
  if (partNumbers.length === 0) return {};

  const conditions = partNumbers.map(p => `UPPER(i.itemid) = UPPER('${p.replace(/'/g, "''")}')`).join(' OR ');
  const query = `
    SELECT i.id, i.itemid, i.displayname, i.description
    FROM item i
    WHERE ${conditions}
  `;

  const result = await suiteqlQuery(query);
  const items = result?.items || [];
  const map: Record<string, { id: string; name: string; displayName: string; description: string }> = {};

  for (const item of items) {
    map[item.itemid?.toUpperCase()] = {
      id: item.id?.toString(),
      name: item.itemid,
      displayName: item.displayname || item.itemid,
      description: item.description || item.displayname || item.itemid,
    };
  }

  return map;
}

/**
 * Create a standalone Invoice in NetSuite (no SO required)
 * Used for direct invoicing of scanned vehicles without PO/SO flow
 */
export async function createDirectInvoice(payload: {
  customerId: string | number;
  locationId?: string | number;
  memo?: string;
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

  const items = payload.lineItems.map((li) => ({
    item: { id: li.itemId },
    quantity: li.quantity,
    rate: li.rate,
    ...(li.description ? { description: li.description } : {}),
  }));

  const body: any = {
    entity: { id: payload.customerId },
    item: { items },
    ...(payload.locationId ? { location: { id: payload.locationId } } : {}),
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

      lineOverrides = soLines
        .filter((line: any) => {
          const lineNum = parseInt(line.linesequencenumber);
          const installedQty = payload.installedQuantities![lineNum];
          return installedQty !== undefined && installedQty > 0;
        })
        .map((line: any) => {
          const lineNum = parseInt(line.linesequencenumber);
          return {
            item: { id: line.item },
            quantity: payload.installedQuantities![lineNum],
            rate: parseFloat(line.rate || '0'),
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

export async function getSalesOrderPdf(salesOrderId: string): Promise<{
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
    const result = await callRestlet(restletUrl, 'GET', { salesOrderId });

    if (result?.success && result?.pdfBase64) {
      return {
        success: true,
        pdfBase64: result.pdfBase64,
        filename: result.filename || `SalesOrder_${salesOrderId}.pdf`,
      };
    }

    return { success: false, error: result?.error || 'Failed to generate PDF' };
  } catch (e: any) {
    return { success: false, error: `Error generating PDF: ${e.message}` };
  }
}

export async function getInvoicePdf(invoiceId: string): Promise<{
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
    // Pass invoiceId — requires the updated RESTlet (scripts/netsuite-pdf-restlet.js)
    const result = await callRestlet(restletUrl, 'GET', { invoiceId });

    if (result?.success && result?.pdfBase64) {
      return {
        success: true,
        pdfBase64: result.pdfBase64,
        filename: result.filename || `Invoice_${invoiceId}.pdf`,
      };
    }

    return { success: false, error: result?.error || 'Failed to generate PDF' };
  } catch (e: any) {
    return { success: false, error: `Error generating PDF: ${e.message}` };
  }
}
