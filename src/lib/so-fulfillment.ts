/**
 * Should this sales order be fulfilled before it's invoiced — and is it
 * safe to?
 *
 * Field report (2026-08-28): "I tried to invoice from a sales order during
 * the completion process and it sort of worked, but the invoice only showed
 * items that aren't fulfillable, like labor and freight." That is Advanced
 * Shipping: with it on — and it is on here, our own SO status map carries
 * Pending Fulfillment / Partially Fulfilled / Pending Billing — NetSuite's
 * SO→Invoice transform carries only the lines that need no fulfillment.
 * Every part has to pass through an Item Fulfillment first.
 *
 * Fulfilling relieves inventory and posts COGS, so this decision is kept
 * pure and tested rather than inlined in the route: the cost of getting it
 * wrong is real stock and real cost postings, twice.
 *
 * We only ever fulfill the FULL sales order: this runs at completion, when
 * the order is done.
 */

/** NetSuite sales-order status keys (per-type — these are SalesOrd's). */
export type SoStatus = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | string;

export interface FulfillmentInputs {
  /** transaction.status on the sales order. */
  soStatus: SoStatus;
  /** Human label (BUILTIN.DF), used in the messages staff read. */
  soStatusLabel?: string | null;
  /** Item Fulfillments NetSuite already has against this SO. */
  existingFulfillments: number;
  /** How many of those read back as Shipped (status C). Only a SHIPPED
   *  fulfillment has relieved inventory — a Picked or Packed one leaves the
   *  parts un-billable, so the invoice would come up short all over again. */
  shippedFulfillments: number;
}

export type FulfillmentDecision =
  /** Create the fulfillment, then invoice. */
  | { action: 'fulfill' }
  /** Don't fulfill, but invoicing is fine — nothing is waiting to ship. */
  | { action: 'skip'; reason: string }
  /** Don't touch NetSuite at all; tell the user why. */
  | { action: 'block'; error: string };

const label = (i: FulfillmentInputs) => i.soStatusLabel || `status ${i.soStatus}`;

export function decideFulfillment(input: FulfillmentInputs): FulfillmentDecision {
  // Anything already fulfilled is never fulfilled again, whatever the status
  // says. A second fulfillment double-relieves inventory and double-posts
  // COGS — the one outcome this whole path exists to prevent.
  if (input.existingFulfillments > 0) {
    if (input.shippedFulfillments > 0) {
      return {
        action: 'skip',
        reason: `already fulfilled in NetSuite (${input.existingFulfillments} item fulfillment${input.existingFulfillments === 1 ? '' : 's'})`,
      };
    }
    // Fulfilled but not shipped: the parts still aren't billable, and
    // creating another fulfillment is the one thing we must never do.
    return {
      action: 'block',
      error: 'This sales order already has an item fulfillment that NetSuite has not marked Shipped, so its parts are not billable yet. Set that fulfillment to Shipped in NetSuite, then invoice.',
    };
  }

  switch (input.soStatus) {
    case 'B': // Pending Fulfillment
    case 'D': // Partially Fulfilled
    case 'E': // Pending Billing/Partially Fulfilled
      return { action: 'fulfill' };

    // Pending Billing: everything fulfillable is shipped (or there was
    // nothing to ship — a labor-only order). Invoice straight through.
    case 'F':
      return { action: 'skip', reason: 'nothing left to fulfill — the sales order is pending billing' };

    case 'A':
      return { action: 'block', error: 'This sales order is still Pending Approval in NetSuite. Approve it there, then invoice.' };
    case 'C':
      return { action: 'block', error: 'This sales order is cancelled in NetSuite.' };
    case 'G':
      return { action: 'block', error: 'This sales order is already fully billed in NetSuite.' };
    case 'H':
      return { action: 'block', error: 'This sales order is closed in NetSuite.' };

    // An unrecognized status is not a licence to move stock. Fulfilling is
    // irreversible bookkeeping; a human reads the message and decides.
    default:
      return {
        action: 'block',
        error: `Unexpected sales order ${label(input)} — fulfil and invoice this one in NetSuite directly.`,
      };
  }
}

/**
 * NetSuite's REST errors are wire text. Turn the ones staff will actually
 * hit into an instruction, keeping the raw error for the console.
 */
export function describeFulfillmentError(raw: string): string {
  const t = (raw || '').toLowerCase();

  if (/permission|insufficient_permission|not have permission/.test(t)) {
    return 'The NetSuite integration role cannot create Item Fulfillments. Grant it Transactions › Fulfill Sales Orders (and the Item Fulfillment record permission), then try again.';
  }
  if (/insufficient quantity|not enough|exceeds the (available|quantity)|negative inventory/.test(t)) {
    return 'NetSuite says there is not enough on hand at this location to fulfill the order. Receive or transfer the stock in NetSuite first.';
  }
  if (/record has been changed|rcrd_has_been_changed|concurrent/.test(t)) {
    return 'The sales order changed in NetSuite while this was running. Reload and try again.';
  }
  if (/location/.test(t) && /required|missing|enter a value/.test(t)) {
    return 'NetSuite needs a location on the fulfillment lines. Set the sales order’s location in NetSuite, then try again.';
  }
  return 'NetSuite refused the item fulfillment.';
}

/**
 * Does this error read like NetSuite rejecting the SHAPE of our shipStatus
 * field rather than the fulfillment itself? The REST record API takes
 * select fields as `{ id }` on some releases and a bare string on others,
 * so the caller sends the documented object form first and retries with the
 * string when the field itself is what came back invalid.
 */
export function isShipStatusRejection(raw: string): boolean {
  const t = (raw || '').toLowerCase();
  if (!t.includes('shipstatus')) return false;
  return /invalid|unexpected|not a valid|malformed|wrong type/.test(t);
}
