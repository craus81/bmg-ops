/**
 * Integration Checkup — what the app needs from the outside world, and
 * whether it's actually there.
 *
 * The problem this solves: roughly forty features shipped across the Round
 * 4-6 audit waves, and a meaningful minority of them are dark until someone
 * does something in NetSuite, Vercel or a connected app.
 * `docs/owner-setup-runbook.md` lists all of it, but a document can only
 * say what each feature REQUIRES — it can't say what's missing, because
 * nothing outside production can read production's env. So the answer lived
 * in a person's memory, and features sat dark without anyone noticing.
 *
 * This module is the catalog and the pure classification. The network
 * probing (NetSuite auth, the three RESTlet pings, OAuth token validity)
 * lives in the route, so everything here stays synchronous and testable.
 *
 * SECURITY: this reports PRESENCE and SHAPE, never values. No secret is
 * read into a response, and the catalog below deliberately has no field
 * that could carry one. Account-id lists report a count because "3 bank
 * accounts configured" is the useful fact and the ids themselves are not.
 */

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'unknown';

export interface CheckRow {
  key: string;
  label: string;
  status: CheckStatus;
  /** What is true right now. */
  detail: string;
  /** What doesn't work while this isn't ok. Omitted when status is ok. */
  impact?: string;
  /** The action that fixes it. Omitted when status is ok. */
  fix?: string;
  /** Repo doc with the full procedure. */
  docs?: string;
}

export interface CheckGroup {
  key: string;
  label: string;
  blurb: string;
  rows: CheckRow[];
}

/**
 * How bad is it when this variable is absent?
 *   fail — a core path is broken for everyone
 *   warn — a shipped feature is dark, but the rest of the app is fine
 *   off  — genuinely optional; absence is a choice, not a problem
 */
type Severity = 'fail' | 'warn' | 'off';

export interface EnvSpec {
  name: string;
  group: string;
  /** What this switches on, phrased so a non-engineer can act on it. */
  powers: string;
  whenMissing: Severity;
  /** Comma-separated id list — report how many, not which. */
  idList?: boolean;
  docs?: string;
}

export const ENV_GROUPS: { key: string; label: string; blurb: string }[] = [
  { key: 'netsuite', label: 'NetSuite connection', blurb: 'The API token and account. Nothing NetSuite-shaped works without these.' },
  { key: 'ns_accounts', label: 'NetSuite account groups', blurb: 'Chart-of-Accounts internal IDs behind the Financials tiles. Each unset group is a tile reading "—".' },
  { key: 'email', label: 'Email', blurb: 'Outbound mail and its delivery tracking.' },
  { key: 'storage', label: 'File storage', blurb: 'Photos, proofs, attachments and PDFs.' },
  { key: 'google', label: 'Google', blurb: 'Gmail auto-import and the shop calendar.' },
  { key: 'telephony', label: 'Phone & SMS', blurb: 'Text alerts, call logging and the caller-ID screen-pop.' },
  { key: 'push', label: 'Push notifications', blurb: 'Browser and native push.' },
  { key: 'ai', label: 'AI', blurb: 'PO and vendor-invoice extraction, voice notes, knowledge-base vision.' },
  { key: 'platform', label: 'Platform', blurb: 'The things the app itself runs on.' },
  { key: 'optional', label: 'Not wired up', blurb: 'Integrations that exist in code but were never provisioned. Blank here is a decision, not a fault.' },
];

/**
 * Every environment variable the code actually reads, with what it powers.
 * Kept in sync with the code by `integration-checkup.test.ts`, which greps
 * src/ for `process.env.X` and fails when a variable is used but uncatalogued
 * — otherwise this list silently rots the first time someone adds an
 * integration, and a checkup that misses things is worse than none.
 */
export const ENV_SPECS: EnvSpec[] = [
  // --- NetSuite connection ---
  { name: 'NETSUITE_ACCOUNT_ID', group: 'netsuite', powers: 'Which NetSuite account to talk to', whenMissing: 'fail' },
  { name: 'NETSUITE_CONSUMER_KEY', group: 'netsuite', powers: 'Token-based auth', whenMissing: 'fail' },
  { name: 'NETSUITE_CONSUMER_SECRET', group: 'netsuite', powers: 'Token-based auth', whenMissing: 'fail' },
  { name: 'NETSUITE_TOKEN_ID', group: 'netsuite', powers: 'Token-based auth', whenMissing: 'fail' },
  { name: 'NETSUITE_TOKEN_SECRET', group: 'netsuite', powers: 'Token-based auth', whenMissing: 'fail' },
  { name: 'NETSUITE_SUBSIDIARY_ID', group: 'netsuite', powers: 'Which subsidiary new records post to', whenMissing: 'warn' },
  { name: 'NETSUITE_DEFAULT_LOCATION_ID', group: 'netsuite', powers: 'Fallback location on invoices when the mapping has no entry', whenMissing: 'warn' },
  { name: 'NETSUITE_LABOR_ITEM_ID', group: 'netsuite', powers: 'Overrides the labor item. Blank is fine when Settings resolves one — see the Labor item check above', whenMissing: 'off' },
  { name: 'NETSUITE_SUBCONTRACTOR_ACCOUNT_ID', group: 'netsuite', powers: 'Expense account on CNI installer vendor bills (defaults to 223)', whenMissing: 'off', docs: 'docs/cni-vendor-bills.md' },

  // --- NetSuite account groups ---
  { name: 'NETSUITE_BANK_ACCOUNT_IDS', group: 'ns_accounts', powers: 'The Cash tile', whenMissing: 'warn', idList: true },
  { name: 'NETSUITE_CARD_ACCOUNT_ID', group: 'ns_accounts', powers: 'The "owed on cards" tile', whenMissing: 'warn', idList: true },
  { name: 'NETSUITE_AP_ACCOUNT_IDS', group: 'ns_accounts', powers: 'The A/P tile', whenMissing: 'warn', idList: true },
  { name: 'NETSUITE_SALES_TAX_ACCOUNT_IDS', group: 'ns_accounts', powers: 'The sales-tax-owed tile', whenMissing: 'warn', idList: true },
  { name: 'NETSUITE_PAYROLL_ACCOUNT_IDS', group: 'ns_accounts', powers: 'The Payroll tile, Labor % of revenue, and real payroll in the 4-week cash outlook (which reports no figure at all rather than guessing)', whenMissing: 'warn', idList: true, docs: 'docs/pnl-restlet-deploy.md' },

  // --- Email ---
  { name: 'RESEND_API_KEY', group: 'email', powers: 'Every outbound email', whenMissing: 'fail' },
  { name: 'RESEND_FROM_EMAIL', group: 'email', powers: 'The From address', whenMissing: 'fail' },
  { name: 'RESEND_FROM_NAME', group: 'email', powers: 'Display name on the From address', whenMissing: 'off' },
  { name: 'RESEND_REPLY_TO_EMAIL', group: 'email', powers: 'Fallback Reply-To when no staff sender applies', whenMissing: 'off' },
  { name: 'RESEND_WEBHOOK_SECRET', group: 'email', powers: 'Delivery tracking — without it every send stays "Sent" and bounces are invisible', whenMissing: 'warn' },

  // --- Storage ---
  { name: 'R2_ACCOUNT_ID', group: 'storage', powers: 'Photo and attachment storage', whenMissing: 'fail' },
  { name: 'R2_ACCESS_KEY_ID', group: 'storage', powers: 'Photo and attachment storage', whenMissing: 'fail' },
  { name: 'R2_SECRET_ACCESS_KEY', group: 'storage', powers: 'Photo and attachment storage', whenMissing: 'fail' },
  { name: 'R2_BUCKET_NAME', group: 'storage', powers: 'Photo and attachment storage', whenMissing: 'fail' },
  { name: 'R2_PUBLIC_URL', group: 'storage', powers: 'Serving stored files back', whenMissing: 'warn' },
  { name: 'NEXT_PUBLIC_R2_PUBLIC_URL', group: 'storage', powers: 'Client-side file URLs', whenMissing: 'warn' },

  // --- Google ---
  { name: 'GOOGLE_CLIENT_ID', group: 'google', powers: 'Gmail auto-import and calendar OAuth', whenMissing: 'warn' },
  { name: 'GOOGLE_CLIENT_SECRET', group: 'google', powers: 'Gmail auto-import and calendar OAuth', whenMissing: 'warn' },
  { name: 'GOOGLE_REDIRECT_URI', group: 'google', powers: 'Completing the Google OAuth handshake', whenMissing: 'warn' },
  { name: 'GOOGLE_CALENDAR_ID', group: 'google', powers: 'Which calendar the schedule syncs to', whenMissing: 'warn' },
  { name: 'GOOGLE_DWD_CLIENT_EMAIL', group: 'google', powers: 'Domain-wide delegation (service-account mailbox access)', whenMissing: 'off' },
  { name: 'GOOGLE_DWD_PRIVATE_KEY', group: 'google', powers: 'Domain-wide delegation (service-account mailbox access)', whenMissing: 'off' },

  // --- Telephony ---
  { name: 'SMS_PROVIDER', group: 'telephony', powers: 'Which provider sends texts (twilio or dialpad)', whenMissing: 'warn' },
  { name: 'SMS_PROVIDER_ENABLED', group: 'telephony', powers: 'Master switch for outbound SMS', whenMissing: 'off' },
  { name: 'TWILIO_ACCOUNT_SID', group: 'telephony', powers: 'Twilio SMS', whenMissing: 'off' },
  { name: 'TWILIO_AUTH_TOKEN', group: 'telephony', powers: 'Twilio SMS', whenMissing: 'off' },
  { name: 'TWILIO_PHONE_NUMBER', group: 'telephony', powers: 'Twilio SMS', whenMissing: 'off' },
  { name: 'TWILIO_VALIDATE_SIGNATURE', group: 'telephony', powers: 'Verifying inbound Twilio webhooks', whenMissing: 'off' },
  { name: 'DIALPAD_API_KEY', group: 'telephony', powers: 'Dialpad SMS and call logging', whenMissing: 'off' },
  { name: 'DIALPAD_FROM_NUMBER', group: 'telephony', powers: 'Dialpad send-from number (or use DIALPAD_USER_ID)', whenMissing: 'off' },
  { name: 'DIALPAD_USER_ID', group: 'telephony', powers: 'Sending Dialpad texts as a specific user', whenMissing: 'off' },
  { name: 'DIALPAD_WEBHOOK_SECRET', group: 'telephony', powers: 'The caller-ID screen-pop and CRM call logging — without it inbound call events are rejected', whenMissing: 'off' },

  // --- Push ---
  { name: 'NEXT_PUBLIC_VAPID_PUBLIC_KEY', group: 'push', powers: 'Browser push', whenMissing: 'warn' },
  { name: 'VAPID_PRIVATE_KEY', group: 'push', powers: 'Browser push', whenMissing: 'warn' },
  { name: 'VAPID_EMAIL', group: 'push', powers: 'Browser push contact address', whenMissing: 'warn' },
  { name: 'APNS_KEY_ID', group: 'push', powers: 'Native iOS push', whenMissing: 'off' },
  { name: 'APNS_TEAM_ID', group: 'push', powers: 'Native iOS push', whenMissing: 'off' },
  { name: 'APNS_PRIVATE_KEY', group: 'push', powers: 'Native iOS push', whenMissing: 'off' },
  { name: 'APNS_BUNDLE_ID', group: 'push', powers: 'Native iOS push', whenMissing: 'off' },

  // --- AI ---
  { name: 'ANTHROPIC_API_KEY', group: 'ai', powers: 'PO and vendor-invoice extraction, ship-to parsing, voice notes, knowledge-base vision, the AI agent', whenMissing: 'warn' },

  // --- Platform ---
  { name: 'NEXT_PUBLIC_SUPABASE_URL', group: 'platform', powers: 'The database', whenMissing: 'fail' },
  { name: 'NEXT_PUBLIC_SUPABASE_ANON_KEY', group: 'platform', powers: 'The database', whenMissing: 'fail' },
  { name: 'SUPABASE_SERVICE_ROLE_KEY', group: 'platform', powers: 'Every server-side read and write', whenMissing: 'fail' },
  { name: 'SUPABASE_DB_URL', group: 'platform', powers: 'Applying migrations during the build', whenMissing: 'fail' },
  { name: 'DATABASE_URL', group: 'platform', powers: 'Migration fallback connection string', whenMissing: 'off' },
  { name: 'CRON_SECRET', group: 'platform', powers: 'Authenticating scheduled runs — without it every cron is effectively off', whenMissing: 'fail' },
  { name: 'NEXT_PUBLIC_APP_URL', group: 'platform', powers: 'Absolute URLs in emails and notifications — deep links break without it', whenMissing: 'fail' },
  { name: 'HEALTH_PING_URL', group: 'platform', powers: "The external dead-man's switch that catches the scheduler itself dying", whenMissing: 'warn' },
  { name: 'VERCEL_ENV', group: 'platform', powers: 'Set by Vercel automatically', whenMissing: 'off' },
  { name: 'PROOF_SENDERS', group: 'platform', powers: 'Which senders the proof sweep treats as proof email', whenMissing: 'off' },
  { name: 'PROOF_SUBJECT_KEYWORDS', group: 'platform', powers: 'Subject matching for the proof sweep', whenMissing: 'off' },

  // --- Not wired up ---
  { name: 'DROPBOX_APP_KEY', group: 'optional', powers: 'Dropbox proof sync', whenMissing: 'off' },
  { name: 'DROPBOX_APP_SECRET', group: 'optional', powers: 'Dropbox proof sync', whenMissing: 'off' },
  { name: 'PAYCHEX_API_BASE', group: 'optional', powers: 'Payroll sync — blocked on the owner call about API scope', whenMissing: 'off' },
  { name: 'PAYCHEX_CLIENT_ID', group: 'optional', powers: 'Payroll sync — blocked on the owner call about API scope', whenMissing: 'off' },
  { name: 'PAYCHEX_CLIENT_SECRET', group: 'optional', powers: 'Payroll sync — blocked on the owner call about API scope', whenMissing: 'off' },
];

/** Presence + shape of one variable. Never its value. */
export function checkEnv(spec: EnvSpec, raw: string | undefined): CheckRow {
  const value = (raw || '').trim();
  const present = value.length > 0;

  if (present) {
    const detail = spec.idList
      ? `Set — ${countIds(value)} account ${countIds(value) === 1 ? 'id' : 'ids'}`
      : 'Set';
    return { key: spec.name, label: spec.name, status: 'ok', detail, docs: spec.docs };
  }

  if (spec.whenMissing === 'off') {
    return {
      key: spec.name,
      label: spec.name,
      status: 'unknown',
      detail: 'Not set',
      impact: spec.powers,
      docs: spec.docs,
    };
  }

  return {
    key: spec.name,
    label: spec.name,
    status: spec.whenMissing === 'fail' ? 'fail' : 'warn',
    detail: 'Not set',
    impact: spec.powers,
    fix: `Add ${spec.name} in Vercel → Settings → Environment Variables, then redeploy.`,
    docs: spec.docs,
  };
}

/** Count the ids in a comma-separated list, ignoring blanks. */
export function countIds(raw: string): number {
  return raw.split(',').map(s => s.trim()).filter(Boolean).length;
}

export type RestletProbe =
  | { reachable: false; error: string }
  | { reachable: true; version: string | null };

/**
 * Turn a RESTlet ping into a verdict.
 *
 * The subtle case is `reachable: true, version: null` — the URL answers, so
 * "is it deployed?" looks like yes, but the code that answered predates the
 * ping action and is therefore OLD. That's exactly the state the P&L band
 * was stuck in, reported as a success. It is a failure here.
 */
export function classifyRestlet(
  spec: { label: string; envVar: string; expectedVersion: string; powers: string; runbook: string | null },
  urlSet: boolean,
  probe: RestletProbe | null,
): CheckRow {
  const base = { key: spec.envVar, label: spec.label, docs: spec.runbook || undefined };

  if (!urlSet) {
    return {
      ...base,
      status: 'fail',
      detail: 'No URL configured',
      impact: spec.powers,
      fix: `Deploy the script in NetSuite and set ${spec.envVar} in Vercel.`,
    };
  }
  if (!probe || probe.reachable === false) {
    return {
      ...base,
      status: 'fail',
      detail: `Unreachable — ${probe?.error || 'no response'}`,
      impact: spec.powers,
      fix: "Check the URL is the deployment's External URL, and that the deployment's role is still active.",
    };
  }
  if (probe.version === null) {
    return {
      ...base,
      status: 'fail',
      detail: 'Answering, but running code older than this app expects',
      impact: spec.powers,
      fix: 'Re-upload the current script over the File Cabinet copy — the deployment picks it up automatically. The version probe was added on 2026-09-10, so a RESTlet that cannot answer it predates that.',
    };
  }
  if (probe.version !== spec.expectedVersion) {
    return {
      ...base,
      status: 'warn',
      detail: `Deployed ${probe.version}, app expects ${spec.expectedVersion}`,
      impact: `Newer behavior may be missing: ${spec.powers}`,
      fix: 'Re-upload the current script over the File Cabinet copy.',
    };
  }
  return { ...base, status: 'ok', detail: `Deployed and current (${probe.version})` };
}

/**
 * Compare what the database says is applied against what the repo ships.
 *
 * Pending files here mean the production build's migrate step didn't run or
 * didn't finish — worth knowing, since code whose schema didn't apply is
 * exactly the failure the deploy pipeline exists to prevent.
 */
export function compareMigrations(repoFiles: string[], appliedFiles: string[]): CheckRow {
  const applied = new Set(appliedFiles);
  const pending = repoFiles.filter(f => !applied.has(f)).sort();
  const orphaned = appliedFiles.filter(f => !repoFiles.includes(f)).sort();

  if (repoFiles.length === 0) {
    return {
      key: 'migrations',
      label: 'Migrations',
      status: 'unknown',
      detail: `${appliedFiles.length} applied; the repo's migration list wasn't readable in this deployment`,
      impact: 'Cannot confirm every migration landed.',
    };
  }
  if (pending.length > 0) {
    return {
      key: 'migrations',
      label: 'Migrations',
      status: 'fail',
      detail: `${pending.length} pending: ${pending.slice(0, 5).join(', ')}${pending.length > 5 ? ` +${pending.length - 5} more` : ''}`,
      impact: 'Code is live whose schema is not. Expect errors on anything touching those tables.',
      fix: 'Re-deploy — the build runs the migrator and fails the deploy if one fails. Never apply these by hand in the SQL editor.',
    };
  }
  const orphanNote = orphaned.length > 0
    ? ` (${orphaned.length} applied row${orphaned.length === 1 ? '' : 's'} no longer in the repo — renamed or removed files)`
    : '';
  return {
    key: 'migrations',
    label: 'Migrations',
    status: 'ok',
    detail: `All ${repoFiles.length} applied${orphanNote}`,
  };
}

/** Worst status wins, so a group header can summarize its rows. */
export function rollUp(rows: CheckRow[]): CheckStatus {
  if (rows.some(r => r.status === 'fail')) return 'fail';
  if (rows.some(r => r.status === 'warn')) return 'warn';
  if (rows.some(r => r.status === 'ok')) return 'ok';
  return 'unknown';
}
