#!/usr/bin/env node
/**
 * Paychex Flex External API smoke test.
 *
 * Verifies the client-credentials setup end to end without storing or
 * printing anything sensitive: mints a token, lists companies, then
 * checks whether the app's entitlements expose workers (headcount),
 * pay periods, and checks — the feeds the CEO dashboard payroll sync
 * needs (docs/ceo-dashboard-plan.md). Endpoints match the External
 * API OpenAPI spec (v1.0). Prints counts and HTTP statuses only: no
 * worker names, no pay amounts, no token.
 *
 * Usage:
 *   PAYCHEX_CLIENT_ID=... PAYCHEX_CLIENT_SECRET=... node scripts/paychex-smoke-test.mjs
 *
 * Optional: PAYCHEX_API_BASE (defaults to https://api.paychex.com).
 * Requires Node 18+ (global fetch).
 */

const BASE = process.env.PAYCHEX_API_BASE || 'https://api.paychex.com';
const CLIENT_ID = process.env.PAYCHEX_CLIENT_ID;
const CLIENT_SECRET = process.env.PAYCHEX_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error(
    'Set PAYCHEX_CLIENT_ID and PAYCHEX_CLIENT_SECRET as environment variables.\n' +
    '(Env vars, not CLI arguments — arguments would land in shell history.)',
  );
  process.exit(1);
}

const ok = (label, extra = '') => console.log(`  ✓ ${label}${extra ? ` — ${extra}` : ''}`);
const bad = (label, extra = '') => console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`);

/** Paychex list responses are usually { metadata, content: [...] }, but be
 * defensive — the wrapper varies by endpoint. */
function rows(body) {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.content)) return body.content;
  for (const v of Object.values(body || {})) if (Array.isArray(v)) return v;
  return [];
}

async function getToken() {
  let res;
  try {
    res = await fetch(`${BASE}/auth/oauth/v2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
      }),
    });
  } catch (e) {
    bad('token', `cannot reach ${BASE} (${e.cause?.code || e.message})`);
    return null;
  }
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.access_token) {
    bad(`token (HTTP ${res.status})`, body?.error_description || body?.error || 'no access_token in response');
    return null;
  }
  ok('token', `bearer issued, expires in ${body.expires_in}s`);
  return body.access_token;
}

async function get(path, token) {
  try {
    const res = await fetch(`${BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  } catch (e) {
    return { status: 0, body: null, error: e.cause?.code || e.message };
  }
}

/** 403 on a data endpoint means the token is fine but the Integrated App
 * wasn't granted that data type — fix it in Paychex Flex, not in code. */
function explain(status, error) {
  if (status === 0) return `network error (${error || 'unreachable'})`;
  if (status === 403) return 'entitlement not granted to this app (adjust data access in Paychex Flex)';
  if (status === 401) return 'token rejected';
  return `HTTP ${status}`;
}

const token = await getToken();
if (!token) process.exit(1);

const companies = await get('/companies', token);
const companyList = rows(companies.body);
if (companies.status !== 200 || companyList.length === 0) {
  bad(`companies (HTTP ${companies.status})`, explain(companies.status, companies.error));
  process.exit(1);
}
ok('companies', `${companyList.length} visible`);

let workersOk = false;
let payPeriodsOk = false;
let checksOk = false;

for (const c of companyList.slice(0, 3)) {
  const companyId = c.companyId || c.id;
  console.log(`\nCompany: ${c.legalName || c.displayId || companyId} (companyId ${companyId})`);

  const workers = await get(`/companies/${companyId}/workers`, token);
  if (workers.status === 200) {
    const total = workers.body?.metadata?.pagination?.total;
    ok('workers', `${total ?? rows(workers.body).length}${total != null ? ' total' : ' on first page'}`);
    workersOk = true;
  } else {
    bad('workers', explain(workers.status, workers.error));
  }

  // Pay periods over the last ~90 days, then a checks probe against the
  // most recent one — checks are only queryable per pay period
  // (payperiodid is a required parameter in the External API).
  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
  const periods = await get(`/companies/${companyId}/payperiods?from=${from}&to=${to}`, token);
  if (periods.status !== 200) {
    bad('payperiods', explain(periods.status, periods.error));
    continue;
  }
  const list = rows(periods.body);
  ok('payperiods', `${list.length} in the last 90 days`);
  payPeriodsOk = true;

  const latest = [...list].sort((a, b) => String(b.endDate || '').localeCompare(String(a.endDate || '')))[0];
  if (!latest?.payPeriodId) {
    console.log('  · checks probe skipped (no pay period found in range)');
    continue;
  }
  const checks = await get(`/companies/${companyId}/checks?payperiodid=${latest.payPeriodId}`, token);
  if (checks.status === 200) {
    ok('checks', `${rows(checks.body).length} in pay period ending ${latest.endDate || '?'}`);
    checksOk = true;
  } else {
    bad('checks', explain(checks.status, checks.error));
  }
}

console.log('');
if (workersOk && payPeriodsOk && checksOk) {
  console.log('All good: headcount, pay periods, and check data are all readable — the dashboard sync is fully unblocked.');
} else if (workersOk || payPeriodsOk || checksOk) {
  console.log('Partial: some data is readable, the ✗ items above need their entitlements enabled in Paychex Flex.');
  process.exitCode = 1;
} else {
  console.log('Token works but no payroll/worker data is readable — enable data access for this app in Paychex Flex.');
  process.exitCode = 1;
}
