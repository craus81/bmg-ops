import { NextRequest, NextResponse } from 'next/server';
import { getMessage, getPdfAttachments, getAttachment, getHeader } from '@/lib/google';
import { createClient } from '@supabase/supabase-js';
import { notifyMany } from '@/lib/notify';
import { requireAuth } from '@/lib/api-auth';

/**
 * Check extracted PO lines for graphic parts (02* or RM*) and create flagged graphics jobs.
 * Sends notifications via in-app, SMS, and email based on each user's preferences.
 */
async function flagGraphicParts(
  supabase: any,
  poId: string,
  poNumber: string,
  customer: string,
  extractedLines: any[],
  createdBy?: string,
) {
  const graphicLines = extractedLines.filter((l: any) => {
    const pn = (l.supplier_part || l.part_number || '').toUpperCase();
    return pn.startsWith('02') || pn.startsWith('RM');
  });

  if (graphicLines.length === 0) return { flaggedCount: 0 };

  // Get existing line item IDs for this PO to link jobs
  const { data: poLineItems } = await supabase
    .from('po_line_items')
    .select('id, part_number')
    .eq('po_id', poId);

  const jobInserts = graphicLines.map((l: any) => {
    const partNum = l.supplier_part || l.part_number;
    const matchedLine = (poLineItems || []).find((pli: any) =>
      pli.part_number?.toUpperCase() === (partNum || '').toUpperCase()
    );
    return {
      po_id: poId,
      po_line_item_id: matchedLine?.id || null,
      job_number: `GFX-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 5).toUpperCase()}`,
      title: l.description || `Graphic - ${partNum}`,
      part_number: partNum,
      customer: customer || null,
      quantity: parseInt(l.quantity) || 1,
      status: 'flagged',
      priority: 'normal',
      created_by: createdBy || null,
    };
  });

  const { data: createdJobs } = await supabase
    .from('graphics_jobs')
    .insert(jobInserts)
    .select('id, title, job_number');

  // Log status history
  if (createdJobs && createdJobs.length > 0) {
    await supabase.from('graphics_status_history').insert(
      createdJobs.map((j: any) => ({
        job_id: j.id,
        from_status: null,
        to_status: 'flagged',
        changed_by: createdBy || null,
        note: `Auto-flagged from PO #${poNumber}`,
      }))
    );

    // Notify users who want new job alerts (via in-app, SMS, email per their prefs)
    const { data: prefs } = await supabase
      .from('notification_preferences')
      .select('user_id, notify_new_job');

    if (prefs) {
      const notifyUserIds = prefs
        .filter((p: any) => p.notify_new_job && p.user_id !== createdBy)
        .map((p: any) => p.user_id);

      if (notifyUserIds.length > 0) {
        for (const job of createdJobs) {
          await notifyMany(notifyUserIds, {
            type: 'graphics_flagged',
            title: `Graphics Job Flagged: ${job.title}`,
            body: `PO #${poNumber} (${customer}) has a graphic part that needs review`,
            url: '/graphics',
          });
        }
      }
    }
  }

  return { flaggedCount: graphicLines.length, flaggedJobs: createdJobs || [] };
}

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
- LINE ITEMS TABLE: Each row starts with a line number (1.000, 2.000, etc.) followed by columns of data

COLUMN IDENTIFICATION — THIS IS CRITICAL:
The PO table has multiple columns that contain part-number-like codes. You MUST use the correct columns:
- "Part Number" or "Part Number Supplier Part Number" column: This is the CORRECT column for the buyer/Masterack part number. Use this value for part_number.
- "Supplier Part" row below a line item: This is BMG's part number. Use this for supplier_part.
- "Drawing Number" or "Drawing Number and Revision" column: COMPLETELY IGNORE THIS COLUMN. Do NOT extract values from it. Do NOT put drawing numbers or revision numbers into part_number or supplier_part. These are engineering drawing references that have nothing to do with part numbers.
- "Revision" column: COMPLETELY IGNORE THIS COLUMN. Revision numbers are NOT part numbers.

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
- part_number: The Masterack/buyer part number from the "Part Number" column (e.g., RM530432, 06T278). This is the PRIMARY identifier.
- supplier_part: BMG's supplier part number, often shown on the line below the main item row. If not present, copy part_number.
- DO NOT include drawing numbers or revision numbers anywhere. Ignore those columns entirely. Only extract from the "Part Number" and "Supplier Part" columns.
- quantity: Integer only
- unit_price: Decimal number, no $ sign (e.g., 45.00)
- delivery_date: The requested delivery date for that line, if shown
- If the PO has items across multiple pages, include ALL pages
- customer: Usually "Masterack" for Masterack POs. Use the buyer/company name from the header`;

export async function POST(req: NextRequest) {
  // Allow internal server-to-server calls (from auto-import cron)
  const authHeader = req.headers.get('authorization');
  const isInternalCall = authHeader === `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`;
  if (!isInternalCall) {
    const auth = await requireAuth(req);
    if (auth.error) return auth.error;
  }

  try {
    const { messageId, autoCreate, forceOverwrite, extractOnly, preExtracted } = await req.json();
    if (!messageId) {
      return NextResponse.json({ error: 'messageId required' }, { status: 400 });
    }

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    // Get the message metadata
    const message = await getMessage(messageId);
    const subject = getHeader(message, 'Subject');
    const from = getHeader(message, 'From');
    const date = getHeader(message, 'Date');
    const pdfs = getPdfAttachments(message);

    // If preExtracted data is provided (user reviewed/edited the extraction), skip Claude and use it directly
    if (preExtracted) {
      const extracted = preExtracted;
      const poNumber = extracted.po_number;
      if (!poNumber) {
        return NextResponse.json({ error: 'No PO number in edited data' }, { status: 400 });
      }
      const extractedLines = (extracted.lines || []).filter((l: any) => l.part_number);
      const pdfFilenames = pdfs.map((p: any) => p.filename).join(', ');

      // From here, proceed to PO creation logic (same as normal flow)
      // Check if PO already exists
      const { data: existingPO } = await supabase
        .from('purchase_orders')
        .select('*, po_line_items(*)')
        .eq('po_number', String(poNumber))
        .maybeSingle();

      if (existingPO && !forceOverwrite) {
        return NextResponse.json({
          status: 'exists',
          poNumber,
          poId: existingPO.id,
          existingLineCount: (existingPO.po_line_items || []).length,
          newLineCount: extractedLines.length,
          changes: [],
          hasChanges: true,
          extracted,
        });
      }

      if (existingPO && forceOverwrite) {
        // Clear FK references
        const existingLineIds = (existingPO.po_line_items || []).map((li: any) => li.id);
        if (existingLineIds.length > 0) {
          await supabase.from('scanned_vehicles').update({ po_line_item_id: null }).in('po_line_item_id', existingLineIds);
        }
        await supabase.from('po_line_items').delete().eq('po_id', existingPO.id);

        const customer = extracted.customer || existingPO.customer || 'Unknown';
        await supabase.from('purchase_orders').update({
          customer,
          ordered_date: extracted.ordered_date || existingPO.ordered_date || null,
          notes: extracted.notes ? String(extracted.notes) : existingPO.notes,
          ship_to: extracted.ship_to || existingPO.ship_to || null,
        }).eq('id', existingPO.id);

        const { data: catalogData } = await supabase.from('catalog').select('*').eq('active', true);
        const catalogItems = catalogData || [];

        const lineInserts = extractedLines.map((l: any) => {
          const partNum = l.supplier_part || l.part_number;
          const catalogMatch = catalogItems.find((c: any) =>
            c.part_number.toUpperCase() === (partNum || '').toUpperCase() ||
            c.part_number.toUpperCase() === (l.part_number || '').toUpperCase()
          );
          return {
            po_id: existingPO.id,
            ...(catalogMatch?.id ? { catalog_id: catalogMatch.id } : {}),
            part_number: partNum,
            description: l.description || null,
            quantity: parseInt(l.quantity) || 0,
            unit_price: parseFloat(l.unit_price) || 0,
          };
        });

        if (lineInserts.length > 0) {
          await supabase.from('po_line_items').insert(lineInserts);
        }

        await supabase.from('gmail_po_imports').upsert({
          message_id: messageId, thread_id: message.threadId, subject, from_email: from,
          received_at: date ? new Date(date).toISOString() : null,
          po_number: String(poNumber), po_id: existingPO.id,
          attachment_filename: pdfFilenames, status: 'imported', raw_extraction: extracted,
        }, { onConflict: 'message_id' });

        const unmatchedParts = extractedLines
          .filter((l: any) => {
            const partNum = l.supplier_part || l.part_number;
            return !catalogItems.find((c: any) =>
              c.part_number.toUpperCase() === (partNum || '').toUpperCase() ||
              c.part_number.toUpperCase() === (l.part_number || '').toUpperCase()
            );
          })
          .map((l: any) => ({ part_number: l.supplier_part || l.part_number, description: l.description || '', unit_price: parseFloat(l.unit_price) || 0 }));

        // Flag graphic parts (02/RM) for production review
        const flagResult = await flagGraphicParts(supabase, existingPO.id, String(poNumber), customer, extractedLines);

        return NextResponse.json({ status: 'updated', poNumber, poId: existingPO.id, customer, lineCount: lineInserts.length, unmatchedParts, extracted, flaggedGraphics: flagResult.flaggedCount });
      }

      // Create new PO from reviewed data
      const { data: catalogData } = await supabase.from('catalog').select('*').eq('active', true);
      const catalogItems = catalogData || [];
      const customer = extracted.customer || 'Unknown';

      const { data: adminUser } = await supabase.from('profiles').select('id').eq('role', 'admin').limit(1).single();
      const insertPayload: any = {
        po_number: String(poNumber), customer,
        ordered_date: extracted.ordered_date || null,
        notes: extracted.notes ? String(extracted.notes) : null,
        ship_to: extracted.ship_to || null,
      };
      if (adminUser?.id) insertPayload.created_by = adminUser.id;

      const { data: newPO, error: poError } = await supabase.from('purchase_orders').insert(insertPayload).select().single();
      if (poError || !newPO) {
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
          ...(catalogMatch?.id ? { catalog_id: catalogMatch.id } : {}),
          part_number: partNum,
          description: l.description || null,
          quantity: parseInt(l.quantity) || 0,
          unit_price: parseFloat(l.unit_price) || 0,
        };
      });

      if (lineInserts.length > 0) {
        await supabase.from('po_line_items').insert(lineInserts);
      }

      await supabase.from('gmail_po_imports').upsert({
        message_id: messageId, thread_id: message.threadId, subject, from_email: from,
        received_at: date ? new Date(date).toISOString() : null,
        po_number: String(poNumber), po_id: newPO.id,
        attachment_filename: pdfFilenames, status: 'imported', raw_extraction: extracted,
      }, { onConflict: 'message_id' });

      const unmatchedParts = extractedLines
        .filter((l: any) => {
          const partNum = l.supplier_part || l.part_number;
          return !catalogItems.find((c: any) =>
            c.part_number.toUpperCase() === (partNum || '').toUpperCase() ||
            c.part_number.toUpperCase() === (l.part_number || '').toUpperCase()
          );
        })
        .map((l: any) => ({ part_number: l.supplier_part || l.part_number, description: l.description || '', unit_price: parseFloat(l.unit_price) || 0 }));

      // Flag graphic parts (02/RM) for production review
      const flagResult = await flagGraphicParts(supabase, newPO.id, String(poNumber), customer, extractedLines);

      return NextResponse.json({ status: 'imported', poNumber, poId: newPO.id, customer, lineCount: lineInserts.length, unmatchedParts, extracted, flaggedGraphics: flagResult.flaggedCount });
    }

    if (pdfs.length === 0) {
      return NextResponse.json({ error: 'No PDF attachment found' }, { status: 400 });
    }

    // Download ALL PDF attachments so Claude can find the PO in any of them
    // Sort: filenames containing "PO" or "purchase" first, then by size descending
    const sortedPdfs = [...pdfs].sort((a, b) => {
      const aIsPO = /\b(po|purchase.?order)\b/i.test(a.filename) ? 1 : 0;
      const bIsPO = /\b(po|purchase.?order)\b/i.test(b.filename) ? 1 : 0;
      if (aIsPO !== bIsPO) return bIsPO - aIsPO;
      return b.size - a.size;
    });

    // Build document content blocks for all PDFs
    const documentBlocks: any[] = [];
    const pdfFilenames: string[] = [];
    for (const pdf of sortedPdfs) {
      try {
        const pdfBase64 = await getAttachment(messageId, pdf.attachmentId);
        documentBlocks.push({
          type: 'document',
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            data: pdfBase64,
          },
        });
        pdfFilenames.push(pdf.filename);
      } catch (err) {
        console.warn(`Failed to download attachment ${pdf.filename}:`, err);
      }
    }

    if (documentBlocks.length === 0) {
      return NextResponse.json({ error: 'Failed to download any PDF attachments' }, { status: 400 });
    }

    // Build the prompt — if multiple PDFs, tell Claude to find the PO
    const multiPdfNote = documentBlocks.length > 1
      ? `\n\nIMPORTANT: This email has ${documentBlocks.length} PDF attachments (${pdfFilenames.join(', ')}). One of them is the Purchase Order — find it and extract the data from it. Ignore non-PO attachments (spec sheets, drawings, BOLs, etc.).`
      : '';

    // Send to Claude API for extraction using native PDF support (with retry)
    const anthropicRes = await callAnthropicWithRetry({
      model: 'claude-sonnet-4-6',
      max_tokens: 8192,
      messages: [{
        role: 'user',
        content: [
          ...documentBlocks,
          {
            type: 'text',
            text: PO_EXTRACTION_PROMPT + multiPdfNote,
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
        attachment_filename: pdfFilenames.join(', '),
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
        attachment_filename: pdfFilenames.join(', '),
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
    const inputTokens = aiResult.usage?.input_tokens || 0;
    const outputTokens = aiResult.usage?.output_tokens || 0;

    console.log(`PO ${poNumber}: extracted ${extractedLines.length} lines, hasPricing=${hasPricing}, stopReason=${stopReason}, tokens=${inputTokens}/${outputTokens}`);

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
        attachment_filename: pdfFilenames.join(', '),
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

    // Note: $0.00 pricing is allowed — some POs arrive without pricing and can be edited after import
    if (!hasPricing && hasLines) {
      console.log(`PO ${poNumber}: all prices are $0.00 — proceeding (pricing can be added after import)`);
    }

    // If extractOnly mode, return the extracted data for user review/editing — don't create anything
    if (extractOnly) {
      await supabase.from('gmail_po_imports').upsert({
        message_id: messageId,
        thread_id: message.threadId,
        subject,
        from_email: from,
        received_at: date ? new Date(date).toISOString() : null,
        po_number: String(poNumber),
        attachment_filename: pdfFilenames.join(', '),
        status: 'pending',
        raw_extraction: extracted,
      }, { onConflict: 'message_id' });

      return NextResponse.json({
        status: 'review',
        poNumber,
        customer: extracted.customer || 'Unknown',
        ordered_date: extracted.ordered_date || null,
        extracted,
      });
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
        attachment_filename: pdfFilenames.join(', '),
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
        ordered_date: extracted.ordered_date || existingPO.ordered_date || null,
        notes: extracted.notes ? String(extracted.notes) : existingPO.notes,
        ship_to: extracted.ship_to || existingPO.ship_to || null,
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
          ...(catalogMatch?.id ? { catalog_id: catalogMatch.id } : {}),
          part_number: partNum,
          description: l.description || null,
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
        attachment_filename: pdfFilenames.join(', '),
        status: 'imported',
        raw_extraction: extracted,
      }, { onConflict: 'message_id' });

      // Identify unmatched parts for catalog addition
      const unmatchedParts = extractedLines
        .filter((l: any) => {
          const partNum = l.supplier_part || l.part_number;
          return !catalogItems.find((c: any) =>
            c.part_number.toUpperCase() === (partNum || '').toUpperCase() ||
            c.part_number.toUpperCase() === (l.part_number || '').toUpperCase()
          );
        })
        .map((l: any) => ({
          part_number: l.supplier_part || l.part_number,
          description: l.description || '',
          unit_price: parseFloat(l.unit_price) || 0,
        }));

      // Flag graphic parts (02/RM) for production review
      const flagResult2 = await flagGraphicParts(supabase, existingPO.id, String(poNumber), extracted.customer || existingPO.customer, extractedLines);

      return NextResponse.json({
        status: 'updated',
        poNumber,
        poId: existingPO.id,
        customer: extracted.customer || existingPO.customer,
        lineCount: lineInserts.length,
        unmatchedParts,
        extracted,
        flaggedGraphics: flagResult2.flaggedCount,
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
        ordered_date: extracted.ordered_date || null,
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
          attachment_filename: pdfFilenames.join(', '),
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
          ...(catalogMatch?.id ? { catalog_id: catalogMatch.id } : {}),
          part_number: partNum,
          description: l.description || null,
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
        attachment_filename: pdfFilenames.join(', '),
        status: 'imported',
        raw_extraction: extracted,
      }, { onConflict: 'message_id' });

      // Identify unmatched parts for catalog addition
      const unmatchedParts = extractedLines
        .filter((l: any) => {
          const partNum = l.supplier_part || l.part_number;
          return !catalogItems.find((c: any) =>
            c.part_number.toUpperCase() === (partNum || '').toUpperCase() ||
            c.part_number.toUpperCase() === (l.part_number || '').toUpperCase()
          );
        })
        .map((l: any) => ({
          part_number: l.supplier_part || l.part_number,
          description: l.description || '',
          unit_price: parseFloat(l.unit_price) || 0,
        }));

      // Flag graphic parts (02/RM) for production review
      const flagResult3 = await flagGraphicParts(supabase, newPO.id, String(poNumber), customer, extractedLines, adminUser?.id);

      return NextResponse.json({
        status: 'imported',
        poNumber,
        poId: newPO.id,
        customer,
        lineCount: lineInserts.length,
        unmatchedParts,
        extracted,
        flaggedGraphics: flagResult3.flaggedCount,
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
      attachment_filename: pdfFilenames.join(', '),
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
