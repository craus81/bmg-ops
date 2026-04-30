# Glossary

Terms used across the BMG Fleet app. Listed alphabetically.

## A

**Admin** — Top-level role. Sees the full FleetSuite app and every feature.
Can override permissions per user, approve new accounts, and run all
admin-only tools.

**Approval token** — Single-use URL token that lets a customer accept or
reject an estimate or graphics proof from email or SMS without logging
in. 30-day expiry. See `workflows/magic-link-approvals.md`.

## C

**Catalog** — The library of upfit parts and graphics SKUs. Lives at
**Admin → Parts Catalog** for upfit parts and **Admin → Catalog** for
graphics. Used as the picker when building estimates and POs.

**Check-in** — Recording that a vehicle has arrived at the shop and
capturing arrival photos, current condition, and the customer's
delivery instructions. Done at `/fleet`.

**CNI** — "Customer-Not-Included" job. Jobs where a customer ships a
vehicle to BMG to be upfit and graphic'd, billed back at the end. CNI
jobs have their own admin surface at **Admin → CNI Management** and a
mobile installer surface at **Installer → CNI Jobs**.

**Completion ceremony** — The structured flow at the end of an install:
QC checklist done, completion photo captured, completion notes saved,
customer notified. Run from the **Mark Complete** button on the
pick-list or from `/tracking` via **Run Completion Process**.

**Customer** — Either a NetSuite customer record (ERP) or an internal
customer profile. Used to scope estimates, POs, jobs, threads, and
install context.

## E

**Estimate** — A pre-sale quote of the upfit / graphic work, built at
`/estimates`. Can be sent for magic-link customer approval. On accept,
flips to **accepted** and is ready to convert to a NetSuite Sales Order.

## F

**FleetSuite** — The admin-facing brand of the app (header label "Admin").

**Fleet GO** — The crew-facing brand of the app (header label "Crew"). Same
codebase — what shows up in the navigation depends on your role.

**FS-CUSTOM** — Permanent NetSuite item used as a placeholder when an
estimate has a custom line that doesn't map to a real NetSuite item.
Required for `/estimates` → SO push to succeed.

## G

**Graphics job** — A queue item at `/graphics` representing a fleet
vehicle that needs vinyl / wraps / decals applied. Has stages: new →
proof_pending → approved → in_production → ready_to_pickup → shipped →
installed.

**Graphics production** — Role for the graphics team. Sees the queue,
manages proofs, runs production, marks jobs as shipped.

## I

**Install context** — The 3-layer set of operational notes for an
upfit / install: customer-default settings, estimate-level overrides,
and per-vehicle notes. Surfaced on the pick-list and on `/tracking`.

**Installer** — Role for the upfit shop floor. Mobile-first surface;
works the pick-list, completion ceremony, time clock, and CNI jobs.

## J

**Job tasks** — Individual checklist items inside an install checklist
(e.g. "Lift kit installed", "Headliner trim verified"). Tracked at the
installer level via the pick-list.

## M

**Magic link** — A single-use URL sent by email / SMS that grants access
without a password. Used for both login and customer-facing approvals.

## P

**Pick-list** — The mobile installer page for a single vehicle in the
shop. Lives at `/vehicles/[vin]/pick-list`. Shows assigned graphics,
proofs, design files, install context, the QC checklist, photo
timeline, and a **Mark Complete** button.

**PO** — Purchase Order. A vendor-side order BMG places (e.g. with a part
supplier). Tracked at `/admin/pos`.

**Proof** — A graphics design file that a customer needs to approve before
production runs. Sent for approval via magic link.

**Prospect** — A pre-customer sales lead in the CRM. Lives at
`/admin/prospects`.

## Q

**QC checklist** — Per-vehicle checklist of required tasks before an
install can be marked complete. Templates managed at
`/admin/install-checklists`. Auto-instantiated when a vehicle moves
from `received` to `in_progress`.

## R

**Ready for install** — Status for a vehicle that has at least one
graphics job marked `ready` and is awaiting an installer to schedule.
Surfaced at `/installer/ready-for-install`.

**Ready to pickup** — Graphics job status meaning the work is done and
the customer has been notified to come pick up. Auto-fires the customer
notification.

## S

**Sales** — Role for the sales / estimating team. Builds estimates,
manages prospects, owns customer-default install context.

**Sales Order (SO)** — NetSuite-side commitment to deliver work, created
when an estimate is converted. Carries the install context and notes
into NetSuite.

**Scan** — VIN scan + log entry. Done at `/scan`. Powers the Fleet
check-in lookup and the part-shipment receiving flow.

**Service role key** — Supabase admin-level API key used by server-side
routes (the AI agent, sync scripts) to bypass RLS. Never exposed to the
browser.

**Shop tech** — Role for warehouse / receiving staff. Does check-ins,
scans, time tracking, and basic in-shop tracking. Doesn't touch
estimates, customer comms, or the catalog.

**Signed document** — Immutable HTML snapshot stored in the private
`signed-documents` bucket whenever a customer accepts an estimate or
proof via magic link. Includes IP, user agent, time on page, and
sha256 hash. Audit-grade.

## T

**Thread** — A customer comms thread at `/admin/inbox`. Polymorphic —
scoped to a fleet check-in, PO, graphics job, estimate, or just the
customer.

**Tracking** — The in-shop status board at `/tracking`. Shows every
vehicle currently at the shop, what stage it's in, what's outstanding,
and lets admins run the completion process.

## U

**Upfit** — Vehicle modification work (lifts, ladder racks, partitions,
shelving, lighting, etc.). The non-graphics half of BMG's business.

**Upfit project** — A higher-level container for an upfit job that may
have child graphics jobs linked to it. Lives at `/upfit`.

## V

**View as** — Admin tool for previewing the app the way another role
sees it. Available from the avatar menu.

**VIN** — Vehicle Identification Number, the 17-character ID for a
specific vehicle. Used as the primary key across check-ins, photos,
graphics jobs, and pick-lists. The scanner accepts the last 8+ chars
for quick lookup.
