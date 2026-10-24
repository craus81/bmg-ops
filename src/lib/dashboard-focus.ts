/**
 * Dashboard focus: which slice of the shop a person's Dashboard is about
 * (owner decision 2026-10-24, thread "Simplify dashboards and
 * notifications": staff were overwhelmed by one Dashboard for everyone).
 *
 * A super admin picks each person's focus in Admin → Users (stored on
 * `profiles.dashboard_focus`, migration 432). Nobody loses access to any
 * page: focus only decides what the Dashboard shows first, what folds
 * away, and what it leaves out. Scheduling, Purchasing and Sales also make
 * the person that area's alert owner (getAlertOwnerIds in src/lib/notify.ts).
 *
 * With no saved focus, the role decides: admins see everything, sales sees
 * sales, finance and executives see the financial view.
 */

export const DASHBOARD_FOCI = ['everything', 'sales', 'financial', 'scheduling', 'purchasing'] as const;
export type DashboardFocus = typeof DASHBOARD_FOCI[number];

export const FOCUS_LABEL: Record<DashboardFocus, string> = {
  everything: 'Everything',
  sales: 'Sales',
  financial: 'Financial',
  scheduling: 'Scheduling',
  purchasing: 'Purchasing',
};

export const FOCUS_HINT: Record<DashboardFocus, string> = {
  everything: 'Every card, with their own to-dos first and the rest folded',
  sales: 'Their quotes, proofs and pipeline',
  financial: 'Invoiced, owed to us and what is coming in. Very short',
  scheduling: 'Pickups, promised-back vehicles, the next 7 days and shop load',
  purchasing: 'Parts requests, imported POs and scans waiting on a PO',
};

const isFocus = (v: unknown): v is DashboardFocus =>
  typeof v === 'string' && (DASHBOARD_FOCI as readonly string[]).includes(v);

/** Clean a saved or submitted list: known values only, no repeats, and
 *  'everything' on its own (it already covers the rest). Empty → null. */
export function normalizeFocus(raw: unknown): DashboardFocus[] | null {
  if (!Array.isArray(raw)) return null;
  const list = DASHBOARD_FOCI.filter(f => raw.some(r => r === f));
  if (list.includes('everything')) return ['everything'];
  return list.length > 0 ? list : null;
}

/** The focus a person's Dashboard uses: their saved pick, else their role. */
export function resolveDashboardFocus(
  saved: unknown,
  roles: { isAdmin: boolean; sales: boolean; finance: boolean; executive: boolean },
): DashboardFocus[] {
  const picked = normalizeFocus(saved);
  if (picked) return picked;
  if (roles.isAdmin) return ['everything'];
  const fromRole: DashboardFocus[] = [];
  if (roles.sales) fromRole.push('sales');
  if (roles.finance || roles.executive) fromRole.push('financial');
  return fromRole.length > 0 ? fromRole : ['everything'];
}

/**
 * Which part of the shop each to-do on the Dashboard belongs to. 'owner'
 * items are the ones only the people running the shop act on (accounts,
 * pay, background jobs, graphics review). Every key the Dashboard can
 * raise must be listed; the test holds this.
 */
export const TODO_AREA = {
  invoice: 'financial',
  unpaid: 'financial',
  'never-invoiced': 'financial',
  ap: 'financial',
  imports: 'purchasing',
  waitingpo: 'purchasing',
  'parts-requested': 'purchasing',
  'ready-pickup': 'scheduling',
  'promised-back': 'scheduling',
  quotes: 'sales',
  proofs: 'sales',
  'quiet-leads': 'sales',
  atrisk: 'sales',
  flagged: 'owner',
  users: 'owner',
  unpriced: 'owner',
  health: 'owner',
} as const;
export type TodoKey = keyof typeof TODO_AREA;

/**
 * Split the Dashboard's to-dos into the person's own ("For you") and the
 * rest of the shop's. An Everything person's own are the owner and money
 * items; everyone else's own are their focus areas, and the rest of the
 * shop's to-dos are not shown to them at all (`others` is only rendered
 * for Everything).
 */
export function splitTodos<T extends { key: string }>(items: T[], focus: DashboardFocus[]): { mine: T[]; others: T[] } {
  const everything = focus.includes('everything');
  const mineAreas = new Set<string>(everything ? ['owner', 'financial'] : focus);
  const mine: T[] = [];
  const others: T[] = [];
  for (const it of items) {
    const area = (TODO_AREA as Record<string, string>)[it.key];
    if (area && mineAreas.has(area)) mine.push(it);
    else others.push(it);
  }
  return { mine, others };
}

export type DashCard =
  | 'kpis' | 'pulse' | 'shopTodos' | 'graphics' | 'upfit' | 'sales'
  | 'next7' | 'shopLoad' | 'rightNow' | 'activity' | 'messages'
  | 'openPos' | 'finance';

/** How each card shows: open, folded to one line (tap to open), or not at all. */
export type CardMode = 'open' | 'folded';

/**
 * The cards a focus shows and whether each starts open. Several foci (e.g.
 * Scheduling + Purchasing) get every card either one shows, and a card one
 * focus opens stays open.
 */
export function dashboardCards(focus: DashboardFocus[]): Partial<Record<DashCard, CardMode>> {
  const per: Record<DashboardFocus, Partial<Record<DashCard, CardMode>>> = {
    everything: {
      kpis: 'open', pulse: 'open', shopTodos: 'folded', graphics: 'folded', upfit: 'folded',
      sales: 'folded', next7: 'folded', shopLoad: 'folded', rightNow: 'folded',
      activity: 'folded', messages: 'folded',
    },
    sales: { sales: 'folded', next7: 'folded', messages: 'folded' },
    financial: { finance: 'open' },
    scheduling: { next7: 'open', shopLoad: 'open', upfit: 'folded', messages: 'folded' },
    purchasing: { openPos: 'folded', messages: 'folded' },
  };
  const out: Partial<Record<DashCard, CardMode>> = {};
  for (const f of focus) {
    for (const [card, mode] of Object.entries(per[f]) as [DashCard, CardMode][]) {
      out[card] = out[card] === 'open' || mode === 'open' ? 'open' : 'folded';
    }
  }
  return out;
}
