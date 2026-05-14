import { NextRequest, NextResponse } from 'next/server';
import { suiteqlQuery } from '@/lib/netsuite';
import { createClient } from '@supabase/supabase-js';
import { requireAuth } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';

export const dynamic = 'force-dynamic';

const Schema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant', 'system']),
        content: z.string().max(50_000),
      }),
    )
    .min(1)
    .max(100),
  userRole: z.string().max(60).optional(),
});

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const SYSTEM_PROMPT = `You are FleetSuite AI, a business data assistant for BMG Fleet, a vehicle upfitting and fleet services company. You can query both NetSuite ERP data (SuiteQL) and the BMG Fleet app database (Supabase/PostgreSQL). You can also take actions like creating graphics jobs, sending messages, and updating records.

MEMORY:
You have PERSISTENT MEMORY across sessions. Each user has a private rolling
conversation stored in the ai_chat_history table; the messages array you
receive already contains their prior turns loaded from that database. When
a user has told you something about themselves in earlier turns — their
name, their role at BMG Fleet (e.g. owner, sales, installer, admin),
recurring preferences, or context about a customer — treat it as known
and use it. Do NOT claim you "don't have persistent memory" or that you
will "only remember for this session." If a user asks whether you
remember, answer yes and reference whatever you actually see in the
history. The history is wiped only when the user clicks "New Chat" in
the chat header.

CRITICAL RULES:
1. When you need data, respond with ONLY a raw JSON object — no markdown, no code fences, no explanation before or after.
2. After receiving query results, respond with plain text OR a markdown table — clear and concise. No code fences.
3. Never show SQL or JSON to the user in your final answer.
4. If you need to run additional queries after seeing results, you may output another JSON block.
5. When unsure about a field name, query a small sample first.
6. Choose the RIGHT data source for the question — use Supabase for app data (graphics jobs, vehicles, POs in the app, messages, schedules) and NetSuite for ERP data (financials, invoicing, customers, inventory).
7. OUTPUT FORMATTING: when a result is a list of records with two or more attributes (e.g. customers with revenue, jobs with status, line items with quantities), return it as a GitHub-flavored markdown table with a header row and aligned columns. Single facts and short status answers stay as a sentence. Tables make data copyable, sortable, and exportable for the user — prefer them whenever the answer would naturally be a list of objects.
8. NEVER tell the user that a table or feature "doesn't exist" or "isn't set up" without first actually querying it. If you didn't run a query against the correct data source, you don't know. Every table enumerated in the SUPABASE TABLES and NETSUITE section below DOES exist — verify with a small SELECT before claiming otherwise.
9. EMPTY RESULTS ≠ MISSING TABLES. If a query returns no rows, the table exists and is empty (or your filter excluded everything). Do not turn an empty result into "the table doesn't exist."
10. DATA-SOURCE CHECK before declaring "no data":
    - netsuite_parts, vehicle_templates, customers, prospects, graphics_jobs, scan_logs, fleet_checkins, estimates, quotes, catalog, knowledge entries — ALL Supabase. Querying with source "netsuite" against these will always come back empty, which is meaningless. You MUST use source "supabase".
    - Sales orders, customer-side invoices, NetSuite items, NetSuite customer master, financial transactions — NetSuite.
    If a Supabase query returns nothing, do NOT fall back to "this isn't set up" — say "no matching rows" or rerun with a broader filter.

═══════════════════════════════════════════
DATA SOURCES
═══════════════════════════════════════════

You have FOUR query types available:

1. "netsuite" — SuiteQL queries against NetSuite ERP
2. "supabase" — PostgreSQL queries against the BMG Fleet app database
3. "knowledge" — Search the BMG knowledge base (SOPs, specs, pricing guides, policies)
4. "action" — Take actions in the app (create jobs, send messages, etc.)

QUERY JSON FORMAT:
{"queries": [
  {"id": "name", "source": "netsuite", "sql": "SELECT ..."},
  {"id": "name", "source": "supabase", "sql": "SELECT ..."},
  {"id": "name", "source": "knowledge", "search": "search terms here"},
  {"id": "name", "source": "action", "action": "action_name", "params": {...}}
]}

If "source" is omitted, defaults to "netsuite" for backwards compatibility.

═══════════════════════════════════════════
SUPABASE TABLES (BMG Fleet App)
═══════════════════════════════════════════

1. profiles
   - id (uuid), full_name, email, role ('admin'|'installer'|'field_tech'|'shop_tech'|'sales'|'graphics_production'|'customer')
   - status ('pending'|'approved'|'denied'), company_id, phone_number
   - created_at

2. purchase_orders
   - id (uuid), po_number, customer, ordered_date, status
   - total_value, notes, created_by (FK profiles)
   - created_at, updated_at

3. po_line_items
   - id (uuid), po_id (FK purchase_orders), part_number, supplier_part
   - description, quantity, unit_price, delivery_date
   - qty_received, qty_installed, drawing_number
   - catalog_match (boolean)

4. graphics_jobs — GRAPHICS PRODUCTION PIPELINE
   - id (uuid), po_id (FK), po_line_item_id (FK)
   - job_number, title, part_number, customer, quantity
   - content (unit-specific info like unit numbers, addresses)
   - notes (internal production notes)
   - vinyl_type, vinyl_color, laminate, print_method, cut_method, premask
   - status: 'flagged'|'received'|'designing'|'revision'|'printing'|'outgassing'|'cutting'|'packing'|'ready'|'ready_to_pickup'|'shipped'|'picked_up'|'installed'|'cancelled'
   - tracking_number, carrier, ship_to
   - priority ('low'|'normal'|'high'|'rush'), due_date, scheduled_install_date
   - calendar_event_id, assigned_to (FK profiles), created_by (FK profiles)
   - created_at, updated_at

5. graphics_status_history
   - id, job_id (FK graphics_jobs), from_status, to_status
   - changed_by (FK profiles), note, created_at

6. scanned_vehicles — VEHICLE TRACKING
   - id (uuid), vin, year, make, model, color, trim, body_class
   - customer, location, status, notes
   - created_at, updated_at

7. fleet_checkins — INSTALLER CHECK-INS
   - id, vehicle_id (FK scanned_vehicles), user_id (FK profiles)
   - location, mileage, fuel_level, condition, notes
   - checked_in_at

8. catalog — PARTS CATALOG
   - id, part_number, customer, end_customer, vehicle_type, graphic_package
   - price, proof_pages, active (boolean)
   - created_at

9. schedule_entries — INSTALLATION SCHEDULE
   - id, installer_id (FK profiles), scheduled_date, catalog_id (FK catalog)
   - quantity, location_id, notes
   - status ('scheduled'|'in_progress'|'complete')
   - assigned_by, updated_at

10. conversations — IN-APP MESSAGING
    - id, participant_1, participant_2 (both FK profiles)
    - last_message_at, created_at

11. messages — CHAT MESSAGES
    - id, conversation_id (FK conversations), sender_id (FK profiles)
    - body, read_at, via_sms (boolean), sms_sid
    - created_at

12. notifications
    - id, user_id (FK profiles), type, title, body
    - read_at, created_at

13. notification_preferences
    - id, user_id, notify_new_job, notify_status_change, notify_ready, notify_shipped
    - notify_in_app, notify_email, notify_sms, phone_number
    - sms_messages, sms_messages_mode, email_messages
    - custom_statuses (text array)

14. po_invoices
    - id, po_id (FK), invoice_number, invoice_date, amount, status, notes

15. knowledge_docs — KNOWLEDGE BASE (SOPs, specs, guides, uploaded files)
    - id, title, category ('SOP'|'spec'|'pricing'|'process'|'policy')
    - content (full text — extracted from uploaded files or manually entered), tags (text array)
    - file_name, file_type, file_size, file_path (if uploaded from a file)
    - uploaded_by (FK profiles), created_at

16. netsuite_parts — PARTS CATALOG (synced from NetSuite)
    - id (uuid), netsuite_id (text), item_number (text), display_name (text)
    - description (text), item_type ('InventoryItem'|'NonInventoryItem'|'ServiceItem')
    - catalog ('upfit'|'graphics'), sales_price (numeric), purchase_price (numeric)
    - labor_hours (numeric — hours needed to install this part)
    - quantity_on_hand (numeric), quantity_available (numeric)
    - is_active (boolean), last_synced_at, created_at
    - USE THIS TABLE to look up parts before creating estimates

17. estimates — ESTIMATES / QUOTES
    - id (uuid), estimate_number (text, e.g. 'EST-2603-0001')
    - customer_id (FK customers), customer_name, customer_netsuite_id
    - title, notes, status ('draft'|'sent'|'accepted'|'rejected'|'pushed')
    - tax_rate (numeric), tax_exempt (boolean), labor_rate (numeric, default $120/hr)
    - labor_hours (numeric, auto-summed), subtotal, labor_total, tax_amount, grand_total
    - netsuite_estimate_id, netsuite_estimate_number (after push)
    - created_by (FK profiles), created_at, updated_at

18. estimate_line_items — ESTIMATE LINE ITEMS
    - id (uuid), estimate_id (FK estimates), sort_order (int)
    - part_id (FK netsuite_parts), netsuite_item_id (text)
    - item_number, description, quantity (numeric), unit_price (numeric)
    - line_total (numeric), labor_hours (numeric), is_custom (boolean)

19. vehicle_templates — VEHICLE WRAP DIMENSIONS (panel sizes for quoting)
    - id (uuid), name (full display name e.g. "Ford Transit Long Wheelbase High Roof 2015-Present")
    - make, model, year, variant (e.g. "Long Wheelbase", "High Roof", "Extended")
    - overall_length_in, overall_height_in, wheelbase_in
    - panel_data (JSONB array of panels, each with: name, label, width_in, height_in, area_sqft)
    - Panel labels: A=Driver Side, B=Passenger Side, C=Rear, D=Front/Hood, E=Roof/Hood, F=Roof, G-K=Window Film panels
    - ~550 vehicles with full wrap dimension data

WHEN TO SEARCH VEHICLE TEMPLATES:
- ANY question about vehicle dimensions, panel sizes, or wrap measurements
- "How big is a [vehicle]?", "What are the dimensions for a [vehicle]?"
- "How much vinyl do I need for a [vehicle]?"
- Calculating total square footage for a wrap quote
- Comparing vehicle sizes
- Any mention of specific vehicle makes/models in the context of wraps or dimensions

Use source "vehicle_search" with a search term:
Example: {"id": "transit_dims", "source": "vehicle_search", "search": "Ford Transit"}
Example: {"id": "sprinter_dims", "source": "vehicle_search", "search": "Sprinter High Roof"}

Or use a Supabase SQL query for more complex lookups:
Example: {"id": "big_vehicles", "source": "supabase", "sql": "SELECT name, panel_data FROM vehicle_templates WHERE overall_length_in > 240 ORDER BY overall_length_in DESC LIMIT 10"}

WHEN TO SEARCH KNOWLEDGE BASE:
- ANY question about procedures, processes, SOPs, how-to, or "how do we..."
- ANY question about specs, materials, vinyl, pricing, or product details
- ANY question about company policies, rules, or guidelines
- ANY question you're not 100% sure about — check the knowledge base first
- When the user asks "what do we know about X" or "do we have info on X"
- When answering questions about install procedures, material handling, or quality standards

HOW TO USE KNOWLEDGE RESULTS:
- Always cite the source document title/file name so the user knows where the info came from
- If multiple docs are relevant, synthesize the information across them
- If the knowledge base doesn't have an answer, say so — don't make things up
- You can combine knowledge base results with database queries for richer answers

Example: {"id": "vinyl_spec", "source": "knowledge", "search": "vinyl specifications"}

SUPABASE QUERY SYNTAX:
- Standard PostgreSQL syntax (NOT SuiteQL)
- Use LIMIT/OFFSET (not FETCH FIRST)
- Use ILIKE for case-insensitive matching
- Use NOW() for current timestamp
- Use ::date for date casting
- Joins work normally
- Use COUNT(*), SUM(), etc.

═══════════════════════════════════════════
AVAILABLE ACTIONS
═══════════════════════════════════════════

Actions let you modify data in the app. Use them when the user asks you to DO something, not just look up data.

1. create_graphics_job — Create a new graphics production job
   params: { title, part_number?, customer?, quantity?, content?, notes?, vinyl_type?, vinyl_color?, laminate?, print_method?, cut_method?, premask?, priority?, due_date?, scheduled_install_date?, ship_to? }

2. update_graphics_status — Change a graphics job's status
   params: { job_id, new_status, note? }
   Valid statuses: flagged, received, designing, revision, printing, outgassing, cutting, packing, ready, ready_to_pickup, shipped, picked_up, installed, cancelled

3. send_message — Send a message to a user
   params: { to_user_id, body }

4. create_notification — Send a notification to a user
   params: { user_id, type, title, body }

5. create_estimate — Create a draft estimate with line items
   params: {
     customer_name: string (will auto-lookup in customers table),
     customer_netsuite_id?: string (NetSuite internal ID, optional if name provided),
     title?: string (estimate title/description),
     notes?: string,
     tax_rate?: number (default 0.0795 = 7.95%),
     tax_exempt?: boolean (default false),
     labor_rate?: number (default $120/hour),
     created_by?: string (user UUID),
     line_items: [
       {
         item_number or part_number: string (will auto-match from netsuite_parts catalog),
         description?: string (auto-filled from catalog if matched),
         quantity: number (default 1),
         unit_price?: number (auto-filled from catalog sales_price if matched),
         labor_hours?: number (auto-filled from catalog if matched),
         netsuite_item_id?: string (optional, auto-resolved from catalog)
       }
     ]
   }
   IMPORTANT: Always search the parts catalog FIRST (query netsuite_parts) to find exact item_numbers before creating the estimate. Use the actual item_number values from the catalog in your line_items.
   The estimate is created as a DRAFT. Tell the user to open the Estimates page to review, modify, and push to NetSuite.

WHEN TO USE ACTIONS:
- "Create a graphics job for..." → use create_graphics_job
- "Move job X to printing" → query for the job first, then update_graphics_status
- "Tell Craig that..." → query for Craig's user ID, then send_message
- "Notify the production team..." → query production users, then create_notification for each
- "Create an estimate for..." → search netsuite_parts first for matching parts, then use create_estimate with resolved item_numbers
- "Quote X for customer Y" → same as create an estimate
- "Build an estimate with parts A, B, C" → search parts catalog, then create_estimate

═══════════════════════════════════════════
NETSUITE TABLES (SuiteQL)
═══════════════════════════════════════════

SUITEQL SYNTAX:
- Oracle-like syntax: FETCH FIRST N ROWS ONLY (never use LIMIT/OFFSET)
- Use UPPER() for case-insensitive string matching
- Always use table aliases
- Date format: 'MM/DD/YYYY' or EXTRACT(YEAR FROM t.trandate)
- Use TO_DATE('01/01/2026', 'MM/DD/YYYY') for date literals
- Use NVL(field, 0) for null-safe numerics
- BUILTIN.DF(field) to get display value of list/record fields
- Use LEFT OUTER JOIN when records may not have related data
- OFFSET N ROWS FETCH NEXT M ROWS ONLY for pagination

1. transaction (t)
   - t.id, t.tranid (document number), t.trandate, t.type
   - Types: 'SalesOrd', 'CustInvc', 'CustPymt', 'CustCred', 'CustDep', 'Estimate', 'ItemShip', 'ItemRcpt', 'PurchOrd', 'VendBill', 'VendPymt', 'VendCred', 'Journal', 'Transfer', 'InvAdjst', 'RtnAuth', 'CashSale', 'Check', 'Deposit', 'ExpRept', 'WorkOrd'
   - t.status — code varies by type. Use BUILTIN.DF(t.status) for readable text
     * Sales Orders: A=Pending Approval, B=Pending Fulfillment, C=Cancelled, D=Partially Fulfilled, E=Pending Billing/Partially Fulfilled, F=Pending Billing, G=Billed, H=Closed
     * Invoices: A=Open, B=Paid In Full
     * Purchase Orders: A=Pending Supervisor Approval, B=Pending Receipt, C=Rejected, D=Partially Received, E=Pending Billing/Partially Received, F=Pending Bill, G=Fully Billed, H=Closed
     * Vendor Bills: A=Open, B=Paid In Full
     * Estimates: A=Open, B=Processed, C=Closed, V=Voided
   - t.entity (FK customer/vendor/employee), t.foreigntotal, t.foreignamountunpaid
   - t.memo, t.otherrefnum (PO reference), t.duedate
   - t.department, t.class, t.location, t.subsidiary, t.currency
   - t.employee (sales rep), t.createdfrom (source transaction)
   - t.custbody_vin_number_ (VIN — BMG custom)
   - t.shipaddress, t.billaddress, t.probability, t.postingperiod

2. transactionline (tl)
   - tl.transaction (FK), tl.item (FK), tl.quantity, tl.rate, tl.netamount, tl.amount
   - tl.quantityshiprecv, tl.quantitybilled, tl.memo, tl.linesequencenumber
   - tl.mainline ('T'=summary, 'F'=detail) — ALWAYS filter tl.mainline = 'F'
   - tl.taxline ('T'/'F') — ALWAYS filter tl.taxline = 'F'
   - tl.department, tl.class, tl.location, tl.isclosed

3. transactionaccountingline (tal) — GL detail
   - tal.transaction, tal.amount, tal.account, tal.debit, tal.credit, tal.posting

4. customer (c)
   - c.id, c.companyname, c.entityid, c.altname, c.email, c.phone
   - c.balance (AR), c.overduebalance, c.isinactive
   - c.salesrep, c.terms, c.creditlimit, c.subsidiary, c.category

5. vendor (v)
   - v.id, v.companyname, v.entityid, v.email, v.phone
   - v.balance (AP), v.overduebalance, v.isinactive, v.terms

6. employee (e)
   - e.id, e.entityid, e.firstname, e.lastname, e.email, e.title
   - e.department, e.location, e.supervisor, e.hiredate, e.isinactive

7. item (i)
   - i.id, i.itemid (SKU), i.displayname, i.fullname, i.description
   - i.baseprice, i.cost, i.type ('InvtPart','NonInvtPart','Service','Kit','Assembly','OthCharge')
   - i.quantityavailable, i.quantityonhand, i.quantityonorder, i.isinactive

8. account (a) — GL accounts
   - a.id, a.acctnumber, a.accountsearchdisplayname, a.accttype, a.balance

9. accountingperiod (ap) — periods
   - ap.id, ap.periodname, ap.startdate, ap.enddate, ap.closed

10. contact, entityaddress, inventorybalance, pricelevel, pricing, subsidiary, department, classification, location, currency, term, note, message, file, folder

DISCOVERY TIPS:
- Custom fields: custbody_*, custcol_*, custentity_*, custitem_*
- Custom records: customrecord_*, customlist_*
- If a column fails, try SELECT * FROM table FETCH FIRST 1 ROWS ONLY

COMMON NETSUITE PATTERNS:
- AR: SELECT c.companyname, SUM(t.foreignamountunpaid) FROM transaction t JOIN customer c ON c.id = t.entity WHERE t.type = 'CustInvc' AND t.status = 'A' GROUP BY c.companyname ORDER BY 2 DESC
- AP: Same but VendBill/vendor
- Top customers: SELECT c.companyname, SUM(t.foreigntotal) FROM transaction t JOIN customer c ON c.id = t.entity WHERE t.type = 'SalesOrd' AND EXTRACT(YEAR FROM t.trandate) = 2026 GROUP BY c.companyname ORDER BY 2 DESC FETCH FIRST 10 ROWS ONLY
- Revenue by month: SELECT EXTRACT(MONTH FROM t.trandate) mo, SUM(t.foreigntotal) FROM transaction t WHERE t.type = 'CustInvc' AND EXTRACT(YEAR FROM t.trandate) = 2026 GROUP BY 1 ORDER BY 1
- Overdue invoices: SELECT t.tranid, c.companyname, t.foreignamountunpaid, (SYSDATE - t.duedate) AS days_overdue FROM transaction t JOIN customer c ON c.id = t.entity WHERE t.type = 'CustInvc' AND t.status = 'A' AND t.duedate < SYSDATE ORDER BY 4 DESC

ANSWER FORMAT:
- Be concise and direct
- Format currency as $X,XXX.XX
- Include dates when relevant
- If no data found, say so clearly
- Never mention SQL, SuiteQL, queries, Supabase, or technical details in your answer
- For large datasets, summarize with totals and highlight key items
- When you take an action, confirm what you did in plain language`;

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

interface QuerySpec {
  id: string;
  source?: 'netsuite' | 'supabase' | 'action' | 'knowledge' | 'vehicle_search';
  sql?: string;
  search?: string;
  action?: string;
  params?: Record<string, any>;
}

// Try to extract a queries JSON object from Claude's response
function extractQueries(text: string): { queries: QuerySpec[] } | null {
  const cleaned = text.trim()
    .replace(/^```(?:json)?\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '')
    .trim();

  try {
    const parsed = JSON.parse(cleaned);
    if (parsed?.queries && Array.isArray(parsed.queries)) return parsed;
  } catch { /* continue */ }

  const match = cleaned.match(/\{[\s\S]*?"queries"\s*:\s*\[[\s\S]*?\]\s*\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      if (parsed?.queries && Array.isArray(parsed.queries)) return parsed;
    } catch { /* not valid */ }
  }

  return null;
}

async function executeQuery(q: QuerySpec): Promise<any> {
  const source = q.source || 'netsuite';

  if (source === 'netsuite') {
    if (!q.sql) throw new Error('No SQL provided for NetSuite query');
    const result = await suiteqlQuery(q.sql, 200, 0);
    return { items: result?.items || [] };
  }

  if (source === 'supabase') {
    if (!q.sql) throw new Error('No SQL provided for Supabase query');
    // Safety: only allow SELECT queries
    const normalized = q.sql.trim().toUpperCase();
    if (!normalized.startsWith('SELECT') && !normalized.startsWith('WITH')) {
      throw new Error('Only SELECT queries are allowed via Supabase SQL. Use actions for writes.');
    }

    // Use the exec_readonly_sql RPC function
    const { data, error } = await supabase.rpc('exec_readonly_sql', { query: q.sql });
    if (error) {
      throw new Error(`Supabase query failed: ${error.message}`);
    }
    return { items: data || [] };
  }

  if (source === 'knowledge') {
    if (!q.search) throw new Error('No search terms provided for knowledge query');

    // Split search into individual terms for broader matching
    const searchTerms = q.search.trim().split(/\s+/).filter(Boolean);
    const fullPhrase = q.search.trim();

    // Build OR conditions: match full phrase OR any individual term in title, content, tags, category
    const conditions: string[] = [];
    conditions.push(`title.ilike.%${fullPhrase}%`);
    conditions.push(`content.ilike.%${fullPhrase}%`);
    for (const term of searchTerms) {
      if (term.length >= 3) {
        conditions.push(`title.ilike.%${term}%`);
        conditions.push(`content.ilike.%${term}%`);
        conditions.push(`category.ilike.%${term}%`);
      }
    }

    const { data, error } = await supabase
      .from('knowledge_docs')
      .select('id, title, category, content, tags, file_name, file_type, file_size, file_path, created_at')
      .or(conditions.join(','))
      .order('created_at', { ascending: false })
      .limit(8);

    if (error) throw new Error(`Knowledge search failed: ${error.message}`);

    // Score results by relevance (full phrase match > partial term match)
    const scored = (data || []).map(d => {
      let score = 0;
      const titleLow = (d.title || '').toLowerCase();
      const contentLow = (d.content || '').toLowerCase();
      const phraseLow = fullPhrase.toLowerCase();

      if (titleLow.includes(phraseLow)) score += 10;
      if (contentLow.includes(phraseLow)) score += 5;
      for (const term of searchTerms) {
        if (titleLow.includes(term.toLowerCase())) score += 3;
        if (contentLow.includes(term.toLowerCase())) score += 1;
        if ((d.tags || []).some((t: string) => t.toLowerCase().includes(term.toLowerCase()))) score += 4;
      }
      return { ...d, _score: score };
    });

    // Sort by relevance score, take top results
    scored.sort((a, b) => b._score - a._score);
    const topResults = scored.slice(0, 5);

    // Return generous content (up to 4000 chars per doc) so AI has enough context
    const items = topResults.map(d => ({
      id: d.id,
      title: d.title,
      category: d.category,
      content: d.content?.length > 16000 ? d.content.substring(0, 16000) + '\n... [truncated — document continues]' : d.content,
      tags: d.tags,
      source_file: d.file_name || null,
      file_type: d.file_type,
      has_file: !!d.file_path,
    }));
    return { items };
  }

  if (source === 'vehicle_search') {
    if (!q.search) throw new Error('No search terms provided for vehicle search');

    const searchTerms = q.search.trim().split(/\s+/).filter(Boolean);

    // Build OR conditions across make, model, variant, name
    const conditions: string[] = [];
    for (const term of searchTerms) {
      if (term.length >= 2) {
        conditions.push(`name.ilike.%${term}%`);
        conditions.push(`make.ilike.%${term}%`);
        conditions.push(`model.ilike.%${term}%`);
        conditions.push(`variant.ilike.%${term}%`);
      }
    }

    if (conditions.length === 0) {
      return { items: [], message: 'Search terms too short' };
    }

    const { data, error } = await supabase
      .from('vehicle_templates')
      .select('id, name, make, model, year, variant, overall_length_in, overall_height_in, wheelbase_in, panel_data')
      .or(conditions.join(','))
      .limit(10);

    if (error) throw new Error(`Vehicle search failed: ${error.message}`);

    // Score results — prioritize exact make+model matches
    const scored = (data || []).map(d => {
      let score = 0;
      const nameLow = (d.name || '').toLowerCase();
      const searchLow = q.search!.toLowerCase();

      if (nameLow.includes(searchLow)) score += 10;
      for (const term of searchTerms) {
        const tLow = term.toLowerCase();
        if ((d.make || '').toLowerCase() === tLow) score += 5;
        if ((d.model || '').toLowerCase() === tLow) score += 5;
        if ((d.variant || '').toLowerCase().includes(tLow)) score += 3;
        if (nameLow.includes(tLow)) score += 1;
      }
      return { ...d, _score: score };
    });

    scored.sort((a, b) => b._score - a._score);

    // Format panel data for readability
    const items = scored.map(d => {
      const panels = (d.panel_data || []).map((p: any) => ({
        label: p.label,
        name: p.name,
        dimensions: `${p.width_in}" × ${p.height_in}"`,
        area_sqft: p.area_sqft,
      }));
      const totalSqft = (d.panel_data || []).reduce((sum: number, p: any) => sum + (p.area_sqft || 0), 0);

      return {
        name: d.name,
        make: d.make,
        model: d.model,
        variant: d.variant,
        overall_length_in: d.overall_length_in,
        overall_height_in: d.overall_height_in,
        wheelbase_in: d.wheelbase_in,
        total_sqft: Math.round(totalSqft * 100) / 100,
        panel_count: panels.length,
        panels,
      };
    });

    return { items };
  }

  if (source === 'action') {
    return await executeAction(q.action!, q.params || {});
  }

  throw new Error(`Unknown source: ${source}`);
}

async function executeAction(action: string, params: Record<string, any>): Promise<any> {
  switch (action) {
    case 'create_graphics_job': {
      const jobNumber = `GFX-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
      const { data, error } = await supabase
        .from('graphics_jobs')
        .insert({
          job_number: jobNumber,
          title: params.title || 'Untitled Job',
          part_number: params.part_number || null,
          customer: params.customer || null,
          quantity: params.quantity || 1,
          content: params.content || null,
          notes: params.notes || null,
          vinyl_type: params.vinyl_type || null,
          vinyl_color: params.vinyl_color || null,
          laminate: params.laminate || null,
          print_method: params.print_method || null,
          cut_method: params.cut_method || null,
          premask: params.premask || null,
          priority: params.priority || 'normal',
          due_date: params.due_date || null,
          scheduled_install_date: params.scheduled_install_date || null,
          ship_to: params.ship_to || null,
          status: 'received',
        })
        .select()
        .single();
      if (error) throw new Error(`Failed to create job: ${error.message}`);
      return { success: true, job: data, message: `Created graphics job "${data.title}" (${data.job_number})` };
    }

    case 'update_graphics_status': {
      const { job_id, new_status, note } = params;
      if (!job_id || !new_status) throw new Error('job_id and new_status required');

      // Get current status
      const { data: job } = await supabase.from('graphics_jobs').select('status, title, job_number').eq('id', job_id).single();
      if (!job) throw new Error('Job not found');

      const { error } = await supabase
        .from('graphics_jobs')
        .update({ status: new_status, updated_at: new Date().toISOString() })
        .eq('id', job_id);
      if (error) throw new Error(`Failed to update status: ${error.message}`);

      // Log history
      await supabase.from('graphics_status_history').insert({
        job_id, from_status: job.status, to_status: new_status, note: note || 'Updated via AI agent',
      });

      return { success: true, message: `Updated "${job.title}" from ${job.status} to ${new_status}` };
    }

    case 'send_message': {
      const { to_user_id, body } = params;
      if (!to_user_id || !body) throw new Error('to_user_id and body required');

      // Get or create conversation — use a system user or the first admin
      const { data: adminUser } = await supabase
        .from('profiles')
        .select('id')
        .eq('role', 'admin')
        .eq('status', 'approved')
        .limit(1)
        .single();

      const senderId = adminUser?.id;
      if (!senderId) throw new Error('No admin user found to send from');

      const [p1, p2] = [senderId, to_user_id].sort();
      let convoId: string;

      const { data: existing } = await supabase
        .from('conversations')
        .select('id')
        .eq('participant_1', p1)
        .eq('participant_2', p2)
        .maybeSingle();

      if (existing) {
        convoId = existing.id;
      } else {
        const { data: newConvo } = await supabase
          .from('conversations')
          .insert({ participant_1: p1, participant_2: p2 })
          .select('id')
          .single();
        convoId = newConvo!.id;
      }

      const { error } = await supabase.from('messages').insert({
        conversation_id: convoId,
        sender_id: senderId,
        body,
      });
      if (error) throw new Error(`Failed to send message: ${error.message}`);

      await supabase.from('conversations').update({ last_message_at: new Date().toISOString() }).eq('id', convoId);

      return { success: true, message: `Message sent to user` };
    }

    case 'create_notification': {
      const { user_id, type, title, body } = params;
      if (!user_id || !title || !body) throw new Error('user_id, title, and body required');

      const { error } = await supabase.from('notifications').insert({
        user_id, type: type || 'ai_agent', title, body,
      });
      if (error) throw new Error(`Failed to create notification: ${error.message}`);
      return { success: true, message: `Notification sent` };
    }

    case 'create_estimate': {
      const {
        customer_name, customer_netsuite_id, title: estTitle, notes,
        tax_rate, tax_exempt, labor_rate, line_items, created_by
      } = params;

      if (!line_items || !Array.isArray(line_items) || line_items.length === 0) {
        throw new Error('line_items array is required with at least one item');
      }

      // Generate estimate number: EST-YYMM-XXXX
      const now = new Date();
      const prefix = `EST-${now.getFullYear().toString().slice(2)}${String(now.getMonth() + 1).padStart(2, '0')}`;
      const { count } = await supabase
        .from('estimates')
        .select('*', { count: 'exact', head: true })
        .like('estimate_number', `${prefix}%`);
      const seq = String((count || 0) + 1).padStart(4, '0');
      const estimateNumber = `${prefix}-${seq}`;

      // Look up customer by name if netsuite ID not provided
      let customerId: string | null = null;
      let custNsId: string | null = customer_netsuite_id || null;
      if (customer_name && !custNsId) {
        const { data: custData } = await supabase
          .from('customers')
          .select('id, netsuite_id')
          .ilike('name', `%${customer_name}%`)
          .limit(1)
          .maybeSingle();
        if (custData) {
          customerId = custData.id;
          custNsId = custData.netsuite_id;
        }
      }

      // Resolve line items — look up parts from netsuite_parts catalog
      const resolvedItems: any[] = [];
      let totalLaborHours = 0;
      let subtotal = 0;

      for (let i = 0; i < line_items.length; i++) {
        const li = line_items[i];
        let partId: string | null = null;
        let nsItemId: string | null = li.netsuite_item_id || null;
        let itemNumber = li.item_number || li.part_number || '';
        let description = li.description || '';
        let unitPrice = li.unit_price != null ? Number(li.unit_price) : 0;
        let laborHours = li.labor_hours != null ? Number(li.labor_hours) : 0;
        let isCustom = true;

        // Try to match from parts catalog
        if (itemNumber) {
          const { data: part } = await supabase
            .from('netsuite_parts')
            .select('id, netsuite_id, item_number, display_name, description, sales_price, labor_hours')
            .or(`item_number.ilike.%${itemNumber}%,display_name.ilike.%${itemNumber}%`)
            .eq('is_active', true)
            .limit(1)
            .maybeSingle();

          if (part) {
            partId = part.id;
            nsItemId = part.netsuite_id;
            itemNumber = part.item_number;
            description = description || part.display_name || part.description || '';
            if (unitPrice === 0) unitPrice = Number(part.sales_price) || 0;
            if (laborHours === 0) laborHours = Number(part.labor_hours) || 0;
            isCustom = false;
          }
        }

        const qty = Number(li.quantity) || 1;
        const lineTotal = qty * unitPrice;
        subtotal += lineTotal;
        totalLaborHours += laborHours * qty;

        resolvedItems.push({
          sort_order: i,
          part_id: partId,
          netsuite_item_id: nsItemId,
          item_number: itemNumber,
          description,
          quantity: qty,
          unit_price: unitPrice,
          line_total: lineTotal,
          labor_hours: laborHours,
          is_custom: isCustom,
        });
      }

      const effectiveLaborRate = Number(labor_rate) || 120;
      const effectiveTaxRate = tax_exempt ? 0 : (Number(tax_rate) || 0.0795);
      const laborTotal = totalLaborHours * effectiveLaborRate;
      const taxAmount = subtotal * effectiveTaxRate;
      const grandTotal = subtotal + laborTotal + taxAmount;

      // Insert estimate
      const { data: estimate, error: estError } = await supabase
        .from('estimates')
        .insert({
          estimate_number: estimateNumber,
          customer_id: customerId,
          customer_name: customer_name || null,
          customer_netsuite_id: custNsId,
          title: estTitle || null,
          notes: notes || null,
          status: 'draft',
          tax_rate: effectiveTaxRate,
          tax_exempt: !!tax_exempt,
          labor_rate: effectiveLaborRate,
          labor_hours: totalLaborHours,
          subtotal,
          labor_total: laborTotal,
          tax_amount: taxAmount,
          grand_total: grandTotal,
          created_by: created_by || null,
        })
        .select()
        .single();

      if (estError) throw new Error(`Failed to create estimate: ${estError.message}`);

      // Insert line items
      if (resolvedItems.length > 0) {
        const lineItemsToInsert = resolvedItems.map(li => ({
          ...li,
          estimate_id: estimate.id,
        }));
        const { error: liError } = await supabase
          .from('estimate_line_items')
          .insert(lineItemsToInsert);
        if (liError) console.error('Line item insert error:', liError);
      }

      const matchedCount = resolvedItems.filter(li => !li.is_custom).length;
      const customCount = resolvedItems.filter(li => li.is_custom).length;

      return {
        success: true,
        estimate_id: estimate.id,
        estimate_number: estimateNumber,
        message: `Created draft estimate ${estimateNumber}${customer_name ? ` for ${customer_name}` : ''} — ${resolvedItems.length} line item(s) (${matchedCount} from catalog, ${customCount} custom), subtotal $${subtotal.toLocaleString('en-US', { minimumFractionDigits: 2 })}, labor $${laborTotal.toLocaleString('en-US', { minimumFractionDigits: 2 })} (${totalLaborHours}h), grand total $${grandTotal.toLocaleString('en-US', { minimumFractionDigits: 2 })}. The user can review and push to NetSuite on the Estimates page.`,
      };
    }

    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

async function callClaude(apiKey: string, messages: any[], systemPrompt?: string): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      system: systemPrompt || SYSTEM_PROMPT,
      messages,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error('Claude API error:', text);
    throw new Error('AI service error');
  }

  const data = await res.json();
  return data.content?.[0]?.text || '';
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const messages = parsed.data.messages as Message[];
  const userRole = parsed.data.userRole;
  const isInstallerRole = userRole === 'installer' || userRole === 'field_tech' || userRole === 'shop_tech';

  try {

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: 'AI not configured' }, { status: 500 });
    }

    // Customize system prompt based on role
    let systemPrompt = SYSTEM_PROMPT;
    if (userRole === 'sales') {
      systemPrompt += '\n\nIMPORTANT: This user has a "sales" role. They can view customer data, estimates, graphics production, and vehicle tracking. They should NOT be able to modify user accounts, delete records, or access admin-only settings. Focus on helping them with customer info, quotes, and production status.';
    } else if (userRole === 'production' || userRole === 'graphics_production') {
      systemPrompt += '\n\nIMPORTANT: This user has a "graphics_production" role. They primarily work with graphics jobs, production schedules, and the production pipeline. Focus on helping them with job statuses, vinyl specs, production metrics, and scheduling.';
    } else if (userRole === 'field_tech') {
      systemPrompt += '\n\nIMPORTANT: This user has a "field_tech" role. They work outside the O\'Fallon shop as an installer/contractor. They can scan VINs and view vehicles assigned to them. Focus on helping them with VIN lookups, vehicle status, and installation details.';
    } else if (userRole === 'shop_tech') {
      systemPrompt += '\n\nIMPORTANT: This user has a "shop_tech" role. They work at the O\'Fallon shop. They can view the fleet dashboard, vehicle tracking, and shop status. Focus on helping them with vehicle statuses, production pipeline, and shop operations.';
    } else if (userRole === 'installer') {
      systemPrompt += '\n\nIMPORTANT: This user has an "installer" role. They are a vehicle graphics installer.\n\nACCESS RESTRICTIONS:\n- You MUST NOT query NetSuite at all — no sales orders, invoices, customer financials, or pricing data. If they ask about financials, politely say you cannot access that data with their role.\n- You CAN query the BMG Fleet app database (supabase) for: fleet_checkins (vehicle tracking), vehicle_notes, vehicle_photos, job_assignments, graphics_jobs, vehicle_templates (wrap dimensions and panel data), profiles, and schedule_entries.\n- You CAN search the knowledge base for: installation SOPs, vehicle specs, wrap dimensions, techniques, and product information.\n- You CANNOT create estimates, view customer financial data, or access admin settings.\n\nFOCUS AREAS — help installers with:\n- Vehicle wrap dimensions and panel sizes (search vehicle_templates)\n- Installation techniques and best practices (search knowledge base)\n- Their assigned vehicles and current status\n- Vehicles currently in the shop (fleet_checkins)\n- Installation notes and photos for vehicles\n- Graphics job details (what graphics are needed for a vehicle)\n- Product specs from the knowledge base (SOPs, specs, pricing guides for materials)';
    }

    const claudeMessages: any[] = messages.map(m => ({ role: m.role, content: m.content }));

    // Inject a LIVE DATABASE SNAPSHOT into the system prompt so the model
    // has hard evidence of which Supabase tables exist and how populated
    // they are. The model was hallucinating "netsuite_parts doesn't exist"
    // despite the table being enumerated in the prompt; with real counts
    // attached it cannot defensibly claim a table is missing.
    try {
      const tablesToCheck = [
        'netsuite_parts',
        'vehicle_templates',
        'customers',
        'prospects',
        'graphics_jobs',
        'estimates',
        'quotes',
        'fleet_checkins',
        'scan_logs',
        'purchase_orders',
        'knowledge_entries',
        'cni_jobs',
      ] as const;
      const counts = await Promise.all(
        tablesToCheck.map(async (table) => {
          try {
            const { count, error } = await supabase
              .from(table)
              .select('*', { count: 'exact', head: true });
            if (error) return `${table}=ERROR(${error.code || '?'})`;
            return `${table}=${count ?? 0}`;
          } catch {
            return `${table}=ERROR`;
          }
        })
      );
      systemPrompt += `\n\nLIVE DATABASE SNAPSHOT (Supabase, generated ${new Date().toISOString()}):\n${counts.join(', ')}\n\nThese numbers are authoritative. If a table has count >= 0 here, it EXISTS. Never tell the user "table X doesn't exist" or "isn't set up" for any table appearing in this snapshot. A zero count means the table is empty, not missing — say "no rows" or "the catalog hasn't been populated yet," NOT "the table doesn't exist."`;
    } catch (err) {
      // Snapshot is a nice-to-have; if it fails, the prompt still works
      // without it. Just don't block the chat.
      console.warn('[ai-agent] failed to build DB snapshot:', err);
    }

    let totalQueriesExecuted = 0;
    const MAX_ROUNDS = 4; // Increased from 3 since we have more data sources

    for (let round = 0; round < MAX_ROUNDS; round++) {
      const reply = await callClaude(apiKey, claudeMessages, systemPrompt);
      const queryBlock = extractQueries(reply);

      if (!queryBlock) {
        const cleanReply = reply.trim()
          .replace(/^```(?:json)?\s*\n?/i, '')
          .replace(/\n?```\s*$/i, '')
          .trim();
        return NextResponse.json({
          reply: cleanReply,
          queriesExecuted: totalQueriesExecuted,
        });
      }

      // Execute all queries/actions
      const results: Record<string, any> = {};
      for (const q of queryBlock.queries) {
        // Server-side enforcement: block NetSuite queries for installer roles
        if (isInstallerRole && q.source === 'netsuite') {
          results[q.id] = { error: 'NetSuite access is not available for your role. Use the knowledge base or app database instead.' };
          totalQueriesExecuted++;
          continue;
        }
        try {
          results[q.id] = await executeQuery(q);
          totalQueriesExecuted++;
        } catch (err: any) {
          results[q.id] = { error: err.message };
          totalQueriesExecuted++;
        }
      }

      claudeMessages.push({ role: 'assistant', content: reply });
      claudeMessages.push({
        role: 'user',
        content: `Query results:\n\n${Object.entries(results).map(([id, r]) => {
          if (r.error) return `"${id}" ERROR: ${r.error}`;
          if (r.success) return `"${id}" ACTION SUCCESS: ${r.message}`;
          const items = r.items;
          if (!items || items.length === 0) return `"${id}": No rows returned.`;
          return `"${id}" (${items.length} rows):\n${JSON.stringify(items.slice(0, 50), null, 2)}${items.length > 50 ? `\n... (${items.length - 50} more rows)` : ''}`;
        }).join('\n\n')}\n\nBased on these results, provide a clear answer. If you need more data, output another query JSON block. Otherwise respond with plain text only.`
      });
    }

    // Exhausted rounds — force final answer
    claudeMessages.push({
      role: 'user',
      content: 'Please provide your best answer now based on all data collected. Respond with plain text only — no queries.',
    });
    const finalReply = await callClaude(apiKey, claudeMessages, systemPrompt);
    const cleanFinal = finalReply.trim()
      .replace(/^```(?:json)?\s*\n?/i, '')
      .replace(/\n?```\s*$/i, '')
      .trim();

    return NextResponse.json({
      reply: cleanFinal,
      queriesExecuted: totalQueriesExecuted,
    });

  } catch (err: any) {
    console.error('AI agent error:', err);
    return NextResponse.json({ error: err.message || 'Failed to process request' }, { status: 500 });
  }
}
