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
