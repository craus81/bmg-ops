import { NextRequest, NextResponse } from 'next/server';
import { searchPOEmails, getMessage, getPdfAttachments, getHeader } from '@/lib/google';
import { createClient } from '@supabase/supabase-js';
import { requireAuth } from '@/lib/api-auth';

export const dynamic = 'force-dynamic';

// Search Gmail for PO emails and return unimported ones
export async function GET(req: NextRequest) {
  try {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    // Get days parameter (default 90 for manual search, cron uses 1)
    const days = parseInt(req.nextUrl.searchParams.get('days') || '90');
    const afterDate = new Date();
    afterDate.setDate(afterDate.getDate() - days);
    const afterStr = `${afterDate.getFullYear()}/${afterDate.getMonth() + 1}/${afterDate.getDate()}`;

    // Search Gmail
    const messages = await searchPOEmails(afterStr);

    if (messages.length === 0) {
      return NextResponse.json({ emails: [], newCount: 0 });
    }

    // Get already-imported message IDs
    const messageIds = messages.map((m: any) => m.id);
    const { data: existing } = await supabase
      .from('gmail_po_imports')
      .select('message_id')
      .in('message_id', messageIds);
    const importedSet = new Set((existing || []).map((e: any) => e.message_id));

    // Also get existing PO numbers to detect duplicates
    const { data: existingPOs } = await supabase
      .from('purchase_orders')
      .select('po_number');
    const existingPoNumbers = new Set((existingPOs || []).map((p: any) => p.po_number));

    // Fetch details for unimported messages
    const emails = [];
    for (const msg of messages) {
      const id = msg.id!;
      const alreadyImported = importedSet.has(id);

      const full = await getMessage(id);
      const subject = getHeader(full, 'Subject');
      const from = getHeader(full, 'From');
      const date = getHeader(full, 'Date');
      const pdfs = getPdfAttachments(full);

      // Extract PO number from subject
      const poMatch = subject.match(/(?:PO\s*#?\s*)(\d{5,})/i) ||
                       subject.match(/Purchase\s*Order\s*#?\s*(\w+)/i) ||
                       subject.match(/PO\s*(\d{5,})/i);
      const poNumber = poMatch ? poMatch[1] : null;

      // Parse sender name
      const fromMatch = from.match(/"?([^"<]+)"?\s*</);
      const fromName = fromMatch ? fromMatch[1].trim() : from;
      const fromEmail = from.match(/<([^>]+)>/)?.[1] || from;

      // Determine customer from sender
      let customer = 'Unknown';
      if (fromEmail.toLowerCase().includes('masterack') || fromEmail.toLowerCase().includes('jbpco')) {
        customer = 'Masterack';
      } else if (fromEmail.toLowerCase().includes('geappliances')) {
        customer = 'GE Appliances';
      } else if (fromEmail.toLowerCase().includes('buyersproducts')) {
        customer = 'Buyers Products';
      } else if (fromEmail.toLowerCase().includes('grimco')) {
        customer = 'Grimco';
      }

      const alreadyInSystem = poNumber ? existingPoNumbers.has(poNumber) : false;

      emails.push({
        messageId: id,
        threadId: msg.threadId,
        subject,
        from: fromName,
        fromEmail,
        date,
        customer,
        poNumber,
        pdfs: pdfs.map(p => ({ filename: p.filename, size: p.size })),
        alreadyImported,
        alreadyInSystem,
      });
    }

    const newCount = emails.filter(e => !e.alreadyImported && !e.alreadyInSystem && e.pdfs.length > 0).length;

    return NextResponse.json({ emails, newCount });
  } catch (err: any) {
    if (err.message === 'NO_GOOGLE_TOKEN') {
      return NextResponse.json({ error: 'Gmail not connected. Please authorize first.', needsAuth: true }, { status: 401 });
    }
    console.error('Gmail search error:', err);
    return NextResponse.json({ error: err.message || 'Failed to search Gmail' }, { status: 500 });
  }
}
