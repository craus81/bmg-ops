import { NextRequest, NextResponse } from 'next/server';
import { getMessage, getPdfAttachments, getAttachment, getHeader } from '@/lib/google';
import { createClient } from '@supabase/supabase-js';

async function callAnthropicWithRetry(body: any, apiKey: string, maxRetries = 3): Promise<Response> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'pdfs-2024-09-25',
      },
      body: JSON.stringify(body),
    });

    // If rate limited (429) or server error (529 overloaded), retry with backoff
    if ((res.status === 429 || res.status === 529) && attempt < maxRetries - 1) {
      const retryAfter = res.headers.get('retry-after');
      const waitMs = retryAfter ? parseInt(retryAfter) * 1000 : Math.min(2000 * Math.pow(2, attempt), 30000);
      console.log(`Anthropic API ${res.status}, retrying in ${waitMs}ms (attempt ${attempt + 1}/${maxRetries})`);
      await new Promise(r => setTimeout(r, waitMs));
      continue;
    }

    return res;
  }

  // Should not reach here, but just in case
  throw new Error('Max retries exceeded for Anthropic API');
}

const PO_EXTRACTION_PROMPT = `You are extracting purchase order data from a PDF document. This is typically a Masterack or similar fleet equipment purchase order sent to BMG Fleet Installation.

CRITICAL: You MUST extract every single line item from the table. Each line item row has: a line number (like 1.000, 2.000), a part number, a description, quantity, unit of measure (EA/PC), and a unit price. Some POs have many line items across multiple pages — extract ALL of them.

LOOK FOR THESE SPECIFIC ELEMENTS:
- PURCHASE ORDER NUMBER: Usually at top right, labeled "PURCHASE ORDER NUMBER" followed by a number like 35045953
- ORDERED DATE: Format like MM/DD/YY or MM/DD/YYYY
- SHIP TO / DELIVER TO: The address block showing where to ship
- LINE ITEMS TABLE: Each row starts with a line number (1.000, 2.000, etc.) followed by a part number (alphanumeric like 06T278, RM530432, 065058, 06CS900008), description text, quantity (integer), UOM (EA or PC), and unit price (decimal number)
- The row below a line item may contain a "Supplier Part" number — this is BMG's part number

Return ONLY valid JSON, no markdown, no backticks, no other text:
{
  "po_number": "35045953",
  "customer": "Masterack",
  "ordered_date": "03/18/2026",
  "ship_to": {
    "name": "BMG Fleet Installation LLC",
    "address": "123 Main St",
    "city": "Indianapolis",
    "state": "IN",
    "zip": "46201"
  },
  "lines": [
    {
      "line_no": "1.000",
      "part_number": "06T278",
      "supplier_part": "06T278",
      "description": "GRAPHIC KIT-FORD TRANSIT",
      "quantity": 10,
      "unit_price": 45.00,
      "delivery_date": "03/25/2026"
    }
  ],
  "notes": null
}

RULES:
- Extract EVERY line item row — do not skip any
- part_number: The Masterack/buyer part number from the main line (e.g., RM530432)
- supplier_part: BMG's part number from the line below (e.g., 06T278). If not present, copy part_number
- quantity: Integer only
- unit_price: Decimal number, no $ sign (e.g., 45.00)
- delivery_date: The requested delivery date for that line, if shown
- If the PO has items across multiple pages, include ALL pages
- customer: Usually "Masterack" for Masterack POs. Use the buyer/company name from the header`;

export async function POST(req: NextRequest) {
  try {
    const { messageId, autoCreate, forceOverwrite } = await req.json();
    if (!messageId) {
      return NextResponse.json({ error: 'messageId required' }, { status: 400 });
    }

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    // Get the message and find PDF attachment
    const message = await getMessage(messageId);
    const subject = getHeader(message, 'Subject');
    const from = getHeader(message, 'From');
    const date = getHeader(message, 'Date');
    const pdfs = getPdfAttachments(message);

    if (pdfs.length === 0) {
      return NextResponse.json({ error: 'No PDF attachment found' }, { status: 400 });
    }

    // Download the first (or largest) PDF
    const targetPdf = pdfs.reduce((a, b) => a.size > b.size ? a : b);
    const pdfBase64 = await getAttachment(messageId, targetPdf.attachmentId);

    // Send to Claude API for extraction using native PDF support (with retry)
    const anthropicRes = await callAnthropicWithRetry({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 8192,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: pdfBase64,
            },
          },
          {
            type: 'text',
            text: PO_EXTRACTION_PROMPT,
          },
        ],
      }],
    }, process.env.ANTHROPIC_API_KEY!);

    if (!anthropicRes.ok) {
      const errBody = await anthropicRes.text();
      console.error('Anthropic API error:', errBody);

      await supabase.from('gmail_po_imports').upsert({
        message_id: messageId,
        thread_id: message.threadId,
        subject,
        from_email: from,
        received_at: date ? new Date(date).toISOString() : null,
        attachment_filename: targetPdf.filename,
        status: 'error',
        error_message: `AI extraction failed: ${anthropicRes.status}`,
      }, { onConflict: 'message_id' });

      return NextResponse.json({ error: 'AI extraction failed', details: errBody }, { status: 500 });
    }

    const aiResult = await anthropicRes.json();
    const aiText = aiResult.content?.[0]?.text || '';

    // Parse the JSON from AI response
    let extracted;
    try {
      // Try to find JSON in the response, handling potential markdown wrapping
      let jsonStr = aiText;
      const codeBlockMatch = aiText.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (codeBlockMatch) {
        jsonStr = codeBlockMatch[1];
      } else {
        const jsonMatch = aiText.match(/\{[\s\S]*\}/);
        if (jsonMatch) jsonStr = jsonMatch[0];
      }
      extracted = JSON.parse(jsonStr);
    } catch (parseErr: any) {
      await supabase.from('gmail_po_imports').upsert({
        message_id: messageId,
        thread_id: message.threadId,
        subject,
        from_email: from,
        received_at: date ? new Date(date).toISOString() : null,
        attachment_filename: targetPdf.filename,
        status: 'error',
        error_message: 'Failed to parse AI extraction',
        raw_extraction: { raw: aiText },
      }, { onConflict: 'message_id' });

      return NextResponse.json({ error: 'Failed to parse extraction', raw: aiText }, { status: 500 });
    }

    const poNumber = extracted.po_number;
    if (!poNumber) {
      return NextResponse.json({ error: 'No PO number found in PDF', extracted }, { status: 400 });
    }

    const extractedLines = (extracted.lines || []).filter((l: any) => l.part_number);

    // Validate extraction quality — catch partial/degraded extractions
    const hasLines = extractedLines.length > 0;
    const hasPricing = extractedLines.some((l: any) => parseFloat(l.unit_price) > 0);
    const stopReason = aiResult.stop_reason;

    if (stopReason === 'max_tokens') {
      console.warn(`PO ${poNumber}: AI response hit max_tokens — extraction may be truncated`);
    }

    if (!hasLines) {
      await supabase.from('gmail_po_imports').upsert({
        message_id: messageId,
        thread_id: message.threadId,
        subject,
        from_email: from,
        received_at: date ? new Date(date).toISOString() : null,
        po_number: String(poNumber),
        attachment_filename: targetPdf.filename,
        status: 'error',
        error_message: 'AI extracted PO number but no line items — possible rate limit or degraded response',
        raw_extraction: extracted,
      }, { onConflict: 'message_id' });

      return NextResponse.json({
        error: `Extracted PO #${poNumber} but no line items were found. This may be due to API rate limiting — try again in a moment.`,
        extracted,
        warning: 'partial_extraction',
      }, { status: 422 });
    }

    if (!hasPricing) {
      console.warn(`PO ${poNumber}: Extracted ${extractedLines.length} lines but none have pricing`)
    }

    // Check if PO already exists
    const { data: existingPO } = await supabase
      .from('purchase_orders')
      .select('*, po_line_items(*)')
      .eq('po_number', String(poNumber))
      .maybeSingle();

    if (existingPO && !forceOverwrite) {
      // Build a diff of what changed
      const existingLines = existingPO.po_line_items || [];
      const changes: any[] = [];

      // Check for new or changed lines
      for (const newLine of extractedLines) {
        const match = existingLines.find((el: any) =>
          el.part_number?.toUpperCase() === (newLine.part_number || '').toUpperCase() ||
          el.part_number?.toUpperCase() === (newLine.supplier_part || '').toUpperCase()
        );
        if (!match) {
          changes.push({
            type: 'added',
            part_number: newLine.supplier_part || newLine.part_number,
            description: newLine.description,
            quantity: parseInt(newLine.quantity) || 0,
            unit_price: parseFloat(newLine.unit_price) || 0,
          });
        } else {
          const newQty = parseInt(newLine.quantity) || 0;
          const newPrice = parseFloat(newLine.unit_price) || 0;
          const qtyChanged = newQty !== match.quantity;
          const priceChanged = Math.abs(newPrice - match.unit_price) > 0.001;
          if (qtyChanged || priceChanged) {
            changes.push({
              type: 'changed',
              part_number: match.part_number,
              description: newLine.description,
              old_quantity: match.quantity,
              new_quantity: newQty,
              old_price: match.unit_price,
              new_price: newPrice,
              quantity_changed: qtyChanged,
              price_changed: priceChanged,
            });
          }
        }
      }

      // Check for removed lines
      for (const existingLine of existingLines) {
        const stillExists = extractedLines.find((nl: any) =>
          (nl.part_number || '').toUpperCase() === existingLine.part_number?.toUpperCase() ||
          (nl.supplier_part || '').toUpperCase() === existingLine.part_number?.toUpperCase()
        );
        if (!stillExists) {
          changes.push({
            type: 'removed',
            part_number: existingLine.part_number,
            quantity: existingLine.quantity,
            unit_price: existingLine.unit_price,
          });
        }
      }

      // Record extraction
      await supabase.from('gmail_po_imports').upsert({
        message_id: messageId,
        thread_id: message.threadId,
        subject,
        from_email: from,
        received_at: date ? new Date(date).toISOString() : null,
        po_number: String(poNumber),
        po_id: existingPO.id,
        attachment_filename: targetPdf.filename,
        status: 'pending',
        raw_extraction: extracted,
      }, { onConflict: 'message_id' });

      return NextResponse.json({
        status: 'exists',
        poNumber,
        poId: existingPO.id,
        existingLineCount: existingLines.length,
        newLineCount: extractedLines.length,
        changes,
        hasChanges: changes.length > 0,
        extracted,
      });
    }

    // Overwrite existing PO if forceOverwrite is true
    if (existingPO && forceOverwrite) {
      // Clear FK references from scanned_vehicles before deleting line items
      const existingLineIds = (existingPO.po_line_items || []).map((li: any) => li.id);
      if (existingLineIds.length > 0) {
        await supabase
          .from('scanned_vehicles')
          .update({ po_line_item_id: null })
          .in('po_line_item_id', existingLineIds);
      }

      // Delete old line items
      const { error: deleteErr } = await supabase.from('po_line_items').delete().eq('po_id', existingPO.id);
      if (deleteErr) {
        console.error('Failed to delete old line items:', deleteErr);
        return NextResponse.json({ error: `Failed to update PO: ${deleteErr.message}` }, { status: 500 });
      }

      // Update PO header
      const customer = extracted.customer || existingPO.customer || 'Unknown';
      const { error: updateErr } = await supabase.from('purchase_orders').update({
        customer,
        notes: extracted.notes ? String(extracted.notes) : existingPO.notes,
      }).eq('id', existingPO.id);
      if (updateErr) {
        console.error('Failed to update PO header:', updateErr);
      }

      // Get catalog for part matching
      const { data: catalogData } = await supabase.from('catalog').select('*').eq('active', true);
      const catalogItems = catalogData || [];

      // Insert new line items
      const lineInserts = extractedLines.map((l: any) => {
        const partNum = l.supplier_part || l.part_number;
        const catalogMatch = catalogItems.find((c: any) =>
          c.part_number.toUpperCase() === (partNum || '').toUpperCase() ||
          c.part_number.toUpperCase() === (l.part_number || '').toUpperCase()
        );
        return {
          po_id: existingPO.id,
          catalog_id: catalogMatch?.id || null,
          part_number: partNum,
          quantity: parseInt(l.quantity) || 0,
          unit_price: parseFloat(l.unit_price) || 0,
        };
      });

      if (lineInserts.length > 0) {
        const { error: insertErr } = await supabase.from('po_line_items').insert(lineInserts);
        if (insertErr) {
          console.error('Failed to insert new line items:', insertErr);
          return NextResponse.json({ error: `Failed to insert updated line items: ${insertErr.message}` }, { status: 500 });
        }
      }

      await supabase.from('gmail_po_imports').upsert({
        message_id: messageId,
        thread_id: message.threadId,
        subject,
        from_email: from,
        received_at: date ? new Date(date).toISOString() : null,
        po_number: String(poNumber),
        po_id: existingPO.id,
        attachment_filename: targetPdf.filename,
        status: 'imported',
        raw_extraction: extracted,
      }, { onConflict: 'message_id' });

      return NextResponse.json({
        status: 'updated',
        poNumber,
        poId: existingPO.id,
        customer: extracted.customer || existingPO.customer,
        lineCount: lineInserts.length,
        extracted,
      });
    }

    // Create new PO
    if (autoCreate !== false) {
      const { data: catalogData } = await supabase.from('catalog').select('*').eq('active', true);
      const catalogItems = catalogData || [];

      const customer = extracted.customer || 'Unknown';

      const { data: adminUser } = await supabase
        .from('profiles')
        .select('id')
        .eq('role', 'admin')
        .limit(1)
        .single();

      const insertPayload: any = {
        po_number: String(poNumber),
        customer,
        notes: extracted.notes ? String(extracted.notes) : null,
      };
      if (adminUser?.id) {
        insertPayload.created_by = adminUser.id;
      }

      const { data: newPO, error: poError } = await supabase
        .from('purchase_orders')
        .insert(insertPayload)
        .select()
        .single();

      if (poError || !newPO) {
        await supabase.from('gmail_po_imports').upsert({
          message_id: messageId,
          thread_id: message.threadId,
          subject,
          from_email: from,
          received_at: date ? new Date(date).toISOString() : null,
          po_number: String(poNumber),
          attachment_filename: targetPdf.filename,
          status: 'error',
          error_message: `Failed to create PO: ${poError?.message}`,
          raw_extraction: extracted,
        }, { onConflict: 'message_id' });

        return NextResponse.json({ error: 'Failed to create PO', details: poError?.message }, { status: 500 });
      }

      const lineInserts = extractedLines.map((l: any) => {
        const partNum = l.supplier_part || l.part_number;
        const catalogMatch = catalogItems.find((c: any) =>
          c.part_number.toUpperCase() === (partNum || '').toUpperCase() ||
          c.part_number.toUpperCase() === (l.part_number || '').toUpperCase()
        );
        return {
          po_id: newPO.id,
          catalog_id: catalogMatch?.id || null,
          part_number: partNum,
          quantity: parseInt(l.quantity) || 0,
          unit_price: parseFloat(l.unit_price) || 0,
        };
      });

      if (lineInserts.length > 0) {
        await supabase.from('po_line_items').insert(lineInserts);
      }

      await supabase.from('gmail_po_imports').upsert({
        message_id: messageId,
        thread_id: message.threadId,
        subject,
        from_email: from,
        received_at: date ? new Date(date).toISOString() : null,
        po_number: String(poNumber),
        po_id: newPO.id,
        attachment_filename: targetPdf.filename,
        status: 'imported',
        raw_extraction: extracted,
      }, { onConflict: 'message_id' });

      return NextResponse.json({
        status: 'imported',
        poNumber,
        poId: newPO.id,
        customer,
        lineCount: lineInserts.length,
        extracted,
      });
    }

    // Just return extracted data
    await supabase.from('gmail_po_imports').upsert({
      message_id: messageId,
      thread_id: message.threadId,
      subject,
      from_email: from,
      received_at: date ? new Date(date).toISOString() : null,
      po_number: String(poNumber),
      attachment_filename: targetPdf.filename,
      status: 'pending',
      raw_extraction: extracted,
    }, { onConflict: 'message_id' });

    return NextResponse.json({ status: 'extracted', poNumber, extracted });
  } catch (err: any) {
    if (err.message === 'NO_GOOGLE_TOKEN') {
      return NextResponse.json({ error: 'Gmail not connected', needsAuth: true }, { status: 401 });
    }
    console.error('Import PO error:', err);
    return NextResponse.json({ error: err.message || 'Failed to import PO' }, { status: 500 });
  }
}
