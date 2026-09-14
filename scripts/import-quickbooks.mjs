#!/usr/bin/env node
/**
 * Drive the QuickBooks ledger import from OUTSIDE the app.
 *
 * The bulk pull is chunked because Vercel functions cap out: the route does
 * ≤ ~45 s (or whatever --budget says) of work per call and hands back a
 * cursor. This script is the loop. It holds no logic of its own — every
 * decision lives in src/lib/quickbooks/* and the route — so there is exactly
 * one implementation of the import.
 *
 * Node 22, no dependencies.
 *
 *   APP_URL=https://ops.example.com CRON_SECRET=… \
 *     node scripts/import-quickbooks.mjs --mode dry-run
 *
 * Run --help for the full option list and the gate rules.
 */

const APP_URL = (process.env.APP_URL || '').replace(/\/$/, '');
const CRON_SECRET = process.env.CRON_SECRET || '';

const USAGE = `
Drive the QuickBooks ledger import.

  APP_URL=<https://host>   required
  CRON_SECRET=<secret>     required (the same value as the Vercel env var)

  --mode dry-run|report-viewed|confirm-cutover|import|resume|status|cancel|probe-r2
  --run <uuid>             the run to resume, cancel or inspect
  --dry-run-id <uuid>      the dry run an import or cutover is gated on
  --date YYYY-MM-DD        the cutover date to confirm
  --phases a,b             a subset of: connect,reference,customers,match,
                           transactions,attachments_index,pdfs,
                           attachments_fetch,reports,repair,finalize
  --budget 240000          ms of work per call (default 45000, max 240000)
  --max-loops N            stop after N chunks (default 500)
  --confirm <host>         required for import / resume / probe-r2; must equal
                           the APP_URL host, so a production run cannot be
                           started by muscle memory

THE GATE. --dry-run-id is REQUIRED for every 'import' whose --phases is not a
subset of pdfs,attachments_fetch,repair. 'reports' is NOT in that set — it
writes fresh financial rows, so it carries the same dry-run + cutover gate a
full import does. A 412 needsDryRun is not retried: run --mode dry-run, read
the report, then --mode confirm-cutover.

ORDER (docs/ledger-import.md): probe-r2 → dry-run → report-viewed →
confirm-cutover → import.
`;

function parseArgs(argv) {
  const out = { mode: 'status', budget: 45_000, maxLoops: 500 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--mode') out.mode = next();
    else if (a === '--run') out.run = next();
    else if (a === '--dry-run-id') out.dryRunId = next();
    else if (a === '--date') out.date = next();
    else if (a === '--phases') out.phases = next().split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--budget') out.budget = Number(next());
    else if (a === '--max-loops') out.maxLoops = Number(next());
    else if (a === '--confirm') out.confirm = next();
    else { console.error(`Unknown option ${a}`); process.exit(2); }
  }
  return out;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * POST one chunk. Retries the failures that are about the PIPE (network,
 * 502/504, an HTML error page from the edge) and never the ones that are
 * about the REQUEST.
 */
async function post(body) {
  let backoff = 5_000;
  for (let attempt = 1; attempt <= 10; attempt++) {
    let res;
    try {
      res = await fetch(`${APP_URL}/api/admin/ledger/import`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${CRON_SECRET}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (e) {
      console.error(`  network error (${e.message}) — retrying in ${backoff / 1000}s`);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 60_000);
      continue;
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* an HTML error page */ }
    if (json === null) {
      if (attempt === 10) return { status: res.status, body: { error: text.slice(0, 300) } };
      console.error(`  non-JSON response (HTTP ${res.status}) — retrying in ${backoff / 1000}s`);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 60_000);
      continue;
    }
    if ((res.status === 502 || res.status === 504) && attempt < 10) {
      console.error(`  HTTP ${res.status} — retrying in ${backoff / 1000}s`);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 60_000);
      continue;
    }
    return { status: res.status, body: json };
  }
  return { status: 0, body: { error: 'gave up after 10 attempts' } };
}

function summarize(b) {
  const bits = [b.mode, b.status, b.phase || '—'];
  if (b.entity) bits.push(b.entity);
  if (b.progress) bits.push(`${b.progress.processed ?? 0}/${b.progress.expected ?? '?'}`, `${b.progress.apiCalls ?? 0} calls`);
  if (b.partial) bits.push('partial');
  return bits.join(' · ');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(USAGE); return 0; }
  if (!APP_URL) { console.error('APP_URL is required.\n' + USAGE); return 2; }
  if (!CRON_SECRET) { console.error('CRON_SECRET is required.\n' + USAGE); return 2; }

  // A production import is not something to start by accident.
  if (['import', 'resume', 'probe-r2'].includes(args.mode)) {
    const host = new URL(APP_URL).host;
    if (args.confirm !== host) {
      console.error(`--mode ${args.mode} needs --confirm ${host}`);
      return 2;
    }
  }

  // The CLI spells modes with hyphens; the route's discriminated union uses
  // underscores. Posting the hyphenated form would be a bare 400 from
  // validateBody, so the translation happens here, once.
  const mode = args.mode.replace(/-/g, '_');
  const base = { mode };
  if (args.budget) base.budgetMs = Math.min(args.budget, 240_000);

  if (mode === 'probe_r2') {
    const { status, body } = await post({ mode });
    if (status !== 200) { console.error(body.error || `HTTP ${status}`); return 2; }
    console.log(`Wrote ${body.key}${body.existed ? ' (already there)' : ''}`);
    console.log(body.publicUrlToTest
      ? `Now request this URL and confirm it is BLOCKED:\n  ${body.publicUrlToTest}`
      : `  ${body.note}`);
    return 0;
  }

  if (mode === 'report_viewed' || mode === 'cancel') {
    if (!args.run) { console.error(`--mode ${args.mode} needs --run <uuid>`); return 2; }
    const { status, body } = await post({ mode, runId: args.run });
    console.log(JSON.stringify(body, null, 2));
    return status === 200 ? 0 : 2;
  }

  if (mode === 'confirm_cutover') {
    if (!args.dryRunId || !args.date) { console.error('--mode confirm-cutover needs --dry-run-id and --date'); return 2; }
    let payload = { ...base, mode, dryRunId: args.dryRunId, date: args.date };
    for (let i = 0; i < args.maxLoops; i++) {
      const { status, body } = await post(payload);
      if (status !== 200) { console.error(body.error || `HTTP ${status}`); return 2; }
      console.log(`restamped ${body.restamped}${body.partial ? ' (partial)' : ''}`);
      if (!body.partial) return 0;
    }
    console.error('still partial after --max-loops; run it again');
    return 2;
  }

  if (mode === 'status') {
    const { status, body } = await post(args.run ? { mode, runId: args.run } : { mode });
    console.log(JSON.stringify(body, null, 2));
    return status === 200 ? 0 : 2;
  }

  // ── The looping modes: dry_run, import, resume ────────────────────────
  let payload = { ...base, mode };
  if (mode === 'dry_run' && args.run) payload.runId = args.run;
  if (mode === 'import') {
    if (args.dryRunId) payload.dryRunId = args.dryRunId;
    if (args.phases) payload.phases = args.phases;
  }
  if (mode === 'resume') {
    if (!args.run) { console.error('--mode resume needs --run <uuid>'); return 2; }
    payload.runId = args.run;
  }

  let runId = args.run || null;
  for (let i = 0; i < args.maxLoops; i++) {
    const { status, body } = await post(payload);

    if (status === 412) {
      // The dry-run gate. Retrying would just fail the same way.
      console.error(`\n${body.error}\nRun --mode dry-run, read the report, then --mode confirm-cutover.`);
      return 2;
    }
    if (status === 403 && body.needsFlip) {
      console.error(`\n${body.error}`);
      return 2;
    }
    if (status === 401) {
      console.error(`\n${body.error} — reconnect from Settings → Company.`);
      return 2;
    }
    if (status === 409) {
      console.error(`  ${body.error} — waiting ${(body.retryAfterMs || 5_000) / 1000}s`);
      await sleep(body.retryAfterMs || 5_000);
      if (body.runId) { runId = body.runId; payload = { mode: 'resume', runId, budgetMs: base.budgetMs }; }
      continue;
    }
    if (status !== 200) {
      console.error(body.error || `HTTP ${status}`);
      return 2;
    }

    runId = body.runId || runId;
    console.log(summarize(body));
    for (const line of (body.lastErrors || []).slice(0, 3)) console.log(`    ! ${line}`);

    if (body.status === 'failed') {
      console.error(`\nFailed: ${body.error}`);
      console.error(`Resume with: node scripts/import-quickbooks.mjs --mode resume --run ${runId} --confirm ${new URL(APP_URL).host}`);
      return 2;
    }
    if (body.complete) {
      console.log(`\nComplete. Run ${runId}.`);
      if (mode === 'dry_run') {
        console.log('Read the report on /admin/ledger, then:');
        console.log(`  --mode report-viewed --run ${runId}`);
        console.log(`  --mode confirm-cutover --dry-run-id ${runId} --date <YYYY-MM-DD>`);
      }
      return 0;
    }
    // Throttled or budget-stopped: honour the wait the route asked for.
    if (body.retryAfterMs) await sleep(body.retryAfterMs);
    else await sleep(2_000);
    payload = { mode: mode === 'dry_run' ? 'dry_run' : 'resume', budgetMs: base.budgetMs };
    if (mode === 'dry_run') payload.runId = runId;
    else payload.runId = runId;
  }

  console.error(`\nStopped after ${args.maxLoops} chunks; run --mode resume --run ${runId} to continue.`);
  return 2;
}

main().then(code => process.exit(code)).catch(e => {
  console.error(e?.stack || e?.message || e);
  process.exit(2);
});
