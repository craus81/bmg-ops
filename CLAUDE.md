# Project instructions

## Typecheck before every push — the right way

`npx tsc --noEmit` here can lie twice, and it shipped a type error that
blocked production deploys (the #568 build): tsconfig has
`"incremental": true`, so a stale `tsconfig.tsbuildinfo` hides brand-new
errors — delete it first (`rm -f tsconfig.tsbuildinfo`). And never pipe
the command (`tsc | tail`): the pipeline's exit code is the pipe's, not
tsc's, so failures read as exit 0. Capture output to a file and check
tsc's own exit code. The authoritative check is `npx next build` (its
"checking validity of types" phase) — exactly what the Vercel build runs.

One container gotcha: in a session box with no Supabase env vars,
`next build`'s later "Collecting page data" phase flakes
NONDETERMINISTICALLY — ~121 routes create module-scope Supabase clients,
each throws "supabaseUrl is required" when evaluated, and Next's retries
usually (not always) swallow it, so the same tree can build green one run
and exit 1 the next on a route the diff never touched. Don't chase these
as real failures and don't call them a reason to skip the build: run it
with placeholder env and it's deterministic —
`NEXT_PUBLIC_SUPABASE_URL="https://placeholder.supabase.co"
NEXT_PUBLIC_SUPABASE_ANON_KEY="x" SUPABASE_SERVICE_ROLE_KEY="x" npx next
build`. The types phase (the part #568 was about) is unaffected either way.

## Git workflow

Pushes to `main` are currently broken (the local git proxy returns
HTTP 403). Do not attempt to push to `main` — it will fail and waste
retries.

**Default: ship every change as its own PR — don't batch, and don't wait
to be asked.** As soon as a change is complete and verified, cut a
branch, push, and open the PR. (The user will say when they want to go
back to batching — see the bottom of this section.)

Per change:

1. **Work on a feature branch, never on local `main`.** Cut a brand-new
   branch from a synced `main` HEAD *before* you commit:
   `git checkout main && git checkout -b claude/<short-topic>` (keep the
   topic short and descriptive; naming is flexible). Commit your work on
   that branch. Keeping commits off local `main` is also what keeps the
   stop hook quiet — see the note below.
2. **Push immediately** after committing: `git push -u origin
   claude/<short-topic>`. Never end a turn with unpushed commits.
3. **Open a PR** against `main` via the GitHub MCP
   (`mcp__github__create_pull_request`) summarizing the change, and
   **always subscribe** (`mcp__github__subscribe_pr_activity`) — respond
   to review comments / fix CI failures as events arrive, no need to ask.
4. **One fresh branch per PR.** GitHub auto-deletes head branches when
   their PR merges ("Automatically delete head branches" is ON, enabled
   2026-08-13), so after a merge the same branch name is free again —
   the next push creates a brand-new branch from your synced `main`,
   which is exactly the fresh-branch-per-PR this rule wants. Sessions
   pinned to one `claude/<name>` branch can simply recreate it after
   each merge: `git checkout -B claude/<name> origin/main`. Escape
   hatch, only if a merged branch still exists on the remote (it
   predates auto-delete, or deletion was skipped): do NOT force-push
   over it or delete it from a session — repo rules reject force-pushes
   (GH013) and the session git proxy 403s deletions. Instead cut your
   branch from `origin/main`, `git merge` the stale remote branch into
   it (its content is identical to the squash already on `main`, so it
   merges clean), and push — the push fast-forwards and the PR diff
   stays exactly your new change.
5. **After a PR merges, resync local `main` to the remote** before the
   next change: `git fetch origin main` then `git checkout main && git
   merge --ff-only origin/main` (or `git reset --hard origin/main` if it
   won't fast-forward — safe here, the work lives on in the squash). Cut
   the next branch from this merged HEAD so it stays conflict-free.

Never push to `main` directly. Never force-push. Don't reset local `main`
to discard *unmerged* work without explicit user confirmation — resyncing
to `origin/main` after the matching PR has merged (step 5) is expected.

**Stop-hook "Unverified" nag.** The commits ARE signed and use
`noreply@anthropic.com`, and they show as Verified once squash-merged on
GitHub. The local stop hook flags them anyway because this container has
no `ssh-keygen` and no readable signing public key, so git's `%G?` can't
verify the SSH signature and returns `N` — which the hook treats as
"unsigned." Nothing is wrong, and `git commit --amend --reset-author`
will NOT help (it re-signs with the same locally-unverifiable key). The
hook only fires for commits sitting *ahead of their upstream*, so the
branch-first flow above (commit on a branch, push right away, keep local
`main` synced) avoids it. If the nag still appears in the brief window
before a push, ignore it.

**If the user asks to batch** (e.g. "start batching", "hold these"):
accumulate commits on local `main` and wait for a "ship it" / "create the
branch" signal before cutting the branch + PR. Stay in batch mode until
they tell you to go back to auto-shipping.

## Domain notes

- **Text size (Regular/Large/XL) scales the app via CSS `zoom` — never
  write a bare vh/vw in an inline style.** The setting lives on the More
  page and Settings (component `TextSizeToggle`), persists per-device in
  localStorage (`bmg-text-size`), and is stamped as `data-textsize` on
  `<html>` (pre-paint script in `src/app/layout.tsx` + `ThemeProvider`);
  globals.css applies matching `zoom` on `<body>`. Because zoom also
  multiplies viewport units, a plain `maxHeight: '90vh'` renders at 117%
  of the screen at XL — write `calc(90vh / var(--ts))` instead (`--ts`
  mirrors the zoom factor; the division makes it exact at every size and
  a no-op at Regular). JS that mixes real viewport px (clientX,
  window.innerWidth/innerHeight) with CSS px inside the zoomed page must
  divide the real px by `getTextZoom()` from `src/lib/text-size.ts` —
  see the AiChat drag handling. CSS media queries see real px and are
  unaffected.

- **Deep links are mandatory on every notification.** Anything that lands
  in "New for you", the bell, the Mentions inbox, a push, or an email CTA
  (`notify`/`notifyMany` `url`, `reportMentions` `contextUrl`,
  `buildNotificationEmail` cta) must link to the EXACT record it
  references — never a bare list page while a record id is in scope, and
  never no url at all (that's a dead click). Build every URL from
  `src/lib/deep-links.ts` — one canonical builder per entity — so
  producers and destination pages can't drift. True digests (many records,
  no single id) may link to the list; a digest of ONE record links to the
  record. When adding a new page or notification: add its builder to
  deep-links.ts, make the destination page actually handle the params the
  builder emits (open the record's modal, scroll to it, `flashNote` it),
  and pass the built url at the call site. This came from a field bug
  ("New for you" clicks going to the page, or nowhere).

- **Every customer/vendor email goes through the standard compose
  screen** — see `docs/customer-email-standard.md`. Any feature where
  staff email someone outside the company must open
  `src/components/EmailComposeModal.tsx` (editable multi-recipient To,
  Bcc-me, personal message, attachments with size cap, live server
  preview), with the API accepting `emails[]`/`bccSelf`/`message`/
  `preview` and setting Reply-To to the sender. No bare send buttons, no
  `dialog.prompt` recipients. Update the doc's flow table when adding a
  flow.

- **Supabase reads silently cap at 1000 rows** (PostgREST default —
  `.limit(N > 1000)` does NOT raise it). Any read of a table that can
  grow unboundedly (netsuite_parts, scan_logs, po/invoice line items,
  credits, emails, …) must paginate: use `fetchAllRows` from
  `src/lib/fetch-all.ts`, and give the query a deterministic order with
  a unique tiebreaker (e.g. `.order('item_number').order('id')`). This
  has caused repeated field bugs ("part not in catalog", stale
  inventory, inflated waiting-on-PO counts).

- **Invoicing a sales order fulfills it first** — see
  `docs/netsuite-fulfill-and-invoice.md`. This account runs Advanced
  Shipping, so NetSuite's SO→Invoice transform carries ONLY non-fulfillable
  lines (labor, freight); parts need an Item Fulfillment first, which
  **relieves inventory and posts COGS**. Never fulfill a sales order twice:
  `/api/vehicle-tracking/invoice` re-reads NetSuite's own `ItemShip` records
  and holds the `UNIQUE(netsuite_so_id)` claim in `netsuite_so_fulfillments`
  (migration 242) before creating one, and a failed fulfillment never falls
  through to invoicing.

- **CNI installer payouts → NetSuite vendor bills:** see
  `docs/cni-vendor-bills.md`. Key trap: an installer's
  `cni_profiles.netsuite_vendor_id` must be the vendor's numeric NetSuite
  **Internal ID**, not the **Entity ID**/name — a name 500s the bill create.
  The doc also covers the required bill fields (subsidiary 2, account 223,
  header-only location, reference no.) and the SuiteQL/role limitations.
