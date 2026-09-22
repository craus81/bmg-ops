# Future features — deferred, with trigger conditions

A standing home for work that was investigated, costed, and then **deliberately
not built yet**. Distinct from `fleetsuite-roadmap.md` (a specific working
session's notes) and `feature-audit-2026-09.md` (what exists today).

Every entry carries: what it is, **why it's deferred**, **what would un-defer
it** (a concrete trigger, not "when we have time"), what already shipped from
it, and the open questions. Nothing here is a commitment to build.

Append new entries at the bottom. When an entry ships, move it out — don't
leave it here marked done.

---

## F1 — Foldable / iPhone Duo layout

**Deferred 2026-09-10.** Full analysis: `docs/foldable-duo-layout-spec.md`
(shipped in #892). This entry records the decision and the demo-specific
reframing that came after the spec was written.

### Why it's deferred

Exactly one person at BMG will have a Duo (the owner), and the purpose is
**demoing the app to prospective clients** — not daily fleet work. That
changes the economics: this is a sales-surface polish project for an audience
of one operator, not an ergonomics project for the crew.

It also can't be validated yet. The device ships **2026-10-23**; there is no
simulator, so every breakpoint in the spec is an estimate (~740–860 CSS px
unfolded, derived from a rumored 7.5" inner display at the announced shared
aspect ratio). Building against guessed dimensions and then re-measuring is
strictly more work than measuring first.

### What already shipped from it

- **#892** — the spec doc itself.
- **#893** — three bare `vh`/`vw` inline styles guarded against text-size
  zoom. Two were the upfit designer's scene and parts panes
  (`calc(100vh - 300px)` → 130% of screen height at XL), one an estimates
  dropdown (`92vw`). A real Large/XL bug on any device, found during the
  audit and unrelated to foldables.

### What would un-defer it

Any one of these:

1. **The Duo is in hand and the fold behavior is known** (see open questions).
   This is the expected trigger, ~Oct 23.
2. **A real demo is scheduled** where the app will be shown unfolded to a
   prospect. Then F1's demo subset below becomes time-boxed work with a date.
3. **iPad demand appears from the crew.** None of this is Duo-specific —
   the same tier system fixes iPad and split-screen. If iPad usage grows,
   build it for that reason and the foldable benefits for free.

### The demo reframing — revised priorities

The spec ordered screens by ops utility. **For a sales demo the order is
different**, and two of the spec's picks drop out entirely:

| Screen | Spec priority | Demo priority | Why |
|---|---|---|---|
| `upfit-designer` | not listed | **1st** | see below — the money shot |
| `tracking` (In-Shop) | 1st | 2nd | a prospect's own vehicles, live |
| `estimates` / `quotes` | 2nd | 3rd | what the customer receives |
| `portal/[token]` | not listed | 4th | what *their* team logs into (579 lines) |
| `parts` | 3rd | **drop** | internal ops; no prospect cares |
| `scan` | 3rd | **drop** | internal ops |

Also inverted: **resize-*resilience* matters more than resize-*optimization*
for a demo.** Nobody in a sales meeting notices a missing column. Everyone
notices a modal stranded half-open, a lost scroll position, or a camera
permission re-prompt when the phone folds. Spec §7 moves up; spec §6
per-screen polish moves down.

### The upfit designer is already most of the way there

`src/app/(main)/upfit-designer/page.tsx` — a three.js van configurator
(`@react-three/fiber`, scene in `src/components/upfit/UpfitScene.tsx`). It is
the single best thing to show on a foldable, and it needs close to no work,
because it was built desktop-first with flexible panes.

The container at **line 1008** is `display: flex` + `flexWrap: 'wrap'` with
**two** direct panes:

| Pane | Line | Flex basis | `minWidth` |
|---|---|---|---|
| 3D scene | 1011 | `1 1 480px` | 300px |
| Parts list | 1057 | `0 1 300px` | 260px |

Side-by-side needs ~570px (300 + 260 + 10 gap). So:

- **Folded** (~420px) → under 570px, panes wrap, scene stacks above the list.
- **Unfolded** (~840px) → side by side, and the scene's `1 1 480px` absorbs
  every extra pixel, so the 3D van gets all the new width.

That's a genuine fold-to-unfold transformation with **zero code**. Verify it
on hardware before relying on it in front of anyone.

> **Correction to an earlier claim in this project's history:** this was
> first described as a *three*-pane layout whose min-widths summed to ~840px,
> "almost exactly the unfolded Duo estimate." That was wrong on both counts.
> The `flex: '0 1 360px'` pane at line 894 is a *different* section of the
> page (the "Summary + actions" block under "Layout preview"), not a third
> pane in this container. The real threshold is ~570px, not ~840px — which
> makes the designer *more* already-ready than claimed, not less, but there
> is no numerical coincidence with the Duo's width.

### The build subset, if triggered

Roughly a third of the spec. In order:

1. **Tier system** (spec §5) — `compact`/`medium`/`expanded` on *effective*
   (post-zoom) width. Foundation for everything else. **M**
2. **`Popout.tsx` docks as a side panel** (spec §6.4) — one file, nine entity
   types, and it's what makes an unfold visibly *transform* rather than just
   widen. Highest value per line changed. **M**
3. **`tracking` master-detail** (spec §6.1) — `expandedId` already holds the
   right state. **L**
4. Skip `parts` and `scan`.

Independent of all of it and worth doing anyway: **`admin/pos/page.tsx`**
reads `window.innerWidth >= 1000` once at open time (lines 449, 469, 1492)
and never re-evaluates. That's a live iPad-rotate bug today; folding just
makes it permanent. **S**

### Open questions

Carried from spec §9, in the order they matter for a demo:

1. **Does iOS preserve the WKWebView across a fold, or reload it?**
   **Demo-critical.** If it reloads, a fold mid-demo drops the prospect back
   to a login screen or an empty list, and no layout work fixes that — the
   answer would be server-side draft persistence, a much larger and
   differently-shaped project. Answer this before building anything.
2. **Real viewport dimensions.** Everything is estimated until the simulator
   exists. The 640/1024 thresholds are conventional, not measured.
3. **`capacitor.config.ts` `preferredContentMode: 'mobile'`** — `'recommended'`
   (let the system pick by screen size) is probably right for a device that's
   a phone half the time, but it changes UA and viewport behavior on *every*
   iOS install. Needs hardware testing, not a blind flip.
4. **Orientation lock across a fold** — `src/lib/orientation-lock.ts` locks
   orientation for camera flows. Behavior across a fold transition is unknown.
5. **Does Apple expose the foldable web APIs at all?** Safari ships none of
   `viewport-segments` / `env(viewport-segment-*)` / Device Posture today.
   The tier system deliberately doesn't depend on them — that's the point —
   but if they land, seam/posture refinements become possible on top.
