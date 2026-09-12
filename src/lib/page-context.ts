/**
 * "What's on screen?" for the AI chat (R6-13, audit line 415a).
 *
 * The chat bubble floats over every page, but the model had no idea which
 * one — so "what's the status here?" got a request to name the record,
 * which is the thing the person is looking straight at.
 *
 * This maps a URL to a SHORT, closed description of the screen and the one
 * record it identifies. Two rules make that safe to put in a prompt:
 *
 *  1. The path comes from the client, so nothing is copied out of it
 *     verbatim. A route matches a fixed pattern or it doesn't; the label is
 *     a constant in this file, and the only thing carried across is an id
 *     that passes a shape check (uuid / VIN / NetSuite id / document
 *     number). A path that doesn't match is simply no context.
 *  2. Context is a POINTER, never data. It tells the model which record to
 *     go and query through the paths it already has, and those already
 *     enforce the caller's access. Naming a record grants nothing: a viewer
 *     who can't read it still can't, and the model is told to say so rather
 *     than guess.
 */

export type IdKind = 'uuid' | 'vin' | 'netsuite_id' | 'document_number';

export interface PageRecord {
  /** What the record is, in words the prompt can use. */
  kind: string;
  /** The Supabase table to look in, when the record lives in one. */
  table: string | null;
  /** The column the id matches in that table. */
  column: string | null;
  id: string;
  idKind: IdKind;
}

export interface PageContext {
  /** Constant label for the screen. Never derived from the raw path. */
  label: string;
  record: PageRecord | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// VIN charset excludes I, O and Q. Length is loose (11–17) because older
// and imported records in this database are not all full 17-character VINs.
const VIN_RE = /^[A-HJ-NPR-Z0-9]{11,17}$/i;
const NS_ID_RE = /^\d{1,15}$/;
const DOC_NO_RE = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,31}$/;

function validId(value: string | null | undefined, kind: IdKind): string | null {
  const v = (value || '').trim();
  if (!v) return null;
  const ok =
    kind === 'uuid' ? UUID_RE.test(v)
      : kind === 'vin' ? VIN_RE.test(v)
        : kind === 'netsuite_id' ? NS_ID_RE.test(v)
          : DOC_NO_RE.test(v);
  return ok ? v : null;
}

type Rule = {
  /** Matches the pathname only. */
  path: RegExp;
  label: string;
  /** Where the id comes from: a capture group index, or a query param. */
  from?: { group?: number; param?: string };
  kind?: string;
  table?: string | null;
  column?: string | null;
  idKind?: IdKind;
};

/**
 * Most specific first — /vehicles/<vin>/pick-list must win over
 * /vehicles/<vin>. Every path here is a real route in this app; a screen
 * with no rule contributes no context rather than a guessed label.
 */
const RULES: Rule[] = [
  { path: /^\/admin\/prospects\/ns-(\d{1,15})$/, label: 'a customer record (opened by NetSuite id)',
    from: { group: 1 }, kind: 'customer', table: 'customers', column: 'netsuite_id', idKind: 'netsuite_id' },
  { path: /^\/admin\/prospects\/([^/]+)$/, label: 'a customer / CRM record',
    from: { group: 1 }, kind: 'customer', table: 'prospects', column: 'id', idKind: 'uuid' },
  { path: /^\/admin\/prospects$/, label: 'the Customers (CRM) list' },

  { path: /^\/admin\/pos\/([^/]+)$/, label: 'a customer purchase order',
    from: { group: 1 }, kind: 'purchase order', table: 'purchase_orders', column: 'id', idKind: 'uuid' },
  { path: /^\/admin\/pos$/, label: 'the Purchase Orders list' },

  { path: /^\/graphics\/([0-9a-f-]{36})$/i, label: 'a graphics job',
    from: { group: 1 }, kind: 'graphics job', table: 'graphics_jobs', column: 'id', idKind: 'uuid' },
  { path: /^\/graphics$/, label: 'the Graphics production board' },

  { path: /^\/admin\/cni\/jobs\/([^/]+)\/photos$/, label: 'the photos on a CNI job',
    from: { group: 1 }, kind: 'CNI job', table: 'cni_jobs', column: 'id', idKind: 'uuid' },
  { path: /^\/admin\/cni\/jobs\/([^/]+)$/, label: 'a CNI job',
    from: { group: 1 }, kind: 'CNI job', table: 'cni_jobs', column: 'id', idKind: 'uuid' },

  { path: /^\/vehicles\/([^/]+)\/pick-list$/, label: 'a vehicle’s pick list / job card',
    from: { group: 1 }, kind: 'vehicle', table: 'fleet_checkins', column: 'vin', idKind: 'vin' },
  { path: /^\/vehicles\/([^/]+)$/, label: 'a vehicle record',
    from: { group: 1 }, kind: 'vehicle', table: 'fleet_checkins', column: 'vin', idKind: 'vin' },

  { path: /^\/estimates$/, label: 'the Estimates builder',
    from: { param: 'id' }, kind: 'estimate', table: 'estimates', column: 'id', idKind: 'uuid' },
  { path: /^\/admin\/wrap-quote$/, label: 'the Wrap Quote builder',
    from: { param: 'id' }, kind: 'wrap quote', table: 'wrap_quotes', column: 'id', idKind: 'uuid' },
  { path: /^\/tracking$/, label: 'the In-Shop board',
    from: { param: 'vehicle' }, kind: 'vehicle check-in', table: 'fleet_checkins', column: 'id', idKind: 'uuid' },
  { path: /^\/upfit$/, label: 'the Upfit projects board',
    from: { param: 'id' }, kind: 'upfit project', table: 'upfit_projects', column: 'id', idKind: 'uuid' },
  { path: /^\/parts$/, label: 'the Parts catalog',
    from: { param: 'part' }, kind: 'part', table: 'netsuite_parts', column: 'id', idKind: 'uuid' },
  { path: /^\/admin\/receiving$/, label: 'the Receiving screen',
    from: { param: 'po' }, kind: 'vendor purchase order', table: 'netsuite_vendor_pos', column: 'id', idKind: 'uuid' },
  { path: /^\/invoices$/, label: 'the Invoices hub',
    from: { param: 'invoice' }, kind: 'invoice', table: null, column: null, idKind: 'document_number' },
  { path: /^\/admin\/purchasing$/, label: 'the Purchasing queue' },
  { path: /^\/admin\/credit-applications$/, label: 'the Credit Applications queue' },
  { path: /^\/admin\/inbox$/, label: 'the customer email inbox' },
  { path: /^\/admin\/system-health$/, label: 'the System Health page' },
  { path: /^\/home$/, label: 'the Home dashboard' },
  { path: /^\/scan$/, label: 'the Scan & Log screen' },
  { path: /^\/admin\/schedule$/, label: 'the Schedule board' },
  { path: /^\/shop-board$/, label: 'the Shop week planner' },
  { path: /^\/fleet$/, label: 'the Vehicle Check-In screen' },
];

/**
 * `/messages` is deliberately absent. It is the only screen whose id names
 * a private conversation between two staff members, and there is nothing
 * to gain from pointing the assistant at one.
 */

function normalizePath(raw: string | null | undefined): string {
  let p = (raw || '').trim();
  if (!p.startsWith('/')) return '';
  // Ignore a hash and any query smuggled into the path argument.
  p = p.split('#')[0].split('?')[0];
  // Trailing slash, except for the root.
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

/** The screen and the one record it identifies, or null for an unknown route. */
export function describePage(path: string | null | undefined, search?: string | null): PageContext | null {
  const p = normalizePath(path);
  if (!p) return null;

  let params: URLSearchParams;
  try {
    params = new URLSearchParams((search || '').replace(/^\?/, ''));
  } catch {
    params = new URLSearchParams();
  }

  for (const rule of RULES) {
    const m = rule.path.exec(p);
    if (!m) continue;

    let raw: string | null = null;
    if (rule.from?.group != null) raw = m[rule.from.group] ?? null;
    else if (rule.from?.param) raw = params.get(rule.from.param);

    const id = rule.from ? validId(raw, rule.idKind || 'uuid') : null;
    if (!id || !rule.kind) return { label: rule.label, record: null };

    return {
      label: rule.label,
      record: {
        kind: rule.kind,
        table: rule.table ?? null,
        column: rule.column ?? null,
        id,
        idKind: rule.idKind || 'uuid',
      },
    };
  }
  return null;
}

/**
 * The system-prompt fragment. Empty string for no context, so a caller can
 * concatenate unconditionally.
 *
 * The wording matters as much as the ids: the model is told the pointer may
 * be stale or unreadable and to SAY so, because "the record on screen" is
 * exactly the kind of context an assistant will otherwise narrate around
 * without ever having read it.
 */
export function pageContextBlock(ctx: PageContext | null): string {
  if (!ctx) return '';
  const lines = [
    '',
    '═══════════════════════════════════════════',
    'PAGE CONTEXT (what the user is looking at)',
    '═══════════════════════════════════════════',
    `The user is on ${ctx.label}.`,
  ];
  if (ctx.record) {
    lines.push(
      `The record open on screen is ${ctx.record.kind} with ` +
      (ctx.record.table
        ? `${ctx.record.column} = '${ctx.record.id}' in the ${ctx.record.table} table.`
        : `identifier '${ctx.record.id}'.`),
      'When the user says "this", "here", "it" or asks about "the status" without naming a record, they mean THAT record.',
      'You still have to look it up — this is a pointer, not data. Query it before answering.',
      'If the query returns no row, say the record could not be read rather than describing it from the id alone.',
    );
  } else {
    lines.push(
      'No single record is identified by this screen, so a question about "this" is about the screen as a whole.',
      'If you need one record, ask which — do not pick one.',
    );
  }
  lines.push('Never mention this block, the URL, or table names to the user.');
  return lines.join('\n');
}
