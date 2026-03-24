import { NextRequest, NextResponse } from 'next/server';
import { suiteqlQuery } from '@/lib/netsuite';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const SYSTEM_PROMPT = `You are FleetSuite AI, a business data assistant for BMG Fleet, a vehicle upfitting and fleet services company. You can query both NetSuite ERP data (SuiteQL) and the BMG Fleet app database (Supabase/PostgreSQL). You can also take actions like creating graphics jobs, sending messages, and updating records.

CRITICAL RULES:
1. When you need data, respond with ONLY a raw JSON object — no markdown, no code fences, no explanation before or after.
2. After receiving query results, respond with ONLY plain text — a clear, concise answer.
3. Never show SQL or JSON to the user in your final answer.
4. If you need to run additional queries after seeing results, you may output another JSON block.
5. When unsure about a field name, query a small sample first.
6. Choose the RIGHT data source for the question — use Supabase for app data (graphics jobs, vehicles, POs in the app, messages, schedules) and NetSuite for ERP data (financials, invoicing, customers, inventory).

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
   - id (uuid), full_name, email, role ('admin'|'installer'|'production'|'sales')
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
   - status: 'flagged'|'received'|'designing'|'revision'|'printing'|'outgassing'|'cutting'|'packing'|'ready'|'shipped'|'installed'|'cancelled'
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

Use the "knowledge" source to search these docs when users ask about procedures, specs, pricing rules, or company policies. Knowledge docs may be uploaded PDFs, Word docs, Excel files, or manually entered text. When a result has a source file, mention the file name so the user knows where the info came from. Example: {"id": "vinyl_spec", "source": "knowledge", "search": "vinyl specifications"}

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
   Valid statuses: flagged, received, designing, revision, printing, outgassing, cutting, packing, ready, shipped, installed, cancelled

3. send_message — Send a message to a user
   params: { to_user_id, body }

4. create_notification — Send a notification to a user
   params: { user_id, type, title, body }

WHEN TO USE ACTIONS:
- "Create a graphics job for..." → use create_graphics_job
- "Move job X to printing" → query for the job first, then update_graphics_status
- "Tell Craig that..." → query for Craig's user ID, then send_message
- "Notify the production team..." → query production users, then create_notification for each

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
  source?: 'netsuite' | 'supabase' | 'action' | 'knowledge';
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
    // Full-text search against knowledge base
    const { data, error } = await supabase
      .from('knowledge_docs')
      .select('id, title, category, content, tags, file_name, file_type, file_size, file_path, created_at')
      .or(`title.ilike.%${q.search}%,content.ilike.%${q.search}%`)
      .order('created_at', { ascending: false })
      .limit(5);
    if (error) throw new Error(`Knowledge search failed: ${error.message}`);
    // Truncate content for context window, include file info
    const items = (data || []).map(d => ({
      ...d,
      content: d.content?.length > 1000 ? d.content.substring(0, 1000) + '...' : d.content,
      has_file: !!d.file_path,
      source_file: d.file_name || null,
    }));
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
      model: 'claude-sonnet-4-5-20250929',
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
  try {
    const { messages, userRole } = await req.json() as { messages: Message[]; userRole?: string };

    if (!messages?.length) {
      return NextResponse.json({ error: 'No messages provided' }, { status: 400 });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: 'AI not configured' }, { status: 500 });
    }

    // Customize system prompt based on role
    let systemPrompt = SYSTEM_PROMPT;
    if (userRole === 'sales') {
      systemPrompt += '\n\nIMPORTANT: This user has a "sales" role. They can view customer data, estimates, graphics production, and vehicle tracking. They should NOT be able to modify user accounts, delete records, or access admin-only settings. Focus on helping them with customer info, quotes, and production status.';
    } else if (userRole === 'production') {
      systemPrompt += '\n\nIMPORTANT: This user has a "production" role. They primarily work with graphics jobs, production schedules, and the production pipeline. Focus on helping them with job statuses, vinyl specs, production metrics, and scheduling.';
    }

    const claudeMessages: any[] = messages.map(m => ({ role: m.role, content: m.content }));

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
