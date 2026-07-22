# Project instructions

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
4. **One fresh branch per PR — never reuse a branch across PRs.** PRs are
   squash-merged, so a reused branch still carries its old individual
   commits and collides with `main`'s squashed version on the next PR (a
   guaranteed merge conflict). Every change gets a new `claude/<topic>`.
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

- **Supabase reads silently cap at 1000 rows** (PostgREST default —
  `.limit(N > 1000)` does NOT raise it). Any read of a table that can
  grow unboundedly (netsuite_parts, scan_logs, po/invoice line items,
  credits, emails, …) must paginate: use `fetchAllRows` from
  `src/lib/fetch-all.ts`, and give the query a deterministic order with
  a unique tiebreaker (e.g. `.order('item_number').order('id')`). This
  has caused repeated field bugs ("part not in catalog", stale
  inventory, inflated waiting-on-PO counts).

- **CNI installer payouts → NetSuite vendor bills:** see
  `docs/cni-vendor-bills.md`. Key trap: an installer's
  `cni_profiles.netsuite_vendor_id` must be the vendor's numeric NetSuite
  **Internal ID**, not the **Entity ID**/name — a name 500s the bill create.
  The doc also covers the required bill fields (subsidiary 2, account 223,
  header-only location, reference no.) and the SuiteQL/role limitations.
