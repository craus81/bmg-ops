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
   - Cut a branch at the current `main` HEAD: `claude/<short-topic>`
     (naming convention is flexible — the user doesn't care, just keep
     it short and descriptive).
   - Push it: `git push -u origin claude/<short-topic>`.
   - Open a PR against `main` via the GitHub MCP
     (`mcp__github__create_pull_request`) with a summary of the batched
     commits.
4. **Don't reset local `main` after cutting the branch.** Next batch
   keeps going from the same HEAD. Subsequent PRs will include prior
   unmerged commits until those PRs are merged in order — that's a
   known tradeoff of this workflow.

Never push to `main` directly. Never force-push. Never reset local main
to discard committed work without explicit user confirmation.

## Backlog (user-approved June 2026, not yet started)

From the FleetSuite improvement review:

- **Tests for money-handling code**: characterization tests for
  `src/lib/netsuite.ts`, `computeTotals` in
  `src/app/api/estimates/route.ts`, `src/lib/parsePO.ts`,
  `src/lib/nesting-algorithm.ts`, and `src/lib/vin-decoder.ts`.
