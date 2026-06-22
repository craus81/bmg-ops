/**
 * NetSuite RESTlet — Item Field Updater
 *
 * Updates the description on an item record. Used by BMG Ops so staff can edit
 * a part's description in the app and have it written back to NetSuite (the
 * source of truth), instead of a local-only edit that the next parts sync would
 * overwrite.
 *
 * Why a RESTlet (and not the REST Record API): updating via the REST Record API
 * requires knowing the item's exact record-type endpoint (inventoryItem vs
 * nonInventoryResaleItem vs serviceSaleItem vs servicePurchaseItem, …), which
 * we don't store and can't reliably derive. SuiteScript resolves the exact
 * record type from the item's internal id, so this works for any item type.
 *
 * POST body: { "itemId": "12345", "description": "New description text" }
 * Returns JSON: { success: true, itemId, recordType, fieldsSet: [...] }
 *           or: { success: false, error: "..." }
 *
 * Setup in NetSuite (same as the PDF RESTlet):
 *   1. Upload this file to the File Cabinet (e.g. SuiteScripts/bmg-item-restlet.js)
 *   2. Create a Script record: Type = RESTlet, Entry Points: POST = post
 *   3. Deploy the script (role with item edit permission) and note the External URL
 *   4. Set NETSUITE_ITEM_RESTLET_URL in your .env to that URL
 *
 * @NApiVersion 2.1
 * @NScriptType Restlet
 */
define(['N/search', 'N/record'], function (search, record) {

  function post(body) {
    var itemId = body && body.itemId;
    var description = body && body.description;

    if (!itemId) {
      return { success: false, error: 'Missing parameter: itemId' };
    }
    if (typeof description !== 'string') {
      return { success: false, error: 'Missing parameter: description' };
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

      // Items expose the "Description" as salesdescription and/or
      // purchasedescription depending on type. Set whichever exist so the
      // change is visible regardless of which the catalog sync reads.
      var fieldsSet = [];
      ['salesdescription', 'purchasedescription'].forEach(function (fieldId) {
        try {
          rec.setValue({ fieldId: fieldId, value: description });
          fieldsSet.push(fieldId);
        } catch (e) {
          // Field not present on this item type — skip it.
        }
      });

      if (fieldsSet.length === 0) {
        return { success: false, error: 'No description field on record type ' + recordType };
      }

      rec.save({ enableSourcing: false, ignoreMandatoryFields: true });

      return { success: true, itemId: itemId, recordType: recordType, fieldsSet: fieldsSet };
    } catch (e) {
      return { success: false, error: (e && e.message) ? e.message : String(e) };
    }
  }

  return { post: post };

});
