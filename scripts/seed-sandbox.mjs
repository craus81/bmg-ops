#!/usr/bin/env node
/**
 * seed-sandbox.mjs — fill a FRESH sandbox Supabase project with believable
 * FleetSuite data so every list, board and report has content.
 *
 *   NEXT_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co \
 *   SUPABASE_SERVICE_ROLE_KEY=... \
 *   SEED_SANDBOX_CONFIRM=<ref> \
 *   node scripts/seed-sandbox.mjs [--dry-run]
 *
 * !!! THIS SCRIPT MUST NEVER BE POINTED AT PRODUCTION !!!
 * It refuses to run unless SEED_SANDBOX_CONFIRM equals the project ref parsed
 * from the URL, and refuses outright when that ref is the known production
 * project (PRODUCTION_REF below, checked in — no env var needed) or equals
 * PRODUCTION_SUPABASE_REF (optional extra guard). It talks to Supabase over
 * HTTPS only (supabase-js + service role) — never a Postgres connection.
 *
 * Idempotent: every row id is a deterministic sha256-derived UUID and every
 * write is an upsert, so re-running updates rather than duplicates. Seeded
 * rows carry the marker "[sandbox seed]" wherever a notes/description column
 * exists. Auth users are created with a printed known password.
 *
 * Optional env: SEED_PASSWORD (default Sandbox!2026), SEED_EMAIL_DOMAIN
 * (default sandbox.fleetsuite.test).
 */
import { createClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';

// ───────────────────────────── config / safety ─────────────────────────────
const DRY_RUN = process.argv.includes('--dry-run');
const URL = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const PASSWORD = process.env.SEED_PASSWORD || 'Sandbox!2026';
const EMAIL_DOMAIN = process.env.SEED_EMAIL_DOMAIN || 'sandbox.fleetsuite.test';
const MARK = '[sandbox seed]';
/** Production project ref (README.md "Environment Variables"). Checked in so the
 *  refusal never depends on a fresh shell having PRODUCTION_SUPABASE_REF set. */
const PRODUCTION_REF = 'jdwoceryzhbimjmtwrpr';

function fail(msg) { console.error(`\nREFUSING: ${msg}\n`); process.exit(2); }

if (!URL) fail('NEXT_PUBLIC_SUPABASE_URL is not set');
if (!KEY && !DRY_RUN) fail('SUPABASE_SERVICE_ROLE_KEY is not set');
const refMatch = URL.match(/^https:\/\/([a-z0-9-]+)\.supabase\.co\/?$/i);
if (!refMatch) fail(`URL "${URL}" is not of the form https://<ref>.supabase.co`);
const REF = refMatch[1];
// The URL regex above only admits https://<ref>.supabase.co, and production is
// itself a *.supabase.co project, so the only real production guard is the ref.
if (REF.toLowerCase() === PRODUCTION_REF) fail(`ref ${REF} is the production project — never seed it`);
if (process.env.PRODUCTION_SUPABASE_REF && process.env.PRODUCTION_SUPABASE_REF === REF) {
  fail(`ref ${REF} equals PRODUCTION_SUPABASE_REF — that is production`);
}
if (process.env.SEED_SANDBOX_CONFIRM !== REF) {
  fail(`SEED_SANDBOX_CONFIRM does not match the project ref.\n` +
    `  Target project ref: ${REF}\n` +
    `  To confirm this is a throwaway sandbox, run again with:\n` +
    `    SEED_SANDBOX_CONFIRM=${REF} node scripts/seed-sandbox.mjs`);
}

const supabase = DRY_RUN
  ? null
  : createClient(URL, KEY, { auth: { autoRefreshToken: false, persistSession: false } });

// ───────────────────────────── helpers ─────────────────────────────
const NAMESPACE = 'fleetsuite-sandbox-seed-v1';

/** Deterministic v4-shaped UUID from a stable key (e.g. 'customer:acme-fleet'). */
export function id(key) {
  const h = createHash('sha256').update(`${NAMESPACE}:${key}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${(parseInt(h[16], 16) & 0x3 | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
/** Deterministic pseudo-random in [0,1) from a key. */
function rnd(key) {
  const h = createHash('sha256').update(`${NAMESPACE}:rnd:${key}`).digest();
  return h.readUInt32BE(0) / 0x100000000;
}
const NOW = new Date();
const DAY = 86400000;
function at(daysOffset, hour = 9) {
  const d = new Date(NOW.getTime() + daysOffset * DAY);
  d.setUTCHours(0, 0, 0, 0);
  return new Date(d.getTime() + hour * 3600000).toISOString();
}
function day(daysOffset) { return at(daysOffset).slice(0, 10); }
function money(n) { return Math.round(n * 100) / 100; }
function pad(n, w) { return String(n).padStart(w, '0'); }
function vinFor(prefix, i) { return (prefix + pad(i, 17 - prefix.length)).slice(0, 17); }

const summary = {};   // table -> rows written
const failures = [];  // { group, table, message }
const warnings = [];

function chunk(arr, n) { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }

/** Upsert rows into a table (chunked). Throws on error with the table name attached. */
async function upsert(table, rows, onConflict = 'id') {
  if (!rows.length) return;
  summary[table] = (summary[table] || 0) + rows.length;
  if (DRY_RUN) return;
  for (const part of chunk(rows, 200)) {
    const { error } = await supabase.from(table).upsert(part, { onConflict });
    if (error) { const e = new Error(`${table}: ${error.message}${error.details ? ` (${error.details})` : ''}`); e.table = table; throw e; }
  }
}

/** Upsert that records a failure but does not abort the surrounding group —
 *  for tables whose base columns are only evidenced by app code, not migrations. */
async function softUpsert(table, rows, onConflict = 'id') {
  try { await upsert(table, rows, onConflict); return true; }
  catch (err) { console.error(`\n   ✖ ${table}: ${err.message}`); failures.push({ group: table, table, message: err.message }); return false; }
}

/** Patch one row by id. */
async function update(table, rowId, patch) {
  if (DRY_RUN) return;
  const { error } = await supabase.from(table).update(patch).eq('id', rowId);
  if (error) { const e = new Error(`${table} (update): ${error.message}`); e.table = table; throw e; }
}

/** Delete children of the given parents then insert — for tables whose UPDATE
 *  path is broken (BEFORE UPDATE trigger referencing a missing updated_at). */
async function replaceChildren(table, parentCol, parentIds, rows) {
  summary[table] = (summary[table] || 0) + rows.length;
  if (DRY_RUN) return;
  for (const ids of chunk(parentIds, 100)) {
    const { error } = await supabase.from(table).delete().in(parentCol, ids);
    if (error) { const e = new Error(`${table} (delete): ${error.message}`); e.table = table; throw e; }
  }
  for (const part of chunk(rows, 200)) {
    const { error } = await supabase.from(table).insert(part);
    if (error) { const e = new Error(`${table} (insert): ${error.message}`); e.table = table; throw e; }
  }
}

async function select(table, cols = '*') {
  if (DRY_RUN) return [];
  const { data, error } = await supabase.from(table).select(cols).limit(1000);
  if (error) { warnings.push(`${table}: select failed — ${error.message}`); return []; }
  return data || [];
}

async function group(name, fn) {
  process.stdout.write(`▸ ${name} … `);
  try {
    await fn();
    console.log('ok');
  } catch (err) {
    console.log('FAILED');
    const table = err.table || name;
    console.error(`   ✖ ${table}: ${err.message}`);
    failures.push({ group: name, table, message: err.message });
  }
}

// ───────────────────────────── shared state ─────────────────────────────
/** role -> auth user id (populated by seedUsers) */
const U = {};
const NAMES = {};
const CUSTOMERS = [];    // seeded customer rows
const PROSPECTS = [];
const PARTS = [];
const ESTIMATES = [];
const WRAP_QUOTES = [];
const GRAPHICS_JOBS = [];
const CHECKINS = [];
const UPFIT_PROJECTS = [];
const VENDOR_POS = [];
const CNI_JOBS = [];
const SCAN_LOGS = [];
const SUBSTRATES = [];
const ROLLS = [];
let LOCATIONS = [];      // work_locations rows
let PLATFORMS = {};      // key -> id
let CATEGORIES = {};     // name -> id
let TAGS = {};           // label -> id

const COMPANY = {
  midwest: id('company:midwest-wrap-installers'),
  gulf: id('company:gulf-coast-fleet-graphics'),
};
/** Set by seedUsers. When the companies upsert fails, every later writer that
 *  links to COMPANY.* (profiles, CNI jobs/invites/bids, vendor invoices) leaves
 *  the link null instead of failing three groups later on an FK violation. */
let companiesOk = true;

// ═════════════════════════════ 1. users + profiles ═════════════════════════════
const USER_SPECS = [
  // key, scalar role, roles[], full name
  ['super_admin', 'admin', ['admin', 'super_admin'], 'Sam Superuser'],
  ['admin', 'admin', ['admin'], 'Alex Admin'],
  ['executive', 'executive', ['executive'], 'Evelyn Executive'],
  ['finance', 'finance', ['finance'], 'Frank Finance'],
  ['sales', 'sales', ['sales'], 'Sarah Sales'],
  ['graphics_production', 'graphics_production', ['graphics_production'], 'Gabe Graphics'],
  ['shop_tech', 'shop_tech', ['shop_tech'], 'Tina Shoptech'],
  ['field_tech', 'field_tech', ['field_tech'], 'Felix Fieldtech'],
  ['installer', 'installer', ['installer'], 'Ivan Installer'],
  ['installer2', 'installer', ['installer'], 'Isla Installer'],
  ['customer', 'customer', ['customer'], 'Casey Customer'],
];
const CUSTOMER_USER_NETSUITE_ID = '1001'; // links the customer-role login to Acme Fleet Services

async function findUserByEmail(email) {
  let page = 1;
  for (;;) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(`auth.listUsers: ${error.message}`);
    const hit = (data?.users || []).find((u) => (u.email || '').toLowerCase() === email.toLowerCase());
    if (hit) return hit;
    if (!data?.users?.length || data.users.length < 1000) return null;
    page++;
  }
}

async function seedUsers() {
  for (const [key, role, roles, fullName] of USER_SPECS) {
    const email = `${key}@${EMAIL_DOMAIN}`;
    NAMES[key] = fullName;
    if (DRY_RUN) { U[key] = id(`user:${key}`); continue; }
    const { data, error } = await supabase.auth.admin.createUser({
      email, password: PASSWORD, email_confirm: true,
      user_metadata: { full_name: fullName, seed: MARK },
    });
    if (error) {
      if (!/already|exists|registered/i.test(error.message)) throw new Error(`auth.createUser(${email}): ${error.message}`);
      const existing = await findUserByEmail(email);
      if (!existing) throw new Error(`auth user ${email} reported as existing but not found`);
      const { error: resetErr } = await supabase.auth.admin.updateUserById(existing.id, { password: PASSWORD, email_confirm: true });
      if (resetErr) throw new Error(`auth.updateUserById(${email}): ${resetErr.message}`);
      U[key] = existing.id;
    } else {
      U[key] = data.user.id;
    }
    summary['auth.users'] = (summary['auth.users'] || 0) + 1;
  }
  if (DRY_RUN) summary['auth.users'] = USER_SPECS.length;

  // Companies first (installer profiles point at them); the back-reference to the
  // primary contact profile is patched in after the profiles exist.
  const companies = [
    { id: COMPANY.midwest, name: 'Midwest Wrap Installers LLC', phone: '314-555-0140', email: 'dispatch@midwestwrap.example', address: { line1: '2200 Industrial Dr', city: "O'Fallon", state: 'MO', zip: '63366' }, netsuite_vendor_id: '7001', insurance_expiry: day(120), primary_contact_profile_id: U.installer },
    { id: COMPANY.gulf, name: 'Gulf Coast Fleet Graphics', phone: '713-555-0177', email: 'jobs@gulfcoastfleet.example', address: { line1: '901 Bayou Rd', city: 'Houston', state: 'TX', zip: '77002' }, netsuite_vendor_id: '7002', insurance_expiry: day(20), primary_contact_profile_id: U.installer2 },
  ];
  // companies predates migrations/: base columns id + name are evidenced only by
  // migration 122 (`INSERT INTO companies (name) ... RETURNING id`); the rest are
  // 110/165/300 deltas. Soft so a base-column mismatch reports instead of taking
  // profiles/cni_profiles down with it; profiles then skip the company FK.
  companiesOk = await softUpsert('companies', companies.map((c) => ({ ...c, primary_contact_profile_id: null })));
  if (!companiesOk) warnings.push('companies did not seed — company links on profiles, CNI jobs/invites/bids and installer invoices were left null');

  const profiles = USER_SPECS.map(([key, role, roles, fullName]) => ({
    id: U[key],
    email: `${key}@${EMAIL_DOMAIN}`,
    full_name: fullName,
    role,
    roles,
    status: 'approved',
    deactivated: false,
    phone_number: `636-555-01${pad(USER_SPECS.findIndex((s) => s[0] === key), 2)}`,
    company_id: !companiesOk ? null : key === 'installer' ? COMPANY.midwest : key === 'installer2' ? COMPANY.gulf : null,
    customer_netsuite_id: key === 'customer' ? CUSTOMER_USER_NETSUITE_ID : null,
    is_field_installer: key === 'field_tech',
    email_signature: `${fullName}\nBMG Fleet (sandbox)`,
  }));
  // profiles predates migrations/: id/email/full_name/role come from handle_new_user()
  // (migration 045), status/roles/company_id from the same upsert shape in
  // src/app/api/admin/create-user/route.ts:121-129. handle_new_user() already
  // inserted (id, email, full_name, role) when the auth user was created, so this
  // upsert on id is an UPDATE for fresh users — the base names must be exact.
  await softUpsert('profiles', profiles);
  if (companiesOk) for (const c of companies) await update('companies', c.id, { primary_contact_profile_id: c.primary_contact_profile_id });

  await upsert('notification_preferences', USER_SPECS.map(([key]) => ({
    id: id(`notification_preferences:${key}`), user_id: U[key],
    notify_new_job: true, notify_status_change: true, notify_ready: true, notify_shipped: true,
    notify_in_app: true, notify_email: false, notify_sms: false, notify_new_po: key === 'admin',
    notify_invoicing: key === 'finance' || key === 'admin', notify_weekly_brief: true, email_mentions: true,
  })), 'user_id');

  await upsert('cni_profiles', [
    { id: id('cni_profile:installer'), user_id: U.installer, primary_contact_name: NAMES.installer, phone: '314-555-0140',
      business_address: { line1: '2200 Industrial Dr', city: "O'Fallon", state: 'MO', zip: '63366' }, service_area: { zip: '63366', radius_miles: 150 },
      coverage_radius_miles: 150, service_types: ['graphics', 'upfit'], equipment_capabilities: ['heat_gun', 'lift', 'trailer'],
      availability_status: 'available', availability_notes: MARK, insurance_expiry: day(120), terms_accepted_at: at(-200),
      install_expectations_accepted_at: at(-200), timeline_agreement_accepted_at: at(-200), completion_reliability: 'good',
      photo_quality: 'pass', communication_rating: 'responsive', jobs_completed: 42, jobs_on_time: 39, risk_tags: [],
      profile_complete: true, onboarded_at: at(-200), netsuite_vendor_id: '7001' },
    { id: id('cni_profile:installer2'), user_id: U.installer2, primary_contact_name: NAMES.installer2, phone: '713-555-0177',
      business_address: { line1: '901 Bayou Rd', city: 'Houston', state: 'TX', zip: '77002' }, service_area: { zip: '77002', radius_miles: 200 },
      coverage_radius_miles: 200, service_types: ['graphics'], equipment_capabilities: ['heat_gun'],
      availability_status: 'limited', availability_notes: `Weekends only through October. ${MARK}`, insurance_expiry: day(20),
      terms_accepted_at: at(-90), install_expectations_accepted_at: at(-90), timeline_agreement_accepted_at: at(-90),
      completion_reliability: 'late_flags', photo_quality: 'conditional', communication_rating: 'slow', jobs_completed: 6, jobs_on_time: 4,
      risk_tags: ['late_photos'], profile_complete: true, onboarded_at: at(-90), netsuite_vendor_id: '7002' },
  ], 'user_id');

  await upsert('user_feature_overrides', [
    { id: id('ufo:sales:cni_portal'), user_id: U.sales, feature: 'cni_portal', granted: true },
    { id: id('ufo:shop_tech:proof_search'), user_id: U.shop_tech, feature: 'proof_search', granted: true },
  ], 'user_id,feature');

  await upsert('ai_instructions', [
    { id: id('ai_instructions:global'), scope: 'global', content: `This is a sandbox environment with seeded demo data. ${MARK}`, enabled: true, sort_order: 0, created_by: U.admin },
  ]);
}

// ═════════════════════════════ 2. customers ═════════════════════════════
const CUSTOMER_SPECS = [
  // slug, company, netsuite_id (null = unlinked), city, state, workflow
  ['acme-fleet', 'Acme Fleet Services', '1001', 'St. Louis', 'MO', 'po_portal'],
  ['gateway-plumbing', 'Gateway Plumbing & Heating', '1002', "O'Fallon", 'MO', 'email_ap'],
  ['riverbend-electric', 'Riverbend Electric Co.', '1003', 'St. Charles', 'MO', 'no_po_direct'],
  ['metro-hvac', 'Metro HVAC Solutions', '1004', 'Kansas City', 'MO', 'email_ap'],
  ['prairie-telecom', 'Prairie Telecom Field Services', '1005', 'Columbia', 'MO', 'po_portal'],
  ['masterack', 'Masterack LLC', '1006', 'Social Circle', 'GA', 'po_portal'],
  ['reading-truck', 'Reading Equipment and Distribution', '1007', 'Reading', 'PA', 'no_po_direct'],
  ['designs-that-stick', 'Designs That Stick', '1008', 'Wentzville', 'MO', 'po_portal'],
  ['bluebird-pest', 'Bluebird Pest Control', '1009', 'Springfield', 'MO', 'no_po_direct'],
  ['summit-roofing', 'Summit Roofing Group', '1010', 'Chesterfield', 'MO', 'email_ap'],
  ['ozark-water', 'Ozark Water Delivery', '1011', 'Branson', 'MO', 'no_po_direct'],
  ['heartland-cable', 'Heartland Cable Contractors', '1012', 'Wichita', 'KS', 'po_portal'],
  ['lakeside-landscaping', 'Lakeside Landscaping', '1013', 'Lake St. Louis', 'MO', 'no_po_direct'],
  ['city-of-wentzville', 'City of Wentzville Public Works', '1014', 'Wentzville', 'MO', 'po_portal'],
  ['tri-state-medical', 'Tri-State Medical Courier', null, 'Belleville', 'IL', 'email_ap'],
  ['northwind-solar', 'Northwind Solar Installers', null, 'Edwardsville', 'IL', null],
  ['cardinal-locksmith', 'Cardinal Locksmith', null, 'Florissant', 'MO', 'no_po_direct'],
  ['bravo-security', 'Bravo Security Systems', null, 'Fenton', 'MO', null],
  ['evergreen-tree', 'Evergreen Tree Service', null, 'Ballwin', 'MO', 'no_po_direct'],
  ['pioneer-glass', 'Pioneer Auto Glass', null, 'Arnold', 'MO', null],
];

async function seedCustomers() {
  TAGS = Object.fromEntries((await select('customer_tag_vocabulary', 'id,label')).map((t) => [t.label, t.id]));
  const rows = CUSTOMER_SPECS.map(([slug, name, nsId, city, state, workflow], i) => {
    const spend = money(5000 + rnd(`spend:${slug}`) * 120000);
    const orders = 2 + Math.floor(rnd(`orders:${slug}`) * 30);
    const row = {
      id: id(`customer:${slug}`),
      netsuite_id: nsId,
      netsuite_url: nsId ? `https://sandbox.app.netsuite.com/app/common/entity/custjob.nl?id=${nsId}` : null,
      company_name: name,
      entity_id: nsId ? `C${nsId}` : '',
      email: `ap@${slug.replace(/-/g, '')}.example`,
      phone: `636-555-02${pad(i, 2)}`,
      address: `${100 + i * 7} Commerce Pkwy, ${city}, ${state} 6${pad(3000 + i * 11, 4)}`,
      active: true,
      total_orders: nsId ? orders : 0,
      total_spend: nsId ? spend : 0,
      avg_order_value: nsId ? money(spend / orders) : 0,
      ytd_spend: nsId ? money(spend * 0.4) : 0,
      ytd_orders: nsId ? Math.ceil(orders * 0.4) : 0,
      last_year_spend: nsId ? money(spend * 0.5) : 0,
      last_year_orders: nsId ? Math.floor(orders * 0.5) : 0,
      last_order_date: nsId ? day(-Math.floor(rnd(`lod:${slug}`) * 200)) : null,
      billing_contact_name: `AP Desk (${name})`,
      billing_contact_email: `ap@${slug.replace(/-/g, '')}.example`,
      ap_email: `ap@${slug.replace(/-/g, '')}.example`,
      delivery_instructions: i % 3 === 0 ? 'Deliver to rear dock, call 30 minutes ahead.' : null,
      default_ship_to: { name, address: `${100 + i * 7} Commerce Pkwy`, city, state, zip: `6${pad(3000 + i * 11, 4)}` },
      account_owner_id: i % 2 === 0 ? U.sales : U.admin,
      internal_notes: `${MARK} ${workflow ? `Bills via ${workflow}.` : 'Billing workflow not yet set.'}`,
      billing_workflow: workflow,
      billing_portal: workflow === 'po_portal' ? `https://portal.${slug.replace(/-/g, '')}.example` : null,
      billing_notes: workflow === 'po_portal' ? 'Upload invoice PDF to portal; PO number required on every line.' : null,
      tax_exempt: slug === 'city-of-wentzville',
      tax_exempt_cert_number: slug === 'city-of-wentzville' ? 'MO-EX-44921' : null,
      tax_exempt_expires_at: slug === 'city-of-wentzville' ? day(400) : null,
      notify_status_emails: i % 4 === 0,
      weekly_digest: i % 5 === 0,
      notify_estimate_reminders: true,
      parent_customer_id: slug === 'designs-that-stick' ? id('customer:masterack') : null,
      parent_source: slug === 'designs-that-stick' ? 'manual' : null,
      at_risk_dismissed_at: slug === 'ozark-water' ? at(-10) : null,
      at_risk_dismissed_by: slug === 'ozark-water' ? U.sales : null,
      portal_token: nsId ? id(`portal-token:${slug}`) : null,
      portal_token_created_at: nsId ? at(-30) : null,
    };
    CUSTOMERS.push({ slug, ...row });
    return row;
  });
  // Parent must exist before the child references it; masterack precedes designs-that-stick in order.
  // customers predates migrations/: the 17 base columns above (id, netsuite_id, netsuite_url,
  // company_name, entity_id, email, phone, address, active, total_orders, total_spend,
  // avg_order_value, ytd_spend, ytd_orders, last_year_spend, last_year_orders, last_order_date)
  // are exactly the SET list of the NetSuite customer sync
  // (src/app/api/cron/netsuite-sync/route.ts:141-163) plus the promote-prospect mirror row
  // (src/lib/promote-prospect.ts:199-208); the rest are migration deltas. Soft so a wrong base
  // name fails this table (and the dependents that need CUSTOMERS[]) with a named error rather
  // than aborting the whole group opaquely.
  await softUpsert('customers', rows);

  const contacts = [];
  CUSTOMERS.forEach((c, i) => {
    contacts.push({ id: id(`external_contact:${c.slug}:primary`), customer_id: c.id, name: `Fleet Manager ${i + 1}`, phone: `636-555-03${pad(i, 2)}`,
      email: `fleet@${c.slug.replace(/-/g, '')}.example`, title: 'Fleet Manager', is_primary: true, channel_pref: i % 2 ? 'sms' : 'email', is_unknown: false,
      notes: MARK, created_by: U.sales });
    if (i % 3 === 0) contacts.push({ id: id(`external_contact:${c.slug}:ap`), customer_id: c.id, name: `AP Clerk ${i + 1}`, phone: `636-555-04${pad(i, 2)}`,
      email: `ap.${i}@${c.slug.replace(/-/g, '')}.example`, title: 'Accounts Payable', is_primary: false, channel_pref: 'email', is_unknown: false, notes: MARK, created_by: U.sales });
  });
  await upsert('external_contacts', contacts);

  const tagLabels = Object.keys(TAGS);
  if (tagLabels.length) {
    const tagRows = [];
    CUSTOMERS.forEach((c, i) => {
      const label = tagLabels[i % tagLabels.length];
      tagRows.push({ customer_id: c.id, tag_id: TAGS[label], created_by: U.admin });
    });
    await upsert('customer_tags', tagRows, 'customer_id,tag_id');
  } else if (!DRY_RUN) warnings.push('customer_tag_vocabulary is empty — customer_tags skipped');

  await upsert('customer_files', [
    { id: id('customer_file:city-of-wentzville:cert'), customer_id: id('customer:city-of-wentzville'), category: 'tax_exempt_cert', file_name: 'MO-EX-44921.pdf',
      content_type: 'application/pdf', size_bytes: 48213, storage_path: `customer-files/${id('customer:city-of-wentzville')}/MO-EX-44921.pdf`, uploaded_by: U.finance },
  ]);
}

// ═════════════════════════════ 3. prospects (CRM) ═════════════════════════════
const PROSPECT_SPECS = [
  // slug, company, contact, status, record_type, createdDaysAgo, lastActivityDaysAgo (null = never), is_hot
  ['harbor-freight-lines', 'Harbor Freight Lines', 'Dana Ruiz', 'active', 'customer', 12, 2, true],
  ['keystone-elevator', 'Keystone Elevator Service', 'Marcus Bell', 'active', 'customer', 30, 5, false],
  ['peak-plumbing', 'Peak Plumbing Co.', 'Lena Park', 'active', 'customer', 95, 70, false],   // stale: no touch for 60+ days
  ['sunrise-dairy', 'Sunrise Dairy Distribution', 'Owen Hart', 'active', 'customer', 120, null, false], // stale: never contacted
  ['ironclad-security', 'Ironclad Security Patrol', 'Priya Nair', 'active', 'customer', 8, 1, true],
  ['bramble-landscape', 'Bramble & Sons Landscape', 'Tom Bramble', 'nurturing', 'customer', 60, 20, false],
  ['clearview-windows', 'Clearview Window Cleaning', 'Ana Silva', 'nurturing', 'customer', 75, 65, false], // stale
  ['redline-couriers', 'Redline Couriers', 'Jae Kim', 'lost', 'customer', 100, 45, false],
  ['acme-fleet', 'Acme Fleet Services', 'Fleet Manager 1', 'converted', 'customer', 300, 10, false],
  ['gateway-plumbing', 'Gateway Plumbing & Heating', 'Fleet Manager 2', 'converted', 'customer', 250, 40, false],
  ['vinyl-supply-co', 'Vinyl Supply Co. (vendor rep)', 'Rob Vendor', 'active', 'vendor', 40, 15, false],
];

async function seedProspects() {
  const rows = PROSPECT_SPECS.map(([slug, company, contact, status, recordType, createdAgo, lastAgo, hot], i) => {
    const converted = status === 'converted';
    const cust = converted ? CUSTOMERS.find((c) => c.slug === slug) : null;
    const row = {
      id: id(`prospect:${slug}`),
      company_name: company, contact_name: contact, title: recordType === 'vendor' ? 'Territory Rep' : 'Operations Manager',
      email: `${contact.toLowerCase().replace(/[^a-z]/g, '.')}@${slug.replace(/-/g, '')}.example`,
      phone: `314-555-05${pad(i, 2)}`, address: `${400 + i * 3} Main St`, city: 'St. Louis', state: 'MO', zip: `631${pad(i, 2)}`,
      website: `https://${slug.replace(/-/g, '')}.example`,
      notes: `${MARK} ${recordType === 'vendor' ? 'Supplier contact — no NetSuite push.' : 'Met at Work Truck Show.'}`,
      source: i % 2 ? 'business_card' : 'manual',
      status, record_type: recordType,
      converted_customer_id: cust?.netsuite_id || null,
      netsuite_id: cust?.netsuite_id || null,
      netsuite_type: cust ? 'customer' : null,
      netsuite_url: cust?.netsuite_url || null,
      pushed_at: cust ? at(-createdAgo + 5) : null,
      pushed_by: cust ? U.sales : null,
      location_count: 1 + (i % 4), multi_location: i % 4 > 0, email_campaign: i % 3 === 0, is_hot: hot,
      lead_source: ['referral', 'trade_show', 'website', 'cold_call'][i % 4],
      lost_reason: status === 'lost' ? 'price' : null,
      lost_note: status === 'lost' ? 'Went with a local sign shop.' : null,
      billing_emails: [`ap@${slug.replace(/-/g, '')}.example`],
      created_by: U.sales, created_at: at(-createdAgo), updated_at: at(lastAgo == null ? -createdAgo : -lastAgo),
    };
    PROSPECTS.push({ slug, lastAgo, ...row });
    return row;
  });
  await upsert('prospects', rows);

  const contacts = [];
  PROSPECTS.forEach((p, i) => {
    contacts.push({ id: id(`prospect_contact:${p.slug}:1`), prospect_id: p.id, name: p.contact_name, title: p.title, email: p.email, phone: p.phone, is_decision_maker: true, notes: MARK });
    if (i % 2 === 0) contacts.push({ id: id(`prospect_contact:${p.slug}:2`), prospect_id: p.id, name: `Assistant ${i + 1}`, title: 'Office Admin', email: `admin@${p.slug.replace(/-/g, '')}.example`, phone: `314-555-06${pad(i, 2)}`, is_decision_maker: false, notes: MARK });
  });
  await upsert('prospect_contacts', contacts);

  const opps = [];
  const stages = ['lead', 'quoted', 'negotiating', 'won', 'lost'];
  const types = ['tech_install', 'graphics', 'rebrand', 'fleet_wrap', 'other'];
  PROSPECTS.forEach((p, i) => {
    if (p.record_type === 'vendor') return;
    const stage = p.status === 'lost' ? 'lost' : p.status === 'converted' ? 'won' : stages[i % 3];
    opps.push({ id: id(`opportunity:${p.slug}:1`), prospect_id: p.id, title: `${types[i % 5].replace('_', ' ')} — ${p.company_name}`, type: types[i % 5], stage,
      value: money(4000 + rnd(`opp:${p.slug}`) * 60000), notes: MARK, expected_close_date: day(10 + i * 4),
      closed_at: stage === 'won' || stage === 'lost' ? at(-5) : null, lost_reason: stage === 'lost' ? 'competitor' : null,
      created_by: U.sales, updated_by: U.sales });
    if (i % 3 === 0) opps.push({ id: id(`opportunity:${p.slug}:2`), prospect_id: p.id, title: `Phase 2 add-on — ${p.company_name}`, type: 'graphics', stage: 'lead',
      value: money(1500 + rnd(`opp2:${p.slug}`) * 9000), notes: MARK, expected_close_date: day(45), created_by: U.sales });
  });
  await upsert('prospect_opportunities', opps);

  const activities = [];
  PROSPECTS.forEach((p, i) => {
    if (p.lastAgo == null) return;
    activities.push({ id: id(`activity:${p.slug}:call`), prospect_id: p.id, type: 'call', summary: `Intro call with ${p.contact_name}`, details: `Discussed fleet size and timeline. ${MARK}`, contact_id: id(`prospect_contact:${p.slug}:1`), created_by: U.sales, created_at: at(-p.lastAgo - 3), auto: false });
    activities.push({ id: id(`activity:${p.slug}:note`), prospect_id: p.id, type: 'note', summary: 'Follow-up note', details: `Send pricing sheet for 6 vans. ${MARK}`, created_by: U.sales, created_at: at(-p.lastAgo), auto: false });
    activities.push({ id: id(`activity:${p.slug}:status`), prospect_id: p.id, type: 'status_change', summary: `Status set to ${p.status}`, details: null, created_by: U.sales, created_at: at(-p.lastAgo - 1), auto: true });
    if (i % 2 === 0) activities.push({ id: id(`activity:${p.slug}:email`), prospect_id: p.id, type: 'email', summary: 'Sent capabilities deck', details: `Auto-logged from outbound email. ${MARK}`, created_by: U.sales, created_at: at(-p.lastAgo - 2), auto: true, email_log_id: null });
  });
  await upsert('prospect_activities', activities);

  await upsert('prospect_tags', PROSPECTS.map((p, i) => ({ id: id(`prospect_tag:${p.slug}`), prospect_id: p.id, tag: ['work-truck-show', 'plumbing', 'hvac', 'delivery'][i % 4], auto_generated: false })), 'prospect_id,tag');

  await upsert('prospect_reminders', [
    { id: id('reminder:harbor'), prospect_id: id('prospect:harbor-freight-lines'), title: 'Call Dana about wrap proof', description: MARK, due_at: at(1, 14), created_by: U.sales, notified_at: null },
    { id: id('reminder:keystone'), prospect_id: id('prospect:keystone-elevator'), title: 'Send revised estimate', description: MARK, due_at: at(-2, 10), created_by: U.sales, notified_at: at(-2, 8) },
    { id: id('reminder:bramble'), prospect_id: id('prospect:bramble-landscape'), title: 'Quarterly check-in', description: MARK, due_at: at(20, 9), completed_at: null, created_by: U.sales },
  ]);

  await upsert('credit_applications', [
    { id: id('credit_app:harbor'), company_name: 'Harbor Freight Lines', dba_name: null, business_type: 'LLC', tax_id: '**-***4411', years_in_business: 7,
      contact_name: 'Dana Ruiz', contact_title: 'Controller', contact_email: 'dana@harborfreightlines.example', contact_phone: '314-555-0500',
      address: '400 Main St', city: 'St. Louis', state: 'MO', zip: '63100', requested_terms: 'net_30', estimated_monthly_volume: 12000,
      trade_ref_1_company: 'Midwest Tire', trade_ref_1_contact: 'J. Doe', trade_ref_1_phone: '314-555-0900', bank_name: 'First Community Bank',
      status: 'pending', submitted_at: at(-3), prospect_id: id('prospect:harbor-freight-lines'), ip_address: '203.0.113.10' },
    { id: id('credit_app:keystone'), company_name: 'Keystone Elevator Service', business_type: 'Corporation', years_in_business: 22,
      contact_name: 'Marcus Bell', contact_email: 'marcus@keystoneelevator.example', requested_terms: 'net_45', estimated_monthly_volume: 30000,
      status: 'approved', reviewed_by: U.finance, reviewed_at: at(-20), review_notes: `Strong references. ${MARK}`, submitted_at: at(-25), prospect_id: id('prospect:keystone-elevator') },
  ]);
}

// ═════════════════════════════ 4. parts catalog + materials ═════════════════════════════
const PART_SPECS = [
  // item_number, display, catalog, sales, purchase, on_hand, labor_hours, vendor, category
  ['MR-SH-4820', 'Masterack 48" x 20" Steel Shelving Unit', 'upfit', 489.00, 310.00, 14, 1.5, 'Masterack', 'Shelving'],
  ['MR-SH-6020', 'Masterack 60" x 20" Steel Shelving Unit', 'upfit', 549.00, 352.00, 6, 1.5, 'Masterack', 'Shelving'],
  ['MR-PT-TRANSIT', 'Masterack Composite Partition — Ford Transit', 'upfit', 725.00, 470.00, 3, 2.0, 'Masterack', 'Partitions'],
  ['MR-PT-PROMASTER', 'Masterack Composite Partition — Ram ProMaster', 'upfit', 725.00, 470.00, 0, 2.0, 'Masterack', 'Partitions'],
  ['RT-LR-TRANSIT-HR', 'Reading Ladder Rack — Transit High Roof', 'upfit', 1195.00, 780.00, 2, 2.5, 'Reading Truck', 'Ladder Racks'],
  ['MR-DR-3', 'Masterack 3-Drawer Cabinet', 'upfit', 389.00, 255.00, 9, 1.0, 'Masterack', 'Bins & Drawers'],
  ['LEG-FL-TRANSIT-148', 'Legend Composite Floor — Transit 148', 'upfit', 899.00, 610.00, 4, 2.0, 'Legend Fleet', 'Flooring'],
  ['WL-LED-STRIP', 'LED Cargo Light Strip 48"', 'upfit', 129.00, 64.00, 25, 0.5, 'Whelen', 'Lighting & Electrical'],
  ['VZ-CONNECT-HW', 'Verizon Connect Telematics Hardware Kit', 'upfit', 0.00, 0.00, 40, 0.75, 'Verizon Connect', 'Telematics'],
  ['GR-DOOR-LOGO-24', 'Door Logo Decal 24" (per pair)', 'graphics', 145.00, 0.00, 0, 0.5, null, 'Graphics & Wraps'],
  ['GR-PARTIAL-WRAP-VAN', 'Partial Wrap — Cargo Van', 'graphics', 2450.00, 0.00, 0, 8.0, null, 'Graphics & Wraps'],
  ['GR-FULL-WRAP-VAN', 'Full Wrap — Cargo Van', 'graphics', 4200.00, 0.00, 0, 14.0, null, 'Graphics & Wraps'],
  ['GR-USDOT-LETTER', 'USDOT / MC Number Lettering (set)', 'graphics', 85.00, 0.00, 0, 0.25, null, 'Graphics & Wraps'],
  ['LABOR', 'Installation Labor (per hour)', 'upfit', 85.00, 0.00, 0, null, null, 'Labor & Services'],
  ['MR-BLK-SS', 'Masterack Stainless Steel Bulkhead — Sprinter', 'upfit', 810.00, 530.00, 1, 2.0, 'Masterack', 'Partitions'],
  ['ADR-BIN-SM', 'Adrian Steel Small Parts Bin (6-pack)', 'upfit', 95.00, 58.00, 30, 0.25, 'Adrian Steel', 'Bins & Drawers'],
];

async function seedParts() {
  CATEGORIES = Object.fromEntries((await select('product_categories', 'id,name')).map((c) => [c.name, c.id]));
  const rows = PART_SPECS.map(([num, name, catalog, sales, purchase, onHand, labor, vendor, cat], i) => {
    const row = {
      id: id(`part:${num}`), netsuite_id: String(3000 + i), item_number: num, display_name: name,
      description: `${name}. ${MARK}`, item_type: catalog === 'graphics' ? 'Service' : 'InvtPart', catalog,
      sales_price: sales, purchase_price: purchase, quantity_on_hand: onHand, quantity_available: onHand,
      labor_hours: labor, ns_class: catalog === 'graphics' ? 'Graphics' : 'Upfit', is_active: true, last_synced_at: at(0),
      vendor, billable_customer: vendor === 'Masterack' ? 'Masterack LLC' : null, requires_po_match: vendor === 'Masterack',
      source: 'netsuite', is_taxable: num !== 'LABOR', reorder_point: onHand > 0 && catalog === 'upfit' ? 5 : null,
      order_up_to: onHand > 0 && catalog === 'upfit' ? 20 : null,
      product_category_id: CATEGORIES[cat] || null, category_source: CATEGORIES[cat] ? 'manual' : null,
      marketing_description: catalog === 'upfit' ? `Heavy-duty ${name.toLowerCase()} built for daily fleet use.` : null,
      width_in: catalog === 'upfit' && purchase > 0 ? 48 : null, depth_in: catalog === 'upfit' && purchase > 0 ? 20 : null, height_in: catalog === 'upfit' && purchase > 0 ? 46 : null,
      weight_lb: catalog === 'upfit' && purchase > 0 ? 62 : null, mount_type: cat === 'Shelving' ? 'floor' : cat === 'Partitions' ? 'partition' : null,
      dims_source: catalog === 'upfit' && purchase > 0 ? 'manual' : null,
    };
    PARTS.push(row);
    return row;
  });
  await upsert('netsuite_parts', rows);

  await upsert('part_files', [
    { id: id('part_file:MR-SH-4820:guide'), part_id: id('part:MR-SH-4820'), file_name: 'MR-SH-4820-install-guide.pdf', file_type: 'application/pdf', file_size: 210044, storage_path: 'part-files/MR-SH-4820/install-guide.pdf', uploaded_by: U.admin, bucket: 'graphics-proofs', sort_order: 1, label: 'Install guide' },
    { id: id('part_file:GR-PARTIAL-WRAP-VAN:proof'), part_id: id('part:GR-PARTIAL-WRAP-VAN'), file_name: 'partial-wrap-proof.pdf', file_type: 'application/pdf', file_size: 1503311, storage_path: 'proofs/partial-wrap-van/proof.pdf', uploaded_by: U.graphics_production, bucket: 'proofs', sort_order: 1, label: 'Proof' },
  ]);

  await upsert('part_kits', [
    { id: id('kit:plumber-transit'), name: 'Plumber Package — Transit 148', description: `Shelving both sides, partition, drawer cabinet. ${MARK}`, vehicle_label: 'Ford Transit 148 MR', active: true, created_by: U.sales, labor_adder_hours: 1.0 },
    { id: id('kit:electrician-promaster'), name: 'Electrician Package — ProMaster 159', description: `Shelving, bins, LED lighting. ${MARK}`, vehicle_label: 'Ram ProMaster 159', active: true, created_by: U.sales, labor_adder_hours: 0.5 },
  ]);
  await upsert('part_kit_items', [
    { id: id('kit_item:plumber:1'), kit_id: id('kit:plumber-transit'), part_id: id('part:MR-SH-4820'), quantity: 2, sort_order: 1 },
    { id: id('kit_item:plumber:2'), kit_id: id('kit:plumber-transit'), part_id: id('part:MR-PT-TRANSIT'), quantity: 1, sort_order: 2 },
    { id: id('kit_item:plumber:3'), kit_id: id('kit:plumber-transit'), part_id: id('part:MR-DR-3'), quantity: 1, sort_order: 3 },
    { id: id('kit_item:electrician:1'), kit_id: id('kit:electrician-promaster'), part_id: id('part:MR-SH-6020'), quantity: 2, sort_order: 1 },
    { id: id('kit_item:electrician:2'), kit_id: id('kit:electrician-promaster'), part_id: id('part:ADR-BIN-SM'), quantity: 2, sort_order: 2 },
    { id: id('kit_item:electrician:3'), kit_id: id('kit:electrician-promaster'), part_id: id('part:WL-LED-STRIP'), quantity: 2, sort_order: 3 },
  ], 'kit_id,part_id');

  PLATFORMS = Object.fromEntries((await select('vehicle_platforms', 'id,key')).map((p) => [p.key, p.id]));
  if (PLATFORMS.transit && PLATFORMS.promaster) {
    await upsert('part_fitment', [
      { id: id('fitment:MR-PT-TRANSIT'), part_id: id('part:MR-PT-TRANSIT'), platform_id: PLATFORMS.transit, source: 'manual', created_by: U.admin },
      { id: id('fitment:RT-LR-TRANSIT-HR'), part_id: id('part:RT-LR-TRANSIT-HR'), platform_id: PLATFORMS.transit, roof_label: 'High', source: 'manual', created_by: U.admin },
      { id: id('fitment:MR-PT-PROMASTER'), part_id: id('part:MR-PT-PROMASTER'), platform_id: PLATFORMS.promaster, source: 'manual', created_by: U.admin },
    ]);
  } else if (!DRY_RUN) warnings.push('vehicle_platforms missing transit/promaster keys — part_fitment skipped');

  await upsert('install_pay_rates', [
    { id: id('pay_rate:VZ-CONNECT-HW'), part_number: 'VZ-CONNECT-HW', rate_per_vehicle: 45.00, active: true, created_by: U.admin },
    { id: id('pay_rate:MR-SH-4820'), part_number: 'MR-SH-4820', rate_per_vehicle: 120.00, active: true, created_by: U.admin },
    { id: id('pay_rate:GR-DOOR-LOGO-24'), part_number: 'GR-DOOR-LOGO-24', rate_per_vehicle: 60.00, active: true, created_by: U.admin },
  ], 'part_number');
}

const SUBSTRATE_SPECS = [
  // slug, name, price, cost, laminate, lam price, lam cost, color, labor/sqft
  ['3m-ij180', '3M IJ180mC-10 Cast Wrap Film', 4.25, 1.60, '3M 8518 Gloss Overlaminate', 1.75, 0.65, '#ffffff', 3.50],
  ['avery-1105', 'Avery MPI 1105 Easy Apply RS', 3.95, 1.45, 'Avery DOL 1360Z Gloss', 1.60, 0.60, '#f5f5f5', 3.25],
  ['3m-2080-black', '3M 2080 Gloss Black (color change)', 5.10, 2.10, null, 0, null, '#111111', 4.00],
  ['oracal-651', 'Oracal 651 Cut Vinyl — White', 1.20, 0.35, null, 0, null, '#ffffff', 1.50],
  ['3m-680-reflective', '3M 680 Reflective Conspicuity', 6.80, 3.10, null, 0, null, '#e0e0e0', 2.00],
];

async function seedMaterials() {
  const rows = SUBSTRATE_SPECS.map(([slug, name, price, cost, lam, lamPrice, lamCost, color, labor]) => {
    const row = { id: id(`substrate:${slug}`), name, price_per_sqft: price, bleed_in: 0.5, is_active: true, laminate_name: lam, laminate_price_per_sqft: lamPrice,
      color, labor_per_sqft: labor, cost_per_sqft: cost, laminate_cost_per_sqft: lamCost, premask_name: slug.startsWith('oracal') ? 'RTape 4075 Premask' : null,
      premask_cost_per_sqft: slug.startsWith('oracal') ? 0.18 : null, ink_cost_per_sqft: lam ? 0.22 : null, roll_width_in: 54, roll_length_ft: 150 };
    SUBSTRATES.push(row);
    return row;
  });
  await upsert('wrap_substrates', rows);

  const rollRows = [
    { slug: '3m-ij180', n: 1, initial: 150, remaining: 92 }, { slug: '3m-ij180', n: 2, initial: 150, remaining: 150 },
    { slug: 'avery-1105', n: 1, initial: 150, remaining: 18 }, { slug: '3m-2080-black', n: 1, initial: 75, remaining: 0 },
    { slug: 'oracal-651', n: 1, initial: 150, remaining: 140 },
  ].map(({ slug, n, initial, remaining }) => {
    const s = SUBSTRATES.find((x) => x.id === id(`substrate:${slug}`));
    const row = { id: id(`roll:${slug}:${n}`), substrate_id: s.id, material_name: s.name, kind: 'film', unit: 'ft', width_in: 54, initial_qty: initial, remaining_qty: remaining,
      cost: money(initial * 54 / 12 * (s.cost_per_sqft || 1)), vendor_name: 'Grimco', received_at: day(-30 - n * 10), status: remaining === 0 ? 'depleted' : 'open', notes: MARK, created_by: U.graphics_production };
    ROLLS.push(row);
    return row;
  });
  rollRows.push({ id: id('roll:premask:1'), substrate_id: null, material_name: 'RTape 4075 Premask 54"', kind: 'premask', unit: 'ft', width_in: 54, initial_qty: 300, remaining_qty: 210, cost: 180, vendor_name: 'Grimco', received_at: day(-45), status: 'open', notes: MARK, created_by: U.graphics_production });
  rollRows.push({ id: id('roll:ink:cyan'), substrate_id: null, material_name: 'HP Latex 831 Cyan', kind: 'ink', unit: 'cartridge', initial_qty: 4, remaining_qty: 1, cost: 640, vendor_name: 'Grimco', received_at: day(-60), status: 'open', notes: MARK, created_by: U.graphics_production });
  await upsert('material_rolls', rollRows);

  await upsert('material_stock_settings', [
    { id: id('stock_setting:3m-ij180'), kind: 'film', material_key: '3m ij180mc-10 cast wrap film', material_name: '3M IJ180mC-10 Cast Wrap Film', substrate_id: id('substrate:3m-ij180'), unit: 'ft', reorder_at: 100, order_up_to: 450, vendor_name: 'Grimco', item_number: 'IJ180MC-10-54', updated_by: U.admin },
    { id: id('stock_setting:avery-1105'), kind: 'film', material_key: 'avery mpi 1105 easy apply rs', material_name: 'Avery MPI 1105 Easy Apply RS', substrate_id: id('substrate:avery-1105'), unit: 'ft', reorder_at: 50, order_up_to: 300, vendor_name: 'Grimco', item_number: 'MPI1105-54', updated_by: U.admin },
    { id: id('stock_setting:ink-cyan'), kind: 'ink', material_key: 'hp latex 831 cyan', material_name: 'HP Latex 831 Cyan', unit: 'cartridge', reorder_at: 2, order_up_to: 6, vendor_name: 'Grimco', updated_by: U.admin },
  ], 'kind,material_key');

  await upsert('wrap_quote_settings', [{ id: 1, company: { name: 'BMG Fleet (sandbox)', phone: '636-555-0100', email: 'quotes@sandbox.fleetsuite.test', address: "2200 Industrial Dr, O'Fallon, MO 63366" },
    tax_rate: 7.95, design: { flat: 150, hourly: 95, hours: 0, extra: 0 }, preparation: { flat: 0, hourly: 65, hours: 1, extra: 0 }, installation: { flat: 0, hourly: 85, hours: 0, extra: 0 },
    min_job_charge: 250, qty_discounts: [{ min_qty: 5, pct: 5 }, { min_qty: 12, pct: 10 }] }], 'id');
  await upsert('quote_settings', [{ id: 1, margin_floor_pct: 30, sales_tax_rate_pct: 7.95, netsuite_labor_item_id: '3013', netsuite_labor_item_number: 'LABOR',
    shop_labor_cost_rate: 38.00, shop_crew_size: 4, shop_shift_hours: 8, default_ink_cost_per_sqft: 0.22, default_premask_cost_per_sqft: 0.18, updated_by: U.admin }], 'id');

  await upsert('vehicle_templates', [
    { id: id('template:transit-148-mr'), name: 'Ford Transit 148 MR Cargo', make: 'Ford', model: 'Transit', year: '2024', variant: '148" WB Medium Roof', scale: '1:20', overall_length_in: 237.6, overall_height_in: 100.7, wheelbase_in: 148, panel_data: [], created_by: U.admin, doors: 'Sliding', roof_height: 'Medium', windows: 'None', template_code: 'FT-148-MR', px_per_in: 4.0, is_active: true },
    { id: id('template:promaster-159'), name: 'Ram ProMaster 159 HR Cargo', make: 'Ram', model: 'ProMaster', year: '2024', variant: '159" WB High Roof', scale: '1:20', overall_length_in: 236.0, overall_height_in: 101.2, wheelbase_in: 159, panel_data: [], created_by: U.admin, doors: 'Sliding', roof_height: 'High', windows: 'None', template_code: 'RP-159-HR', px_per_in: 4.0, is_active: true },
    { id: id('template:f150-crew'), name: 'Ford F-150 Crew Cab 5.5ft', make: 'Ford', model: 'F-150', year: '2023', variant: 'SuperCrew 5.5', scale: '1:20', overall_length_in: 231.7, overall_height_in: 77.2, wheelbase_in: 145.4, panel_data: [], created_by: U.admin, doors: '4', roof_height: null, windows: 'Standard', template_code: 'FF-150-SC', px_per_in: 4.0, is_active: true },
  ]);
}

// ═════════════════════════════ 5. estimates + wrap quotes ═════════════════════════════
const ESTIMATE_SPECS = [
  // n, customer slug, status, title, daysAgo, vehicles, labor hrs, expiresIn
  [1, 'acme-fleet', 'draft', 'Transit shelving package x3', 2, 3, 6, 30],
  [2, 'gateway-plumbing', 'draft', 'ProMaster plumber build', 1, 1, 7, 30],
  [3, 'bluebird-pest', 'draft', 'Partial wrap + door logos', 5, 2, 9, 25],
  [4, 'riverbend-electric', 'sent', 'Electrician package — 2 vans', 9, 2, 8, 21],
  [5, 'metro-hvac', 'sent', 'HVAC tech van upfit', 14, 1, 6, 16],
  [6, 'prairie-telecom', 'accepted', 'Telematics install — 12 units', 20, 12, 9, 10],
  [7, 'summit-roofing', 'accepted', 'Ladder rack + floor', 25, 1, 4.5, 5],
  [8, 'heartland-cable', 'rejected', 'Full wrap — 4 vans', 40, 4, 56, -10],
  [9, 'city-of-wentzville', 'pushed', 'Public works partitions', 6, 5, 10, 24],
  [10, 'lakeside-landscaping', 'pushed', 'Truck bed bins + lettering', 3, 1, 1.5, 27],
];

function estimateLines(n, slug) {
  const pick = (num, qty) => { const p = PARTS.find((x) => x.item_number === num); return { p, qty }; };
  const sets = {
    1: [pick('MR-SH-4820', 6), pick('MR-PT-TRANSIT', 3)],
    2: [pick('MR-SH-6020', 2), pick('MR-PT-PROMASTER', 1), pick('MR-DR-3', 1)],
    3: [pick('GR-PARTIAL-WRAP-VAN', 2), pick('GR-DOOR-LOGO-24', 2)],
    4: [pick('MR-SH-6020', 4), pick('ADR-BIN-SM', 4), pick('WL-LED-STRIP', 4)],
    5: [pick('MR-SH-4820', 2), pick('MR-PT-TRANSIT', 1)],
    6: [pick('VZ-CONNECT-HW', 12)],
    7: [pick('RT-LR-TRANSIT-HR', 1), pick('LEG-FL-TRANSIT-148', 1)],
    8: [pick('GR-FULL-WRAP-VAN', 4)],
    9: [pick('MR-PT-TRANSIT', 5)],
    10: [pick('ADR-BIN-SM', 2), pick('GR-USDOT-LETTER', 1)],
  };
  return sets[n].map(({ p, qty }, i) => ({
    id: id(`estimate_line:${n}:${i}`), estimate_id: id(`estimate:${n}`), sort_order: i, part_id: p.id, netsuite_item_id: p.netsuite_id,
    item_number: p.item_number, description: p.display_name, quantity: qty, unit_price: p.sales_price, line_total: money(qty * p.sales_price),
    labor_hours: p.labor_hours, is_custom: false, notes: i === 0 ? MARK : null,
  }));
}

async function seedEstimates() {
  const rows = [];
  const lines = [];
  for (const [n, slug, status, title, ago, vehicles, laborHrs, expiresIn] of ESTIMATE_SPECS) {
    const cust = CUSTOMERS.find((c) => c.slug === slug);
    const ls = estimateLines(n, slug);
    const subtotal = money(ls.reduce((s, l) => s + l.line_total, 0));
    const laborTotal = money(laborHrs * 85);
    const taxable = cust.tax_exempt ? 0 : subtotal;
    const tax = money(taxable * 0.0795);
    const sent = ['sent', 'accepted', 'rejected'].includes(status);
    const row = {
      id: id(`estimate:${n}`), estimate_number: `EST-2609-${pad(n, 3)}`, customer_id: cust.id, customer_name: cust.company_name,
      customer_netsuite_id: cust.netsuite_id, title, notes: `${MARK} ${title}`, status, tax_rate: 0.0795, tax_exempt: !!cust.tax_exempt,
      labor_rate: 85, labor_hours: laborHrs, subtotal, labor_total: laborTotal, tax_amount: tax, grand_total: money(subtotal + laborTotal + tax),
      netsuite_estimate_id: status === 'pushed' || status === 'accepted' ? String(8000 + n) : null,
      netsuite_estimate_number: status === 'pushed' || status === 'accepted' ? `EST${8000 + n}` : null,
      pushed_at: status === 'pushed' || status === 'accepted' ? at(-ago + 1) : null, pushed_by: status === 'pushed' || status === 'accepted' ? U.sales : null,
      netsuite_so_id: status === 'accepted' ? String(52000 + n) : null, netsuite_so_number: status === 'accepted' ? `SO${52000 + n}` : null,
      created_by: U.sales, updated_by: U.sales, created_at: at(-ago), updated_at: at(-ago + 1),
      install_instructions: n % 2 ? 'Customer drops off Monday morning; keys in lockbox.' : null,
      on_site_contact_name: `Fleet Manager ${CUSTOMERS.indexOf(cust) + 1}`, on_site_contact_phone: cust.phone, delivery_preferences: n % 3 === 0 ? 'Deliver to customer yard' : null,
      internal_notes: MARK, approval_token: sent ? id(`approval-token:estimate:${n}`) : null, approval_token_expires_at: sent ? at(expiresIn) : null,
      customer_approved: status === 'accepted', customer_approved_at: status === 'accepted' ? at(-ago + 4) : null,
      customer_approved_ip: status === 'accepted' ? '198.51.100.7' : null, customer_approved_via: status === 'accepted' ? 'email_link' : null,
      customer_approved_delivery_target: status === 'accepted' ? cust.email : null, customer_approved_time_on_page_seconds: status === 'accepted' ? 212 : null,
      customer_rejected_at: status === 'rejected' ? at(-ago + 6) : null, customer_rejection_reason: status === 'rejected' ? 'Over budget for this quarter.' : null,
      sent_for_approval_at: sent ? at(-ago + 2) : null, sent_for_approval_by: sent ? U.sales : null,
      approval_email_status: sent ? 'delivered' : null, approval_email_to: sent ? [cust.email] : null,
      po_number: status === 'accepted' ? `PO-${slug.toUpperCase().slice(0, 4)}-${n}` : null, expiration_date: day(expiresIn), vehicle_count: vehicles,
      vehicle_platform_id: PLATFORMS.transit || null, vehicle_year: '2024', vehicle_wheelbase: PLATFORMS.transit ? '148' : null, vehicle_roof: PLATFORMS.transit ? 'Medium' : null,
      vehicle_other: PLATFORMS.transit ? null : 'Ford Transit 148 MR', vin: n % 2 ? vinFor('1FTBW3XM7', 900 + n) : null, unit_number: n % 2 ? `U-${100 + n}` : null,
      quoted_cost_total: money(ls.reduce((s, l) => s + l.quantity * (PARTS.find((p) => p.id === l.part_id)?.purchase_price || 0), 0)),
      quoted_margin_pct: 34.5, quoted_below_floor: false, quoted_floor_pct: 30, quoted_labor_cost: money(laborHrs * 38), quoted_margin_at: at(-ago),
      prospect_id: PROSPECTS.find((p) => p.slug === slug)?.id || null, last_followup_at: status === 'sent' ? at(-3) : null,
    };
    rows.push(row); ESTIMATES.push({ n, slug, ...row }); lines.push(...ls);
  }
  await upsert('estimates', rows);
  await replaceChildren('estimate_line_items', 'estimate_id', rows.map((r) => r.id), lines);

  await upsert('estimate_files', [
    { id: id('estimate_file:4'), estimate_id: id('estimate:4'), file_name: 'riverbend-layout.pdf', content_type: 'application/pdf', size_bytes: 88120, storage_path: 'estimate-files/riverbend-layout.pdf', public_url: 'https://files.sandbox.fleetsuite.test/estimate-files/riverbend-layout.pdf', uploaded_by: U.sales },
  ]);

  await upsert('quote_followups', [
    { id: id('followup:estimate:4'), quote_type: 'estimate', quote_id: id('estimate:4'), note: `Left voicemail, will call back Thursday. ${MARK}`, remind_at: day(2), created_by: U.sales },
    { id: id('followup:estimate:5'), quote_type: 'estimate', quote_id: id('estimate:5'), note: `Customer reviewing with owner. ${MARK}`, remind_at: day(-1), created_by: U.sales },
  ]);
  await upsert('quote_views', [
    { id: id('quote_view:estimate:4:1'), quote_type: 'estimate', quote_id: id('estimate:4'), viewed_at: at(-6, 15), ip_address: '198.51.100.20', user_agent: 'Mozilla/5.0 (iPhone)', viewer_kind: 'human', view_signal: 'scroll' },
    { id: id('quote_view:estimate:4:2'), quote_type: 'estimate', quote_id: id('estimate:4'), viewed_at: at(-7, 11), ip_address: '66.249.0.1', user_agent: 'GoogleImageProxy', viewer_kind: 'bot' },
    { id: id('quote_view:estimate:6:1'), quote_type: 'estimate', quote_id: id('estimate:6'), viewed_at: at(-17, 10), ip_address: '198.51.100.7', user_agent: 'Mozilla/5.0 (Windows)', viewer_kind: 'human', view_signal: 'scroll', notified_at: at(-17, 10) },
  ]);

  // Wrap quotes
  const wq = [
    { n: 1, slug: 'bluebird-pest', status: 'draft', tpl: 'template:transit-148-mr', desc: '2024 Ford Transit 148 MR', area: 180, ago: 1, qty: 1 },
    { n: 2, slug: 'heartland-cable', status: 'sent', tpl: 'template:promaster-159', desc: '2024 Ram ProMaster 159', area: 240, ago: 8, qty: 4 },
    { n: 3, slug: 'ozark-water', status: 'accepted', tpl: 'template:transit-148-mr', desc: '2023 Ford Transit 148 MR', area: 200, ago: 22, qty: 2 },
    { n: 4, slug: 'evergreen-tree', status: 'rejected', tpl: 'template:f150-crew', desc: '2023 Ford F-150 SuperCrew', area: 110, ago: 35, qty: 1 },
  ].map(({ n, slug, status, tpl, desc, area, ago, qty }) => {
    const cust = CUSTOMERS.find((c) => c.slug === slug);
    const sub = SUBSTRATES[0];
    const materials = money(area * (sub.price_per_sqft + sub.laminate_price_per_sqft));
    const labor = money(area * sub.labor_per_sqft + 150);
    const subtotal = money((materials + labor) * qty);
    const tax = money(subtotal * 0.0795);
    const row = {
      id: id(`wrap_quote:${n}`), quote_number: `WQ-2609-${pad(n, 3)}`, template_id: id(tpl), vehicle_description: desc, customer_id: cust.id,
      customer: { name: cust.company_name, email: cust.email, phone: cust.phone, contact: `Fleet Manager ${CUSTOMERS.indexOf(cust) + 1}` },
      project_type: n % 2 ? 'Partial wrap' : 'Full wrap', project_notes: `${MARK} ${desc}`,
      measurements: [
        { panel: 'Driver side', width_in: 120, height_in: 60, area_sqft: area / 2, substrate: sub.name, price_per_sqft: sub.price_per_sqft, bleed_in: sub.bleed_in },
        { panel: 'Passenger side', width_in: 120, height_in: 60, area_sqft: area / 2, substrate: sub.name, price_per_sqft: sub.price_per_sqft, bleed_in: sub.bleed_in },
      ],
      labor: { design: { flat: 150, hourly: 95, hours: 0, extra: 0 }, preparation: { flat: 0, hourly: 65, hours: 1, extra: 0 }, installation: { flat: 0, hourly: 85, hours: area * sub.labor_per_sqft / 85, extra: 0 } },
      total_area_sqft: area, materials_total: money(materials * qty), labor_total: money(labor * qty), subtotal, tax_rate: 7.95, tax_amount: tax, total: money(subtotal + tax),
      status, sent_at: status === 'draft' ? null : at(-ago + 1), sent_to: status === 'draft' ? null : cust.email, created_by: U.sales, updated_by: U.sales,
      created_at: at(-ago), updated_at: at(-ago + 1), attachments: [], package_qty: qty,
      adjustments: qty > 1 ? { package_qty: qty, kit_area_sqft: area, kit_materials: materials, pre_materials: materials * qty, pre_labor: labor * qty, pre_subtotal: (materials + labor) * qty, discount_pct: 0, discount_amount: 0, min_charge: 250, min_bump: 0 } : null,
      accepted_at: status === 'accepted' ? at(-ago + 5) : null, rejected_at: status === 'rejected' ? at(-ago + 7) : null,
      approval_token: status === 'draft' ? null : id(`approval-token:wrap:${n}`), approval_token_expires_at: status === 'draft' ? null : at(30 - ago),
      customer_approved_via: status === 'accepted' ? 'email_link' : null, customer_rejection_reason: status === 'rejected' ? 'Decided on magnets instead.' : null,
      hide_line_items: false, estimate_id: null,
    };
    WRAP_QUOTES.push({ n, slug, ...row });
    return row;
  });
  await upsert('wrap_quotes', wq);
  await upsert('quote_followups', [
    { id: id('followup:wrap:2'), quote_type: 'wrap', quote_id: id('wrap_quote:2'), note: `Emailed revised colour proof. ${MARK}`, remind_at: day(3), created_by: U.sales },
  ]);
}

// ═════════════════════════════ 6. graphics jobs ═════════════════════════════
const GRAPHICS_SPECS = [
  // n, status, priority, customer slug, title, dueIn, category, estimate n (or null)
  [1, 'flagged', 'high', 'acme-fleet', 'Acme door logos — artwork low-res', 2, 'proofing', null],
  [2, 'received', 'normal', 'bluebird-pest', 'Bluebird partial wrap — 2 vans', 12, 'production', 3],
  [3, 'designing', 'rush', 'harbor-freight-lines', 'Harbor Freight rebrand mockup', 1, 'proofing', null],
  [4, 'revision', 'normal', 'gateway-plumbing', 'Gateway van lettering rev 2', 5, 'proofing', null],
  [5, 'printing', 'normal', 'heartland-cable', 'Heartland full wrap set', 3, 'production', 8],
  [6, 'outgassing', 'normal', 'ozark-water', 'Ozark Water partial wrap x2', 4, 'production', null],
  [7, 'cutting', 'high', 'city-of-wentzville', 'City fleet numbers + seals', 2, 'production', 9],
  [8, 'packing', 'normal', 'masterack', 'Masterack ship-out kit — 6 sets', 1, 'production', null],
  [9, 'ready', 'rush', 'summit-roofing', 'Summit Roofing USDOT lettering', 0, 'production', 7],
  [10, 'ready_to_pickup', 'normal', 'lakeside-landscaping', 'Lakeside truck lettering', -1, 'production', 10],
  [11, 'shipped', 'normal', 'designs-that-stick', 'DTS reseller decal run', -4, 'customer_supplied', null],
  [12, 'picked_up', 'low', 'cardinal-locksmith', 'Cardinal door magnets', -6, 'production', null],
  [13, 'installed', 'normal', 'prairie-telecom', 'Prairie Telecom fleet graphics', -15, 'production', 6],
  [14, 'cancelled', 'low', 'redline-couriers', 'Redline courier wrap (lost)', -20, 'internal', null],
];
const STATUS_ORDER = ['received', 'designing', 'revision', 'printing', 'outgassing', 'cutting', 'packing', 'ready', 'ready_to_pickup', 'shipped', 'picked_up', 'installed'];

async function seedGraphicsJobs() {
  const rows = [];
  const history = [];
  for (const [n, status, priority, slug, title, dueIn, category, estN] of GRAPHICS_SPECS) {
    const cust = CUSTOMERS.find((c) => c.slug === slug);
    const custName = cust?.company_name || PROSPECTS.find((p) => p.slug === slug)?.company_name || slug;
    const ago = 20 - Math.min(dueIn, 15);
    const sentForApproval = ['printing', 'outgassing', 'cutting', 'packing', 'ready', 'ready_to_pickup', 'shipped', 'picked_up', 'installed', 'revision'].includes(status);
    const approved = sentForApproval && status !== 'revision';
    const row = {
      id: id(`graphics_job:${n}`), job_number: `GJ-2609-${pad(n, 3)}`, title, customer: custName, quantity: 1 + (n % 4), content: `Vehicle graphics for ${custName}. ${MARK}`,
      notes: `${MARK} ${priority === 'rush' ? 'RUSH — customer picking up.' : ''}`.trim(), vinyl_type: n % 2 ? '3M IJ180mC-10' : 'Avery MPI 1105', vinyl_color: 'Print',
      laminate: n % 2 ? '3M 8518 Gloss' : 'Avery DOL 1360Z', print_method: 'Latex', cut_method: 'Contour', premask: 'RTape 4075',
      status, priority, due_date: day(dueIn), created_by: U.sales, assigned_to: n % 3 === 0 ? U.graphics_production : null, created_at: at(-ago), updated_at: at(-1),
      scheduled_install_date: status === 'installed' ? day(-14) : (n === 9 || n === 7 ? day(3) : null), job_category: category,
      customer_approved: approved, customer_approved_at: approved ? at(-ago + 3) : null, customer_approved_by: null,
      po_number: n % 3 === 0 ? `PO-${slug.toUpperCase().slice(0, 3)}-${1000 + n}` : null, customer_netsuite_id: cust?.netsuite_id || null,
      estimate_id: estN ? id(`estimate:${estN}`) : null, install_location: n % 2 ? "O'Fallon Shop" : 'Customer site',
      tracking_number: status === 'shipped' ? `1Z999AA1${pad(n, 10)}` : null, carrier: status === 'shipped' ? 'UPS' : null,
      ship_to: status === 'shipped' ? `${custName}, Wentzville MO` : null, supplier: category === 'customer_supplied' ? 'Customer-supplied artwork' : null,
      approval_token: sentForApproval ? id(`approval-token:proof:${n}`) : null, approval_token_expires_at: sentForApproval ? at(30 - ago) : null,
      sent_for_approval_at: sentForApproval ? at(-ago + 2) : null, sent_for_approval_by: sentForApproval ? U.graphics_production : null,
      customer_approved_via: approved ? 'email_link' : null, customer_rejected_at: status === 'revision' ? at(-2) : null,
      customer_rejection_reason: status === 'revision' ? 'Logo too small on rear doors.' : null,
      netsuite_invoice_id: status === 'installed' || status === 'picked_up' ? String(61000 + n) : null,
      netsuite_invoice_number: status === 'installed' || status === 'picked_up' ? `INV${61000 + n}` : null,
      invoiced_at: status === 'installed' || status === 'picked_up' ? at(-3) : null, invoiced_by: status === 'installed' || status === 'picked_up' ? U.finance : null,
      invoice_amount: status === 'installed' || status === 'picked_up' ? money(800 + n * 120) : null,
      wrap_quote_id: n === 6 ? id('wrap_quote:3') : null, updated_by: U.graphics_production,
    };
    rows.push(row); GRAPHICS_JOBS.push({ n, slug, ...row });
    // status history walk
    const idx = STATUS_ORDER.indexOf(status);
    const walk = idx >= 0 ? STATUS_ORDER.slice(0, idx + 1) : ['received', status];
    walk.forEach((s, i) => history.push({ id: id(`graphics_history:${n}:${i}`), job_id: row.id, from_status: i === 0 ? null : walk[i - 1], to_status: s, changed_by: U.graphics_production,
      note: i === 0 ? `Job created. ${MARK}` : null, created_at: at(-ago + i * (ago / Math.max(walk.length, 2)), 10) }));
  }
  await upsert('graphics_jobs', rows);
  await upsert('graphics_status_history', history);

  await upsert('graphics_job_files', [
    { id: id('graphics_file:5:proof'), job_id: id('graphics_job:5'), file_name: 'heartland-proof-r1.pdf', file_type: 'application/pdf', file_size: 2411000, storage_path: 'graphics-jobs/5/heartland-proof-r1.pdf', uploaded_by: U.graphics_production },
    { id: id('graphics_file:4:proof1'), job_id: id('graphics_job:4'), file_name: 'gateway-proof-r1.pdf', file_type: 'application/pdf', file_size: 1200000, storage_path: 'graphics-jobs/4/gateway-proof-r1.pdf', uploaded_by: U.graphics_production },
    { id: id('graphics_file:4:proof2'), job_id: id('graphics_job:4'), file_name: 'gateway-proof-r2.pdf', file_type: 'application/pdf', file_size: 1250000, storage_path: 'graphics-jobs/4/gateway-proof-r2.pdf', uploaded_by: U.graphics_production },
  ]);

  const rounds = [];
  for (const j of GRAPHICS_JOBS) {
    if (!j.sent_for_approval_at) continue;
    if (j.status === 'revision') {
      rounds.push({ id: id(`proof_round:${j.n}:1`), job_id: j.id, round_number: 1, addressing: 'Fleet manager', proof_file_id: id('graphics_file:4:proof1'), sent_at: j.sent_for_approval_at, sent_by: U.graphics_production, outcome: 'rejected', decided_at: at(-2), rejection_reason: j.customer_rejection_reason });
      rounds.push({ id: id(`proof_round:${j.n}:2`), job_id: j.id, round_number: 2, addressing: 'Fleet manager', proof_file_id: id('graphics_file:4:proof2'), sent_at: at(-1), sent_by: U.graphics_production, outcome: 'pending' });
    } else {
      rounds.push({ id: id(`proof_round:${j.n}:1`), job_id: j.id, round_number: 1, addressing: 'Fleet manager', proof_file_id: j.n === 5 ? id('graphics_file:5:proof') : null, sent_at: j.sent_for_approval_at, sent_by: U.graphics_production, outcome: 'approved', decided_at: j.customer_approved_at });
    }
  }
  await upsert('graphics_proof_rounds', rounds);

  const mats = [];
  for (const j of GRAPHICS_JOBS) {
    if (['printing', 'outgassing', 'cutting', 'packing', 'ready', 'shipped', 'installed'].includes(j.status)) {
      const sub = SUBSTRATES[j.n % 2];
      const roll = ROLLS.find((r) => r.substrate_id === sub.id) || null;
      const sqft = 60 + (j.n * 17) % 120;
      mats.push({ id: id(`material:${j.n}:film`), graphics_job_id: j.id, material_name: sub.name, category: 'vinyl', quantity_sqft: sqft, linear_feet: money(sqft / 4.5), cost: money(sqft * (sub.cost_per_sqft || 1)), notes: MARK, logged_by: U.graphics_production, substrate_id: sub.id, rate_per_sqft: sub.cost_per_sqft, cost_source: 'catalog', roll_id: roll?.id || null, graphic_sqft: sqft * 0.85 });
      if (sub.laminate_name) mats.push({ id: id(`material:${j.n}:lam`), graphics_job_id: j.id, material_name: sub.laminate_name, category: 'laminate', quantity_sqft: sqft, cost: money(sqft * (sub.laminate_cost_per_sqft || 0.6)), logged_by: U.graphics_production, substrate_id: sub.id, rate_per_sqft: sub.laminate_cost_per_sqft, cost_source: 'catalog' });
      mats.push({ id: id(`material:${j.n}:ink`), graphics_job_id: j.id, material_name: 'HP Latex ink', category: 'ink', quantity_sqft: sqft, cost: money(sqft * 0.22), logged_by: U.graphics_production, rate_per_sqft: 0.22, cost_source: 'settings_default' });
    }
  }
  await upsert('graphics_job_materials', mats);

  await upsert('graphics_pack_items', [0, 1, 2].map((i) => ({
    id: id(`pack_item:8:${i}`), graphics_job_id: id('graphics_job:8'), line_index: i, part_number: ['GR-DOOR-LOGO-24', 'GR-USDOT-LETTER', 'GR-PARTIAL-WRAP-VAN'][i],
    description: ['Door logo pairs', 'USDOT sets', 'Partial wrap panels'][i], quantity_expected: 6, quantity_packed: i < 2 ? 6 : null,
    packed_by: i < 2 ? U.graphics_production : null, packed_at: i < 2 ? at(0, 8) : null, checked_by: i === 0 ? U.shop_tech : null, checked_at: i === 0 ? at(0, 9) : null, notes: MARK,
  })), 'graphics_job_id,line_index');

  await upsert('job_tasks', [
    { id: id('job_task:g9:1'), job_id: id('graphics_job:9'), job_type: 'graphics_job', label: 'Print', completed: true, completed_at: at(-2), completed_by: U.graphics_production, completed_by_name: NAMES.graphics_production, sort_order: 1, required: true, source: 'manual' },
    { id: id('job_task:g9:2'), job_id: id('graphics_job:9'), job_type: 'graphics_job', label: 'Laminate + cut', completed: true, completed_at: at(-1), completed_by: U.graphics_production, completed_by_name: NAMES.graphics_production, sort_order: 2, required: true, source: 'manual' },
    { id: id('job_task:g9:3'), job_id: id('graphics_job:9'), job_type: 'graphics_job', label: 'QC + pack', completed: false, sort_order: 3, required: true, source: 'manual' },
  ]);

  await upsert('install_guides', [
    { id: id('install_guide:13'), title: 'Prairie Telecom — Transit placement guide', customer_name: 'Prairie Telecom Field Services', vehicle_desc: '2024 Ford Transit 148 MR', scale: '1:20', units: 'in', fraction_denominator: 8,
      pages: [{ template_id: id('template:transit-148-mr'), side: 'driver' }], sections: [{ name: 'Door logo', dims: [{ from: 'front wheel', to: 'logo left edge', value_in: 18 }] }], created_by: U.graphics_production, graphics_job_id: id('graphics_job:13'), is_template: false },
    { id: id('install_guide:tpl-transit'), title: 'Template — Transit 148 MR', scale: '1:20', units: 'in', fraction_denominator: 8, pages: [], sections: [], created_by: U.graphics_production, is_template: true, template_name: 'Transit 148 MR', template_year: '2024', template_make: 'Ford', template_model: 'Transit' },
  ]);
}

// ═════════════════════════════ 7. fleet check-ins (In-Shop board) ═════════════════════════════
const VEHICLES = [
  ['2024', 'Ford', 'Transit', '250 MR 148', 'Cargo Van'], ['2023', 'Ram', 'ProMaster', '2500 HR 159', 'Cargo Van'],
  ['2024', 'Mercedes-Benz', 'Sprinter', '2500 HR 144', 'Cargo Van'], ['2022', 'Chevrolet', 'Express', '2500 135', 'Cargo Van'],
  ['2024', 'Ford', 'F-150', 'XL SuperCrew', 'Pickup'], ['2023', 'Ram', '1500', 'Tradesman', 'Pickup'],
  ['2024', 'Ford', 'Transit Connect', 'XL LWB', 'Minivan'], ['2023', 'Chevrolet', 'Silverado 2500', 'WT', 'Pickup'],
];
// status, count
const CHECKIN_MIX = [['received', 7], ['checked_in', 2], ['in_progress', 9], ['stuck_parts', 4], ['stuck_graphics', 3], ['complete', 5], ['shipped', 10]];

async function seedCheckins() {
  const existing = await select('work_locations', 'id,name');
  await upsert('work_locations', [{ id: id('location:sandbox-yard'), name: 'Sandbox Field Yard', address: '1 Seed Way', city: 'Wentzville', state: 'MO', zip: '63385', is_active: true }]);
  LOCATIONS = [...existing, { id: id('location:sandbox-yard'), name: 'Sandbox Field Yard' }];

  const rows = [];
  const history = [];
  const notes = [];
  const tasks = [];
  const sos = [];
  const invoices = [];
  const damage = [];
  const photos = [];
  let i = 0;
  for (const [status, count] of CHECKIN_MIX) {
    for (let k = 0; k < count; k++, i++) {
      const cust = CUSTOMERS[i % CUSTOMERS.length];
      const v = VEHICLES[i % VEHICLES.length];
      const ago = status === 'shipped' ? 8 + i : status === 'complete' ? 4 + k : status === 'received' || status === 'checked_in' ? k : 3 + k;
      const promisedIn = status === 'shipped' ? -(k + 2) : (k % 3 === 0 ? -1 - k : 2 + k); // some overdue
      const soId = String(52100 + i);
      const soNum = `SO${52100 + i}`;
      const invoiced = status === 'shipped' && k < 7;
      const paid = invoiced && k < 4;
      const matchedJob = status === 'shipped' && k === 0 ? id('graphics_job:13') : status === 'stuck_graphics' && k === 0 ? id('graphics_job:4') : status === 'in_progress' && k === 0 ? id('graphics_job:9') : null;
      const needsGraphics = !!matchedJob || i % 4 === 0;
      const glane = matchedJob === id('graphics_job:13') ? 'complete' : !needsGraphics ? 'n/a' : status === 'stuck_graphics' ? 'stuck' : status === 'in_progress' ? 'in_progress' : 'pending';
      const row = {
        id: id(`checkin:${i}`), vin: vinFor('1FTBW3XM7', 100 + i), vehicle_year: v[0], vehicle_make: v[1], vehicle_model: v[2], vehicle_trim: v[3], body_class: v[4],
        netsuite_sales_order_id: i % 6 === 5 ? null : soId, sales_order_number: i % 6 === 5 ? null : soNum, customer_name: cust.company_name, customer_id: cust.id,
        sales_order_memo: `Upfit per estimate. ${MARK}`, sales_order_total: money(1200 + rnd(`so:${i}`) * 9000), notes: `${MARK} ${status === 'stuck_parts' ? 'Waiting on partition from Masterack.' : status === 'stuck_graphics' ? 'Proof not approved yet.' : ''}`.trim(),
        status, checked_in_by: U.shop_tech, updated_by: U.shop_tech, created_at: at(-ago, 8), updated_at: at(-Math.max(ago - 1, 0), 16),
        assigned_to: i % 3 === 0 ? U.shop_tech : i % 3 === 1 ? U.field_tech : null, scheduled_upfit_date: day(-ago + 1), promised_back_date: day(promisedIn),
        invoice_number: invoiced ? `INV${62000 + i}` : null, date_invoiced: invoiced ? day(-k - 1) : null, is_paid: paid, paid_at: paid ? at(-k, 12) : null,
        qc_completed_at: status === 'complete' || status === 'shipped' ? at(-k - 1, 15) : null, qc_completed_by: status === 'complete' || status === 'shipped' ? U.shop_tech : null,
        completion_notes: status === 'complete' || status === 'shipped' ? `All items installed and QC'd. ${MARK}` : null,
        graphics_install_status: glane, needs_graphics: needsGraphics, graphics_signal: needsGraphics ? 'so_line' : null, matched_graphics_job_id: matchedJob,
        install_instructions: i % 2 ? 'Shelving driver side only; keep passenger side clear.' : null, on_site_contact_name: `Fleet Manager ${CUSTOMERS.indexOf(cust) + 1}`, on_site_contact_phone: cust.phone,
        delivery_preferences: i % 5 === 0 ? 'Customer pickup' : null, source_estimate_id: i === 5 ? id('estimate:6') : i === 6 ? id('estimate:7') : null,
        pickup_scheduled_date: status === 'complete' ? day(1 + k) : null, pickup_scheduled_time: status === 'complete' ? '10:00' : null,
        odometer_miles: 1200 + i * 731, fuel_level: ['quarter', 'half', 'three_quarter', 'full'][i % 4], archived_at: null,
      };
      rows.push(row); CHECKINS.push({ i, k, slug: cust.slug, ...row });

      const lane = ['received', 'in_progress', 'complete', 'shipped'];
      const target = status === 'checked_in' ? 'received' : status;
      const idx = lane.indexOf(target);
      const walk = idx >= 0 ? lane.slice(0, idx + 1) : ['received', 'in_progress', status];
      walk.forEach((s, j) => history.push({ id: id(`vehicle_history:${i}:${j}`), vehicle_id: row.id, from_status: j === 0 ? null : walk[j - 1], to_status: s, note: j === 0 ? `Checked in. ${MARK}` : null, changed_by: U.shop_tech, changed_by_name: NAMES.shop_tech, created_at: at(-ago + j, 9 + j) }));
      notes.push({ id: id(`vehicle_note:${i}:1`), vehicle_id: row.id, note: `Keys in lockbox 3. ${MARK}`, created_by: U.shop_tech, created_by_name: NAMES.shop_tech, created_at: at(-ago, 8) });
      if (status.startsWith('stuck')) notes.push({ id: id(`vehicle_note:${i}:2`), vehicle_id: row.id, note: `@${NAMES.admin} blocked — see status. ${MARK}`, created_by: U.shop_tech, created_by_name: NAMES.shop_tech, created_at: at(-1, 14) });
      const done = status === 'complete' || status === 'shipped';
      ['Verify VIN + condition photos', 'Install shelving per spec', 'Install partition', 'Final QC + photos'].forEach((label, t) => tasks.push({
        id: id(`job_task:c${i}:${t}`), job_id: row.id, job_type: 'fleet_checkin', label, required: t !== 2, sort_order: t, source: 'template',
        completed: done || (status === 'in_progress' && t < 2), completed_at: done || (status === 'in_progress' && t < 2) ? at(-1, 10 + t) : null,
        completed_by: done || (status === 'in_progress' && t < 2) ? U.shop_tech : null, completed_by_name: done || (status === 'in_progress' && t < 2) ? NAMES.shop_tech : null, expected_hours: [0.25, 1.5, 2, 0.5][t],
      }));
      tasks.push({ id: id(`job_task:c${i}:so`), job_id: row.id, job_type: 'fleet_checkin', label: 'MR-SH-4820 × 2 — Masterack 48" x 20" Steel Shelving Unit', required: false, sort_order: 10, source: 'so_line', item_number: 'MR-SH-4820', quantity: 2, expected_hours: 3, completed: done });
      if (row.netsuite_sales_order_id) {
        sos.push({ id: id(`checkin_so:${i}`), checkin_id: row.id, netsuite_sales_order_id: soId, sales_order_number: soNum, customer_name: cust.company_name, sales_order_memo: row.sales_order_memo, sales_order_total: row.sales_order_total, added_by: U.shop_tech });
        if (invoiced) invoices.push({ id: id(`checkin_invoice:${i}`), fleet_checkin_id: row.id, netsuite_sales_order_id: soId, invoice_number: row.invoice_number, netsuite_invoice_id: String(62000 + i), fulfillment_number: `IF${62000 + i}`, claimed_at: at(-k - 1, 14), invoiced_at: at(-k - 1, 14), invoiced_by: U.finance });
      }
      if (i % 7 === 0) damage.push({ id: id(`damage:${i}`), checkin_id: row.id, location: 'Rear bumper', severity: ['minor', 'moderate', 'severe'][i % 3], description: `Pre-existing scrape noted at check-in. ${MARK}`, photo_paths: [`checkin-photos/${row.id}/damage-1.jpg`], recorded_by: U.shop_tech });
      photos.push({ id: id(`vehicle_photo:${i}:before`), vehicle_id: row.id, storage_path: `vehicle-photos/${row.id}/before-1.jpg`, photo_type: 'before', taken_by: U.shop_tech, taken_at: at(-ago, 8), caption: 'Arrival — driver side' });
      if (done) photos.push({ id: id(`vehicle_photo:${i}:completion`), vehicle_id: row.id, storage_path: `vehicle-photos/${row.id}/completion-1.jpg`, photo_type: 'completion', taken_by: U.shop_tech, taken_at: at(-k - 1, 15), caption: 'Completed install' });
    }
  }
  await upsert('fleet_checkins', rows);
  await upsert('vehicle_status_history', history);
  await upsert('vehicle_notes', notes);
  await upsert('job_tasks', tasks);
  await upsert('fleet_checkin_sales_orders', sos, 'checkin_id,netsuite_sales_order_id');
  await upsert('fleet_checkin_invoices', invoices, 'fleet_checkin_id,netsuite_sales_order_id');
  await upsert('vehicle_damage_records', damage);
  await upsert('vehicle_photos', photos);

  const complete = CHECKINS.filter((c) => c.status === 'complete');
  await upsert('shop_appointments', complete.slice(0, 2).map((c, n) => ({
    id: id(`appointment:pickup:${c.i}`), kind: 'pickup', fleet_checkin_id: c.id, slot_date: day(1 + n), slot_time: `${10 + n}:00`, status: 'booked',
    customer_name: c.customer_name, contact_name: c.on_site_contact_name, contact_phone: c.on_site_contact_phone, notes: MARK, booked_via: n ? 'staff' : 'customer',
  })));
  await upsert('shop_capacity_overrides', [{ day: day(4), hours: 16, note: `Half crew — training. ${MARK}`, updated_by: U.admin }], 'day');

  // Shop labor shifts on two in-progress vehicles
  const inProg = CHECKINS.filter((c) => c.status === 'in_progress').slice(0, 2);
  await upsert('work_shifts', inProg.map((c, n) => ({ id: id(`shift:shop:${c.i}`), context: 'shop', fleet_checkin_id: c.id, part_number: 'MR-SH-4820', part_description: 'Shelving install', started_by: U.shop_tech, started_at: at(-1, 8), ended_at: n ? null : at(-1, 12), auto_closed: false })));
  await upsert('work_shift_members', inProg.map((c) => ({ id: id(`shift_member:shop:${c.i}`), shift_id: id(`shift:shop:${c.i}`), profile_id: U.shop_tech, share_weight: 1, added_by: U.shop_tech })));
  await upsert('work_shifts', [{ id: id('shift:graphics:9'), context: 'graphics', graphics_job_id: id('graphics_job:9'), task_tag: 'print', started_by: U.graphics_production, started_at: at(-2, 9), ended_at: at(-2, 11), auto_closed: false }]);
  await upsert('work_shift_members', [{ id: id('shift_member:graphics:9'), shift_id: id('shift:graphics:9'), profile_id: U.graphics_production, share_weight: 1, added_by: U.graphics_production }]);
}

// ═════════════════════════════ 8. NetSuite mirrors (SOs, vendors, vendor POs) + purchasing ═════════════════════════════
const VENDOR_PO_SPECS = [
  // n, vendor, status, label, daysAgo, eta, lines: [item, qty, received, billed]
  [1, 'Masterack', 'B', 'Pending Receipt', 3, 6, [['MR-SH-4820', 10, 0, 0], ['MR-PT-TRANSIT', 4, 0, 0]]],
  [2, 'Masterack', 'D', 'Partially Received', 12, -2, [['MR-SH-6020', 8, 5, 0], ['MR-DR-3', 4, 4, 0]]],
  [3, 'Reading Truck', 'E', 'Pending Billing/Partially Received', 20, -8, [['RT-LR-TRANSIT-HR', 3, 3, 1]]],
  [4, 'Legend Fleet', 'F', 'Pending Bill', 30, -20, [['LEG-FL-TRANSIT-148', 2, 2, 0]]],
  [5, 'Whelen', 'G', 'Fully Billed', 45, -40, [['WL-LED-STRIP', 24, 24, 24]]],
  [6, 'Masterack', 'B', 'Pending Receipt', 1, 14, [['MR-PT-PROMASTER', 6, 0, 0], ['MR-BLK-SS', 2, 0, 0]]],
  [7, 'Adrian Steel', 'D', 'Partially Received', 9, 1, [['ADR-BIN-SM', 20, 12, 0]]],
  [8, 'Grimco', 'H', 'Closed', 60, -55, [['IJ180MC-10-54', 3, 3, 3]]],
];
const VENDOR_NS = { Masterack: '7101', 'Reading Truck': '7102', 'Legend Fleet': '7103', Whelen: '7104', 'Adrian Steel': '7105', Grimco: '7106', 'Verizon Connect': '7107' };

async function seedNetSuiteMirrors() {
  // Sales orders mirrored from NetSuite — one per check-in SO plus the accepted estimates' SOs
  const soRows = [];
  const soLines = [];
  for (const c of CHECKINS) {
    if (!c.netsuite_sales_order_id) continue;
    const est = c.source_estimate_id ? ESTIMATES.find((e) => e.id === c.source_estimate_id) : null;
    const cust = CUSTOMERS.find((x) => x.slug === c.slug);
    const billed = c.status === 'shipped' && c.invoice_number;
    soRows.push({ id: id(`so:${c.netsuite_sales_order_id}`), netsuite_id: c.netsuite_sales_order_id, tranid: c.sales_order_number, customer_netsuite_id: cust.netsuite_id, customer_name: c.customer_name,
      trandate: c.created_at.slice(0, 10), status: billed ? 'G' : c.status === 'shipped' || c.status === 'complete' ? 'E' : 'B', status_label: billed ? 'Billed' : c.status === 'shipped' || c.status === 'complete' ? 'Pending Billing' : 'Pending Fulfillment',
      memo: c.sales_order_memo, otherrefnum: c.i % 3 === 0 ? `PO-${c.slug.toUpperCase().slice(0, 4)}-${c.i}` : null, vin: c.vin, total: c.sales_order_total,
      estimate_id: est?.id || null, match_source: est ? 'createdfrom' : null, createdfrom_netsuite_id: est?.netsuite_estimate_id || null, last_synced_at: at(0) });
    soLines.push({ id: id(`so_line:${c.netsuite_sales_order_id}:1`), so_id: id(`so:${c.netsuite_sales_order_id}`), line_id: '1', item_netsuite_id: '3000', item_number: 'MR-SH-4820', description: 'Masterack 48" x 20" Steel Shelving Unit', quantity: 2, quantity_billed: billed ? 2 : 0, rate: 489, amount: 978 });
    soLines.push({ id: id(`so_line:${c.netsuite_sales_order_id}:2`), so_id: id(`so:${c.netsuite_sales_order_id}`), line_id: '2', item_netsuite_id: '3013', item_number: 'LABOR', description: 'Installation Labor', quantity: 3, quantity_billed: billed ? 3 : 0, rate: 85, amount: 255 });
  }
  // An orphan SO with no estimate link, for the SO matchmaker
  soRows.push({ id: id('so:orphan'), netsuite_id: '52999', tranid: 'SO52999', customer_netsuite_id: '1003', customer_name: 'Riverbend Electric Co.', trandate: day(-2), status: 'B', status_label: 'Pending Fulfillment', memo: 'Electrician package — 2 vans', otherrefnum: null, total: 4321.5, estimate_id: null, match_source: null, last_synced_at: at(0) });
  await upsert('netsuite_sales_orders', soRows);
  await upsert('netsuite_sales_order_lines', soLines, 'so_id,line_id');
  await upsert('so_match_suggestions', [{ id: id('so_match:orphan:4'), so_id: id('so:orphan'), estimate_id: id('estimate:4'), score: 82.5, confidence: 'high', rationale: 'Same customer, memo matches estimate title, total within 3%.', signals: { customer: true, memo: true, total_delta_pct: 2.7 }, text_compared: true, text_verdict: 'match', status: 'open' }], 'so_id,estimate_id');

  await upsert('netsuite_vendors', Object.entries(VENDOR_NS).map(([name, nsId]) => ({ id: id(`vendor:${name}`), netsuite_id: nsId, entity_id: name.toUpperCase().replace(/\s+/g, '_'), company_name: name, email: `orders@${name.toLowerCase().replace(/\s+/g, '')}.example`, phone: '800-555-0199', terms: 'Net 30', is_inactive: false, synced_at: at(0) })));

  const poRows = []; const lineRows = []; const receipts = []; const etaEvents = []; const emails = [];
  for (const [n, vendor, status, label, ago, eta, lines] of VENDOR_PO_SPECS) {
    const total = money(lines.reduce((s, [item, qty]) => s + qty * (PARTS.find((p) => p.item_number === item)?.purchase_price || 42), 0));
    const poId = id(`vendor_po:${n}`);
    const row = { id: poId, netsuite_id: String(71000 + n), tranid: `PO${71000 + n}`, vendor_netsuite_id: VENDOR_NS[vendor], vendor_name: vendor, trandate: day(-ago), status, status_label: label,
      memo: `${MARK} vendor PO ${n}`, total, last_synced_at: at(0), eta_date: n === 8 ? null : day(eta), eta_source: n % 2 ? 'email' : 'manual', tracking_number: status === 'B' && n === 1 ? '1Z999AA10123456784' : null, carrier: status === 'B' && n === 1 ? 'UPS' : null };
    poRows.push(row); VENDOR_POS.push({ n, vendor, lines, ...row });
    lines.forEach(([item, qty, received, billed], li) => {
      const part = PARTS.find((p) => p.item_number === item);
      lineRows.push({ id: id(`vendor_po_line:${n}:${li}`), po_id: poId, line_id: String(li + 1), item_netsuite_id: part?.netsuite_id || null, item_number: item, description: part?.display_name || `${item} (vendor item)`, quantity: qty, quantity_received: received, quantity_billed: billed, rate: part?.purchase_price || 42, amount: money(qty * (part?.purchase_price || 42)) });
      if (received > 0 && status === 'D') receipts.push({ id: id(`po_receipt:${n}:${li}`), po_id: poId, po_netsuite_id: row.netsuite_id, line_id: String(li + 1), item_netsuite_id: part?.netsuite_id || null, item_number: item, description: part?.display_name || item, quantity: received, note: MARK, ns_status: li === 0 ? 'posted' : 'manual_needed', ns_receipt_id: li === 0 ? String(73000 + n) : null, ns_receipt_number: li === 0 ? `IR${73000 + n}` : null, received_by: U.shop_tech, received_at: at(-2, 11) });
    });
    if (row.eta_date) {
      etaEvents.push({ id: id(`eta_event:${n}:1`), po_id: poId, po_tranid: row.tranid, vendor_name: vendor, eta_date: day(eta - 3), previous_eta: null, source: 'email', detail: 'Order confirmation', created_at: at(-ago + 1) });
      etaEvents.push({ id: id(`eta_event:${n}:2`), po_id: poId, po_tranid: row.tranid, vendor_name: vendor, eta_date: day(eta), previous_eta: day(eta - 3), source: n % 2 ? 'email' : 'manual', detail: 'Ship date slipped 3 days', created_at: at(-ago + 2) });
      emails.push({ id: id(`shipment_email:${n}`), mailbox: 'parts@bmgfleet.com', gmail_id: `sandbox-gmail-${n}`, from_address: `orders@${vendor.toLowerCase().replace(/\s+/g, '')}.example`, subject: `Your order ${row.tranid} has shipped`, received_at: at(-ago + 2), classification: n === 7 ? 'review' : 'applied', vendor_name: vendor, po_number: row.tranid, ship_date: day(eta - 4), eta_date: day(eta), tracking_number: row.tracking_number, carrier: row.carrier, summary: `Shipment notice for ${row.tranid}. ${MARK}`, matched_po_id: poId });
    }
  }
  await upsert('netsuite_vendor_pos', poRows);
  await upsert('netsuite_vendor_po_lines', lineRows, 'po_id,line_id');
  await upsert('po_receipts', receipts);
  await upsert('po_receipt_exceptions', [{ id: id('dock_exception:2'), receipt_id: id('po_receipt:2:0'), po_id: id('vendor_po:2'), item_number: 'MR-SH-6020', kind: 'damaged', quantity: 1, note: `Bent bracket on one unit. ${MARK}`, status: 'open', flagged_by: U.shop_tech }]);
  await upsert('po_eta_events', etaEvents);
  await upsert('vendor_shipment_emails', emails, 'mailbox,gmail_id');
  await upsert('vendor_parts_invoices', [{ id: id('parts_invoice:5'), email_id: id('shipment_email:5'), mailbox: 'parts@bmgfleet.com', file_name: 'whelen-inv-88213.pdf', storage_path: 'parts-invoices/whelen-inv-88213.pdf', content_type: 'application/pdf', file_size: 91000, vendor_name: 'Whelen', invoice_number: '88213', invoice_date: day(-38), total: 1536, matched_po_id: id('vendor_po:5'), status: 'billed', netsuite_bill_id: '74005', netsuite_bill_number: 'VB74005', billed_by: U.finance, billed_at: at(-35) },
    { id: id('parts_invoice:3'), email_id: id('shipment_email:3'), mailbox: 'parts@bmgfleet.com', file_name: 'reading-inv-5510.pdf', storage_path: 'parts-invoices/reading-inv-5510.pdf', content_type: 'application/pdf', file_size: 77000, vendor_name: 'Reading Truck', invoice_number: '5510', invoice_date: day(-6), total: 2340, matched_po_id: id('vendor_po:3'), status: 'captured' }]);
  await upsert('parts_email_settings', [{ id: 1, enabled: true, mailboxes: ['parts@bmgfleet.com'], updated_by: U.admin }], 'id');

  await upsert('purchase_requests', [
    { id: id('purchase_request:1'), item_number: 'MR-PT-PROMASTER', netsuite_item_id: '3003', description: 'Masterack Composite Partition — Ram ProMaster', quantity: 2, vendor_name: 'Masterack', vendor_netsuite_id: '7101', needed_by: day(7), note: `For Gateway build. ${MARK}`, status: 'pending', requested_by: U.sales },
    { id: id('purchase_request:2'), item_number: 'RT-LR-TRANSIT-HR', netsuite_item_id: '3004', description: 'Reading Ladder Rack — Transit High Roof', quantity: 1, vendor_name: 'Reading Truck', vendor_netsuite_id: '7102', needed_by: day(3), note: MARK, status: 'pending', requested_by: U.shop_tech },
    { id: id('purchase_request:3'), item_number: 'MR-SH-4820', netsuite_item_id: '3000', description: 'Masterack 48" x 20" Steel Shelving Unit', quantity: 10, vendor_name: 'Masterack', vendor_netsuite_id: '7101', needed_by: day(-1), note: MARK, status: 'ordered', ordered_po_id: id('vendor_po:1'), ordered_at: at(-3), ordered_by: U.admin, requested_by: U.sales },
    { id: id('purchase_request:4'), item_number: 'MR-SH-6020', netsuite_item_id: '3001', description: 'Masterack 60" x 20" Steel Shelving Unit', quantity: 14, vendor_name: 'Masterack', vendor_netsuite_id: '7101', note: `On hand 6 vs order-up-to 20 — raised by the nightly reorder sweep. ${MARK}`, status: 'pending', requested_by: null, source: 'auto_reorder' },
    { id: id('purchase_request:5'), item_number: 'ADR-BIN-SM', netsuite_item_id: '3015', description: 'Adrian Steel Small Parts Bin (6-pack)', quantity: 4, vendor_name: 'Adrian Steel', vendor_netsuite_id: '7105', note: `Duplicate — cancelled. ${MARK}`, status: 'cancelled', requested_by: U.shop_tech },
    { id: id('purchase_request:6'), item_number: 'IJ180MC-10-54', description: '3M IJ180mC-10 Cast Wrap Film 54"', quantity: 300, vendor_name: 'Grimco', vendor_netsuite_id: '7106', note: `Film stock below reorder point. ${MARK}`, status: 'pending', requested_by: null, source: 'auto_reorder' },
  ]);
  await upsert('purchasing_demand_dismissals', [{ item_number: 'VZ-CONNECT-HW', needed_at_dismiss: 12, reason: `Customer supplies hardware. ${MARK}`, dismissed_by: U.admin }], 'item_number');
  await upsert('po_locations', [
    { id: id('po_location:wentzville'), name: 'Masterack — Wentzville', address: '1 Plant Rd', city: 'Wentzville', state: 'MO', zip: '63385', archived: false, created_by: U.admin },
    { id: id('po_location:kc'), name: 'Masterack — Kansas City', address: '2 Plant Rd', city: 'Kansas City', state: 'MO', zip: '64101', archived: false, created_by: U.admin },
  ]);
  await upsert('po_location_overrides', [{ po_number: 'PO-ACME-4410', location_id: '12', location_name: 'Wentzville', updated_by: U.finance }], 'po_number');
}

// ═════════════════════════════ 9. upfit projects ═════════════════════════════
const UPFIT_STATUSES = ['opportunity', 'estimate', 'sold', 'parts_ordered', 'parts_arrived', 'parts_in_stock', 'scheduled_dropoff', 'scheduled_build', 'in_progress', 'scheduled_pickup', 'completed', 'cancelled'];

async function seedUpfitProjects() {
  const rows = []; const notes = []; const tasks = []; const allocations = []; const files = []; const pos = [];
  UPFIT_STATUSES.forEach((status, n) => {
    const cust = CUSTOMERS[(n * 3) % CUSTOMERS.length];
    const est = n === 1 ? ESTIMATES[3] : n === 2 ? ESTIMATES[5] : n === 3 ? ESTIMATES[6] : null; // distinct estimates (unique index)
    const checkin = status === 'in_progress' ? CHECKINS.find((c) => c.status === 'in_progress' && c.i % 6 !== 5) : status === 'completed' ? CHECKINS.find((c) => c.status === 'shipped') : status === 'scheduled_pickup' ? CHECKINS.find((c) => c.status === 'complete') : null;
    const sold = n >= 2 && status !== 'cancelled';
    const row = {
      id: id(`upfit_project:${n}`), project_name: `${cust.company_name} — ${['Transit shelving', 'ProMaster plumber build', 'Telematics rollout', 'Ladder rack + floor', 'Partition retrofit', 'Electrician package', 'Drawer + bin refresh', 'Fleet standard upfit', 'Service van build', 'Bulkhead + shelving', 'Truck bed bins', 'Cancelled — budget'][n]}`,
      status, prospect_id: PROSPECTS.find((p) => p.slug === cust.slug)?.id || null, customer_name: cust.company_name, customer_netsuite_id: cust.netsuite_id,
      estimate_id: est?.id || null, estimate_number: est?.estimate_number || null,
      netsuite_so_id: checkin?.netsuite_sales_order_id || (sold ? String(52300 + n) : null), netsuite_so_number: checkin?.sales_order_number || (sold ? `SO${52300 + n}` : null),
      netsuite_vendor_po_id: n >= 3 && n <= 8 ? String(71000 + 1 + (n % 3)) : null, netsuite_vendor_po_number: n >= 3 && n <= 8 ? `PO${71000 + 1 + (n % 3)}` : null,
      scheduled_date: n >= 6 ? day(n - 7) : null, scheduled_end_date: n >= 6 ? day(n - 5) : null, fleet_checkin_id: checkin?.id || null,
      estimated_total: money(3000 + n * 850), so_total: sold ? money(3100 + n * 850) : null, created_by: U.sales, assigned_to: n % 2 ? U.shop_tech : null, updated_by: U.sales,
      created_at: at(-30 + n), updated_at: at(-1), parts_ordered_date: n >= 3 ? day(-20 + n) : null, parts_eta: n === 3 ? day(4) : n >= 4 ? day(-5) : null,
      customer_dropoff_date: n >= 6 ? day(n - 7) : null, need_back_date: n >= 6 ? day(n - 3) : null,
    };
    rows.push(row); UPFIT_PROJECTS.push({ n, ...row });
    notes.push({ id: id(`upfit_note:${n}:0`), project_id: row.id, note_type: 'note', content: `Project opened. ${MARK}`, created_by: U.sales, created_at: row.created_at });
    if (n >= 2) notes.push({ id: id(`upfit_note:${n}:1`), project_id: row.id, note_type: 'status_change', content: `Status → ${status}`, created_by: U.sales, created_at: at(-2) });
    if (est) notes.push({ id: id(`upfit_note:${n}:2`), project_id: row.id, note_type: 'estimate', content: `Linked estimate ${est.estimate_number}`, created_by: U.sales, created_at: at(-10) });
    tasks.push({ id: id(`upfit_task:${n}:1`), project_id: row.id, title: 'Confirm drop-off date with customer', description: MARK, assigned_to: U.sales, due_date: day(2), completed_at: n >= 6 ? at(-3) : null, completed_by: n >= 6 ? U.sales : null, created_by: U.sales });
    if (n % 2) tasks.push({ id: id(`upfit_task:${n}:2`), project_id: row.id, title: 'Stage parts on rack B', description: MARK, assigned_to: U.shop_tech, due_date: day(-1), created_by: U.sales });
    if (n >= 3 && n <= 9) allocations.push({ id: id(`allocation:${n}`), project_id: row.id, item_number: n % 2 ? 'MR-SH-4820' : 'MR-DR-3', quantity: 1 + (n % 3), status: 'reserved', note: MARK, created_by: U.sales });
    if (row.netsuite_vendor_po_id) pos.push({ id: id(`upfit_po:${n}`), project_id: row.id, po_id: id(`vendor_po:${1 + (n % 3)}`), po_number: row.netsuite_vendor_po_number, source: n === 3 ? 'request_queue' : 'manual', created_by: U.admin });
    if (n === 8) files.push({ id: id(`upfit_file:${n}`), project_id: row.id, file_name: 'layout-approved.pdf', file_type: 'application/pdf', file_size: 66000, storage_path: `upfit-files/${row.id}/layout-approved.pdf`, uploaded_by: U.sales });
  });
  await upsert('upfit_projects', rows);
  await upsert('upfit_project_notes', notes);
  await upsert('upfit_project_tasks', tasks);
  await upsert('part_allocations', allocations, 'project_id,item_number');
  await upsert('upfit_project_pos', pos, 'project_id,po_id');
  await upsert('upfit_project_files', files);

  await upsert('shop_inbound', [
    { id: id('inbound:upfit:6'), source_type: 'upfit_project', source_id: id('upfit_project:6'), vehicle_desc: '2024 Ford Transit 250 MR', customer_name: UPFIT_PROJECTS[6].customer_name, work_summary: 'Drawer + bin refresh', install_location: "O'Fallon Shop", expected_date: day(-1), need_back_date: day(3), status: 'expected', created_by: U.sales },
    { id: id('inbound:upfit:7'), source_type: 'upfit_project', source_id: id('upfit_project:7'), vehicle_desc: '2023 Ram ProMaster 2500', customer_name: UPFIT_PROJECTS[7].customer_name, work_summary: 'Fleet standard upfit', install_location: "O'Fallon Shop", expected_date: day(1), need_back_date: day(5), status: 'expected', created_by: U.sales },
    { id: id('inbound:graphics:9'), source_type: 'graphics_job', source_id: id('graphics_job:9'), vehicle_desc: '2024 Ford Transit 148', customer_name: 'Summit Roofing Group', work_summary: 'USDOT lettering install', install_location: "O'Fallon Shop", expected_date: day(3), status: 'expected', created_by: U.graphics_production },
    { id: id('inbound:manual:1'), source_type: 'manual', source_id: id('inbound:manual:1:source'), vehicle_desc: '2022 Chevrolet Express', customer_name: 'Bravo Security Systems', work_summary: 'Walk-in estimate — shelving', install_location: "O'Fallon Shop", expected_date: day(0), status: 'arrived', fleet_checkin_id: CHECKINS[0].id, created_by: U.shop_tech },
    { id: id('inbound:so:est6'), source_type: 'sales_order', source_id: id('estimate:6'), vehicle_desc: 'Telematics — 12 units', customer_name: 'Prairie Telecom Field Services', work_summary: 'Verizon Connect installs', install_location: 'Customer site', expected_date: day(6), status: 'expected', netsuite_so_id: '52006', netsuite_so_number: 'SO52006', created_by: U.sales },
  ], 'source_type,source_id');

  if (PLATFORMS.transit) {
    const interiors = await select('vehicle_interiors', 'id,platform_id,wheelbase_label,roof_label');
    const interior = interiors.find((x) => x.platform_id === PLATFORMS.transit) || null;
    await upsert('upfit_designs', [
      { id: id('design:plumber-transit'), name: 'Plumber Package — Transit 148 MR', customer_id: id('customer:gateway-plumbing'), platform_id: PLATFORMS.transit, wheelbase_label: interior?.wheelbase_label || '148', roof_label: interior?.roof_label || 'Medium', interior_id: interior?.id || null,
        layout: { version: 1, units: 'in', items: [{ part_id: id('part:MR-SH-4820'), x: 12, y: 0, z: 0, rot: 0 }, { part_id: id('part:MR-PT-TRANSIT'), x: 0, y: 0, z: 0, rot: 0 }], unplaced: [] }, is_template: false, trade: 'plumbing', status: 'draft', estimate_id: id('estimate:2'), created_by: U.sales },
      { id: id('design:tpl-electrician'), name: 'Electrician — Transit 148 (template)', platform_id: PLATFORMS.transit, wheelbase_label: interior?.wheelbase_label || '148', roof_label: interior?.roof_label || 'Medium', interior_id: interior?.id || null,
        layout: { version: 1, units: 'in', items: [], unplaced: [{ part_id: id('part:MR-SH-6020') }] }, is_template: true, trade: 'electrical', status: 'draft', created_by: U.sales },
    ]);
  } else if (!DRY_RUN) warnings.push('vehicle_platforms has no "transit" key — upfit_designs skipped');
}

// ═════════════════════════════ 10. CNI network jobs ═════════════════════════════
const CNI_SPECS = [
  // n, status, title, installer key (null = unassigned), vinCount, distribution
  [1, 'awaiting_assignment', 'Heartland Cable — 4 van wraps (Wichita)', null, 4, 'direct'],
  [2, 'bidding_open', 'Prairie Telecom — 12 telematics installs (Columbia)', null, 12, 'published'],
  [3, 'assigned_awaiting_scheduling', 'Ozark Water — 2 partial wraps (Branson)', 'installer', 2, 'invite'],
  [4, 'scheduled_confirmed', 'Metro HVAC — door logos x6 (Kansas City)', 'installer', 6, 'direct'],
  [5, 'in_progress', 'Masterack — Wentzville shelving batch', 'installer', 8, 'direct'],
  [6, 'completed_pending_review', 'Gulf Coast — Houston courier decals', 'installer2', 3, 'invite'],
  [7, 'approved_closed', 'Acme Fleet — Transit lettering (closed)', 'installer', 5, 'direct'],
];

async function seedCni() {
  const rows = []; const vins = []; const invites = []; const bids = []; const hist = []; const msgs = []; const tasks = []; const photos = []; const shifts = []; const members = []; const credits = []; const payouts = [];
  for (const [n, status, title, instKey, vinCount, dist] of CNI_SPECS) {
    const inst = instKey ? U[instKey] : null;
    const company = !companiesOk ? null : instKey === 'installer' ? COMPANY.midwest : instKey === 'installer2' ? COMPANY.gulf : null;
    const custName = title.split(' — ')[0];
    const cust = CUSTOMERS.find((c) => c.company_name.startsWith(custName)) || null;
    const started = ['in_progress', 'completed_pending_review', 'approved_closed'].includes(status);
    const done = status === 'completed_pending_review' || status === 'approved_closed';
    const jobId = id(`cni_job:${n}`);
    const row = {
      id: jobId, job_number: `CNI-9${pad(n, 3)}`, title, description: `${MARK} ${title}`, scope: 'Install supplied graphics per proof; submit 4 photos per vehicle.', assignment_type: 'cni',
      customer_name: cust?.company_name || custName, customer_id: cust?.id || null, address: { line1: '500 Fleet Yard Rd', city: title.match(/\(([^)]+)\)/)?.[1] || 'Wentzville', state: 'MO', zip: '63385' },
      site_contact_name: 'Yard Supervisor', site_contact_phone: '636-555-0777', site_contact_email: 'yard@example.com', is_multi_unit: vinCount > 1, vin_count: vinCount, target_quantity: vinCount,
      budget: money(vinCount * 180), deadline: day(10 + n * 3), estimated_hours: vinCount * 1.5, requires_shipment: true, shipping_address: { line1: '500 Fleet Yard Rd', city: 'Wentzville', state: 'MO', zip: '63385' },
      tracking_number: n >= 3 ? `1Z999AA20${pad(n, 9)}` : null, carrier: n >= 3 ? 'UPS' : null, material_delivered: n >= 4, material_delivered_at: n >= 4 ? at(-6) : null,
      proof_file_paths: [`cni/${n}/proof.pdf`], design_file_paths: [], assigned_installer_id: inst, assigned_at: inst ? at(-8) : null, status,
      proposed_schedule_start: n >= 3 ? day(-3) : null, proposed_schedule_end: n >= 3 ? day(-1) : null, confirmed_schedule_start: n >= 4 ? day(-3) : null, confirmed_schedule_end: n >= 4 ? day(-1) : null,
      schedule_confirmed_at: n >= 4 ? at(-5) : null, scheduled_start_at: n >= 4 ? at(-3, 8) : null, scheduled_end_at: n >= 4 ? at(-1, 17) : null,
      completed_at: done ? at(-1, 16) : null, approved_at: status === 'approved_closed' ? at(0, 9) : null, approved_by: status === 'approved_closed' ? U.admin : null, closed_at: status === 'approved_closed' ? at(0, 9) : null,
      created_by: U.admin, updated_by: U.admin, created_at: at(-12 - n), updated_at: at(-1), distribution_type: dist, published_at: dist === 'published' ? at(-4) : null, bid_count: dist === 'published' ? 2 : dist === 'invite' ? 1 : 0,
      site_access_notes: 'Gate code 4471. Check in at office.', part_number: n === 5 ? 'MR-SH-4820' : 'GR-DOOR-LOGO-24', part_description: n === 5 ? 'Masterack shelving' : 'Door logo decals',
      billable_customer: n === 5 ? 'Masterack LLC' : cust?.company_name || null, assigned_company_id: company, pay_per_vehicle: n === 5 ? 120 : 60, payout_mode: instKey === 'installer2' ? 'individual' : 'company',
      attachments: [{ name: 'proof.pdf', path: `cni/${n}/proof.pdf` }], device_capture: n === 2, source_graphics_job_id: n === 1 ? id('graphics_job:5') : null,
    };
    rows.push(row); CNI_JOBS.push({ n, instKey, ...row });
    for (let v = 0; v < Math.min(vinCount, 4); v++) {
      const completed = done || (started && v < 2);
      vins.push({ id: id(`cni_vin:${n}:${v}`), job_id: jobId, vin: vinFor('3C6TRVAG', 500 + n * 10 + v), vehicle_year: '2023', vehicle_make: 'Ram', vehicle_model: 'ProMaster', status: completed ? 'completed' : started && v === 2 ? 'in_progress' : 'pending',
        completed_at: completed ? at(-1, 10 + v) : null, completion_notes: completed ? `Installed clean. ${MARK}` : null, photos_submitted: completed, sort_order: v, completed_by: completed ? inst : null,
        serial_number: n === 2 ? `SN${pad(n * 100 + v, 6)}` : null, imei: n === 2 ? `35${pad(9000000000000 + n * 100 + v, 13)}` : null });
      if (completed) ['front', 'back', 'driver_side', 'passenger_side'].forEach((pt) => photos.push({ id: id(`cni_photo:${n}:${v}:${pt}`), job_id: jobId, vin_id: id(`cni_vin:${n}:${v}`), storage_path: `cni-photos/${jobId}/${v}-${pt}.jpg`, photo_type: pt, uploaded_by: inst, uploaded_at: at(-1, 11 + v), review_status: 'pending', prescreen_verdict: 'pass', prescreen_at: at(-1, 12 + v) }));
    }
    if (dist !== 'direct' || inst) {
      invites.push({ id: id(`cni_invite:${n}:installer`), job_id: jobId, installer_id: U.installer, company_id: companiesOk ? COMPANY.midwest : null, invite_type: dist === 'published' ? 'published' : 'direct', invited_by: U.admin, sent_at: at(-9), seen_at: at(-8) });
      invites.push({ id: id(`cni_invite:${n}:installer2`), job_id: jobId, installer_id: U.installer2, company_id: companiesOk ? COMPANY.gulf : null, invite_type: dist === 'published' ? 'published' : 'direct', invited_by: U.admin, sent_at: at(-9), seen_at: n % 2 ? at(-7) : null, repinged_at: n % 2 ? null : at(-6) });
    }
    if (dist === 'published') {
      bids.push({ id: id(`cni_bid:${n}:installer`), job_id: jobId, installer_id: U.installer, company_id: companiesOk ? COMPANY.midwest : null, response: 'interested', proposed_start: day(5), proposed_end: day(7), notes: `Can start next week. ${MARK}` });
      bids.push({ id: id(`cni_bid:${n}:installer2`), job_id: jobId, installer_id: U.installer2, company_id: companiesOk ? COMPANY.gulf : null, response: 'declined', decline_reason: 'Out of service area', notes: MARK });
    } else if (dist === 'invite' && instKey) {
      bids.push({ id: id(`cni_bid:${n}:${instKey}`), job_id: jobId, installer_id: inst, company_id: company, response: 'interested', proposed_start: day(-3), proposed_end: day(-1), notes: MARK });
    }
    const walk = ['awaiting_assignment', 'assigned_awaiting_scheduling', 'scheduled_confirmed', 'in_progress', 'completed_pending_review', 'approved_closed'];
    const idx = walk.indexOf(status);
    (idx >= 0 ? walk.slice(0, idx + 1) : ['awaiting_assignment', status]).forEach((s, j, arr) => hist.push({ id: id(`cni_history:${n}:${j}`), job_id: jobId, from_status: j === 0 ? null : arr[j - 1], to_status: s, changed_by: U.admin, note: j === 0 ? MARK : null, created_at: at(-12 - n + j * 2) }));
    if (inst) {
      msgs.push({ id: id(`cni_msg:${n}:1`), job_id: jobId, sender_id: U.admin, body: `Materials ship tomorrow — tracking on the job. ${MARK}`, read_at: at(-5), created_at: at(-6, 10) });
      msgs.push({ id: id(`cni_msg:${n}:2`), job_id: jobId, sender_id: inst, body: 'Received, thanks. Will confirm dates once the yard opens.', read_at: n % 2 ? at(-4) : null, created_at: at(-5, 14) });
    }
    ['Verify proof matches vehicle', 'Clean + prep surfaces', 'Install graphics', 'Submit 4 photos per VIN'].forEach((label, t) => tasks.push({ id: id(`cni_task:${n}:${t}`), job_id: jobId, label, required: t !== 1, sort_order: t, completed: done || (started && t < 2), completed_at: done || (started && t < 2) ? at(-1, 9 + t) : null, completed_by: done || (started && t < 2) ? inst : null, completed_by_name: done || (started && t < 2) ? NAMES[instKey] : null, created_by: U.admin }));
    if (started && inst) {
      const shiftId = id(`shift:cni:${n}`);
      shifts.push({ id: shiftId, context: 'cni', cni_job_id: jobId, part_number: row.part_number, part_description: row.part_description, billable_customer: row.billable_customer, location_name: row.address.city, started_by: inst, started_at: at(-1, 8), ended_at: at(-1, 16), auto_closed: false });
      members.push({ id: id(`shift_member:cni:${n}`), shift_id: shiftId, profile_id: inst, share_weight: 1, added_by: inst });
      const payoutId = id(`payout:cni:${n}`);
      payouts.push({ id: payoutId, profile_id: inst, kind: 'cni_job', cni_job_id: jobId, total_amount: money(Math.min(vinCount, 4) * row.pay_per_vehicle), status: status === 'approved_closed' ? 'billed' : done ? 'approved' : 'draft', netsuite_bill_id: status === 'approved_closed' ? String(75000 + n) : null,
        approved_by: done ? U.admin : null, approved_at: done ? at(0, 9) : null, billed_by: status === 'approved_closed' ? U.finance : null, billed_at: status === 'approved_closed' ? at(0, 10) : null });
      vins.filter((x) => x.job_id === jobId && x.status === 'completed').forEach((x, ci) => credits.push({ id: id(`credit:cni:${n}:${ci}`), shift_id: shiftId, profile_id: inst, cni_job_vin_id: x.id, vin: x.vin, part_number: row.part_number, source: 'cni', rate_per_vehicle: row.pay_per_vehicle, share_weight: 1, crew_size: 1, total_weight: 1, amount: row.pay_per_vehicle, payout_id: payoutId }));
    }
  }
  await upsert('cni_jobs', rows);
  await upsert('cni_job_vins', vins);
  await upsert('cni_job_invites', invites, 'job_id,installer_id');
  await upsert('cni_job_bids', bids, 'job_id,installer_id');
  await upsert('cni_job_status_history', hist);
  await upsert('cni_job_messages', msgs);
  await upsert('cni_job_tasks', tasks);
  await upsert('cni_job_photos', photos);
  await upsert('work_shifts', shifts);
  await upsert('work_shift_members', members);
  await upsert('payouts', payouts);
  await upsert('install_credits', credits);
  await upsert('cni_internal_notes', [
    { id: id('cni_note:installer2:1'), installer_id: U.installer2, note_type: 'issue', content: `Photos arrived two days late on CNI-9006. ${MARK}`, auto_generated: false, source_job_id: id('cni_job:6'), created_by: U.admin },
    { id: id('cni_note:installer:1'), installer_id: U.installer, note_type: 'qc', content: `Consistently clean installs; preferred for wraps. ${MARK}`, auto_generated: false, created_by: U.admin },
  ]);
  if (companiesOk) await upsert('cni_compliance_notices', [{ id: id('compliance:gulf:30'), subject_type: 'company', subject_id: COMPANY.gulf, threshold: 30, expiry: day(20), notified_at: at(-10) }], 'subject_type,subject_id,expiry,threshold');
}

// ═════════════════════════════ 11. field scans, vendor (installer) invoices ═════════════════════════════
async function seedScans() {
  const shop = LOCATIONS.find((l) => /BMG Shop/i.test(l.name)) || LOCATIONS[0];
  const wentzville = LOCATIONS.find((l) => /Wentzville/i.test(l.name)) || LOCATIONS[0];
  const rows = [];
  for (let i = 0; i < 16; i++) {
    const telematics = i % 3 === 0;
    const loc = telematics ? shop : wentzville;
    const ago = i;  // all within the dated unique-index window if run after 2026-08-11 → distinct (vin, part) pairs below
    const invoiced = i > 8;
    const row = {
      id: id(`scan:${i}`), vin: vinFor('1GCWGAFP', 300 + i), vehicle_year: '2024', vehicle_make: telematics ? 'Ford' : 'Chevrolet', vehicle_model: telematics ? 'Transit' : 'Express', vehicle_trim: telematics ? '250' : '2500', body_class: 'Cargo Van',
      part_number: telematics ? 'VZ-CONNECT-HW' : 'MR-SH-4820', part_description: telematics ? 'Verizon Connect Telematics Hardware Kit' : 'Masterack 48" x 20" Steel Shelving Unit',
      billable_customer: telematics ? 'Prairie Telecom Field Services' : 'Masterack LLC', location_id: loc?.id || null, location_name: loc?.name || null,
      scanned_by: i % 2 ? U.field_tech : U.installer, scanned_at: at(-ago, 10 + (i % 6)), exported_at: i > 6 ? at(-ago + 1, 6) : null, exported_by: i > 6 ? U.finance : null,
      invoice_number: invoiced ? `INV${63000 + i}` : null, date_invoiced: invoiced ? day(-ago + 2) : null, is_paid: invoiced && i > 12, paid_at: invoiced && i > 12 ? at(-ago + 6) : null,
      invoiced_amount: invoiced ? (telematics ? 95 : 489) : null, unit_number: `U${400 + i}`, serial_number: telematics ? `VZ${pad(i, 6)}` : null, imei: telematics ? `35${pad(8000000000000 + i, 13)}` : null,
      iccid: telematics ? `8901${pad(i, 15)}` : null, scanned_by_company: i % 2 ? null : 'Midwest Wrap Installers LLC', installer_name: i % 2 ? NAMES.field_tech : NAMES.installer,
      install_cost: i % 2 ? null : (telematics ? 45 : 120), vendor_invoice_id: null,
    };
    rows.push(row); SCAN_LOGS.push(row);
  }
  await upsert('scan_logs', rows);
  await upsert('scan_photos', [{ id: id('scan_photo:0'), scan_log_id: id('scan:0'), storage_path: `photos/${id('scan:0')}/complete.jpg`, content_type: 'image/jpeg', taken_by: U.installer }]);

  // Field shift + pay credits for the field tech's scans
  const fieldScans = SCAN_LOGS.filter((s) => s.scanned_by === U.field_tech).slice(0, 3);
  await upsert('work_shifts', [{ id: id('shift:field:1'), context: 'field', part_number: 'MR-SH-4820', part_description: 'Shelving install', billable_customer: 'Masterack LLC', location_id: wentzville?.id || null, location_name: wentzville?.name || null, started_by: U.field_tech, started_at: at(-1, 7), ended_at: at(-1, 15), auto_closed: false }]);
  await upsert('work_shift_members', [{ id: id('shift_member:field:1'), shift_id: id('shift:field:1'), profile_id: U.field_tech, share_weight: 1, added_by: U.field_tech }]);
  await upsert('payouts', [{ id: id('payout:payroll:field_tech'), profile_id: U.field_tech, kind: 'payroll_period', period_start: day(-14), period_end: day(-1), total_amount: money(fieldScans.length * 120), status: 'draft' }]);
  await upsert('install_credits', fieldScans.map((s, i) => ({ id: id(`credit:field:${i}`), shift_id: id('shift:field:1'), profile_id: U.field_tech, scan_log_id: s.id, vin: s.vin, part_number: s.part_number, source: 'field', rate_per_vehicle: s.part_number === 'VZ-CONNECT-HW' ? 45 : 120, share_weight: 1, crew_size: 1, total_weight: 1, amount: s.part_number === 'VZ-CONNECT-HW' ? 45 : 120, payout_id: id('payout:payroll:field_tech') })));

  // Installer-company invoices (AP queue) against the installer's scans
  const instScans = SCAN_LOGS.filter((s) => s.scanned_by === U.installer);
  const invoiceSpecs = [
    { n: 1, status: 'submitted', scans: instScans.slice(0, 3), ago: 2 },
    { n: 2, status: 'approved', scans: instScans.slice(3, 6), ago: 9 },
    { n: 3, status: 'paid', scans: instScans.slice(6, 8), ago: 30 },
  ];
  const invs = []; const lines = [];
  for (const { n, status, scans, ago } of invoiceSpecs) {
    const total = money(scans.reduce((s, x) => s + (x.install_cost || 100), 0));
    const past = ['approved', 'billed', 'paid'];
    invs.push({ id: id(`vendor_invoice:${n}`), invoice_number: `MWI-${2000 + n}`, invoice_date: day(-ago), company_id: companiesOk ? COMPANY.midwest : null, vendor_name: 'Midwest Wrap Installers LLC', total_amount: total, location_id: wentzville?.id || null, location_name: wentzville?.name || null,
      file_name: `MWI-${2000 + n}.pdf`, storage_path: `vendor-invoices/MWI-${2000 + n}.pdf`, notes: MARK, created_by: U.installer, status, due_date: day(-ago + 30),
      submitted_by: U.installer, submitted_at: at(-ago), approved_by: past.includes(status) ? U.finance : null, approved_at: past.includes(status) ? at(-ago + 1) : null,
      billed_by: status === 'paid' ? U.finance : null, billed_at: status === 'paid' ? at(-ago + 2) : null, netsuite_bill_id: status === 'paid' ? String(76000 + n) : null, paid_by: status === 'paid' ? U.finance : null, paid_at: status === 'paid' ? at(-ago + 20) : null });
    scans.forEach((s, li) => lines.push({ id: id(`vendor_invoice_line:${n}:${li}`), vendor_invoice_id: id(`vendor_invoice:${n}`), scan_log_id: s.id, vin: s.vin, part_number: s.part_number, amount: s.install_cost || 100, was_existing_scan: true }));
  }
  await upsert('vendor_invoices', invs);
  await upsert('vendor_invoice_lines', lines);
}

// ═════════════════════════════ 12. comms, schedule, knowledge, notifications ═════════════════════════════
async function seedCommsAndMisc() {
  await upsert('calendar_events', [
    { id: id('event:1'), title: 'Harbor Freight site visit', description: MARK, event_date: day(1), event_time: '10:00', duration_minutes: 90, event_type: 'meeting', user_id: U.sales, prospect_id: id('prospect:harbor-freight-lines'), source: 'app' },
    { id: id('event:2'), title: 'Call Keystone re: estimate', description: MARK, event_date: day(0), event_time: '14:30', duration_minutes: 30, event_type: 'call', user_id: U.sales, prospect_id: id('prospect:keystone-elevator'), source: 'app' },
    { id: id('event:3'), title: 'Summit Roofing install — USDOT lettering', description: MARK, event_date: day(3), event_time: '08:00', duration_minutes: 240, event_type: 'other', user_id: U.graphics_production, source: 'app', linked_graphics_job_id: id('graphics_job:9') },
    { id: id('event:4'), title: 'Estimate EST-2609-005 expires', description: MARK, event_date: day(16), event_type: 'deadline', user_id: U.sales, source: 'app' },
    { id: id('event:5'), title: 'Weekly shop huddle', description: MARK, event_date: day(2), event_time: '07:30', duration_minutes: 30, event_type: 'meeting', user_id: U.admin, source: 'app', completed_at: null },
  ]);
  await upsert('calendar_event_notes', [{ id: id('event_note:3'), event_id: id('event:3'), note: `@${NAMES.shop_tech} bring the lift. ${MARK}`, created_by: U.graphics_production, created_by_name: NAMES.graphics_production }]);

  await upsert('knowledge_docs', [
    { id: id('kb:shelving-sop'), title: 'SOP — Masterack shelving install', category: 'sop', content: `1. Verify part vs. SO line. 2. Floor mount with supplied hardware. 3. Torque to 25 ft-lb. ${MARK}`, tags: ['upfit', 'masterack'], uploaded_by: U.admin },
    { id: id('kb:wrap-prep'), title: 'Wrap surface prep checklist', category: 'graphics', content: `Wash, clay bar, IPA wipe, 70°F minimum shop temp. ${MARK}`, tags: ['graphics', 'wrap'], uploaded_by: U.graphics_production },
    { id: id('kb:cni-photos'), title: 'CNI photo requirements', category: 'cni', content: `Four photos per VIN: front, back, both sides, VIN plate when device install. ${MARK}`, tags: ['cni'], uploaded_by: U.admin },
  ]);

  // Internal DM between sales and shop tech (participant_1 < participant_2)
  const [p1, p2] = [U.sales, U.shop_tech].sort();
  await upsert('conversations', [{ id: id('conversation:sales-shop'), participant_1: p1, participant_2: p2, last_message_at: at(0, 9) }], 'participant_1,participant_2');
  await upsert('messages', [
    { id: id('message:1'), conversation_id: id('conversation:sales-shop'), sender_id: U.sales, body: 'Is the Gateway van ready for pickup tomorrow?', read_at: at(0, 8.5), created_at: at(0, 8) },
    { id: id('message:2'), conversation_id: id('conversation:sales-shop'), sender_id: U.shop_tech, body: 'QC done, just waiting on the partition bolts.', read_at: null, created_at: at(0, 9) },
  ]);

  // Customer thread (SMS) — trigger bumps the thread on message insert
  const acmeContact = id('external_contact:acme-fleet:primary');
  await upsert('customer_threads', [{ id: id('thread:acme:1'), external_contact_id: acmeContact, customer_id: id('customer:acme-fleet'), context_entity_type: 'fleet_checkin', context_entity_id: CHECKINS[0].id, status: 'open', assigned_to: U.sales, subject: 'Transit check-in — ETA?', created_by: U.sales, last_message_at: at(-1) }]);
  await upsert('customer_messages', [
    { id: id('customer_message:acme:1'), thread_id: id('thread:acme:1'), direction: 'outbound', channel: 'sms', body: 'Hi — your Transit is checked in. We will text when it is ready.', sent_by: U.sales, sent_at: at(-1, 9), delivery_status: 'delivered', provider_name: 'dialpad' },
    { id: id('customer_message:acme:2'), thread_id: id('thread:acme:1'), direction: 'inbound', channel: 'sms', body: 'Great, any chance it is done by Friday?', sent_at: at(-1, 11), delivery_status: 'received', provider_name: 'dialpad', read_at: null },
  ]);
  await upsert('phone_call_events', [
    { id: id('call:1'), provider: 'dialpad', provider_call_id: 'sandbox-call-1', direction: 'inbound', state: 'hangup', from_number: '+13145550500', to_number: '+16365550100', external_digits: '3145550500', matched_prospect_id: id('prospect:harbor-freight-lines'), target_user_id: U.sales, started_at: at(-1, 13), ended_at: at(-1, 13.2), duration_seconds: 420, logged_activity_id: null, raw: { seed: MARK } },
    { id: id('call:2'), provider: 'dialpad', provider_call_id: 'sandbox-call-2', direction: 'outbound', state: 'hangup', from_number: '+16365550100', to_number: '+13145550501', external_digits: '3145550501', matched_prospect_id: id('prospect:keystone-elevator'), target_user_id: U.sales, started_at: at(-2, 15), ended_at: at(-2, 15.1), duration_seconds: 180, raw: { seed: MARK } },
  ], 'provider,provider_call_id');

  await upsert('email_log', [
    { id: id('email_log:1'), source_id: 'sandbox-resend-1', kind: 'estimate_approval', recipients: ['ap@riverbendelectric.example'], subject: 'Estimate EST-2609-004 for your approval', sent_by: U.sales, context_url: `/estimates?id=${id('estimate:4')}`, delivery_status: 'delivered', delivery_updated_at: at(-6), customer_id: id('customer:riverbend-electric'), created_at: at(-7) },
    { id: id('email_log:2'), source_id: 'sandbox-resend-2', kind: 'invoice', recipients: ['ap@acmefleet.example'], subject: 'Invoice INV62008 from BMG Fleet', sent_by: U.finance, delivery_status: 'bounced', delivery_detail: 'Mailbox full', delivery_updated_at: at(-2), customer_id: id('customer:acme-fleet'), created_at: at(-2) },
    { id: id('email_log:3'), source_id: 'sandbox-resend-3', kind: 'proof_approval', recipients: ['fleet@gatewayplumbing.example'], subject: 'Proof round 2 — Gateway van lettering', sent_by: U.graphics_production, context_url: `/graphics/${id('graphics_job:4')}`, delivery_status: 'sent', customer_id: id('customer:gateway-plumbing'), created_at: at(-1) },
  ]);
  await upsert('invoice_emails', [
    { id: id('invoice_email:1'), invoice_number: 'INV62008', netsuite_invoice_id: '62008', customer_name: 'Acme Fleet Services', recipients: ['ap@acmefleet.example'], sent_by: U.finance, sent_at: at(-2), source: 'app', source_id: 'sandbox-resend-2', delivery_status: 'bounced', delivery_detail: 'Mailbox full', delivery_updated_at: at(-2) },
    { id: id('invoice_email:2'), invoice_number: 'INV62009', netsuite_invoice_id: '62009', customer_name: 'Gateway Plumbing & Heating', recipients: ['ap@gatewayplumbing.example'], sent_by: U.finance, sent_at: at(-3), source: 'app', source_id: 'sandbox-resend-4', delivery_status: 'delivered', delivery_updated_at: at(-3) },
  ]);

  await upsert('note_mentions', [
    { id: id('mention:1'), mentioned_user_id: U.admin, mentioned_by: U.shop_tech, source_type: 'vehicle_note', source_id: id('vehicle_note:18:2'), context_label: 'Stuck vehicle — parts', context_url: `/tracking?vehicle=${id('checkin:18')}&note=${id('vehicle_note:18:2')}`, note_excerpt: 'blocked — see status', read_at: null },
    { id: id('mention:2'), mentioned_user_id: U.shop_tech, mentioned_by: U.graphics_production, source_type: 'graphics_note', source_id: id('event_note:3'), context_label: 'Summit Roofing install', context_url: `/admin/schedule?card=${id('event:3')}&note=${id('event_note:3')}`, note_excerpt: 'bring the lift', read_at: at(0, 8) },
  ]);
  // notifications predates migrations/: user_id/type/title/body/url are exactly what
  // notify() writes (src/lib/notify.ts:219-225; it lets the DB default id); id is
  // evidenced by the mark-read paths (src/components/OpsDashboard.tsx:712 .in('id', ids))
  // and read_at by migration 000-06. Kept soft — a mismatch is non-fatal.
  await softUpsert('notifications', [
    { id: id('notification:1'), user_id: U.admin, type: 'stuck_vehicle', title: 'Vehicle stuck on parts 3+ days', body: `${CHECKINS[18].vehicle_year} ${CHECKINS[18].vehicle_make} ${CHECKINS[18].vehicle_model} — ${CHECKINS[18].customer_name}`, url: `/tracking?vehicle=${id('checkin:18')}`, read_at: null },
    { id: id('notification:2'), user_id: U.sales, type: 'quote_viewed', title: 'Estimate EST-2609-004 was opened', body: 'Riverbend Electric Co. viewed the approval page.', url: `/estimates?id=${id('estimate:4')}`, read_at: null },
    { id: id('notification:3'), user_id: U.graphics_production, type: 'proof_rejected', title: 'Proof rejected — Gateway van lettering', body: 'Logo too small on rear doors.', url: `/graphics/${id('graphics_job:4')}`, read_at: at(-1) },
    { id: id('notification:4'), user_id: U.installer, type: 'cni_assigned', title: 'You were assigned CNI-9003', body: 'Ozark Water — 2 partial wraps (Branson)', url: `/admin/cni/jobs/${id('cni_job:3')}`, read_at: null },
    { id: id('notification:5'), user_id: U.finance, type: 'ap_submitted', title: 'Installer invoice MWI-2001 submitted', body: 'Midwest Wrap Installers LLC — awaiting approval', url: `/admin/ap?invoice=${id('vendor_invoice:1')}`, read_at: null },
  ]);
  await upsert('ai_chat_history', [
    { id: id('ai_chat:1'), user_id: U.admin, role: 'user', content: 'Which vehicles are overdue on promised-back date?', created_at: at(-1, 8) },
    { id: id('ai_chat:2'), user_id: U.admin, role: 'assistant', content: `Several In-Shop vehicles are past their promised-back date — open the In-Shop board sorted by Promised Back. ${MARK}`, created_at: at(-1, 8.01) },
  ]);
  await softUpsert('audit_log', [{ id: id('audit:seed'), actor_id: U.super_admin, table_name: 'seed', record_id: null, action: 'seed_sandbox', detail: { marker: MARK, ref: REF }, created_at: at(0) }]);
  await upsert('month_close_gate_signoffs', [{ id: id('close_signoff:last:ar'), period: day(-35).slice(0, 7), gate_key: 'ar_reconciled', kind: 'acknowledged', note: MARK, signed_by: U.finance, signed_by_name: NAMES.finance }], 'period,gate_key');
}

// ═════════════════════════════ 13. cron + metric history ═════════════════════════════
const METRICS = { ar_total: 148000, ar_current: 80000, ar_1_30: 38000, ar_31_60: 18000, ar_61_90: 8000, ar_90_plus: 4000, cash: 212000, ap_total: 61000,
  open_quotes_count: 9, open_quotes_value: 74000, pipeline_deals: 11, pipeline_value: 240000, so_order_book_count: 34, so_order_book_value: 188000, so_unbilled_value: 92000,
  vehicles_in_shop: 25, vehicles_complete_not_shipped: 5, revenue_mtd: 96000 };

async function seedMetrics() {
  const rows = []; const ar = [];
  for (let d = 30; d >= 0; d--) {
    const dayStr = day(-d);
    for (const [metric, base] of Object.entries(METRICS)) {
      const drift = 1 + (rnd(`${metric}:${dayStr}`) - 0.5) * 0.12 + (30 - d) * 0.004;
      const value = metric.endsWith('_count') || metric === 'pipeline_deals' || metric.startsWith('vehicles') ? Math.round(base * drift) : money(base * drift);
      rows.push({ id: id(`metric:${metric}:${dayStr}`), metric, day: dayStr, value, meta: d === 0 ? { seed: MARK } : null });
    }
    const total = rows.find((r) => r.metric === 'ar_total' && r.day === dayStr).value;
    ar.push({ id: id(`ar:total:${dayStr}`), day: dayStr, scope: 'total', key: 'total', label: null, value: total });
    for (const [key, share] of [['current', 0.54], ['d1_30', 0.26], ['d31_60', 0.12], ['d61_90', 0.05], ['d90plus', 0.03]]) ar.push({ id: id(`ar:bucket:${key}:${dayStr}`), day: dayStr, scope: 'bucket', key, label: null, value: money(total * share) });
    for (const c of CUSTOMERS.slice(0, 5)) ar.push({ id: id(`ar:customer:${c.slug}:${dayStr}`), day: dayStr, scope: 'customer', key: `e:${c.netsuite_id}`, label: c.company_name, value: money(total * (0.05 + rnd(`arc:${c.slug}`) * 0.15)) });
  }
  await upsert('metric_snapshots', rows, 'metric,day');
  await upsert('ar_snapshots', ar, 'day,scope,key');
  await upsert('ar_sync_runs', [0, 1, 2].map((d) => ({ id: id(`ar_run:${d}`), run_at: at(-d, 2), source: 'cron', checked_invoices: 40 + d, paid_invoices: 3, fleet_checkins_updated: 2, scan_logs_updated: 1 })));

  const syncTypes = ['netsuite_customers', 'netsuite_contacts', 'netsuite_parts', 'netsuite_inventory', 'netsuite_sales_orders', 'netsuite_vendor_pos', 'gmail_auto_import', 'parts_email_scan', 'health_check', 'metric_snapshots', 'stuck_vehicle_check', 'promised_back_check', 'quote_followup_check', 'reorder_check', 'cni_sweep', 'google_calendar_pull'];
  await upsert('sync_state', syncTypes.map((t, i) => ({ sync_type: t, last_synced_at: at(0, Math.max(0, NOW.getUTCHours() - (i % 4))), last_result: { ok: true, records: 10 + i, seed: MARK } })), 'sync_type');
  const cronRows = [];
  syncTypes.forEach((t, i) => { for (let d = 0; d < 3; d++) cronRows.push({ id: id(`cron_run:${t}:${d}`), sync_type: t, started_at: at(-d, 3), finished_at: at(-d, 3.05), duration_ms: 1200 + i * 90, outcome: t === 'gmail_auto_import' && d === 1 ? 'error' : 'ok', records: 10 + i, error: t === 'gmail_auto_import' && d === 1 ? 'Gmail token refresh failed (sandbox)' : null }); });
  await upsert('cron_runs', cronRows);
}

// ═════════════════════════════ main ═════════════════════════════
async function main() {
  console.log(`\nFleetSuite sandbox seed → project ref ${REF}${DRY_RUN ? '  (DRY RUN — no writes)' : ''}\n`);
  const groups = [
    ['users + profiles + companies', seedUsers],
    ['customers + contacts', seedCustomers],
    ['prospects (CRM)', seedProspects],
    ['parts catalog + kits', seedParts],
    ['materials + wrap settings + templates', seedMaterials],
    ['estimates + wrap quotes', seedEstimates],
    ['graphics jobs', seedGraphicsJobs],
    ['fleet check-ins (In-Shop)', seedCheckins],
    ['NetSuite mirrors + purchasing', seedNetSuiteMirrors],
    ['upfit projects', seedUpfitProjects],
    ['CNI network jobs', seedCni],
    ['field scans + installer invoices', seedScans],
    ['comms, schedule, knowledge, notifications', seedCommsAndMisc],
    ['cron + metric history', seedMetrics],
  ];
  for (const [name, fn] of groups) await group(name, fn);

  console.log(`\n${DRY_RUN ? 'Plan' : 'Summary'} (rows per table):`);
  const width = Math.max(...Object.keys(summary).map((k) => k.length));
  for (const [table, count] of Object.entries(summary).sort(([a], [b]) => a.localeCompare(b))) console.log(`  ${table.padEnd(width)}  ${count}`);
  console.log(`  ${'TOTAL'.padEnd(width)}  ${Object.values(summary).reduce((a, b) => a + b, 0)}`);
  warnings.push('customers / companies / profiles / notifications predate migrations/: their base columns were taken from app code (src/app/api/cron/netsuite-sync/route.ts, src/lib/promote-prospect.ts, src/app/api/admin/create-user/route.ts, migration 045 handle_new_user, migration 122, src/lib/notify.ts), not the schema map — those four tables are upserted softly so a base-column mismatch is reported per table');
  if (warnings.length) { console.log('\nWarnings:'); for (const w of warnings) console.log(`  ! ${w}`); }
  if (!DRY_RUN) {
    console.log('\nLogins (all share one password):');
    for (const [key, role] of USER_SPECS) console.log(`  ${`${key}@${EMAIL_DOMAIN}`.padEnd(48)} role=${role}`);
    console.log(`  password: ${PASSWORD}`);
  }
  if (failures.length) {
    console.log(`\n${failures.length} group(s) FAILED:`);
    for (const f of failures) console.log(`  ✖ ${f.group} → ${f.message}`);
    process.exit(1);
  }
  console.log('\nDone.');
}

main().catch((err) => { console.error('Fatal:', err); process.exit(1); });
