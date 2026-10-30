/**
 * In-app Requests (migration 453; Craig, 2026-10-30): anyone signed in
 * reports a problem, asks for a feature or asks a question; Claude picks it
 * up on a schedule and writes the answer under it. Pure helpers, safe in
 * server routes and client components alike.
 */

export type AppRequestKind = 'problem' | 'idea' | 'question';
export type AppRequestStatus = 'new' | 'looking' | 'waiting' | 'done' | 'wont';

export const REQUEST_KINDS: AppRequestKind[] = ['problem', 'idea', 'question'];
export const REQUEST_STATUSES: AppRequestStatus[] = ['new', 'looking', 'waiting', 'done', 'wont'];

export const KIND_LABEL: Record<AppRequestKind, string> = {
  problem: 'Problem',
  idea: 'Idea',
  question: 'Question',
};

export const STATUS_LABEL: Record<AppRequestStatus, string> = {
  new: 'New',
  looking: 'Looking into it',
  waiting: 'Waiting on Craig',
  done: 'Done',
  wont: "Won't do",
};

/** Statuses Claude may set through the agent route. Won't do is Craig's alone. */
export const AGENT_STATUSES: AppRequestStatus[] = ['new', 'looking', 'waiting', 'done'];

/** Done and Won't do sit under the list's "Closed" chip. */
export const isClosed = (status: AppRequestStatus) => status === 'done' || status === 'wont';

/** Storage prefix for screenshots (denied to the generic storage API). */
export const REQUEST_FILES_PREFIX = 'app-requests';

/** Biggest screenshot the upload route takes, after the phone shrinks it. */
export const MAX_REQUEST_FILE_BYTES = 4 * 1024 * 1024;

export const MAX_REQUEST_FILES = 6;

/** Who owns Won't do: Craig ("just me", 2026-10-30). */
export const REQUESTS_OWNER_EMAIL = 'cgeorge@bmgfleet.com';

/** The screens people come from, named the way they know them. */
const PAGE_NAMES: Array<[RegExp, string]> = [
  [/^\/home/, 'Home'],
  [/^\/estimates/, 'Estimates'],
  [/^\/quotes/, 'Quotes'],
  [/^\/admin\/scans/, 'Scan Log'],
  [/^\/scan/, 'Scan & Log'],
  [/^\/admin\/schedule/, 'Schedule'],
  [/^\/admin\/purchasing/, 'Purchasing'],
  [/^\/admin\/pos/, 'Purchase Orders'],
  [/^\/admin\/receiving/, 'Receiving'],
  [/^\/admin\/inventory/, 'Inventory'],
  [/^\/admin\/books/, 'Books'],
  [/^\/admin\/prospects/, 'Customers'],
  [/^\/admin\/wrap-quote/, 'Graphics Builder'],
  [/^\/admin\/users/, 'User Management'],
  [/^\/graphics/, 'Graphics'],
  [/^\/tracking/, 'In-Shop'],
  [/^\/vehicles/, 'Vehicles'],
  [/^\/invoices/, 'Invoicing'],
  [/^\/parts/, 'Parts Catalog'],
  [/^\/installer-parts/, 'Parts'],
  [/^\/installer/, 'Installer Portal'],
  [/^\/client-files/, 'Client Files'],
  [/^\/completion-photos/, 'Completion Photos'],
  [/^\/camera-installs/, 'Camera Installs'],
  [/^\/qc-fixes/, 'QC Fixes'],
  [/^\/pricing-requests/, 'Pricing Requests'],
  [/^\/sales-orders/, 'Sales Orders'],
  [/^\/upfit-designer/, 'Upfit Designer'],
  [/^\/upfit/, 'Jobs'],
  [/^\/messages/, 'Messages'],
  [/^\/mentions/, 'Mentions'],
  [/^\/settings/, 'Settings'],
  [/^\/help/, 'Help'],
  [/^\/customer/, 'Customer portal'],
  [/^\/more/, 'More'],
];

/** "/admin/scans?x=1" → "Scan Log"; an unknown screen shows its path. */
export function pageName(path: string | null | undefined): string | null {
  if (!path) return null;
  const clean = path.split(/[?#]/)[0];
  for (const [re, name] of PAGE_NAMES) if (re.test(clean)) return name;
  return clean;
}

/** One line of a request for list rows, alert titles and email subjects. */
export function excerpt(text: string, max = 80): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length <= max ? one : one.slice(0, max - 1).trimEnd() + '…';
}

/**
 * Who can see a request: staff see every one (fewer duplicates, and Me too
 * works across people); customer and installer accounts only their own.
 */
export function canSeeRequest(viewer: { id: string; staff: boolean }, request: { created_by: string | null }): boolean {
  return viewer.staff || (!!request.created_by && request.created_by === viewer.id);
}

/**
 * Everyone who hears about a change on a request: the submitter, the people
 * who tapped Me too, and the "Copy me on new alerts" watchers (Craig) — less
 * whoever made the change, and each person once.
 */
export function updateRecipients(opts: {
  submitter: string | null;
  meToo: string[];
  watchers: string[];
  actor: string | null;
}): string[] {
  const out = new Set<string>();
  for (const id of [opts.submitter, ...opts.meToo, ...opts.watchers]) if (id) out.add(id);
  if (opts.actor) out.delete(opts.actor);
  return [...out];
}
