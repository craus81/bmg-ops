# iPhone Duo / foldable layout spec

**Status:** proposal — nothing in here is built yet. Written 2026-09-10, the
day after the Duo announcement, so the device numbers below are partly
estimated (see "What we actually know"). Decide on this doc before any code
moves.

**Scope:** what it would take to make FleetSuite use an unfolded foldable
screen properly, which screens get it first, and what it costs. The same work
covers iPad and desktop — none of it is Duo-specific.

---

## 1. What we actually know

Announced 2026-09-09. Preorders Oct 16, ships Oct 23.

| Fact | Source | Confidence |
|---|---|---|
| Two displays, continuous inner foldable display | Apple | confirmed |
| Both displays share the same aspect ratio | Apple | confirmed |
| Titanium frame, Ceramic Shield 2, IP68, 100+ part hinge | Apple | confirmed |
| $1,999 / 256GB | Apple | confirmed |
| Outer ≈ 5.5", inner ≈ 7.5" diagonal | rumor, pre-announcement | **estimate** |
| Logical (CSS px) viewport of either display | — | **unknown** |

What this means for us: we cannot design to exact pixel dimensions yet. There
is no simulator. The first honest measurement comes from the Xcode beta that
ships alongside the hardware, likely on or near Oct 23.

**So the plan below targets a range, not a number.** A 7.5" display at the same
aspect ratio as a 5.5" phone lands somewhere around **740–860 CSS px wide in
portrait** — iPad-mini territory. Every breakpoint proposed here should be
re-validated against the simulator before we call it done.

---

## 2. We are already shipping into this device

Worth stating plainly because it changes the calculus: **the iOS app exists.**
`ios/App/` is a real Capacitor project, and `capacitor.config.ts` points it at
the live deployment:

```ts
server: { url: 'https://bmg-ops.vercel.app', cleartext: false }
```

The native shell is a WKWebView loading production. There is no separate
codebase to port. **Whatever the web layout does is what the Duo renders**, and
it renders it the moment Vercel deploys — no App Store review in the loop.

Two consequences:

1. Every layout improvement here ships to the Duo automatically. This is not
   speculative work gated on a future port.
2. Conversely, the app's current phone-only layout is what a $1,999 foldable
   will show on its 7.5" display on day one, unless we change it.

One config knob to revisit (`capacitor.config.ts`, `ios` block):

```ts
preferredContentMode: 'mobile',
```

This pins the WKWebView to mobile content mode. On a device that is a phone
half the time and a small tablet the other half, `'recommended'` (let the
system decide by screen size) is probably the right value — but it changes UA
and viewport behavior on *every* iOS install, so it needs testing on real
hardware, not a blind flip.

---

## 3. What the platform gives us — and what it doesn't

There is a W3C foldable API surface. **Safari does not implement it.**

| API | What it does | WKWebView (iOS 26) |
|---|---|---|
| `@media (horizontal-viewport-segments: 2)` | detect a seam | **not shipped** |
| `env(viewport-segment-width 0 0)` etc. | measure each segment | **not shipped** |
| Device Posture API (`navigator.devicePosture`) | folded / flat | **not shipped** |
| `window.resize` + viewport width | the size changed | ✅ works everywhere |
| `env(safe-area-inset-*)` | notch / home indicator | ✅ already used |

Chrome and Edge ship the first three; Safari has not, and Apple has said
nothing about shipping them for the Duo. Writing `viewport-segment` CSS today
means writing code that no-ops on the target device.

**The Duo's inner display is continuous, not two panels with a gap** — so
seam-avoidance, the main thing those APIs buy you, is not the problem we have
anyway. Our problem is simpler and fully solvable with what already works:

> Unfolding fires a plain resize into a viewport roughly twice as wide.
> The app has to have something worth showing at that width, and it has to
> survive the transition.

That is the whole spec. Everything below serves those two sentences.

---

## 4. Current state — audit

### 4.1 There is effectively one breakpoint

`src/app/globals.css` has exactly two layout media queries, both
`@media (max-width: 640px)` (lines 422 and 466), and both are narrow
component fixes — the estimate line-item grid (`.est-line`) and the public
approval-document line grid (`.appr-line`). Neither is a layout system.

Two more live inline, one-off, in single components:

- `src/components/OpsDashboard.tsx:1176` — `@media (max-width: 860px)`
- `src/components/FinancialsDashboard.tsx:638` — `@media (max-width:760px)`

**Everything wider than 640px gets one identical layout.** There is no tablet
tier. A 7.5" unfolded display and a 27" monitor render the same thing.

### 4.2 The priority screens have zero responsive logic

Measured across the six screens picked for this work:

| Screen | Lines | Inline `@media` | `gridTemplateColumns` | Fluid (`auto-fit`) grids |
|---|---|---|---|---|
| `tracking/page.tsx` | 3401 | **0** | 5 | 1 |
| `estimates/page.tsx` | 4691 | **0** | 6 | 2 |
| `parts/page.tsx` | 1751 | **0** | 4 | 0 |
| `scan/page.tsx` | 1500 | **0** | 1 | 0 |
| `quotes/page.tsx` | 451 | **0** | 0 | 0 |
| `invoices/page.tsx` | 964 | **0** | 0 | 0 |

The grids are fixed-track, not fluid. `parts/page.tsx:1072` is representative:

```tsx
display: 'grid', gridTemplateColumns: '1fr 70px 50px 50px',
```

At 400px that's a sensible phone table. At 840px the three data columns stay
at 70/50/50 and the part-number column absorbs all 400 extra pixels of
whitespace. Nothing reflows, nothing gains a column, nothing gets easier to
read — the user just gets a wider blank stripe.

### 4.3 Detail views are phone-idiom overlays

**45 files** app-wide use the full-bleed overlay pattern
(`position: 'fixed', inset: 0`). `src/components/Popout.tsx` is the shared
version — "pop a record's details into a modal" with an *Open full page →*
escape hatch.

That escape hatch exists precisely because a modal is a bad container for a
record. On a wide screen it is also unnecessary: there is room for the list
*and* the record, side by side, with no modal at all.

`tracking/page.tsx` uses the other phone idiom — inline accordion
(`expandedId`, line 73). A vehicle card expands in place inside a
single column, pushing everything below it down. Unfolded, that becomes a
very long single column of very wide cards with one enormous expanded card
somewhere in the middle.

### 4.4 Nothing in the app reacts to a resize

```
$ grep -rn "addEventListener('resize'" src   →   (no matches)
```

Zero resize listeners. The only width-aware code in the app is in
`admin/pos/page.tsx` (lines 449, 469, 1492):

```tsx
setReviewPdfOpen(window.innerWidth >= 1000);
```

That's a **one-shot read at open time**, never re-evaluated. This is already a
concrete fold bug, not a hypothetical one:

- Open the PO review folded (~400px) → PDF panel starts closed → unfold to
  840px → panel is still closed, and the user has a half-empty screen with no
  indication a PDF panel exists.
- Open it unfolded → fold → panel is open and eats the entire narrow viewport.

Everything else in the app has the milder version of the same problem: React
state (open modals, scroll position, half-typed forms, active tab, camera
sessions) has never had to survive a viewport doubling, because on a phone it
never happens except on rotate.

### 4.5 The text-size zoom trap

This is the subtlest finding and the one most likely to ship a broken layout.

Text size (Regular/Large/XL) is implemented as CSS `zoom` on `<body>`
(`globals.css:38-42`):

```css
:root { --ts: 1; }
[data-textsize="large"] { --ts: 1.15; }
[data-textsize="xl"]    { --ts: 1.3; }
[data-textsize="large"] body { zoom: 1.15; }
[data-textsize="xl"]    body { zoom: 1.3; }
```

**Media queries are zoom-blind.** They evaluate against the real viewport.
Content inside `<body>` is laid out in zoomed coordinates. So the width a
media query sees and the width the content actually has are different numbers:

| Device state | Real viewport | What `@media` sees | Effective content width |
|---|---|---|---|
| Duo folded, Regular | ~420px | 420px | 420px |
| Duo unfolded, Regular | ~840px | 840px | 840px |
| Duo unfolded, Large (1.15) | ~840px | 840px | **~730px** |
| Duo unfolded, XL (1.3) | ~840px | 840px | **~646px** |

A naive `@media (min-width: 720px)` two-pane layout would engage at XL text
size and then try to fit two panes into 646 effective px — worse than the
single-column layout it replaced. This is the same failure `globals.css:451`
already documents for the approval-document table ("Large/XL text size made it
worse — zoom shrinks the effective viewport").

**Therefore: the tier system must not be built on plain media queries.** Two
options that both see post-zoom width correctly:

1. **Container queries** — `@container` measures the container's box in its own
   (zoomed) coordinate space, so it naturally reports 646px in the XL row
   above. Cleanest, CSS-only, well-supported in modern WebKit.
2. **A JS-stamped tier attribute** — a provider computes
   `window.innerWidth / getTextZoom()` on resize and stamps
   `data-tier="compact|medium|expanded"` on `<html>`, mirroring how
   `data-textsize` already works. Needed anyway for #4.4, and lets TSX branch
   on tier, not just CSS.

Recommendation: **do both** — (2) as the source of truth since the app styles
overwhelmingly with inline `style` objects rather than classes, and (1) for the
handful of places that are already CSS-driven (`.est-line`, `.appr-line`).

`getTextZoom()` already exists in `src/lib/text-size.ts` for exactly this
real-px-vs-CSS-px conversion; the AiChat drag handling is the existing
precedent.

---

## 5. Proposed system: layout tiers

Three tiers, defined on **effective** (post-zoom) width:

| Tier | Effective width | Devices | Layout |
|---|---|---|---|
| `compact` | < 640px | phones, Duo folded | today's layout, unchanged |
| `medium` | 640–1024px | **Duo unfolded**, iPad portrait, split-screen | master-detail, side rail nav |
| `expanded` | > 1024px | iPad landscape, desktop | today's desktop layout + wider content |

Deliverables:

- **`src/lib/layout-tier.ts`** — `Tier` type, the two thresholds, and
  `getTier(effectiveWidth)`. One place to change the numbers when the simulator
  gives us real ones.
- **`useTier()`** in `ThemeProvider` (it already owns the `data-textsize`
  stamping, so tier belongs next to it) — debounced resize listener,
  divides by `getTextZoom()`, stamps `data-tier` on `<html>` pre-paint the same
  way text size is stamped, returns the tier to React.
- **CSS custom properties** keyed off `[data-tier]` for the CSS-driven bits.

The pre-paint stamp matters: without it the app renders compact and then snaps
to medium on hydration, which on an unfold is a visible flash.

### Nav: bottom bar → side rail at `medium`+

`src/components/BottomNav.tsx` renders `position: fixed; bottom: 0` at every
width — up to 7 tabs + More, always across the bottom. That's correct on a
phone and wrong on a 7.5" display held like a small tablet, where the bottom
edge is the furthest point from the thumbs and horizontal space is what's
scarce.

At `medium` and `expanded`, the same tab list should render as a **left rail**.
The tab model doesn't change — same `allTabs`, same priority sort, same feature
filtering — only the container flips from a horizontal fixed bar to a vertical
fixed rail, and `MAX_TABS = 7` can rise since a vertical rail has room for all
of them (dropping the More overflow entirely at `expanded`).

The safe-area handling already in place (`BottomNav.tsx:123-125` pads for
`safe-area-inset-bottom/left/right`) carries over; the rail wants
`safe-area-inset-left` as its leading pad.

---

## 6. Per-screen plan

Priority order as chosen: shop board + tracking, then estimates/quotes/
invoices, then parts + scan.

Effort estimates are for `medium`-tier work only, assuming the tier system from
§5 already exists.

### 6.1 In-Shop / tracking — `tracking/page.tsx` (3401 lines) — **L**

The biggest win and the biggest job. Today: one column of vehicle cards, one
expands in place (`expandedId`, line 73).

At `medium`: **master-detail.** Vehicle list becomes a fixed-width left column
(~320px); the expanded vehicle's detail renders in the right pane instead of
inline. `expandedId` already holds exactly the state this needs — it becomes
"which record is in the detail pane" rather than "which card is tall." The
linked-estimates fetch (lines 84–97) and sales-order effects (393–427) are
already keyed on `expandedId` and need no change.

Risk: the expanded card body is long and was written assuming full page width.
It needs a pass for anything that assumed ~full-viewport. The viewport-unit
handling is already correct here — both `vh` usages (lines 1383, 1775) are
already written `calc(92vh / var(--ts))` per the CLAUDE.md rule, as are all
three in `scan/page.tsx`. No cleanup needed on that front in these screens.

**Shop board needs no separate work.** `shop-board/page.tsx` is a 13-line
redirect stub — the board merged into `/tracking` and the file only
`router.replace('/tracking')`s to keep old links alive. It inherits §6.1
entirely.

### 6.2 Estimates / quotes / invoices — **M each**

- **`estimates/page.tsx` (4691 lines)** — the `.est-line` grid already has a
  real compact layout in CSS (`globals.css:415-447`). The medium tier mostly
  means *not* collapsing to the stacked-card form, and letting the 8-column
  desktop grid engage — plus a master-detail split for the estimate list.
  The CSS is already class-driven here, so this one can use container queries
  and be largely a CSS-only change. **Cheapest real win in the set.**
- **`quotes/page.tsx` (451 lines)** — small file, one overlay modal. Convert the
  modal to a docked right pane at `medium`. **S.**
- **`invoices/page.tsx` (964 lines)** — no grids, no modals, no media queries.
  Mostly needs a content max-width and a second column for the invoice detail.
  **S–M.**

### 6.3 Parts + scan — **M**

- **`parts/page.tsx`** — the fixed `'1fr 70px 50px 50px'` grid (lines 1072,
  1110) gets a medium variant that adds the columns currently hidden on
  phones (on-hand location, vendor, last cost — confirm with whoever uses the
  screen daily). The two `'1fr 1fr'` sub-grids (1166, 1377) become `'1fr 1fr
  1fr'`. Catalog browsing is the single best argument for the unfolded screen:
  more rows and more columns at once.
- **`scan/page.tsx`** — different shape. Scanning is a *folded*, one-handed,
  camera-up activity; the unfolded state is for reviewing what was scanned.
  The medium layout should be **camera left, scan results/history right** —
  the scan log currently sits below the viewfinder and is invisible while
  scanning.

  **Open question for §9:** `src/lib/orientation-lock.ts` locks orientation for
  camera flows. Unknown how an orientation lock behaves across a fold
  transition, or whether it should apply on the inner display at all.

### 6.4 Shared, benefits everything — **M**

- **`src/components/Popout.tsx` (376 lines)** — the single highest-leverage
  file in this whole spec. It is the app-wide record-detail container for nine
  entity types. Teach *it* to render as a docked side panel at `medium`+
  instead of an overlay, and every caller across the app gets master-detail for
  free, with no per-screen work. The *Open full page →* button becomes
  redundant at that tier.
- **`admin/pos/page.tsx`** — fix the three `window.innerWidth >= 1000` one-shot
  reads (§4.4) to derive from `useTier()`. This is a live bug today on iPad
  rotate; the fold just makes it constant.

---

## 7. Resize resilience

Independent of layout, and cheap. On any fold transition:

- **Open modals must stay open** and re-measure, not unmount. Anything keyed on
  a mount-time width read breaks here (§4.4).
- **Scroll position must be preserved** — anchoring on the top-most visible
  record id, not `scrollTop`, since the column width changed.
- **In-flight form state must survive.** Nothing should remount on tier change;
  tier must drive styles and container structure, not component identity. The
  practical rule: **never key a component on tier, never conditionally render
  two different component trees per tier** — one tree, different styles.
- **Camera sessions must not restart.** `PhotoSession`, `VinScanner`,
  `RfidCapture` hold live `MediaStream`s. A remount drops the stream and, on
  iOS, can prompt for permission again mid-scan.

The last two are the reason the tier system stamps an attribute and returns a
value, rather than swapping component trees.

---

## 8. Effort summary

| Item | Effort | Value without a Duo |
|---|---|---|
| §5 tier system + `layout-tier.ts` + `useTier()` | **M** | high — unblocks all of it, fixes iPad |
| §5 nav rail at `medium`+ | **M** | high — iPad + desktop |
| §6.4 `Popout.tsx` docked panel | **M** | **highest leverage** — 9 entity types at once |
| §6.4 `admin/pos` width bug | **S** | fixes a live iPad-rotate bug |
| §6.1 tracking master-detail | **L** | high |
| §6.2 estimates | **M** | high |
| §6.2 quotes / invoices | **S** each | medium |
| §6.3 parts | **M** | high |
| §6.3 scan split view | **M** | medium |
| §7 resize resilience | **M**, spread across the above | medium |

Nothing here is Duo-specific. Every line of it improves iPad, iPad
split-screen, and desktop — which is the argument for doing it whether or not
anyone at BMG buys a $1,999 phone.

---

## 9. Open questions — need answers before building

1. **Real viewport dimensions.** Everything in §5 is placeholder numbers until
   the simulator exists. The 640/1024 thresholds are conventional, not measured.
2. **`preferredContentMode`** (§2) — flipping `'mobile'` → `'recommended'`
   affects every iOS install. Needs hardware testing.
3. **Orientation lock across a fold** (§6.3) — behavior unknown.
4. **Does Apple expose anything at all to WKWebView?** If Safari ships the
   Device Posture API for the Duo, seam/posture-aware refinements become
   possible on top of this. The tier system doesn't depend on it either way,
   which is the point.
5. **Continuity between displays.** If a user folds mid-task, does iOS hand the
   WKWebView to the outer display with state intact, or does the app reload?
   If it reloads, §7 is moot and the answer is server-side draft persistence
   instead — a much larger project. **This question should be answered first**,
   because a "no" changes the shape of the work.
6. **Who actually gets one?** If the answer is "one or two people," the
   sequencing below (tier system + `Popout` only) is the whole project and the
   per-screen work waits for iPad demand instead.

---

## 10. Recommended sequencing

Before Oct 23 (no hardware needed, no Duo assumptions):

1. `admin/pos` width bug (§4.4) — an existing iPad-rotate bug, worth fixing on
   its own merits.
2. Tier system (§5). Placeholder thresholds, documented as such.
3. `Popout.tsx` docked panel (§6.4) — best value per line changed.

After the simulator exists:

4. Measure. Correct the thresholds in `layout-tier.ts`.
5. Nav rail, then tracking, estimates, parts, scan in that order.

Answer question #5 above before committing to step 2.
