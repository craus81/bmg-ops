# Sandbox setup — a FleetSuite you can break

A second copy of FleetSuite, on its own database, filled with believable
fake data, wired to **nothing real**. Its job is to be used hard: run a
vehicle from check-in to invoice, receive a PO short, reject an estimate,
close a CNI job — and find out where the software gets in the way, without
mailing a customer or creating a sales order in NetSuite.

Every step below is one-time except the last. Budget about 30 minutes.

> **The one rule.** The sandbox never carries a production secret. Not the
> production database URL, not a NetSuite token, not the Resend key. The
> seed script refuses to run unless you confirm the sandbox's own project
> ref, and the app's Connections tab will show every integration as *off* —
> that is the state you want.

---

## 1. Create the Supabase project (5 min)

In the Supabase dashboard, **New project** → name it `fleetsuite-sandbox`.
The free tier is fine; region doesn't matter. When it finishes provisioning,
collect three things from **Settings**:

| Where | What | Used by |
|---|---|---|
| Settings → API → Project URL | `https://<ref>.supabase.co` | app + seed |
| Settings → API → `service_role` key | secret key | app + seed |
| Settings → API → `anon` key | public key | app |
| Settings → Database → Connection string (URI, *Session pooler*) | Postgres URL | migrations only |

`<ref>` is the short id in the project URL. You'll type it once more as a
confirmation.

## 2. Apply the schema (5 min, from your own machine)

The migration runner talks to Postgres directly (port 5432/6543). A Claude
session container can't reach that port, so this step runs from a machine
that can — your laptop with the repo checked out is fine.

```bash
# See what would run. A fresh sandbox lists every file (~330); production lists 0.
SUPABASE_DB_URL='<sandbox session-pooler URI>' npm run migrate -- --dry-run

# Apply.
SUPABASE_DB_URL='<sandbox session-pooler URI>' npm run migrate
```

The inline `SUPABASE_DB_URL=` wins over anything in your `.env.local` —
the runner loads that file but never overrides a variable already set in
the environment. If the dry run says **0 pending**, you are pointed at a
database that's already migrated (almost certainly production). Stop and
check the URL.

Do **not** pass `--deploy`. That flag is the Vercel build hook and is a
deliberate no-op anywhere but a production build.

## 3. Seed it (2 min, from anywhere that can reach the sandbox)

The seed works over HTTPS using the service-role key, so it can run from
your machine, or from a Claude session once step 5 is done.

```bash
export NEXT_PUBLIC_SUPABASE_URL='https://<ref>.supabase.co'
export SUPABASE_SERVICE_ROLE_KEY='<sandbox service_role key>'
export SEED_SANDBOX_CONFIRM='<ref>'        # must equal the ref in the URL

node scripts/seed-sandbox.mjs --dry-run    # prints the plan, touches nothing
node scripts/seed-sandbox.mjs              # seeds
```

What it creates: one login per role (super admin, admin, sales, graphics
production, shop tech, field tech, installer, finance, executive, customer), ~20
customers, ~40 vehicles spread across every stage, purchase orders in every
receiving state, estimates and wrap quotes in every status, prospects and
opportunities, CNI companies/installers/jobs, graphics jobs, materials, and
30 days of metric snapshots so the trend charts draw. It prints the
accounts and their shared password at the end.

It is **idempotent** — every row has a deterministic id and is upserted, so
re-running refreshes the data instead of duplicating it. Every seeded
record carries a `[sandbox seed]` marker where there's a notes field.

The confirm gate is the safety: without `SEED_SANDBOX_CONFIRM` matching the
project ref in the URL, it exits before opening a connection.

## 4. Point the app at it (3 min)

Set **only** the platform variables. Leave every integration key unset.

```bash
NEXT_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<sandbox anon key>
SUPABASE_SERVICE_ROLE_KEY=<sandbox service_role key>
CRON_SECRET=sandbox-anything            # any string; lets you hit crons by hand
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

Do **not** set: `NETSUITE_*`, `RESEND_*`, `GOOGLE_*`, `ANTHROPIC_API_KEY`,
`DROPBOX_*`, `PAYCHEX_*`, `APNS_*`, `DIALPAD_*`, `HEALTH_PING_URL`, or
`SUPABASE_DB_URL` (the app doesn't need it; only the migration step does).

With those absent, every outbound path in the app degrades to "not
configured" rather than firing — the invoice tile says *NetSuite
unavailable*, sends are refused, syncs skip. Confirm on
**/admin/system-health → Connections**: each group should read *off*.
That page is the proof the sandbox can't touch the real world.

Then `npm run dev` and sign in with any of the seeded accounts.

## 5. Let a Claude session reach it (2 min, one setting)

The session environment's network policy decides what a container can
reach. Add one host on port 443:

```
<ref>.supabase.co
```

That's the setting chosen when the environment was created — see
[Claude Code on the web: environments](https://code.claude.com/docs/en/claude-code-on-the-web).
Nothing else needs opening: the app talks to Supabase over HTTPS, and
Chromium and Playwright are already in the container.

A session can then run `npm run dev` against the sandbox with the env from
step 4 and drive the real UI — signing in as a service writer, walking a
job through the shop, and reporting where it got stuck.

## 6. Resetting

- **Refresh the data:** re-run the seed (step 3). Upserts put every seeded
  row back to its starting state; rows you created by hand stay unless they
  collide with a seeded id.
- **Start completely clean:** delete the project in the Supabase dashboard
  and repeat from step 1. Ten minutes.

## What the sandbox is not

It is not a staging environment for the production database, and it is
not a place to test migrations before they ship — migrations auto-apply on
the production deploy and are written idempotent for that reason (see
`CLAUDE.md`). It is a place to use the software as a person would, on data
that doesn't matter, and write down what happened.
