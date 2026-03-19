import { NextRequest, NextResponse } from 'next/server';
import { getMessage, getPdfAttachments, getAttachment, getHeader } from '@/lib/google';
import { createClient } from '@supabase/supabase-js';

const PO_EXTRACTION_PROMPT = `You are extracting purchase order data from a PDF document. Extract ALL information accurately.

Return JSON only, no other text, in this exact format:
{
  "po_number": "35045953",
  "customer": "Masterack",
  "ordered_date": "03/18/2026",
  "ship_to": {
    "name": "BMG Fleet Installation",
    "address": "123 Main St",
    "city": "Indianapolis",
    "state": "IN",
    "zip": "46201"
  },
  "lines": [
    {
      "line_no": "1",
      "part_number": "06T278",
      "supplier_part": "06T278",
      "description": "Transit Van Graphic Kit",
      "quantity": 10,
      "unit_price": 45.00,
      "delivery_date": "03/25/2026"
    }
  ],
  "notes": "Any special instructions or notes from the PO"
}

IMPORTANT RULES:
- Extract ALL line items, not just the first few
- Part numbers are alphanumeric codes (e.g., 06T278, RM530432, 065058)
- Quantities are whole numbers
- Prices should be numeric (no $ signs)
- If a field is not present, use null
- For the customer field, use the company name from the "Ship To" or "Buyer" section
- The PO number is usually prominently displayed at the top`;

export async function POST(req: NextRequest) {
  try {
    const { messageId, autoCreate } = await req.json();
    if (!messageId) {
      return NextResponse.json({ error: 'messageId required' }, { status: 400 });
    }

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    // Check if already imported
    const { data: existingImport } = await supabase
      .from('gmail_po_imports')
      .select('*')
      .eq('message_id', messageId)
      .eq('status', 'imported')
      .maybeSingle();

    if (existingImport) {
      return NextResponse.json({ error: 'Already imported', import: existingImport }, { status: 409 });
    }

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

    // Convert base64 PDF to page images using a different approach
    // We'll send the PDF as a document to Claude API (with beta header)
    // Actually, let's render pages to images server-side
    // For server-side, we'll send the raw PDF base64 to Claude with document type

    // Send to Claude Vision API for extraction
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY!,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'pdfs-2024-09-25',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 4096,
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
      }),
    });

    if (!anthropicRes.ok) {
      const errBody = await anthropicRes.text();
      console.error('Anthropic API error:', errBody);

      // Record the error
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
      const jsonMatch = aiText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON found in AI response');
      extracted = JSON.parse(jsonMatch[0]);
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

    // Check if PO already exists
    const { data: existingPO } = await supabase
      .from('purchase_orders')
      .select('id, po_number')
      .eq('po_number', poNumber)
      .maybeSingle();

    if (existingPO) {
      // Record as skipped
      await supabase.from('gmail_po_imports').upsert({
        message_id: messageId,
        thread_id: message.threadId,
        subject,
        from_email: from,
        received_at: date ? new Date(date).toISOString() : null,
        po_number: poNumber,
        po_id: existingPO.id,
        attachment_filename: targetPdf.filename,
        status: 'skipped',
        error_message: 'PO already exists',
        raw_extraction: extracted,
      }, { onConflict: 'message_id' });

      return NextResponse.json({
        status: 'skipped',
        reason: 'PO already exists',
        poNumber,
        poId: existingPO.id,
        extracted
      });
    }

    // Auto-create the PO if requested
    if (autoCreate !== false) {
      // Get catalog for part matching
      const { data: catalogData } = await supabase.from('catalog').select('*').eq('active', true);
      const catalogItems = catalogData || [];

      // Create the PO
      const customer = extracted.customer || 'Unknown';

      // Get any admin user to use as created_by (FK constraint may require valid user)
      const { data: adminUser } = await supabase
        .from('profiles')
        .select('id')
        .eq('role', 'admin')
        .limit(1)
        .single();

      const insertPayload: any = {
        po_number: poNumber,
        customer,
        notes: extracted.notes ? String(extracted.notes) : null,
      };
      // Only include created_by if we found a valid user
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
          po_number: poNumber,
          attachment_filename: targetPdf.filename,
          status: 'error',
          error_message: `Failed to create PO: ${poError?.message}`,
          raw_extraction: extracted,
        }, { onConflict: 'message_id' });

        return NextResponse.json({ error: 'Failed to create PO', details: poError?.message }, { status: 500 });
      }

      // Create line items
      const lines = (extracted.lines || []).filter((l: any) => l.part_number);
      const lineInserts = lines.map((l: any) => {
        // Try to match to catalog
        const catalogMatch = catalogItems.find((c: any) =>
          c.part_number.toUpperCase() === (l.part_number || '').toUpperCase() ||
          c.part_number.toUpperCase() === (l.supplier_part || '').toUpperCase()
        );

        return {
          po_id: newPO.id,
          catalog_id: catalogMatch?.id || null,
          part_number: l.part_number,
          quantity: parseInt(l.quantity) || 0,
          unit_price: parseFloat(l.unit_price) || 0,
        };
      });

      if (lineInserts.length > 0) {
        await supabase.from('po_line_items').insert(lineInserts);
      }

      // Record successful import
      await supabase.from('gmail_po_imports').upsert({
        message_id: messageId,
        thread_id: message.threadId,
        subject,
        from_email: from,
        received_at: date ? new Date(date).toISOString() : null,
        po_number: poNumber,
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

    // Just return the extracted data without creating
    await supabase.from('gmail_po_imports').upsert({
      message_id: messageId,
      thread_id: message.threadId,
      subject,
      from_email: from,
      received_at: date ? new Date(date).toISOString() : null,
      po_number: poNumber,
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
