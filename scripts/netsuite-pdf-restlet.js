/**
 * NetSuite RESTlet — Transaction PDF Generator
 *
 * Renders PDF for Sales Orders and Invoices.
 * Deploy as a RESTlet in NetSuite (SuiteScript 2.1).
 *
 * Supported query parameters:
 *   - salesOrderId: internal ID of a Sales Order
 *   - invoiceId:    internal ID of an Invoice
 *
 * Returns JSON: { success: true, pdfBase64: "...", filename: "..." }
 *
 * Setup in NetSuite:
 *   1. Upload this file to the File Cabinet (e.g. SuiteScripts/bmg-pdf-restlet.js)
 *   2. Create a Script record: Type = RESTlet, Entry Points: GET = onGet
 *   3. Deploy the script and note the External URL
 *   4. Set NETSUITE_PDF_RESTLET_URL in your .env to that URL
 *
 * @NApiVersion 2.1
 * @NScriptType Restlet
 */
define(['N/render', 'N/record'], function (render, record) {

  function onGet(requestParams) {
    var salesOrderId = requestParams.salesOrderId;
    var invoiceId = requestParams.invoiceId;

    if (!salesOrderId && !invoiceId) {
      return {
        success: false,
        error: 'Missing parameter: provide salesOrderId or invoiceId'
      };
    }

    try {
      var transactionId;
      var transactionType;
      var filenamePrefix;

      if (invoiceId) {
        transactionId = parseInt(invoiceId, 10);
        transactionType = record.Type.INVOICE;
        filenamePrefix = 'Invoice';
      } else {
        transactionId = parseInt(salesOrderId, 10);
        transactionType = record.Type.SALES_ORDER;
        filenamePrefix = 'SalesOrder';
      }

      // Render the transaction as PDF
      var pdfFile = render.transaction({
        entityId: transactionId,
        printMode: render.PrintMode.PDF
      });

      // getContents() on a rendered PDF already returns base64
      var pdfBase64 = pdfFile.getContents();

      // Try to get the transaction number for the filename
      var tranId = '';
      try {
        var rec = record.load({ type: transactionType, id: transactionId, isDynamic: false });
        tranId = rec.getValue({ fieldId: 'tranid' }) || transactionId;
      } catch (e) {
        tranId = transactionId;
      }

      return {
        success: true,
        pdfBase64: pdfBase64,
        filename: filenamePrefix + '_' + tranId + '.pdf'
      };

    } catch (e) {
      return {
        success: false,
        error: 'Failed to generate PDF: ' + e.message
      };
    }
  }

  return {
    get: onGet
  };

});
