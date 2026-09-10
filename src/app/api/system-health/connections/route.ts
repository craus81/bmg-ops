import { NextRequest, NextResponse } from 'next/server';
import { readdirSync } from 'fs';
import { join } from 'path';
import { createServiceClient } from '@/lib/supabase-service';
import { requireFeature } from '@/lib/api-auth';
import { callRestlet, suiteqlQuery } from '@/lib/netsuite';
import { resolveLaborItem } from '@/lib/labor-item';
import { RESTLET_SPECS } from '@/lib/restlet-versions';
import {
  ENV_GROUPS, ENV_SPECS, checkEnv, classifyRestlet, compareMigrations, rollUp,
  type CheckGroup, type CheckRow, type RestletProbe,
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

/** Ping one RESTlet. GET for financials/PDF, POST for the item RESTlet. */
async function pingRestlet(key: string, url: string): Promise<RestletProbe> {
  try {
    const result = key === 'item'
      ? await callRestlet(url, 'POST', undefined, { action: 'ping' })
      : await callRestlet(url, 'GET', { action: 'ping' });
    // A deployment older than the ping action still answers 200 — with
    // whatever its real entry point does with an unknown action. No version
    // field is the tell, and classifyRestlet treats it as stale, not OK.
    const version = result && typeof result.version === 'string' ? result.version : null;
    return { reachable: true, version };
  } catch (e: any) {
    return { reachable: false, error: e?.message ? String(e.message).slice(0, 200) : 'request failed' };
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

  const dropboxConfigured = !!(process.env.DROPBOX_APP_KEY && process.env.DROPBOX_APP_SECRET);
  appRows.push(dropboxConfigured
    ? { key: 'dropbox', label: 'Dropbox', status: 'ok', detail: 'App credentials set' }
    : { key: 'dropbox', label: 'Dropbox', status: 'unknown', detail: 'Not configured', impact: 'Dropbox proof search and sync are off.' });

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
