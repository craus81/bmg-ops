import { NextRequest, NextResponse } from 'next/server';
import { searchPOEmails, getMessage, getPdfAttachments, getHeader } from '@/lib/google';
import { createClient } from '@supabase/supabase-js';

// This route is called by Vercel Cron every hour
// It searches Gmail for new PO emails and auto-imports them

export async function GET(req: NextRequest) {
  // Verify cron secret (optional security)
  const authHeader = req.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    // Allow without secret for manual triggers from the app
    const isManual = req.nextUrl.searchParams.get('manual') === 'true';
    if (!isManual) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  try {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    // Search last 2 days of emails (overlap to catch anything missed)
    const afterDate = new Date();
    afterDate.setDate(afterDate.getDate() - 2);
    const afterStr = `${afterDate.getFullYear()}/${afterDate.getMonth() + 1}/${afterDate.getDate()}`;

    const messages = await searchPOEmails(afterStr);
    if (messages.length === 0) {
      return NextResponse.json({ message: 'No PO emails found', imported: 0, skipped: 0 });
    }

    // Get already-processed message IDs
    const messageIds = messages.map((m: any) => m.id);
    const { data: existing } = await supabase
      .from('gmail_po_imports')
      .select('message_id, status')
      .in('message_id', messageIds);
    const processedMap = new Map((existing || []).map((e: any) => [e.message_id, e.status]));

    // Get existing PO numbers
    const { data: existingPOs } = await supabase
      .from('purchase_orders')
      .select('po_number');
    const existingPoNumbers = new Set((existingPOs || []).map((p: any) => p.po_number));

    // Get catalog for part matching
    const { data: catalogData } = await supabase.from('catalog').select('*').eq('active', true);
    const catalogItems = catalogData || [];

    let imported = 0;
    let skipped = 0;
    let errors = 0;
    const results: any[] = [];

    for (const msg of messages) {
      const id = msg.id!;

      // Skip already processed
      const existingStatus = processedMap.get(id);
      if (existingStatus === 'imported' || existingStatus === 'skipped') {
        skipped++;
        continue;
      }

      try {
        // Call the import-po endpoint in extractOnly mode — queue for manual review
        const importRes = await fetch(new URL('/api/gmail/import-po', req.url), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messageId: id, extractOnly: true }),
        });

        const result = await importRes.json();

        if (result.status === 'imported' || result.status === 'review') {
          imported++;
          results.push({ messageId: id, status: result.status, poNumber: result.poNumber || result.extracted?.po_number });
        } else if (result.status === 'skipped' || result.status === 'exists') {
          skipped++;
          results.push({ messageId: id, status: 'skipped', reason: result.reason });
        } else {
          errors++;
          results.push({ messageId: id, status: 'error', error: result.error });
        }
      } catch (err: any) {
        errors++;
        results.push({ messageId: id, status: 'error', error: err.message });
      }

      // Small delay between imports to avoid rate limits
      await new Promise(r => setTimeout(r, 1000));
    }

    // Send notification to users who opted in for PO alerts
    if (imported > 0) {
      const { data: poPrefs } = await supabase
        .from('notification_preferences')
        .select('user_id')
        .eq('notify_new_po', true);
      const adminIds = (poPrefs || []).map((p: any) => p.user_id);
      if (adminIds.length > 0) {
        const poNumbers = results
          .filter((r: any) => r.status === 'review' || r.status === 'imported')
          .map((r: any) => r.poNumber)
          .filter(Boolean)
          .join(', ');
        fetch(new URL('/api/notifications/send', req.url), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userIds: adminIds,
            type: 'po_pending',
            title: `${imported} new PO${imported !== 1 ? 's' : ''} pending review`,
            body: poNumbers ? `PO #${poNumbers}` : 'New purchase orders found in Gmail',
            url: '/admin/pos',
          }),
        }).catch(() => {});
      }
    }

    return NextResponse.json({
      message: `Processed ${messages.length} emails`,
      imported,
      skipped,
      errors,
      results,
    });
  } catch (err: any) {
    if (err.message === 'NO_GOOGLE_TOKEN') {
      return NextResponse.json({ error: 'Gmail not connected', needsAuth: true }, { status: 401 });
    }
    console.error('Auto-import error:', err);
    return NextResponse.json({ error: err.message || 'Auto-import failed' }, { status: 500 });
  }
}
