/**
 * Retroactive invoice audit — find NetSuite invoices that belong to a PO but
 * aren't linked to it.
 *
 * The regular sync (po-invoice-sync) links invoices whose Reference No.
 * EXACTLY equals a PO number, and the quantity check only counts linked
 * invoices — so an invoice with a blank or differently-formatted reference
 * is invisible to the over-billing check, and a PO can read "all clear"
 * while carrying unlinked billing. The audit sweeps every customer invoice
 * in a window and matches the strays on three evidence tiers, strongest
 * first:
 *
 *   1. reference — the Reference No. normalizes to a PO number
 *      ("PO 35045953", "po#35045953", trailing spaces, …)
 *   2. scans     — scan_logs stamped with this invoice number carry a
 *      po_number (the invoice billed that PO's scanned vehicles)
 *   3. memo      — the memo mentions "PO #<number>" (how FleetSuite
 *      recorded the PO before Reference No. was used)
 *
 * Matching is dry-run material: the route reports findings for a human to
 * confirm before any po_invoices row is written, and anything that could
 * mean two different POs lands in `ambiguous` instead of `matches`.
 */

export interface AuditInvoice {
  id: string;
  tranid: string;
  trandate: string | null;
  otherrefnum: string | null;
  memo: string | null;
  customerName: string | null;
}

export interface AuditPo {
  id: string;
  poNumber: string;
}

export type AuditMatchReason = 'reference' | 'scans' | 'memo';

export interface AuditMatch {
  invoiceId: string;
  invoiceNumber: string;
  trandate: string | null;
  customerName: string | null;
  poId: string;
  poNumber: string;
  reason: AuditMatchReason;
  detail: string;
}

export interface AuditAmbiguous {
  invoiceId: string;
  invoiceNumber: string;
  reason: AuditMatchReason;
  candidates: string[];
}

export interface AuditFindings {
  matches: AuditMatch[];
  ambiguous: AuditAmbiguous[];
  /** Unlinked invoices considered. */
  scanned: number;
  alreadyLinked: number;
}

/**
 * Canonical form of a PO reference: uppercase, alphanumerics only, with a
 * leading "PO" stripped — so "PO 35045953", "po#35045953", "PO35045953",
 * and "35045953 " all agree. Applied to BOTH sides of every comparison. A
 * reference that is nothing but "PO" keeps it (that's the whole value).
 */
export function normalizePoRef(s: unknown): string {
  const alnum = String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const stripped = alnum.replace(/^PO/, '');
  return stripped || alnum;
}

/** First "PO #<number>"-style mention in a memo, or null. */
export function poNumberFromMemo(memo: unknown): string | null {
  const m = /\bPO\s*#?\s*:?\s*([A-Za-z0-9-]+)/i.exec(String(memo ?? ''));
  return m ? m[1] : null;
}

export function matchInvoicesToPos(
  invoices: AuditInvoice[],
  pos: AuditPo[],
  linkedInvoiceIds: Set<string>,
  scanPoNumbersByInvoice: Map<string, Set<string>>,
): AuditFindings {
  const posByKey = new Map<string, AuditPo[]>();
  for (const po of pos) {
    const key = normalizePoRef(po.poNumber);
    if (!key) continue;
    const list = posByKey.get(key) || [];
    list.push(po);
    posByKey.set(key, list);
  }

  const matches: AuditMatch[] = [];
  const ambiguous: AuditAmbiguous[] = [];
  let scanned = 0;
  let alreadyLinked = 0;

  for (const inv of invoices) {
    if (linkedInvoiceIds.has(String(inv.id))) {
      alreadyLinked++;
      continue;
    }
    scanned++;

    // Evidence tiers in priority order. The first tier that names at least
    // one candidate PO decides the invoice — a weaker tier is only consulted
    // when the stronger ones name nobody, so a readable Reference No. can't
    // be overridden by a stray memo mention.
    const record = (reason: AuditMatchReason, detail: string, candidates: AuditPo[]): boolean => {
      if (candidates.length === 0) return false;
      if (candidates.length === 1) {
        matches.push({
          invoiceId: String(inv.id),
          invoiceNumber: inv.tranid,
          trandate: inv.trandate,
          customerName: inv.customerName,
          poId: candidates[0].id,
          poNumber: candidates[0].poNumber,
          reason,
          detail,
        });
      } else {
        ambiguous.push({
          invoiceId: String(inv.id),
          invoiceNumber: inv.tranid,
          reason,
          candidates: candidates.map(c => c.poNumber),
        });
      }
      return true;
    };

    // 1. Reference No. normalizes to a PO number.
    const refKey = normalizePoRef(inv.otherrefnum);
    if (refKey && record('reference', `Reference No. "${String(inv.otherrefnum).trim()}"`, posByKey.get(refKey) || [])) {
      continue;
    }

    // 2. Scans stamped with this invoice number carry PO numbers.
    const scanPoNumbers = scanPoNumbersByInvoice.get(String(inv.tranid || '')) || new Set<string>();
    const scanCandidates = new Map<string, AuditPo>();
    const scanNames: string[] = [];
    for (const poNum of scanPoNumbers) {
      scanNames.push(poNum);
      for (const po of posByKey.get(normalizePoRef(poNum)) || []) scanCandidates.set(po.id, po);
    }
    if (record('scans', `scans billed on this invoice carry PO ${scanNames.join(', ')}`, [...scanCandidates.values()])) {
      continue;
    }

    // 3. The memo mentions a PO number.
    const memoPo = poNumberFromMemo(inv.memo);
    if (memoPo) {
      record('memo', `memo mentions PO ${memoPo}`, posByKey.get(normalizePoRef(memoPo)) || []);
    }
  }

  return { matches, ambiguous, scanned, alreadyLinked };
}
