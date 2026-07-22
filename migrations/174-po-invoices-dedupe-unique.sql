-- Duplicate NetSuite invoice links piling up on POs: the cron sweep's dedup
-- check loaded po_invoices with an unpaginated select, which Supabase caps
-- at 1000 rows. Once the table outgrew the cap, rows past it were invisible
-- to the dedup map, so the sweep re-linked the same invoices on every run
-- (a fresh duplicate per invoice per sweep). Clean out the accumulated
-- duplicates — keeping the oldest row per (PO, invoice), i.e. the original
-- link — then add a unique index so a duplicate link can never be inserted
-- again. The sync code now paginates its reads and upserts against this
-- index (ON CONFLICT DO NOTHING).
DELETE FROM po_invoices
WHERE id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY purchase_order_id, netsuite_invoice_id
      ORDER BY created_at ASC NULLS LAST, id
    ) AS rn
    FROM po_invoices
  ) ranked
  WHERE rn > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_po_invoices_po_ns_invoice
  ON po_invoices(purchase_order_id, netsuite_invoice_id);
