import { NextRequest, NextResponse } from 'next/server';
import { suiteqlQuery } from '@/lib/netsuite';

export const dynamic = 'force-dynamic';

const SYSTEM_PROMPT = `You are FleetSuite AI, a business data assistant for BMG Fleet, a vehicle upfitting and fleet services company. You answer questions by querying their NetSuite ERP data using SuiteQL.

CRITICAL RULES:
1. When you need data, respond with ONLY a raw JSON object — no markdown, no code fences, no explanation before or after.
2. After receiving query results, respond with ONLY plain text — a clear, concise answer.
3. Never show SQL or JSON to the user in your final answer.
4. If you need to run additional queries after seeing results (e.g., to investigate further), you may output another JSON query block.

SUITEQL SYNTAX:
- Oracle-like syntax: FETCH FIRST N ROWS ONLY (never use LIMIT)
- Use UPPER() for case-insensitive string matching
- Always use table aliases
- Date format: 'MM/DD/YYYY' or use EXTRACT(YEAR FROM t.trandate) for year comparisons
- Use TO_DATE('01/01/2026', 'MM/DD/YYYY') for date literals
- Aggregate functions: COUNT(), SUM(), AVG(), MAX(), MIN()
- Use NVL(field, 0) for null-safe numeric operations

AVAILABLE TABLES:

1. transaction (t)
   - t.id, t.tranid (document number like SO1234, INV5678)
   - t.trandate (transaction date)
   - t.type: 'SalesOrd', 'CustInvc', 'CustPymt', 'CustCred', 'Estimate', 'ItemShip'
   - t.status — IMPORTANT status codes:
     * Sales Orders: 'A' (Pending Approval), 'B' (Pending Fulfillment), 'C' (Cancelled), 'D' (Partially Fulfilled), 'E' (Pending Billing/Partially Fulfilled), 'F' (Pending Billing), 'G' (Billed), 'H' (Closed)
     * Invoices: 'A' (Open), 'B' (Paid In Full)
     * To find OPEN/UNPAID invoices: t.type = 'CustInvc' AND t.status = 'A'
     * To find PAID invoices: t.type = 'CustInvc' AND t.status = 'B'
   - t.entity (FK to customer.id)
   - t.foreigntotal (total amount)
   - t.foreignamountunpaid (amount still owed — use for AR/receivables)
   - t.memo
   - t.otherrefnum (customer PO reference)
   - t.custbody_vin_number_ (VIN)

2. transactionline (tl)
   - tl.transaction (FK to transaction.id)
   - tl.item (FK to item.id)
   - tl.quantity, tl.rate, tl.netamount
   - tl.memo (line description)
   - tl.linesequencenumber
   - tl.mainline ('T' = summary line, 'F' = detail line)
   - tl.taxline ('T' = tax line, 'F' = not tax)
   - ALWAYS filter: tl.mainline = 'F' AND tl.taxline = 'F' for real line items

3. customer (c)
   - c.id, c.companyname, c.entityid (customer number)
   - c.email, c.phone, c.defaultbillingaddress
   - c.isinactive ('T'/'F')
   - c.balance (current AR balance)
   - c.overduebalance (overdue portion)

4. item (i)
   - i.id, i.itemid (part number), i.displayname
   - i.description, i.salesdescription
   - i.baseprice (base/list price)

COMMON QUERY PATTERNS:

-- Accounts receivable (money owed to you):
SELECT c.companyname, SUM(t.foreignamountunpaid) AS amount_owed
FROM transaction t
JOIN customer c ON c.id = t.entity
WHERE t.type = 'CustInvc' AND t.status = 'A'
GROUP BY c.companyname
ORDER BY amount_owed DESC

-- Total AR:
SELECT SUM(t.foreignamountunpaid) AS total_ar
FROM transaction t
WHERE t.type = 'CustInvc' AND t.status = 'A'

-- Customer balance (alternative):
SELECT c.companyname, c.balance, c.overduebalance
FROM customer c WHERE c.balance > 0 ORDER BY c.balance DESC

-- Find what you charged a customer for a specific item:
SELECT t.tranid, t.trandate, i.displayname, tl.quantity, tl.rate, tl.netamount
FROM transactionline tl
JOIN transaction t ON t.id = tl.transaction
JOIN item i ON i.id = tl.item
JOIN customer c ON c.id = t.entity
WHERE UPPER(c.companyname) LIKE UPPER('%customer_name%')
AND (UPPER(i.displayname) LIKE UPPER('%search%') OR UPPER(tl.memo) LIKE UPPER('%search%'))
AND tl.mainline = 'F' AND tl.taxline = 'F'
AND t.type IN ('SalesOrd', 'CustInvc')
ORDER BY t.trandate DESC
FETCH FIRST 10 ROWS ONLY

-- Top customers by spend:
SELECT c.companyname, COUNT(DISTINCT t.id) AS order_count, SUM(t.foreigntotal) AS total_spend
FROM transaction t JOIN customer c ON c.id = t.entity
WHERE t.type = 'SalesOrd' AND EXTRACT(YEAR FROM t.trandate) = 2026
GROUP BY c.companyname ORDER BY total_spend DESC
FETCH FIRST 10 ROWS ONLY

QUERY JSON FORMAT (output ONLY this, nothing else):
{"queries": [{"id": "descriptive_name", "sql": "SELECT ..."}]}

ANSWER FORMAT:
- Be concise and direct
- Format currency as $X,XXX.XX
- Include dates when relevant
- If no data found, say so clearly and suggest why (e.g., different name spelling)
- Never mention SuiteQL, queries, or technical details in your answer`;

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

// Try to extract a queries JSON object from Claude's response
function extractQueries(text: string): { queries: { id: string; sql: string }[] } | null {
  const cleaned = text.trim()
    .replace(/^```(?:json)?\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '')
    .trim();

  // Try direct parse
  try {
    const parsed = JSON.parse(cleaned);
    if (parsed?.queries && Array.isArray(parsed.queries)) return parsed;
  } catch { /* continue */ }

  // Try extracting JSON from mixed text
  const match = cleaned.match(/\{[\s\S]*?"queries"\s*:\s*\[[\s\S]*?\]\s*\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      if (parsed?.queries && Array.isArray(parsed.queries)) return parsed;
    } catch { /* not valid */ }
  }

  return null;
}

async function callClaude(apiKey: string, messages: any[]): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
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
    const { messages } = await req.json() as { messages: Message[] };

    if (!messages?.length) {
      return NextResponse.json({ error: 'No messages provided' }, { status: 400 });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: 'AI not configured' }, { status: 500 });
    }

    // Build initial conversation
    const claudeMessages: any[] = messages.map(m => ({ role: m.role, content: m.content }));

    // Query loop: allow up to 3 rounds of queries
    let totalQueriesExecuted = 0;
    const MAX_ROUNDS = 3;

    for (let round = 0; round < MAX_ROUNDS; round++) {
      const reply = await callClaude(apiKey, claudeMessages);
      const queryBlock = extractQueries(reply);

      if (!queryBlock) {
        // No queries — this is the final answer
        // Strip any accidental JSON or code blocks from the final answer
        const cleanReply = reply.trim()
          .replace(/^```(?:json)?\s*\n?/i, '')
          .replace(/\n?```\s*$/i, '')
          .trim();
        return NextResponse.json({
          reply: cleanReply,
          queriesExecuted: totalQueriesExecuted,
        });
      }

      // Execute queries
      const results: Record<string, any> = {};
      for (const q of queryBlock.queries) {
        try {
          const result = await suiteqlQuery(q.sql, 100, 0);
          results[q.id] = { items: result?.items || [] };
          totalQueriesExecuted++;
        } catch (err: any) {
          results[q.id] = { error: err.message };
          totalQueriesExecuted++;
        }
      }

      // Add the query request and results to conversation history
      claudeMessages.push({ role: 'assistant', content: reply });
      claudeMessages.push({
        role: 'user',
        content: `Query results:\n\n${Object.entries(results).map(([id, r]) => {
          if (r.error) return `"${id}" ERROR: ${r.error}`;
          const items = r.items;
          if (items.length === 0) return `"${id}": No rows returned.`;
          return `"${id}" (${items.length} rows):\n${JSON.stringify(items, null, 2)}`;
        }).join('\n\n')}\n\nBased on these results, provide a clear answer. If you need more data, you may output another query JSON block. Otherwise respond with plain text only.`
      });
    }

    // If we exhausted all rounds, do one final call forcing a text answer
    claudeMessages.push({
      role: 'user',
      content: 'Please provide your best answer now based on all the data collected so far. Respond with plain text only — no queries.',
    });
    // Ensure valid alternation: last message must be user role (it is)
    const finalReply = await callClaude(apiKey, claudeMessages);
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
