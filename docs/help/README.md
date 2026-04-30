# BMG Fleet Help Center

This is the in-app help library for BMG Fleet (the FleetSuite admin app and the
Fleet GO crew app — same codebase, different surface depending on your role).
It's the source of truth for "how do I…" answers and is also seeded into the
in-app knowledge base so the FleetSuite AI assistant and the search box at
**Admin → Knowledge** can find these articles.

## Who should read what

- **Admins / owners** → start with `admin.md`, then any workflow doc that
  touches your day.
- **Sales reps** → `sales.md` covers estimates, prospects, customer
  setup, and the sales-pipeline widgets.
- **Graphics production** → `graphics-production.md` covers the graphics
  queue, proof approvals, shipping, and invoicing graphics jobs.
- **Installers / shop techs / field techs** → `installer.md` and
  `shop-and-field-tech.md` cover check-in, the pick-list, the completion
  ceremony, and the CNI program.
- **Customers** → `customer.md` covers the customer dashboard and the
  magic-link estimate / proof approval pages.

If you don't know which role you are, look at the header in the app: it says
**FleetSuite** + "Admin" if you're an admin, and **Fleet GO** + "Crew" if
you're not.

## How the docs are organized

Each role doc is task-oriented. Headings are written in the form
**"How do I …?"** so they map cleanly to questions the FleetSuite AI gets
asked and to the Admin → Knowledge search.

Cross-role workflows (graphics → install handoff, magic-link approvals,
estimate → invoice, install completion) live in `workflows/` because they
touch multiple roles in sequence.

The `glossary.md` file defines terms used across the docs (VIN, PO, SO,
proof, upfit, CNI, etc.).

## Where this content lives

- **Markdown source** — `docs/help/` in the `craus81/bmg-ops` repo. Edit
  here.
- **In-app knowledge base** — `knowledge_docs` table in Supabase, category
  `help`. Synced from the markdown files via
  `scripts/sync-help-docs.ts`. Run that script after editing.
- **Admin → Knowledge UI** — the `help` category is filterable from the
  search box; help articles are read-only there. Edit the markdown
  source instead.
- **FleetSuite AI** — the AI assistant searches `knowledge_docs` via
  `/api/ai-agent/chat`. Help articles show up automatically once synced.

## Editing rules of thumb

- One H1 per file (the title); use H2 for "How do I…" tasks; H3 for steps
  within a task.
- Reference real route paths so people can copy-paste them
  (e.g. `/admin/install-checklists`).
- Reference real button labels in **bold** so search keyword matches work
  (e.g. **Send for Approval**).
- When a task has prerequisites or required permissions, call them out in
  a short list at the top of the section.
- Don't duplicate procedure across role docs — link to a workflow file
  in `workflows/` instead.

## Re-seeding the knowledge base

After editing any markdown file:

```
node scripts/sync-help-docs.mjs
```

That script truncates the `help` category in `knowledge_docs` and re-inserts
one row per markdown file. Title is the H1, content is the full markdown
source, tags include `help`, the file basename, and any role keywords from
the path. It needs `NEXT_PUBLIC_SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` in the environment (auto-loaded from
`.env.local`).

Use `node scripts/sync-help-docs.mjs --dry-run` to preview parsed titles
and tags without touching the database.
