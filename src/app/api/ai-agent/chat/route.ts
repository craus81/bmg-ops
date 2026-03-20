import { NextRequest, NextResponse } from 'next/server';
import { suiteqlQuery } from '@/lib/netsuite';

export const dynamic = 'force-dynamic';

const SYSTEM_PROMPT = `You are a helpful business data assistant for BMG Fleet, a vehicle upfitting and fleet services company. You answer questions by querying NetSuite ERP data using SuiteQL.

IMPORTANT RULES:
- When you need data, respond with a JSON block containing SuiteQL queries to execute
- NetSuite SuiteQL uses Oracle-like syntax: use FETCH FIRST N ROWS ONLY (not LIMIT)
- String comparisons should use UPPER() for case-insensitive matching
- Always use table aliases
- After receiving query results, provide a clear, concise answer

AVAILABLE TABLES AND COLUMNS:
1. transaction (t) - Sales orders, invoices, etc.
   - t.id, t.tranid (SO/invoice number), t.trandate, t.type ('SalesOrd', 'CustInvc', 'CustPymt'),
   - t.status, t.entity (customer ID), t.foreigntotal, t.memo, t.otherrefnum (PO reference)
   - t.custbody_vin_number_ (VIN number)

2. transactionline (tl) - Line items on transactions
   - tl.transaction, tl.item, tl.quantity, tl.rate, tl.netamount, tl.memo (description)
   - tl.linesequencenumber, tl.mainline ('T'/'F'), tl.taxline ('T'/'F')

3. customer (c) - Customer records
   - c.id, c.companyname, c.entityid, c.email, c.phone, c.defaultbillingaddress, c.isinactive

4. item (i) - Items/products
   - i.id, i.itemid (part number), i.displayname, i.description, i.baseprice, i.salesdescription

5. invoice (same as transaction with type = 'CustInvc')

COMMON PATTERNS:
- Find customer: WHERE UPPER(c.companyname) LIKE UPPER('%searchterm%')
- Find item: WHERE UPPER(i.itemid) LIKE UPPER('%searchterm%') OR UPPER(i.displayname) LIKE UPPER('%searchterm%')
- Sales orders: WHERE t.type = 'SalesOrd'
- Invoices: WHERE t.type = 'CustInvc'
- Payments: WHERE t.type = 'CustPymt'
- Line items (exclude summary/tax lines): WHERE tl.mainline = 'F' AND tl.taxline = 'F'
- Recent first: ORDER BY t.trandate DESC

RESPONSE FORMAT:
When you need to query data, respond with EXACTLY this JSON format (no markdown, no extra text):
{"queries": [{"id": "query_name", "sql": "SELECT ..."}]}

When you have results and are ready to answer, respond with plain text. Be concise and specific with numbers/dates. Format currency as $X,XXX.XX. If results are empty, say so clearly.

IMPORTANT: Do NOT wrap your JSON in markdown code blocks. Just output raw JSON when you need queries.`;

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

export async function POST(req: NextRequest) {
  try {
    const { messages, queryResults } = await req.json() as {
      messages: Message[];
      queryResults?: Record<string, any>;
    };

    if (!messages?.length) {
      return NextResponse.json({ error: 'No messages provided' }, { status: 400 });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: 'AI not configured' }, { status: 500 });
    }

    // Build the conversation for Claude
    const claudeMessages: any[] = [];

    for (const msg of messages) {
      claudeMessages.push({ role: msg.role, content: msg.content });
    }

    // If we have query results, append them as a user message
    if (queryResults) {
      let resultsText = 'Here are the query results:\n\n';
      for (const [queryId, result] of Object.entries(queryResults)) {
        if (result.error) {
          resultsText += `Query "${queryId}" failed: ${result.error}\n\n`;
        } else {
          const items = result.items || [];
          resultsText += `Query "${queryId}" returned ${items.length} row(s):\n`;
          resultsText += JSON.stringify(items, null, 2) + '\n\n';
        }
      }
      resultsText += 'Now please provide a clear, concise answer to the original question based on these results.';
      claudeMessages.push({ role: 'user', content: resultsText });
    }

    // Call Claude
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
        messages: claudeMessages,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error('Claude API error:', text);
      return NextResponse.json({ error: 'AI service error' }, { status: 500 });
    }

    const data = await res.json();
    const reply = data.content?.[0]?.text || '';

    // Check if Claude wants to execute queries
    const trimmed = reply.trim();
    // Strip markdown code blocks if present (```json ... ``` or ``` ... ```)
    const stripped = trimmed.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
    let parsed: any = null;
    try {
      // Try to parse the stripped response as JSON
      parsed = JSON.parse(stripped);
    } catch {
      // Also try to extract JSON from the response if it has surrounding text
      const jsonMatch = stripped.match(/\{[\s\S]*"queries"[\s\S]*\}/);
      if (jsonMatch) {
        try {
          parsed = JSON.parse(jsonMatch[0]);
        } catch { /* not JSON */ }
      }
    }

    if (parsed?.queries && Array.isArray(parsed.queries)) {
      // Execute each query against NetSuite
      const results: Record<string, any> = {};

      for (const q of parsed.queries) {
        try {
          const result = await suiteqlQuery(q.sql, 50, 0);
          results[q.id] = { items: result?.items || [] };
        } catch (err: any) {
          results[q.id] = { error: err.message };
        }
      }

      // Call Claude again with the results
      const followUp = await fetch('https://api.anthropic.com/v1/messages', {
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
          messages: [
            ...claudeMessages,
            { role: 'assistant', content: trimmed },
            {
              role: 'user',
              content: `Here are the query results:\n\n${Object.entries(results).map(([id, r]) => {
                if (r.error) return `Query "${id}" failed: ${r.error}`;
                return `Query "${id}" returned ${r.items.length} row(s):\n${JSON.stringify(r.items, null, 2)}`;
              }).join('\n\n')}\n\nNow please provide a clear, concise answer to the original question based on these results.`
            },
          ],
        }),
      });

      if (!followUp.ok) {
        return NextResponse.json({ error: 'AI service error on follow-up' }, { status: 500 });
      }

      const followData = await followUp.json();
      const finalReply = followData.content?.[0]?.text || 'Sorry, I couldn\'t interpret the results.';

      return NextResponse.json({
        reply: finalReply,
        queriesExecuted: Object.keys(results).length,
      });
    }

    // No queries needed — direct answer
    return NextResponse.json({ reply: trimmed });

  } catch (err: any) {
    console.error('AI agent error:', err);
    return NextResponse.json({ error: err.message || 'Failed to process request' }, { status: 500 });
  }
}
