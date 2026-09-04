import { NextRequest, NextResponse } from 'next/server';
import { createSalesOrder, findLocation, closeNetSuiteEstimate } from '@/lib/netsuite';
import { buildSoLineItems, soContentHash } from '@/lib/so-sync';
import { createClient } from '@supabase/supabase-js';
import { requireFeature } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { logAudit } from '@/lib/audit';
import { notifyMany } from '@/lib/notify';
import { deepLinks } from '@/lib/deep-links';
import { syncShopInboundForSalesOrder } from '@/lib/shop-inbound';
import { estimateContextMemo } from '@/lib/estimate-document';
import { resolveOrPromoteByName } from '@/lib/promote-prospect';
import { isGraphicsLine } from '@/lib/graphics-lines';

const ConvertSchema = z.object({
  estimateId: z.string().uuid(),
  /** Admin-only: converts an estimate the customer hasn't accepted, with the
   *  reason recorded in the audit log (phone/email/PO approvals never touch
   *  the magic link, so a hard gate would block legitimate conversions). */
  overrideReason: z.string().trim().min(3).max(500).optional(),
  /** Set by the UI's "Convert anyway" confirm after the graphics-line gate
   *  409s — the gate is a blocking check, not a silent pass. */
  skipGraphicsCheck: z.boolean().optional().default(false),
});

export async function POST(req: NextRequest) {
  const auth = await requireFeature(req, 'estimates');
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, ConvertSchema);
  if (parsed.error) return parsed.error;
  const { estimateId, overrideReason, skipGraphicsCheck } = parsed.data;

  try {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    // Load estimate with line items
    const { data: estimate, error: estError } = await supabase
      .from('estimates')
      .select('*, estimate_line_items(*), vehicle_platforms(label)')
      .eq('id', estimateId)
      .single();

    if (estError || !estimate) {
      return NextResponse.json({ error: 'Estimate not found' }, { status: 404 });
    }
    // Flatten the platform label for the memo's vehicle line.
    (estimate as any).vehicle_platform_label = (estimate as any).vehicle_platforms?.label || null;

    // Check if already converted
    if (estimate.netsuite_so_id) {
      return NextResponse.json({
        status: 'already_created',
        salesOrderId: estimate.netsuite_so_id,
        salesOrderNumber: estimate.netsuite_so_number || '',
        message: `Sales Order already exists (SO #${estimate.netsuite_so_number || estimate.netsuite_so_id})`,
      });
    }

    // ── Graphics gate ──
    // The estimate builder's "spawn graphics job" panel is only a prompt;
    // this is the wall (Stage 2 finding): an estimate carrying graphics
    // lines must have a linked graphics job before it becomes a Sales
    // Order, or production never hears about the work. The UI's
    // "Convert anyway" confirm retries with skipGraphicsCheck.
    if (!skipGraphicsCheck) {
      const gfxLines = (estimate.estimate_line_items || []).filter(isGraphicsLine);
      if (gfxLines.length > 0) {
        const { data: gjob } = await supabase
          .from('graphics_jobs')
          .select('id')
          .eq('estimate_id', estimateId)
          .limit(1);
        if (!gjob || gjob.length === 0) {
          return NextResponse.json({
            error: `This estimate carries ${gfxLines.length} graphics line${gfxLines.length !== 1 ? 's' : ''} but no linked graphics job — production would never hear about the work. Create it first (the Graphics panel on the estimate), or convert anyway.`,
            step: 'graphics_job_missing',
            graphicsLineCount: gfxLines.length,
            canSkip: true,
          }, { status: 409 });
        }
      }
    }

    // ── Acceptance gate ──
    // customer_approved is the real acceptance signal (set by the magic-link
    // approval flow and safe from Save clobbers). status is written by three
    // unrelated paths and is NOT trusted here. Anyone could previously
    // convert a draft; now conversion requires customer approval — or an
    // admin override with a recorded reason, because plenty of customers
    // approve by phone/email/PO and never click the link.
    if (!estimate.customer_approved) {
      const roles: string[] = auth.profile?.roles?.length > 0 ? auth.profile.roles : [auth.profile?.role];
      const isAdminActor = roles.includes('admin') || roles.includes('super_admin');
      const reason = overrideReason?.trim();
      if (!isAdminActor || !reason) {
        return NextResponse.json({
          error: isAdminActor
            ? 'This estimate has not been accepted by the customer. Provide an override reason to convert anyway.'
            : 'This estimate has not been accepted by the customer yet. Send it for approval, or ask an admin to override with a recorded reason.',
          step: 'not_approved',
          canOverride: isAdminActor,
        }, { status: 409 });
      }
      await logAudit(supabase, {
        actorId: auth.user.id,
        table: 'estimates',
        recordId: estimateId,
        action: 'convert_to_so_override',
        detail: { reason, estimate_number: estimate.estimate_number, grand_total: estimate.grand_total },
      });
    }

    // Verify we have a customer NetSuite ID
    let customerId = estimate.customer_netsuite_id;
    if (!customerId && estimate.customer_name) {
      // Same resolver as the estimate push: the lead this estimate is
      // linked to (prospect_id), else an existing NetSuite customer with
      // this exact name, else the lead whose name matches. Stamp the
      // estimate so the linkage survives for invoicing.
      const resolved = await resolveOrPromoteByName(
        supabase, estimate.customer_name, null, estimate.prospect_id || null,
      );
      if (resolved) {
        customerId = resolved.netsuiteId;
        await supabase.from('estimates')
          .update({ customer_netsuite_id: resolved.netsuiteId })
          .eq('id', estimateId);
      }
    }

    if (!customerId) {
      return NextResponse.json({
        error: 'No NetSuite customer ID on this estimate. Select a customer that has been synced from NetSuite.',
        step: 'customer',
      }, { status: 400 });
    }

    const lineItems = (estimate.estimate_line_items || [])
      .sort((a: any, b: any) => (a.sort_order || 0) - (b.sort_order || 0));

    // ONE line builder shared with push-so (src/lib/so-sync.ts) — creating
    // the SO and later updating it map lines, custom lines and labor the
    // same way. A missing labor item is reported (laborSkipped), never a
    // silent no-op.
    const {
      soLineItems, customLineDescriptions, unmappedLineDescriptions,
      laborSkipped, laborItemNumber, laborHours, laborRate,
    } = await buildSoLineItems(supabase, estimate, lineItems);

    if (soLineItems.length === 0) {
      return NextResponse.json({
        error: 'No line items could be mapped to NetSuite. Ensure parts have NetSuite item IDs or create the FS-CUSTOM placeholder item in NetSuite.',
        step: 'line_items',
        unmappedLines: unmappedLineDescriptions,
      }, { status: 400 });
    }

    // The rich SO memo (title, notes, vehicle/install/delivery/on-site/unit
    // context, estimate number) — shared with the estimate-push path so the
    // two NetSuite copies can't drift.
    const memo = estimateContextMemo(estimate);

    const nsLocation = await findLocation("O'Fallon");

    // ── Conversion claim (R3-8 idempotence) ──
    // The "already converted" pre-check above is read-then-act: two
    // concurrent conversions could both pass it and each create a REAL
    // Sales Order (the loser was detected by the first-writer-wins stamp
    // below, but a human still had to delete the duplicate in NetSuite).
    // Claim atomically before touching NetSuite — same pattern as
    // create-po's request claim. A stale claim (crashed request) is taken
    // over after 5 minutes; a live one turns the second request away here.
    // claimActive stays false when the claim column isn't visible to
    // PostgREST (schema-cache lag — the exact failure mode migration 246
    // documents from the SO1064 incident). Blocking every conversion on a
    // cache hiccup would be worse than running one request unclaimed: the
    // detect-and-report guards below still catch a duplicate. Crucially,
    // the success stamp must then NOT carry the claim column either — a
    // cache-lagged column in that update would fail the whole write-back
    // and strand the SO exactly like SO1064.
    let claimActive = false;
    const staleClaimCutoff = new Date(Date.now() - 5 * 60_000).toISOString();
    const { data: claimedRows, error: claimErr } = await supabase
      .from('estimates')
      .update({ so_conversion_claimed_at: new Date().toISOString() })
      .eq('id', estimateId)
      .is('netsuite_so_id', null)
      .or(`so_conversion_claimed_at.is.null,so_conversion_claimed_at.lt.${staleClaimCutoff}`)
      .select('id');
    if (claimErr) {
      if ((claimErr as any).code === 'PGRST204') {
        console.warn('convert-to-so: so_conversion_claimed_at not in the schema cache yet — proceeding without the claim');
      } else {
        return NextResponse.json({ error: 'Could not start the conversion: ' + claimErr.message }, { status: 503 });
      }
    } else if ((claimedRows || []).length === 0) {
      return NextResponse.json({
        error: 'Another conversion for this estimate is already in progress (or just finished). Refresh to see its result before trying again.',
        step: 'conversion_in_progress',
      }, { status: 409 });
    } else {
      claimActive = true;
    }
    const releaseClaim = async () => {
      if (!claimActive) return;
      try {
        await supabase.from('estimates').update({ so_conversion_claimed_at: null }).eq('id', estimateId);
      } catch { /* best-effort — the claim expires on its own in 5 minutes */ }
    };

    let result: Awaited<ReturnType<typeof createSalesOrder>>;
    try {
      result = await createSalesOrder({
        customerId,
        // The SO's PO/Reference field carries the CUSTOMER's PO when the
        // estimate has one — that's what prints on their invoice and what
        // their AP matches against. Our estimate number stays in the memo.
        poNumber: estimate.po_number?.trim() || estimate.estimate_number,
        locationId: nsLocation?.id,
        memo,
        vin: estimate.vin,
        lineItems: soLineItems,
      });
    } catch (err: any) {
      // No SO was created — release so a retry doesn't wait out the claim.
      await releaseClaim();
      return NextResponse.json({
        error: 'Failed to create Sales Order in NetSuite: ' + (err?.message || err),
        step: 'create_so',
      }, { status: 502 });
    }

    if (!result.success) {
      await releaseClaim();
      return NextResponse.json({
        error: result.error || 'Failed to create Sales Order in NetSuite',
        step: 'create_so',
      }, { status: 500 });
    }

    // Write the SO onto the estimate — CONDITIONALLY, and checked. This write
    // used to be fire-and-forget with no guard: a failed write-back returned
    // "created" while the estimate stayed convertible (next click → a second
    // real SO in NetSuite), and two racing clicks each created an SO with the
    // last writer silently winning. `.is('netsuite_so_id', null)` makes the
    // stamp first-writer-wins; zero matched rows means a concurrent
    // conversion already linked a different SO and OURS is the duplicate —
    // reported loudly instead of swallowed.
    const { data: stamped, error: writeBackError } = await supabase
      .from('estimates')
      .update({
        netsuite_so_id: result.salesOrderId,
        netsuite_so_number: result.salesOrderNumber || null,
        // Conversion is done — retire the claim in the same write. Only
        // when the claim actually took: including a cache-invisible column
        // here would fail the entire write-back and strand the SO.
        ...(claimActive ? { so_conversion_claimed_at: null } : {}),
        // With the acceptance gate above, conversion only happens once the
        // customer approved (or an admin overrode with a recorded reason) —
        // so 'accepted' is now a truthful consequence, and the funnel report
        // keeps its won signal for phone/email-approved deals.
        status: 'accepted',
        // The SO contract as just pushed (migration 259) — the save route
        // compares against it to flag "sales order out of date".
        so_pushed_hash: soContentHash(estimate, lineItems),
        so_synced_at: new Date().toISOString(),
        so_out_of_date: false,
      })
      .eq('id', estimateId)
      .is('netsuite_so_id', null)
      .select('id');

    if (writeBackError) {
      // The SO exists in NetSuite but the app couldn't record it. Do NOT let
      // this read as failure-to-create (a retry would duplicate the SO).
      // The claim is deliberately NOT released: it blocks an immediate
      // re-click and expires on its own in 5 minutes — matching the
      // "retry later" advice below.
      return NextResponse.json({
        status: 'created_unlinked',
        salesOrderId: result.salesOrderId,
        salesOrderNumber: result.salesOrderNumber,
        error: `Sales Order SO #${result.salesOrderNumber || result.salesOrderId} WAS created in NetSuite, but saving it onto the estimate failed (${writeBackError.message}). Do NOT convert again — that would create a duplicate SO. Retry later or link the SO number by hand.`,
      }, { status: 500 });
    }

    if ((stamped || []).length === 0) {
      // A concurrent conversion won the stamp — the SO this request just made
      // is a duplicate in NetSuite.
      const { data: current } = await supabase
        .from('estimates')
        .select('netsuite_so_number, netsuite_so_id')
        .eq('id', estimateId)
        .maybeSingle();
      const winner = current?.netsuite_so_number || current?.netsuite_so_id || 'unknown';
      return NextResponse.json({
        status: 'duplicate_so',
        salesOrderId: result.salesOrderId,
        salesOrderNumber: result.salesOrderNumber,
        error: `Another conversion finished first and linked SO #${winner}. This click created a SECOND Sales Order (SO #${result.salesOrderNumber || result.salesOrderId}) in NetSuite — please delete it there.`,
      }, { status: 409 });
    }

    // ── Close the pushed NetSuite estimate (audit Round 2 item 10) ──
    // FleetSuite SOs are standalone, so NetSuite's own estimate->Processed
    // transition never fires and pushed estimates sat Open forever. Closing
    // is a probability-0 PATCH (Document Status is derived — see
    // closeNetSuiteEstimate). Best-effort: the SO exists either way, and
    // the netsuite-sync sweep (closeConvertedEstimates) retires any miss.
    let nsEstimateClosed: boolean | null = null;
    if (estimate.netsuite_estimate_id) {
      const closed = await closeNetSuiteEstimate(String(estimate.netsuite_estimate_id));
      nsEstimateClosed = closed.success;
      if (!closed.success) {
        console.warn(`convert-to-so: NS estimate ${estimate.netsuite_estimate_id} close failed:`, closed.error);
      }
    }

    // ── Auto-create/link the upfit project (roadmap N2 phase 1) ──
    // Conversion used to create nothing downstream: someone had to know to
    // open Upfit Projects, hand-create a project, and re-type the SO number
    // the app just generated before parts readiness/allocations were even
    // reachable. Find-or-create by estimate_id (migration 225's partial
    // unique index guards the race). Non-fatal — the SO already exists.
    let upfitProject: { id: string; created: boolean } | null = null;
    try {
      const { data: existing } = await supabase
        .from('upfit_projects')
        .select('id, netsuite_so_id')
        .eq('estimate_id', estimateId)
        .maybeSingle();
      if (existing) {
        if (!existing.netsuite_so_id) {
          await supabase
            .from('upfit_projects')
            .update({
              netsuite_so_id: result.salesOrderId,
              netsuite_so_number: result.salesOrderNumber || null,
              so_total: estimate.grand_total ?? null,
            })
            .eq('id', existing.id);
        }
        upfitProject = { id: existing.id, created: false };
      } else {
        const projectName = [estimate.customer_name, estimate.title || estimate.estimate_number]
          .filter(Boolean).join(' — ') || `Estimate ${estimate.estimate_number || estimateId.slice(0, 8)}`;
        const { data: createdProject, error: projectErr } = await supabase
          .from('upfit_projects')
          .insert({
            project_name: projectName,
            status: 'sold',
            customer_name: estimate.customer_name || null,
            customer_netsuite_id: customerId,
            estimate_id: estimateId,
            estimate_number: estimate.estimate_number || null,
            netsuite_so_id: result.salesOrderId,
            netsuite_so_number: result.salesOrderNumber || null,
            estimated_total: estimate.grand_total ?? null,
            so_total: estimate.grand_total ?? null,
            created_by: auth.user.id,
          })
          .select('id')
          .single();
        if (projectErr) {
          if (projectErr.code === '23505') {
            // Racing conversion created it between our select and insert.
            const { data: winner } = await supabase
              .from('upfit_projects').select('id').eq('estimate_id', estimateId).maybeSingle();
            if (winner) upfitProject = { id: winner.id, created: false };
          } else {
            console.error('auto upfit-project create failed:', projectErr);
          }
        } else if (createdProject) {
          upfitProject = { id: createdProject.id, created: true };
          await supabase.from('upfit_project_notes').insert({
            project_id: createdProject.id,
            note_type: 'sales_order',
            content: `Project created automatically: ${estimate.estimate_number || 'estimate'} converted to SO #${result.salesOrderNumber || result.salesOrderId}`,
            created_by: auth.user.id,
          });
        }
      }
    } catch (projErr) {
      console.error('auto upfit-project step failed:', projErr);
    }

    // Put the vehicle on the shop's Arriving board (V1). Non-fatal — the SO
    // already exists; a board hiccup shouldn't fail the conversion.
    try {
      await syncShopInboundForSalesOrder(supabase, estimateId);
    } catch (inboundErr) {
      console.error('shop_inbound sales-order sync failed:', inboundErr);
    }

    // Conversion previously notified nobody at all. FYI the estimate's
    // creator and the account owner (minus whoever clicked Convert);
    // non-fatal — the SO already exists either way.
    try {
      const targetIds = new Set<string>();
      if (estimate.created_by) targetIds.add(estimate.created_by);
      if (estimate.customer_id) {
        const { data: cust } = await supabase
          .from('customers')
          .select('account_owner_id')
          .eq('id', estimate.customer_id)
          .maybeSingle();
        if (cust?.account_owner_id) targetIds.add(cust.account_owner_id);
      }
      targetIds.delete(auth.user.id);
      if (targetIds.size > 0) {
        const { data: actorProfile } = await supabase
          .from('profiles').select('full_name').eq('id', auth.user.id).maybeSingle();
        await notifyMany(Array.from(targetIds), {
          type: 'estimate_converted',
          title: `Sales Order created: ${estimate.estimate_number}`,
          body: `${actorProfile?.full_name || 'A teammate'} converted ${estimate.customer_name || 'the customer'}'s estimate to SO #${result.salesOrderNumber || result.salesOrderId}${overrideReason ? ' (admin override — customer approval was recorded outside the app)' : ''}.${upfitProject?.created ? ' An upfit project was created automatically — parts readiness lives there.' : ''}`,
          url: deepLinks.estimate(estimateId),
        });
      }
    } catch (notifyErr) {
      console.error('estimate_converted notification failed:', notifyErr);
    }

    return NextResponse.json({
      status: 'created',
      salesOrderId: result.salesOrderId,
      salesOrderNumber: result.salesOrderNumber,
      lineItemCount: soLineItems.length,
      customLineCount: customLineDescriptions.length,
      customLines: customLineDescriptions.length > 0 ? customLineDescriptions : undefined,
      unmappedLines: unmappedLineDescriptions.length > 0 ? unmappedLineDescriptions : undefined,
      laborSkipped: laborSkipped || undefined,
      laborHours: laborSkipped ? laborHours : undefined,
      laborAmount: laborSkipped ? Math.round(laborHours * laborRate * 100) / 100 : undefined,
      laborItem: laborItemNumber || undefined,
      upfitProject: upfitProject || undefined,
      nsEstimateClosed: nsEstimateClosed === null ? undefined : nsEstimateClosed,
      memoUsed: memo,
    });
  } catch (err: any) {
    console.error('Convert estimate to SO error:', err);
    return NextResponse.json({ error: err.message || 'Failed to convert estimate' }, { status: 500 });
  }
}
