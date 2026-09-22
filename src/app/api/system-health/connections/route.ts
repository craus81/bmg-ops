import { NextRequest, NextResponse } from 'next/server';
import { readdirSync } from 'fs';
import { join } from 'path';
import { createServiceClient } from '@/lib/supabase-service';
import { requireFeature } from '@/lib/api-auth';
import { suiteqlQuery } from '@/lib/netsuite';
import { resolveLaborItem } from '@/lib/labor-item';
import { RESTLET_SPECS } from '@/lib/restlet-versions';
import { pingRestlet } from '@/lib/restlet-probe';
import { ledgerPdfsEnabled } from '@/lib/ledger/pdf-gate';
import { NS_MIRROR_SYNC_TYPE } from '@/lib/ledger/netsuite-mirror';
import { QBO_DEFAULT_MINOR_VERSION, maskRealm, qboConfigured } from '@/lib/quickbooks/config';
import { fetchCompanyInfo } from '@/lib/quickbooks/oauth';
import { getAccessToken as getQboAccessToken } from '@/lib/quickbooks/tokens';
import {
  ENV_GROUPS, ENV_SPECS, checkEnv, classifyRestlet, compareMigrations, rollUp,
  type CheckGroup, type CheckRow,
} from '@/lib/integration-checkup';

export const dynamic = 'force-dynamic';
// Live probes against NetSuite and Google; the default 10s isn't enough when
// one of them is the thing that's broken.
export const maxDuration = 60;

const service = createServiceClient();

/**
 * Integration Checkup — the Connections tab on System Health.
 *
 * Runs every probe on demand and reports what's actually configured. This
 * is the page that answers "is it set up?" without a human logging into
 * Vercel and NetSuite to look.
 *
 * Two rules shape the whole route:
 *
 * 1. NEVER return a secret value. Rows carry presence and shape only. A
 *    checkup that leaked the keys it was checking would be a worse problem
 *    than the one it solves.
 * 2. Every probe fails INDEPENDENTLY. NetSuite being down must not blank
 *    the migrations panel — the same rule the metric snapshots follow
 *    (null + a stated error, never a lying green).
 */

/** Run a probe so its failure becomes a value instead of a thrown route. */
async function attempt<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await fn() };
  } catch (e: any) {
    return { ok: false, error: e?.message ? String(e.message).slice(0, 300) : String(e).slice(0, 300) };
  }
}

export async function GET(req: NextRequest) {
  // Same audience as the page itself: whoever holds `system_health`. This is
  // deliberately narrower than the requireAdmin on the sibling route —
  // knowing which integrations are unconfigured is a map of where the app is
  // soft, so it stays with the owner-level feature.
  const auth = await requireFeature(req, 'system_health');
  if (auth.error) return auth.error;

  const groups: CheckGroup[] = [];

  // --- NetSuite live auth -------------------------------------------------
  // The cheapest query that proves the token works AND the role can read
  // something. A failure here explains most of the NetSuite rows below, so
  // it's reported first rather than leaving the reader to infer it.
  const netsuiteRows: CheckRow[] = [];
  const credsPresent = ['NETSUITE_ACCOUNT_ID', 'NETSUITE_CONSUMER_KEY', 'NETSUITE_CONSUMER_SECRET', 'NETSUITE_TOKEN_ID', 'NETSUITE_TOKEN_SECRET']
    .every(n => (process.env[n] || '').trim());

  if (!credsPresent) {
    netsuiteRows.push({
      key: 'ns_auth', label: 'NetSuite authentication', status: 'fail',
      detail: 'Credentials are not fully configured',
      impact: 'Nothing NetSuite-shaped works: no sync, no push, no financials.',
      fix: 'Set the five NETSUITE_* credential variables listed below.',
    });
  } else {
    // `item` rather than something exotic: the parts sync reads it on every
    // run, so the role provably has it. A probe against a table the app never
    // queries would report a permission gap as an auth failure and send
    // someone rotating a token that was fine.
    const probe = await attempt(() => suiteqlQuery('SELECT id FROM item', 1));
    netsuiteRows.push(probe.ok
      ? { key: 'ns_auth', label: 'NetSuite authentication', status: 'ok', detail: 'Token accepted; the SuiteQL role can read' }
      : {
          key: 'ns_auth', label: 'NetSuite authentication', status: 'fail',
          detail: `SuiteQL probe failed — ${probe.error}`,
          impact: 'Sync, pushes and financials are all affected.',
          fix: 'The error above distinguishes the two causes: a 401 means the integration token was revoked or rotated; a permission error means the role lost a grant it needs.',
        });
  }

  // Labor item — the silent-money check. CLAUDE.md: with no labor item
  // resolved, the entire labor amount vanishes from every pushed estimate
  // and sales order. It has shipped broken twice, so it gets its own row
  // rather than hiding inside the env list.
  const labor = await attempt(() => resolveLaborItem(service));
  if (!labor.ok) {
    netsuiteRows.push({
      key: 'labor_item', label: 'Labor item', status: 'unknown',
      detail: `Could not resolve — ${labor.error}`,
      impact: 'Unknown whether labor will reach NetSuite on pushed estimates and sales orders.',
    });
  } else if (labor.value.item) {
    const { source, itemNumber, id } = labor.value.item;
    const sourceLabel = source === 'env' ? 'NETSUITE_LABOR_ITEM_ID' : source === 'setting' ? 'Settings → NetSuite Labor Item' : 'ranked search';
    netsuiteRows.push({
      key: 'labor_item', label: 'Labor item', status: source === 'search' ? 'warn' : 'ok',
      detail: `${itemNumber || `internal id ${id}`} — from ${sourceLabel}`,
      ...(source === 'search' ? {
        impact: 'Resolved by search rather than configuration, so it can change under you when the item list changes.',
        fix: 'Pin it in Settings → NetSuite Labor Item.',
      } : {}),
    });
  } else {
    netsuiteRows.push({
      key: 'labor_item', label: 'Labor item', status: 'fail',
      detail: labor.value.reason === 'netsuite_error' ? `No item resolved — ${labor.value.error || 'NetSuite error'}` : 'No labor item resolved',
      impact: 'Labor is silently DROPPED from every estimate and sales order pushed to NetSuite — the hours are billed to nothing.',
      fix: 'Set one in Settings → NetSuite Labor Item, or set NETSUITE_LABOR_ITEM_ID.',
    });
  }
  groups.push({ key: 'ns_live', label: 'NetSuite', blurb: 'The live connection, and the item labor is billed to.', rows: netsuiteRows });

  // --- RESTlets -----------------------------------------------------------
  const restletRows = await Promise.all(RESTLET_SPECS.map(async spec => {
    const url = (process.env[spec.envVar] || '').trim();
    if (!url) return classifyRestlet(spec, false, null);
    // Don't burn a probe when the token itself is dead — the RESTlet would
    // report "unreachable" and send someone re-uploading a file that's fine.
    if (!credsPresent) {
      return {
        key: spec.envVar, label: spec.label, status: 'unknown' as const,
        detail: 'Not probed — NetSuite credentials are incomplete',
        impact: spec.powers, docs: spec.runbook || undefined,
      };
    }
    return classifyRestlet(spec, true, await pingRestlet(spec.key, url));
  }));
  groups.push({
    key: 'restlets',
    label: 'NetSuite RESTlets',
    blurb: 'Hand-uploaded scripts with no deploy pipeline. Each answers with its own version, so a re-upload that silently did not take shows up here instead of as a wrong number weeks later.',
    rows: restletRows,
  });

  // --- Connected apps -----------------------------------------------------
  const appRows: CheckRow[] = [];

  const googleToken = await attempt(async () => {
    const { data } = await service.from('google_tokens')
      .select('id, expiry_date, created_at').order('created_at', { ascending: false }).limit(1).maybeSingle();
    return data;
  });
  if (!googleToken.ok) {
    appRows.push({ key: 'google', label: 'Google (Gmail + Calendar)', status: 'unknown', detail: `Could not read stored token — ${googleToken.error}` });
  } else if (!googleToken.value) {
    appRows.push({
      key: 'google', label: 'Google (Gmail + Calendar)', status: 'warn',
      detail: 'No stored token — never connected, or the connection was cleared',
      impact: 'Gmail auto-import (PO and proof email) and calendar sync are both off.',
      fix: 'Reconnect Google from the admin tools to store a fresh refresh token.',
    });
  } else {
    // A refresh token stays usable past the access token's expiry — an
    // expired expiry_date is normal, not a fault. Say that, so nobody
    // "fixes" a working connection.
    appRows.push({
      key: 'google', label: 'Google (Gmail + Calendar)', status: 'ok',
      detail: `Connected — token stored ${new Date(googleToken.value.created_at).toLocaleDateString()}`,
    });
  }

  // QuickBooks Online — the ledger's historical tenant (R8-2). Unconfigured
  // is `unknown`, not a warning: the Intuit app may simply not exist yet, and
  // an unprovisioned integration must never fill "Needs attention" (the
  // Dropbox precedent). Once it IS configured, every state below is a real
  // fault the owner can act on.
  const qboRow = await attempt(async (): Promise<CheckRow> => {
    if (!qboConfigured()) {
      return {
        key: 'quickbooks', label: 'QuickBooks Online', status: 'unknown',
        detail: 'Not configured',
        impact: 'QuickBooks history import is off.',
        docs: 'docs/quickbooks-connect.md',
      };
    }
    const { data, error } = await service
      .from('quickbooks_tokens')
      .select('realm_id, environment, company_name, refresh_expires_at, needs_reauth_at')
      .eq('id', 1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) {
      return {
        key: 'quickbooks', label: 'QuickBooks Online', status: 'warn',
        detail: 'Not connected',
        impact: 'No QuickBooks history can be imported until an admin authorizes the app.',
        fix: 'Connect QuickBooks from Settings → Company',
        docs: 'docs/quickbooks-connect.md',
      };
    }
    if (data.needs_reauth_at) {
      return {
        key: 'quickbooks', label: 'QuickBooks Online', status: 'fail',
        detail: 'Reconnect QuickBooks (refresh token rejected)',
        impact: 'The daily change sync and every import are stopped.',
        fix: 'Settings → Company → QuickBooks Online → Reconnect',
        docs: 'docs/quickbooks-connect.md',
      };
    }
    // Refresh tokens die after 100 IDLE days. The daily sync renews from day
    // one, so this only fires if that job has been dead for weeks — which is
    // exactly when 14 days' notice matters.
    const refreshExpiresAt = data.refresh_expires_at ? new Date(data.refresh_expires_at) : null;
    if (refreshExpiresAt && refreshExpiresAt.getTime() - Date.now() < 14 * 86_400_000) {
      return {
        key: 'quickbooks', label: 'QuickBooks Online', status: 'warn',
        detail: `Reconnect by ${refreshExpiresAt.toLocaleDateString()} — the refresh token is close to expiring`,
        impact: 'Once it expires the connection stops until someone reauthorizes.',
        fix: 'Settings → Company → QuickBooks Online → Reconnect',
        docs: 'docs/quickbooks-connect.md',
      };
    }

    const { token, conn } = await getQboAccessToken(service);
    const probe = await fetchCompanyInfo(
      token, conn.environment, conn.realmId, conn.minorVersion || QBO_DEFAULT_MINOR_VERSION, AbortSignal.timeout(8000),
    );
    const realm = maskRealm(conn.realmId);
    if (!probe.ok && probe.status !== 401) {
      return {
        key: 'quickbooks', label: 'QuickBooks Online', status: 'warn',
        detail: `Token valid; CompanyInfo probe failed — ${probe.reason}`,
        impact: 'The connection works, but the company name cannot be confirmed from here.',
        docs: 'docs/quickbooks-connect.md',
      };
    }
    const name = (probe.ok ? probe.companyName : null) || data.company_name || 'company name unavailable';
    return {
      key: 'quickbooks', label: 'QuickBooks Online', status: 'ok',
      detail: `Connected — ${name} (${conn.environment}, realm ${realm}) · access token refreshes ${new Date(conn.accessExpiresAt).toLocaleString()} · reconnect by ${refreshExpiresAt ? refreshExpiresAt.toLocaleDateString() : 'unknown'}`,
      docs: 'docs/quickbooks-connect.md',
    };
  });
  appRows.push(qboRow.ok ? qboRow.value : {
    key: 'quickbooks', label: 'QuickBooks Online', status: 'unknown',
    detail: `Could not check the connection — ${qboRow.error}`,
    impact: 'Whether the QuickBooks history import can run cannot be confirmed from here.',
    docs: 'docs/quickbooks-connect.md',
  });

  const dropboxConfigured = !!(process.env.DROPBOX_APP_KEY && process.env.DROPBOX_APP_SECRET);
  appRows.push(dropboxConfigured
    ? { key: 'dropbox', label: 'Dropbox', status: 'ok', detail: 'App credentials set' }
    : { key: 'dropbox', label: 'Dropbox', status: 'unknown', detail: 'Not configured', impact: 'Dropbox proof search and sync are off.' });

  // The ledger PDF gate (migration 314 / R8-1). Off is the CORRECT state
  // until the R2 privacy flip in docs/r2-private-flip.md is verified, so an
  // unset gate is `unknown`, not a warning — but it must be visible, because
  // "the importer stored no PDFs" and "the gate is still shut" look
  // identical from the outside.
  //
  // Three states, not two: ledgerPdfsEnabled() fails closed for WRITES but
  // hands back `readError` when the settings row could not be read, so an
  // outage renders as "could not read the gate" rather than the flat fact
  // "Off" (R7-1). attempt() catches the same failure one layer out.
  const ledgerGate = await attempt(() => ledgerPdfsEnabled(service));
  const gateReadFailed = ledgerGate.ok ? !!ledgerGate.value.readError : true;
  if (gateReadFailed) {
    appRows.push({
      key: 'ledger_pdfs', label: 'Ledger PDF storage gate', status: 'unknown',
      detail: ledgerGate.ok ? ledgerGate.value.reason : `Could not read the gate — ${ledgerGate.error}`,
      impact: 'Whether imported documents are being stored cannot be confirmed from here.',
      fix: 'Retry once Supabase is answering; the gate itself stays shut while it cannot be read.',
      docs: 'docs/r2-private-flip.md',
    });
  } else {
    appRows.push(ledgerGate.ok && ledgerGate.value.enabled
      ? {
          key: 'ledger_pdfs', label: 'Ledger PDF storage gate', status: 'ok',
          detail: ledgerGate.value.reason,
          docs: 'docs/r2-private-flip.md',
        }
      : {
          key: 'ledger_pdfs', label: 'Ledger PDF storage gate', status: 'unknown',
          detail: 'Off — ledger PDFs are not written until the R2 privacy flip is verified',
          impact: 'Imported QuickBooks/NetSuite documents are catalogued but their bytes are not stored.',
          docs: 'docs/r2-private-flip.md',
        });
  }

  // The NetSuite half of the ledger (R8-3). Both rows read the mirror's own
  // heartbeat rather than probing NetSuite again: the job settles these
  // facts every two hours and re-asking here would double the SuiteQL cost
  // of opening this page to tell the reader the same thing.
  const nsMirror = await attempt(async () => {
    const { data, error } = await service
      .from('sync_state')
      .select('last_result')
      .eq('sync_type', NS_MIRROR_SYNC_TYPE)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return (data?.last_result ?? null) as Record<string, any> | null;
  });

  if (!nsMirror.ok) {
    for (const [key, label] of [
      ['ledger_ns_credit_memos', 'NetSuite ledger — credit memos'],
      ['ledger_ns_payments', 'NetSuite ledger — customer payments'],
    ] as const) {
      appRows.push({
        key, label, status: 'unknown',
        detail: `Could not read the mirror's last run — ${nsMirror.error}`,
        impact: 'What the integration role can and cannot read cannot be confirmed from here.',
        docs: 'docs/netsuite-ledger-grants.md',
      });
    }
  } else if (!nsMirror.value) {
    for (const [key, label] of [
      ['ledger_ns_credit_memos', 'NetSuite ledger — credit memos'],
      ['ledger_ns_payments', 'NetSuite ledger — customer payments'],
    ] as const) {
      appRows.push({
        key, label, status: 'unknown',
        detail: 'No run yet — the mirror reports this after its first run (every two hours, :35)',
        docs: 'docs/netsuite-ledger-grants.md',
      });
    }
  } else {
    // Credit memos: the header query covers CustInvc AND CustCred, so the
    // ladder having SETTLED — the run's own `columnsSettled`, never an empty
    // `droppedColumns`, which a rejected run also publishes — means the role
    // can read both. Dropped columns are the honest caveat on top of that: a
    // mirror missing `balance` is working, just less completely.
    const dropped: string[] = Array.isArray(nsMirror.value.droppedColumns) ? nsMirror.value.droppedColumns : [];
    const nsRunError = typeof nsMirror.value.error === 'string' && nsMirror.value.error.trim()
      ? nsMirror.value.error.trim().slice(0, 300)
      : null;
    if (nsMirror.value.columnsSettled !== true) {
      // The last run never got an accepted header query back, so nothing
      // here can confirm the role reads CustInvc/CustCred at all.
      appRows.push({
        key: 'ledger_ns_credit_memos', label: 'NetSuite ledger — credit memos',
        status: nsRunError ? 'warn' : 'unknown',
        detail: nsRunError
          ? `The last run could not read invoice and credit-memo headers — ${nsRunError}`
          : 'The last run never reached the header query — nothing confirmed yet',
        impact: 'Nothing confirms the SuiteQL role can read credit memos; mirrored rows are as of the last run that could.',
        ...(nsRunError
          ? { fix: 'Confirm the SuiteQL integration role still has Transactions → Invoice: View and Credit Memo: View, then wait for the next 2-hourly run.' }
          : {}),
        docs: 'docs/netsuite-ledger-grants.md',
      });
    } else {
      appRows.push(dropped.length === 0
        ? {
            key: 'ledger_ns_credit_memos', label: 'NetSuite ledger — credit memos', status: 'ok',
            detail: 'Header and line queries accepted in full',
            docs: 'docs/netsuite-ledger-grants.md',
          }
        : {
            key: 'ledger_ns_credit_memos', label: 'NetSuite ledger — credit memos', status: 'warn',
            detail: `Mirroring without ${dropped.join(', ')} — SuiteQL refused ${dropped.length > 1 ? 'those columns' : 'that column'}`,
            impact: dropped.includes('balance')
              ? 'Open balances are stored only as 0 (paid) or unknown, never guessed from the total.'
              : 'Those fields stay empty on mirrored rows.',
            docs: 'docs/netsuite-ledger-grants.md',
          });
    }

    const payments = (nsMirror.value.capabilities?.payments ?? null) as
      | { permitted?: boolean; linkTable?: string | null; reason?: string | null }
      | null;
    if (!payments) {
      appRows.push({
        key: 'ledger_ns_payments', label: 'NetSuite ledger — customer payments', status: 'unknown',
        detail: 'The last run recorded no payments probe',
        docs: 'docs/netsuite-ledger-grants.md',
      });
    } else if (payments.permitted && payments.linkTable) {
      appRows.push({
        key: 'ledger_ns_payments', label: 'NetSuite ledger — customer payments', status: 'ok',
        detail: `Mirroring via ${payments.linkTable}`,
        docs: 'docs/netsuite-ledger-grants.md',
      });
    } else if (/not probed/i.test(payments.reason || '')) {
      // The absence of an answer, not a fault: the last run never reached
      // the probe (its header query failed, or it ran out of budget).
      appRows.push({
        key: 'ledger_ns_payments', label: 'NetSuite ledger — customer payments', status: 'unknown',
        detail: payments.reason || 'Not probed yet',
        docs: 'docs/netsuite-ledger-grants.md',
      });
    } else if (payments.permitted) {
      // The CustPymt probe SUCCEEDED and only the link tables answered 400:
      // payments themselves ARE mirroring. Telling the owner to grant a
      // permission they already hold, over an impact line claiming payments
      // are missing, would be wrong on both halves.
      appRows.push({
        key: 'ledger_ns_payments', label: 'NetSuite ledger — customer payments', status: 'warn',
        detail: payments.reason || 'Payments mirror; neither link table answered',
        impact: 'Payments mirror, but what each one was applied to does not — invoices show no payments against them.',
        fix: 'An engineering bug in the link-table query, not a missing grant: report the rejected query rather than changing permissions.',
        docs: 'docs/netsuite-ledger-grants.md',
      });
    } else if (/query shape rejected/i.test(payments.reason || '')) {
      // A 400 is the app asking SuiteQL for something it does not
      // understand. The runbook says this verbatim: report it, grant nothing.
      appRows.push({
        key: 'ledger_ns_payments', label: 'NetSuite ledger — customer payments', status: 'warn',
        detail: payments.reason || 'query shape rejected',
        impact: 'Payments and what they were applied to are missing from the ledger; invoices still mirror.',
        fix: 'An engineering bug, not a grant: report the rejected query — no NetSuite permission change will fix it.',
        docs: 'docs/netsuite-ledger-grants.md',
      });
    } else if (/not permitted/i.test(payments.reason || '') || !payments.reason) {
      appRows.push({
        key: 'ledger_ns_payments', label: 'NetSuite ledger — customer payments', status: 'warn',
        detail: payments.reason || 'not permitted — see docs/netsuite-ledger-grants.md',
        impact: 'Payments and what they were applied to are missing from the ledger; invoices still mirror.',
        fix: 'Grant the SuiteQL integration role Transactions → Customer Payment: View and Find Transaction: View.',
        docs: 'docs/netsuite-ledger-grants.md',
      });
    } else {
      // 'probe failed: …' — a 429, a 5xx or a network error. Unsettled, not
      // a verdict: the next 2-hourly run asks again.
      appRows.push({
        key: 'ledger_ns_payments', label: 'NetSuite ledger — customer payments', status: 'unknown',
        detail: payments.reason,
        impact: 'Whether payments can be read is unsettled — the mirror re-probes on its next run (every two hours).',
        docs: 'docs/netsuite-ledger-grants.md',
      });
    }
  }

  const smsProvider = (process.env.SMS_PROVIDER || '').trim().toLowerCase();
  const dialpadReady = !!(process.env.DIALPAD_API_KEY && (process.env.DIALPAD_FROM_NUMBER || process.env.DIALPAD_USER_ID));
  const twilioReady = !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER);
  const activeReady = smsProvider === 'dialpad' ? dialpadReady : smsProvider === 'twilio' ? twilioReady : false;
  appRows.push({
    key: 'sms', label: 'Phone & SMS', status: activeReady ? 'ok' : smsProvider ? 'warn' : 'unknown',
    detail: smsProvider
      ? `Provider ${smsProvider}${activeReady ? ' — credentials complete' : ' — credentials incomplete'}`
      : 'No SMS_PROVIDER selected',
    ...(activeReady ? {} : {
      impact: 'Text alerts do not send.',
      fix: smsProvider === 'dialpad'
        ? 'Set DIALPAD_API_KEY plus DIALPAD_FROM_NUMBER or DIALPAD_USER_ID.'
        : smsProvider === 'twilio'
          ? 'Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_PHONE_NUMBER.'
          : 'Set SMS_PROVIDER to twilio or dialpad, then that provider’s credentials.',
    }),
  });
  // The screen-pop rides a webhook, not the send path — it can be dark while
  // outbound SMS works, which is the confusing state worth naming.
  if (smsProvider === 'dialpad') {
    appRows.push(process.env.DIALPAD_WEBHOOK_SECRET
      ? { key: 'dialpad_hook', label: 'Dialpad call events', status: 'ok', detail: 'Webhook secret set' }
      : {
          key: 'dialpad_hook', label: 'Dialpad call events', status: 'warn',
          detail: 'No webhook secret — inbound call events are rejected',
          impact: 'The caller-ID screen-pop and CRM call logging never fire, even though outbound texts work.',
          fix: 'Set DIALPAD_WEBHOOK_SECRET, then register the subscription in Dialpad pointing at /api/webhooks/dialpad.',
        });
  }
  groups.push({ key: 'apps', label: 'Connected apps', blurb: 'Third-party accounts the app signs in to.', rows: appRows });

  // --- Environment variables ---------------------------------------------
  for (const g of ENV_GROUPS) {
    const rows = ENV_SPECS.filter(s => s.group === g.key).map(s => checkEnv(s, process.env[s.name]));
    if (rows.length > 0) groups.push({ key: `env_${g.key}`, label: g.label, blurb: g.blurb, rows });
  }

  // --- Migrations ---------------------------------------------------------
  // The repo's migrations/ ships with this route via outputFileTracingIncludes
  // in next.config.js. If that ever stops working the panel says so rather
  // than reporting a false "all applied" against an empty repo list.
  const repoFiles = await attempt(async () =>
    readdirSync(join(process.cwd(), 'migrations')).filter(f => f.endsWith('.sql')).sort());
  const appliedRows = await attempt(async () => {
    const { data, error } = await service.from('schema_migrations').select('filename');
    if (error) throw new Error(error.message);
    return (data || []).map(r => r.filename as string);
  });
  const migrationRow: CheckRow = appliedRows.ok
    ? compareMigrations(repoFiles.ok ? repoFiles.value : [], appliedRows.value)
    : {
        key: 'migrations', label: 'Migrations', status: 'unknown',
        detail: `Could not read schema_migrations — ${appliedRows.error}`,
        impact: 'Cannot confirm the database schema matches the deployed code.',
      };
  groups.push({
    key: 'migrations',
    label: 'Database migrations',
    blurb: 'Applied automatically by the production build, in filename order, inside transactions. A failure fails the deploy — so code whose schema did not apply should never be live.',
    rows: [migrationRow],
  });

  return NextResponse.json({
    groups: groups.map(g => ({ ...g, status: rollUp(g.rows) })),
    generatedAt: new Date().toISOString(),
  });
}
