import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { r2Get } from '@/lib/r2';
import { requireAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';

// Mirrors the ship-to portion of the Gmail import prompt so manual PDF
// uploads pull the same field. We only consume `ship_to` from the response,
// but Claude's accuracy holds up better when given the full context, so we
// keep the prompt close to the import-po one.
const SHIP_TO_PROMPT = `You are extracting the ship-to address from a Purchase Order PDF.

A PO usually shows TWO address blocks:
- The supplier/vendor address (BMG Fleet Installation) — IGNORE this.
- The "Ship To" or "Deliver To" address (the actual destination — a customer
  facility, dealership, or job site) — RETURN this.

Never return BMG Fleet Installation's own address as the ship_to.

Return ONLY valid JSON, no markdown, no backticks, no other text:
{
  "ship_to": {
    "name": "Masterack - Kansas City",
    "address": "1234 Industrial Blvd",
    "city": "Kansas City",
    "state": "MO",
    "zip": "64101"
  }
}

If the PDF does not appear to be a Purchase Order or no ship-to is found,
return: {"ship_to": null}`;

const BodySchema = z.object({
  poId: z.string().uuid(),
  storagePath: z.string().min(1),
});

async function callAnthropic(body: any, apiKey: string): Promise<Response> {
  return fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'pdfs-2024-09-25',
    },
    body: JSON.stringify(body),
  });
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, BodySchema);
  if (parsed.error) return parsed.error;
  const { poId, storagePath } = parsed.data;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY not configured' }, { status: 500 });
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  // The PDF lives in R2 (bucket name as key prefix) — the raw supabase-js
  // download() targeted a Supabase bucket that doesn't hold it.
  const dl = await r2Get('graphics-proofs', storagePath);
  if (!dl.success || !dl.body) {
    return NextResponse.json({ error: 'Failed to download PDF', details: dl.error }, { status: 500 });
  }
  const chunks: Buffer[] = [];
  const reader = dl.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(Buffer.from(value));
  }
  const pdfBase64 = Buffer.concat(chunks).toString('base64');

  const aiRes = await callAnthropic({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
        { type: 'text', text: SHIP_TO_PROMPT },
      ],
    }],
  }, apiKey);

  if (!aiRes.ok) {
    const errBody = await aiRes.text();
    return NextResponse.json({ error: 'AI extraction failed', details: errBody }, { status: 500 });
  }

  const aiJson = await aiRes.json();
  const aiText = aiJson.content?.[0]?.text || '';

  let extracted: any;
  try {
    let jsonStr = aiText;
    const codeBlockMatch = aiText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      jsonStr = codeBlockMatch[1];
    } else {
      const jsonMatch = aiText.match(/\{[\s\S]*\}/);
      if (jsonMatch) jsonStr = jsonMatch[0];
    }
    extracted = JSON.parse(jsonStr);
  } catch {
    return NextResponse.json({ error: 'Could not parse AI response', raw: aiText }, { status: 500 });
  }

  const shipTo = extracted?.ship_to;
  if (!shipTo || typeof shipTo !== 'object') {
    return NextResponse.json({ ship_to: null });
  }

  const { error: updateErr } = await supabase
    .from('purchase_orders')
    .update({ ship_to: shipTo })
    .eq('id', poId);

  if (updateErr) {
    return NextResponse.json({ error: 'Failed to save ship-to', details: updateErr.message }, { status: 500 });
  }

  return NextResponse.json({ ship_to: shipTo });
}
