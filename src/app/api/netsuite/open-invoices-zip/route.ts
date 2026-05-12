import { NextRequest, NextResponse } from 'next/server';
import JSZip from 'jszip';
import { suiteqlQuery, getNetSuitePdf } from '@/lib/netsuite';
import { requireAuth } from '@/lib/api-auth';
import { safeIntId, SqlSafeError } from '@/lib/sql-safe';

export const dynamic = 'force-dynamic';
// PDF fetches dominate runtime — give the request room before Vercel kills it.
export const maxDuration = 60;

// Hard cap. Beyond this we'd blow Vercel's per-request limit and the user
// should switch to a background job. ~50 invoices at 5-concurrency takes
// roughly 10s of NetSuite time on average.
const MAX_INVOICES = 60;
const PDF_CONCURRENCY = 5;

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80) || 'customer';
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  try {
    const customerId = safeIntId(req.nextUrl.searchParams.get('customerId'), 'customerId');

    // Pull open invoices with their balance. In this NetSuite install
    // the open-invoice status key is 'A' (see /api/netsuite/invoices
    // STATUS_MAP and AI-agent reference queries).
    const listQuery = `
      SELECT
        t.id,
        t.tranid,
        t.trandate,
        t.foreigntotal AS total,
        BUILTIN.DF(t.entity) AS customer_name
      FROM transaction t
      WHERE t.entity = ${customerId}
        AND t.type = 'CustInvc'
        AND t.status = 'A'
      ORDER BY t.trandate DESC
    `;
    const listResult = await suiteqlQuery(listQuery, MAX_INVOICES + 1);
    const invoices = (listResult?.items || []) as Array<{
      id: string;
      tranid: string;
      trandate: string;
      total: string;
      customer_name: string;
    }>;

    if (invoices.length === 0) {
      return NextResponse.json({ error: 'No open invoices for this customer.' }, { status: 404 });
    }
    if (invoices.length > MAX_INVOICES) {
      return NextResponse.json({
        error: `Customer has ${invoices.length} open invoices, which is over the ${MAX_INVOICES} synchronous limit. Trim the list or run as a background job.`,
      }, { status: 413 });
    }

    const customerName = invoices[0]?.customer_name || `customer-${customerId}`;

    // Fetch PDFs with a small concurrency cap so we don't hammer NetSuite.
    const results: Array<{ tranid: string; pdfBase64?: string; error?: string }> = [];
    for (let i = 0; i < invoices.length; i += PDF_CONCURRENCY) {
      const batch = invoices.slice(i, i + PDF_CONCURRENCY);
      const batchResults = await Promise.all(batch.map(async (inv) => {
        const r = await getNetSuitePdf('invoice', inv.id);
        return {
          tranid: inv.tranid,
          pdfBase64: r.success ? r.pdfBase64 : undefined,
          error: r.success ? undefined : (r.error || 'PDF fetch failed'),
        };
      }));
      results.push(...batchResults);
    }

    const failures = results.filter(r => !r.pdfBase64);
    if (failures.length > 0) {
      return NextResponse.json({
        error: `Failed to fetch ${failures.length} of ${results.length} invoice PDFs.`,
        failed: failures.map(f => ({ tranid: f.tranid, error: f.error })),
      }, { status: 502 });
    }

    const zip = new JSZip();
    for (const r of results) {
      zip.file(`INV-${r.tranid}.pdf`, Buffer.from(r.pdfBase64!, 'base64'));
    }
    const zipBuf = await zip.generateAsync({ type: 'nodebuffer' });

    const filename = `${sanitizeFilename(customerName)}-open-invoices.zip`;
    return new NextResponse(zipBuf as any, {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': String(zipBuf.length),
      },
    });
  } catch (e: any) {
    if (e instanceof SqlSafeError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    console.error('open-invoices-zip error:', e);
    return NextResponse.json({ error: e.message || 'Failed to build zip' }, { status: 500 });
  }
}
