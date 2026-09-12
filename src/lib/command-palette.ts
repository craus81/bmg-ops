/**
 * Command palette support — the "recently opened" list and the per-type
 * quick actions that turn the universal search from a finder into a
 * launcher (R6-13, audit line 416).
 *
 * Pure except for the four localStorage accessors, which take an injectable
 * store so every rule here can be asserted without a browser.
 *
 * Two honesty rules run through the whole file:
 *
 *   1. A quick action renders ONLY when its destination genuinely works for
 *      this viewer AND this record — the feature/role the destination page
 *      gates on is held, and the record carries the field the URL needs. An
 *      action that 403s, 400s or lands on an empty page is a dead click, and
 *      a launcher full of dead clicks is worse than no launcher.
 *   2. Recents are filtered through the same access rules on the way OUT, so
 *      a record opened while you held a feature stops being offered once you
 *      don't.
 */

import { deepLinks } from '@/lib/deep-links';
import { estimateHeadlineNumber } from '@/lib/estimate-number';
import type { FeatureKey } from '@/lib/features';

/** The result groups the universal search returns. */
export type RecentKind =
  | 'purchase_orders'
  | 'vehicles'
  | 'graphics_jobs'
  | 'estimates'
  | 'parts'
  | 'customers'
  | 'messages'
  | 'quotes'
  | 'invoices';

const KINDS = new Set<string>([
  'purchase_orders', 'vehicles', 'graphics_jobs', 'estimates',
  'parts', 'customers', 'messages', 'quotes', 'invoices',
]);

/**
 * Direct messages are deliberately never recorded. Everything in this list
 * is written to the DEVICE's localStorage, and shop tablets are shared —
 * a recents strip that quoted the body of someone's DM would leak private
 * conversations to whoever picks the tablet up next.
 */
const NEVER_RECORD: ReadonlySet<string> = new Set(['messages']);

export interface RecentRecord {
  kind: RecentKind;
  /** The record's own id, as the search returned it (may be an `ns-…` pseudo id). */
  id: string;
  label: string;
  sub: string | null;
  url: string;
  /** Epoch ms of the most recent open. */
  at: number;
}

export const RECENTS_KEY = 'bmg-recent-records';
export const RECENTS_MAX = 10;

export interface PaletteAccess {
  isAdmin: boolean;
  isSales: boolean;
  isGraphicsProduction: boolean;
  isInstaller: boolean;
  isShopTech: boolean;
  isFieldTech: boolean;
  /** Typed against the real key union — a typo'd key would otherwise just
   *  return false and quietly hide an action the viewer is entitled to. */
  hasFeature: (feature: FeatureKey) => boolean;
}

// ── Access ──────────────────────────────────────────────────────────────

/**
 * Can this viewer open a record of this kind at all? Mirrors the gate on
 * each destination page — the pages bounce to /home otherwise, which reads
 * as the app losing the record.
 */
export function canOpenKind(kind: string, a: PaletteAccess): boolean {
  switch (kind) {
    case 'purchase_orders': return a.hasFeature('purchase_orders');
    case 'vehicles': return a.hasFeature('in_shop') || a.hasFeature('fleet_checkin');
    case 'graphics_jobs': return a.hasFeature('graphics');
    case 'estimates': return a.hasFeature('estimates');
    case 'parts': return a.isAdmin || a.isSales || a.hasFeature('parts_catalog');
    case 'customers': return a.hasFeature('prospects');
    case 'messages': return a.hasFeature('messages');
    case 'quotes': return a.isAdmin || a.isSales || a.isGraphicsProduction;
    case 'invoices': return a.isAdmin || a.isSales;
    default: return false;
  }
}

/**
 * A CRM record the write APIs will accept. The customers group also carries
 * NetSuite-mirror rows under an `ns-<internalId>` pseudo id (the record page
 * resolves those); anything keyed on `prospects.id` — logging a call, opening
 * a new estimate against the lead — must skip them. `/api/prospects/log-call`
 * validates `prospectId` as a uuid, so an `ns-` id could only ever 400.
 */
function realProspectId(item: any): string | null {
  const id = typeof item?.id === 'string' ? item.id : '';
  if (!id || id.startsWith('ns-')) return null;
  return id;
}

// ── Quick actions ───────────────────────────────────────────────────────

export type QuickAction =
  /** Navigates in-app. */
  | { key: string; label: string; title: string; kind: 'link'; url: string }
  /** Opens the record's PDF in a new tab (an API route, not a page). */
  | { key: string; label: string; title: string; kind: 'external'; url: string }
  /** Opens the log-call sheet over the palette — no navigation. */
  | { key: string; label: string; title: string; kind: 'log_call' };

/**
 * The actions a result grows, by type.
 *
 * Groups absent from the switch get none, and that is a deliberate result
 * rather than an oversight:
 *
 *  · purchase_orders — the audit asked for "Receive" here, but the search's
 *    POs are CUSTOMER purchase orders (`purchase_orders`), while receiving
 *    runs against vendor POs (`netsuite_vendor_pos`) and `deepLinks.receiving`
 *    takes that table's id. Passing a customer PO id would open the receiving
 *    page on nothing. There is no receive flow for a customer PO to link to.
 *  · parts / invoices / messages — nothing beyond opening the record that is
 *    both keyed on data the search row carries and lands somewhere real.
 */
export function quickActionsFor(group: string, item: any, a: PaletteAccess): QuickAction[] {
  const out: QuickAction[] = [];
  if (!item) return out;

  switch (group) {
    case 'customers': {
      const pid = realProspectId(item);
      if (pid) {
        // Route guard is staff() and the sheet never navigates, so the only
        // condition is a CRM id the API will accept.
        out.push({
          key: 'log_call', label: 'Log call', kind: 'log_call',
          title: 'Log a call against this record without leaving the search',
        });
      }
      if (pid && a.hasFeature('estimates')) {
        out.push({
          key: 'new_estimate', label: 'New estimate', kind: 'link',
          url: deepLinks.newEstimate(null, pid),
          title: 'Start an estimate with this customer pre-selected',
        });
      }
      // The compose screen opens for mirror rows too — the record page
      // resolves `ns-<id>` — but there is nothing to send to without an
      // address on the row.
      const email = typeof item.email === 'string' ? item.email.trim() : '';
      if (email && a.hasFeature('prospects')) {
        out.push({
          key: 'email', label: 'Email', kind: 'link',
          url: deepLinks.prospectCompose(String(item.id), email),
          title: `Open the compose screen addressed to ${email}`,
        });
      }
      break;
    }

    case 'vehicles': {
      const vin = typeof item.vin === 'string' ? item.vin.trim() : '';
      // /vehicles/[vin]/pick-list gates on ROLE, not on a feature key.
      const canPick = a.isInstaller || a.isShopTech || a.isFieldTech || a.isAdmin;
      if (vin && canPick) {
        out.push({
          key: 'pick_list', label: 'Pick list', kind: 'link',
          // Always per-visit: a VIN-only link resolves to the newest visit,
          // which is the wrong one after a returning vehicle re-checks in.
          url: deepLinks.pickList(vin, item.id || null),
          title: 'Open this visit’s job card / pick list',
        });
      }
      break;
    }

    case 'graphics_jobs': {
      // The invoice prompt exists for shipped jobs; offering it earlier would
      // invite billing work that hasn't happened yet.
      if (item.status === 'shipped' && (a.isAdmin || a.isSales)) {
        out.push({
          key: 'create_invoice', label: 'Invoice', kind: 'link',
          url: deepLinks.createInvoiceForJob(String(item.id)),
          title: 'Open the create-invoice dialog for this shipped job',
        });
      }
      break;
    }

    case 'estimates': {
      if (a.hasFeature('estimates')) {
        out.push({
          key: 'pdf', label: 'PDF', kind: 'external',
          url: deepLinks.estimatePdf(String(item.id)),
          title: 'Open the estimate PDF in a new tab',
        });
      }
      break;
    }

    case 'quotes': {
      if (canOpenKind('quotes', a)) {
        out.push({
          key: 'pdf', label: 'PDF', kind: 'external',
          url: deepLinks.wrapQuotePdf(String(item.id)),
          title: 'Open the wrap quote PDF in a new tab',
        });
      }
      break;
    }
  }

  return out;
}

// ── Recents ─────────────────────────────────────────────────────────────

/** How a result row is named in the recents strip. Mirrors the row itself. */
export function describeResult(kind: string, item: any): { label: string; sub: string | null } | null {
  if (!item) return null;
  const clean = (v: any): string => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim());
  const join = (...parts: any[]) => {
    const s = parts.map(clean).filter(Boolean).join(' · ');
    return s || null;
  };

  switch (kind) {
    case 'invoices': {
      const num = clean(item.invoice_number);
      return num ? { label: `INV #${num}`, sub: join(item.customer) } : null;
    }
    case 'purchase_orders': {
      const num = clean(item.po_number);
      return num ? { label: `PO #${num}`, sub: join(item.customer) } : null;
    }
    case 'vehicles': {
      const desc = [item.vehicle_year, item.vehicle_make, item.vehicle_model].map(clean).filter(Boolean).join(' ');
      const vin = clean(item.vin);
      const label = desc || (vin ? `VIN ${vin}` : '');
      if (!label) return null;
      return { label, sub: join(desc && vin ? `VIN ${vin}` : '', item.customer_name) };
    }
    case 'graphics_jobs': {
      const num = clean(item.job_number);
      const name = clean(item.title) || clean(item.part_number);
      const label = [num ? `#${num}` : '', name].filter(Boolean).join(' ');
      return label ? { label, sub: join(item.customer) } : null;
    }
    case 'estimates': {
      const num = estimateHeadlineNumber(item);
      const label = num ? `Est ${num}` : clean(item.title);
      return label ? { label, sub: join(num ? item.title : '') } : null;
    }
    case 'parts': {
      const num = clean(item.part_number) || clean(item.item_number);
      return num ? { label: num, sub: join(item.display_name) } : null;
    }
    case 'customers': {
      const name = clean(item.company_name);
      return name ? { label: name, sub: join(item.contact_name) } : null;
    }
    case 'quotes': {
      const num = clean(item.quote_number);
      return num ? { label: `Quote ${num}`, sub: join(item.customer_name, item.vehicle_description) } : null;
    }
    default:
      return null;
  }
}

/**
 * Build the entry for a record the viewer just opened, or null when it
 * can't be described, has no id, has no destination, or is a kind that is
 * never recorded.
 */
export function buildRecent(kind: string, item: any, url: string, now = Date.now()): RecentRecord | null {
  if (!KINDS.has(kind) || NEVER_RECORD.has(kind)) return null;
  const id = item?.id == null ? '' : String(item.id).trim();
  const dest = typeof url === 'string' ? url.trim() : '';
  if (!id || !dest || dest === '/') return null;
  const desc = describeResult(kind, item);
  if (!desc) return null;
  return { kind: kind as RecentKind, id, label: desc.label, sub: desc.sub, url: dest, at: now };
}

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function defaultStore(): Store | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch {
    // Private mode / blocked site data — recents are a convenience, never a
    // reason for the palette to fail to open.
    return null;
  }
}

function isRecent(v: any): v is RecentRecord {
  return !!v
    && typeof v.kind === 'string' && KINDS.has(v.kind) && !NEVER_RECORD.has(v.kind)
    && typeof v.id === 'string' && v.id.length > 0
    && typeof v.label === 'string' && v.label.length > 0
    && typeof v.url === 'string' && v.url.length > 0
    && Number.isFinite(v.at);
}

/** Newest first, deduped, capped. Anything unparseable reads as empty. */
export function readRecents(store: Store | null = defaultStore()): RecentRecord[] {
  if (!store) return [];
  let raw: string | null = null;
  try { raw = store.getItem(RECENTS_KEY); } catch { return []; }
  if (!raw) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const seen = new Set<string>();
  const rows: RecentRecord[] = [];
  for (const v of parsed) {
    if (!isRecent(v)) continue;
    const key = `${v.kind}:${v.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ kind: v.kind, id: v.id, label: v.label, sub: typeof v.sub === 'string' ? v.sub : null, url: v.url, at: v.at });
  }
  rows.sort((x, y) => y.at - x.at);
  return rows.slice(0, RECENTS_MAX);
}

/** Records an open. Returns the new list (also for callers that render it). */
export function pushRecent(entry: RecentRecord | null, store: Store | null = defaultStore()): RecentRecord[] {
  if (!entry || !isRecent(entry)) return readRecents(store);
  const key = `${entry.kind}:${entry.id}`;
  const rest = readRecents(store).filter(r => `${r.kind}:${r.id}` !== key);
  const next = [entry, ...rest].slice(0, RECENTS_MAX);
  if (store) {
    try { store.setItem(RECENTS_KEY, JSON.stringify(next)); } catch { /* quota / blocked — the list just won't persist */ }
  }
  return next;
}

export function clearRecents(store: Store | null = defaultStore()): void {
  if (!store) return;
  try { store.removeItem(RECENTS_KEY); } catch { /* nothing to do */ }
}

/** The recents this viewer can still open, in order. */
export function visibleRecents(rows: RecentRecord[], a: PaletteAccess): RecentRecord[] {
  return rows.filter(r => canOpenKind(r.kind, a));
}

/**
 * The keyboard hint on the search button. Mac reads ⌘K; everything else
 * Ctrl K. Callers only render it on devices that have a keyboard.
 */
export function shortcutLabel(platform: string | null | undefined): string {
  return /mac|iphone|ipad|ipod/i.test(platform || '') ? '⌘K' : 'Ctrl K';
}

/** True for the Cmd+K / Ctrl+K chord, on any key layout. */
export function isPaletteChord(e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }): boolean {
  if (!e || typeof e.key !== 'string') return false;
  if (e.key.toLowerCase() !== 'k') return false;
  if (e.altKey || e.shiftKey) return false;
  return e.metaKey || e.ctrlKey;
}
