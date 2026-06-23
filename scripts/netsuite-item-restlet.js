/**
 * NetSuite RESTlet — Item Field Updater
 *
 * Updates editable fields on an item record so BMG Ops staff can edit a part in
 * the app and have it written back to NetSuite (the source of truth), instead
 * of a local-only edit that the next parts sync would overwrite. Handles:
 *   - description   → salesdescription / purchasedescription
 *   - displayName   → displayname
 *   - purchasePrice → cost
 *   - salesPrice    → base price (price level "Base Price", first quantity tier)
 *
 * Send only the fields that changed; any combination is allowed.
 *
 * Why a RESTlet (and not the REST Record API): updating via the REST Record API
 * requires knowing the item's exact record-type endpoint (inventoryItem vs
 * nonInventoryResaleItem vs serviceSaleItem vs servicePurchaseItem, …), which
 * we don't store and can't reliably derive. SuiteScript resolves the exact
 * record type from the item's internal id, so this works for any item type.
 *
 * POST body (itemId required; everything else optional, send only what changed):
 *   {
 *     "itemId": "12345",
 *     "description": "New description text",
 *     "displayName": "New display name",
 *     "salesPrice": 123.45,
 *     "purchasePrice": 67.89
 *   }
 * Returns JSON: { success: true, itemId, recordType, fieldsSet: [...] }
 *           or: { success: false, error: "..." }
 *
 * Setup in NetSuite (same as the PDF RESTlet):
 *   1. Upload this file to the File Cabinet (e.g. SuiteScripts/bmg-item-restlet.js)
 *   2. Create a Script record: Type = RESTlet, Entry Points: POST = post
 *   3. Deploy the script (role with item edit permission) and note the External URL
 *   4. Set NETSUITE_ITEM_RESTLET_URL in your .env to that URL
 *
 * NOTE: if you previously deployed the description-only version of this script,
 * re-upload this file and the deployment picks up the new fields automatically.
 *
 * @NApiVersion 2.1
 * @NScriptType Restlet
 */
define(['N/search', 'N/record'], function (search, record) {

  function isProvided(v) {
    return v !== undefined && v !== null && v !== '';
  }

  function post(body) {
    body = body || {};
    var itemId = body.itemId;

    if (!itemId) {
      return { success: false, error: 'Missing parameter: itemId' };
    }

    var hasDescription = typeof body.description === 'string';
    var hasDisplayName = typeof body.displayName === 'string';
    var hasSalesPrice = isProvided(body.salesPrice);
    var hasPurchasePrice = isProvided(body.purchasePrice);

    if (!hasDescription && !hasDisplayName && !hasSalesPrice && !hasPurchasePrice) {
      return {
        success: false,
        error: 'Nothing to update: provide description, displayName, salesPrice, or purchasePrice',
      };
    }

    try {
      // Resolve the exact item record type (e.g. 'inventoryitem',
      // 'noninventoryresaleitem', 'serviceitem') from the internal id.
      var recordType = null;
      search.create({
        type: 'item',
        filters: [['internalid', 'anyof', itemId]],
        columns: ['internalid'],
      }).run().each(function (result) {
        recordType = result.recordType;
        return false; // first row only
      });

      if (!recordType) {
        return { success: false, error: 'Item ' + itemId + ' not found' };
      }

      var rec = record.load({ type: recordType, id: parseInt(itemId, 10), isDynamic: false });
      var fieldsSet = [];

      // Description — items expose it as salesdescription and/or
      // purchasedescription depending on type. Set whichever exist so the
      // change is visible regardless of which the catalog sync reads.
      if (hasDescription) {
        var descSet = false;
        ['salesdescription', 'purchasedescription'].forEach(function (fieldId) {
          try {
            rec.setValue({ fieldId: fieldId, value: body.description });
            fieldsSet.push(fieldId);
            descSet = true;
          } catch (e) {
            // Field not present on this item type — skip it.
          }
        });
        if (!descSet) {
          return { success: false, error: 'No description field on record type ' + recordType };
        }
      }

      // Display name — standard field on every item type.
      if (hasDisplayName) {
        rec.setValue({ fieldId: 'displayname', value: body.displayName });
        fieldsSet.push('displayname');
      }

      // Purchase price → cost. Only purchasable item types (inventory,
      // non-inventory/service "for resale" or "for purchase") have it; setValue
      // throws on sale-only items, which surfaces as a clear error to the app.
      if (hasPurchasePrice) {
        rec.setValue({ fieldId: 'cost', value: parseFloat(body.purchasePrice) });
        fieldsSet.push('cost');
      }

      // Sales price → base price = price level "Base Price" (internal id 1),
      // first quantity tier, stored in the 'price1' sublist field 'price_1_',
      // line 0. This is the same value the parts sync reads (pricelevel = 1).
      if (hasSalesPrice) {
        var lineCount = rec.getLineCount({ sublistId: 'price1' });
        if (lineCount < 1) {
          return { success: false, error: 'No base price line on item ' + itemId };
        }
        rec.setSublistValue({ sublistId: 'price1', fieldId: 'price_1_', line: 0, value: parseFloat(body.salesPrice) });
        fieldsSet.push('baseprice');
      }

      rec.save({ enableSourcing: false, ignoreMandatoryFields: true });

      return { success: true, itemId: itemId, recordType: recordType, fieldsSet: fieldsSet };
    } catch (e) {
      return { success: false, error: (e && e.message) ? e.message : String(e) };
    }
  }

  return { post: post };

});
