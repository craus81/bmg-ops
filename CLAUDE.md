# Project instructions

## Git workflow

Pushes to `main` are currently broken (the local git proxy returns
HTTP 403). Do not attempt to push to `main` — it will fail and waste
retries. The stop hook will keep complaining that local main is ahead
of `origin/main`; that's expected and can be ignored.

Instead, use a branch-per-feature workflow with auto-opened PRs:

1. **Batch commits on local `main`** as you work. Multiple commits per
   batch is fine — that's the point.
2. **Wait for the user to say "create the branch"** (or equivalent —
   "open the PR", "ship it", etc.) before cutting a branch. Don't cut
   one automatically after every commit.
3. **When the user signals**:
   - Pick a short topic name based on the batched commits.
   - Cut a **brand-new** branch at the current `main` HEAD:
     `claude/<short-topic>` (naming convention is flexible — the user
     doesn't care, just keep it short and descriptive).
   - Push it: `git push -u origin claude/<short-topic>`.
   - Open a PR against `main` via the GitHub MCP
     (`mcp__github__create_pull_request`) with a summary of the batched
     commits.
   - Always subscribe to the new PR's activity
     (`mcp__github__subscribe_pr_activity`) and respond to review
     comments / fix CI failures as events arrive — no need to ask.
4. **One fresh branch per PR — never reuse a branch across PRs.** PRs are
   squash-merged, so a reused branch still carries its old individual
   commits and collides with `main`'s squashed version on the next PR (a
   guaranteed merge conflict). Every signal gets a new `claude/<topic>`.
5. **After a PR merges, resync local `main` to the remote** before the
   next batch: `git fetch origin main` then fast-forward
   (`git checkout main && git merge --ff-only origin/main`). If you
   batched on local `main` and it won't fast-forward, reset it
   (`git reset --hard origin/main`) — that's safe here, the work lives on
   in the squash. The next branch is cut from the merged HEAD, so it
   contains only its own changes and stays conflict-free.

Never push to `main` directly. Never force-push. Don't reset local `main`
to discard *unmerged* work without explicit user confirmation — resyncing
to `origin/main` after the matching PR has merged (step 5) is expected.
