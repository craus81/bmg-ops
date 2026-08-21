import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { suiteqlQuery } from '@/lib/netsuite';
import { requireStaff } from '@/lib/api-auth';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * GET /api/parts/transactions?itemId=<NetSuite item internal id>
 *
 * Every customer-side NetSuite transaction a part appears on — invoices,
 * sales orders, estimates — newest first (field ask, 2026-08-21: "parts
 * catalog should give me a link to all transactions that the parts have
 * been involved with"). Feeds the Transactions modal on the parts catalog,
 * which offers the record PDF and a packing list per row.
 */
export async function GET(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const itemId = req.nextUrl.searchParams.get('itemId') || '';
  if (!/^\d{1,15}$/.test(itemId)) {
    return NextResponse.json({ error: 'Invalid item id' }, { status: 400 });
  }

  // Quantity is stored negative for sales transactions; flip for display.
  const query = `
    SELECT
      t.id,
      t.tranid,
      t.type,
      t.trandate,
      t.otherrefnum,
      c.companyname AS customer_name,
      SUM(-tl.quantity) AS quantity
    FROM transaction t
    INNER JOIN transactionline tl
      ON tl.transaction = t.id
    LEFT JOIN customer c
      ON c.id = t.entity
    WHERE tl.item = ${itemId}
      AND tl.mainline = 'F'
      AND tl.taxline = 'F'
      AND t.type IN ('CustInvc', 'SalesOrd', 'Estimate')
    GROUP BY t.id, t.tranid, t.type, t.trandate, t.otherrefnum, c.companyname
    ORDER BY t.trandate DESC, t.id DESC
    FETCH FIRST 200 ROWS ONLY
  `;

  try {
    interface TxOut {
      id: string; tranid: string; type: string; date: string | null;
      poNumber: string | null; customer: string | null; quantity: number;
      graphicsJob: { id: string; jobNumber: string | null; title: string | null } | null;
    }
    const result = await suiteqlQuery(query);
    const transactions: TxOut[] = (result?.items || []).map((r: any) => ({
      id: String(r.id),
      tranid: r.tranid || '',
      type: r.type || '',
      date: r.trandate || null,
      poNumber: r.otherrefnum || null,
      customer: r.customer_name || null,
      quantity: parseFloat(r.quantity || '0') || 0,
      graphicsJob: null,
    }));

    // Attach the FleetSuite graphics job behind each transaction, so the
    // modal can jump from an invoice straight to the job that produced it
    // (field ask 2026-08-21: "open a graphics job from an invoice...look at
    // the graphics job that was created for that invoice"). Invoices link
    // directly (graphics_jobs.netsuite_invoice_id); estimates and sales
    // orders link through the FleetSuite estimate the job came from.
    try {
      const supabase = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!,
      );
      const jobByTxId = new Map<string, { id: string; jobNumber: string | null; title: string | null }>();

      const invoiceIds = transactions.filter(t => t.type === 'CustInvc').map(t => t.id);
      if (invoiceIds.length > 0) {
        const { data } = await supabase
          .from('graphics_jobs')
          .select('id, job_number, title, netsuite_invoice_id')
          .in('netsuite_invoice_id', invoiceIds);
        for (const j of data || []) {
          const key = String(j.netsuite_invoice_id);
          if (!jobByTxId.has(key)) jobByTxId.set(key, { id: j.id, jobNumber: j.job_number, title: j.title });
        }
      }

      const estimateNsIds = transactions.filter(t => t.type === 'Estimate').map(t => t.id);
      const soNsIds = transactions.filter(t => t.type === 'SalesOrd').map(t => t.id);
      if (estimateNsIds.length > 0 || soNsIds.length > 0) {
        const estRows: { id: string; netsuite_estimate_id: string | null; netsuite_so_id: string | null }[] = [];
        if (estimateNsIds.length > 0) {
          const { data } = await supabase
            .from('estimates').select('id, netsuite_estimate_id, netsuite_so_id')
            .in('netsuite_estimate_id', estimateNsIds);
          estRows.push(...(data || []));
        }
        if (soNsIds.length > 0) {
          const { data } = await supabase
            .from('estimates').select('id, netsuite_estimate_id, netsuite_so_id')
            .in('netsuite_so_id', soNsIds);
          estRows.push(...(data || []));
        }
        if (estRows.length > 0) {
          const { data: jobs } = await supabase
            .from('graphics_jobs')
            .select('id, job_number, title, estimate_id')
            .in('estimate_id', estRows.map(e => e.id));
          const jobByEstimate = new Map<string, { id: string; jobNumber: string | null; title: string | null }>();
          for (const j of jobs || []) {
            if (j.estimate_id && !jobByEstimate.has(j.estimate_id)) {
              jobByEstimate.set(j.estimate_id, { id: j.id, jobNumber: j.job_number, title: j.title });
            }
          }
          for (const e of estRows) {
            const job = jobByEstimate.get(e.id);
            if (!job) continue;
            if (e.netsuite_estimate_id && !jobByTxId.has(String(e.netsuite_estimate_id))) {
              jobByTxId.set(String(e.netsuite_estimate_id), job);
            }
            if (e.netsuite_so_id && !jobByTxId.has(String(e.netsuite_so_id))) {
              jobByTxId.set(String(e.netsuite_so_id), job);
            }
          }
        }
      }

      for (const tx of transactions) {
        tx.graphicsJob = jobByTxId.get(tx.id) || null;
      }
    } catch {
      // Job linkage is best-effort — the transaction list stands on its own.
    }

    return NextResponse.json({ transactions });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || 'NetSuite query failed' }, { status: 500 });
  }
}
