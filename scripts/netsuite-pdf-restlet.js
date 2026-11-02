/**
 * NetSuite RESTlet — Transaction PDF Generator
 *
 * Renders PDF for Sales Orders, Invoices, Estimates (quotes) and Credit Memos.
 * Deploy as a RESTlet in NetSuite (SuiteScript 2.1).
 *
 * Supported query parameters:
 *   - salesOrderId:  internal ID of a Sales Order
 *   - invoiceId:     internal ID of an Invoice
 *   - estimateId:    internal ID of an Estimate (quote)
 *   - creditMemoId:  internal ID of a Credit Memo
 *
 * Credit memos also need the DEPLOYMENT'S ROLE to hold View on Credit Memo —
 * see docs/netsuite-ledger-grants.md. Without it this script answers with
 * NetSuite's permission error rather than a PDF.
 *
 * Returns JSON: { success: true, pdfBase64: "...", filename: "..." }
 *
 * POST, action attach_pdf (Books part 68, docs/books.md "Invoice PDFs"):
 * FleetSuite's own PDF of an invoice it made, kept in the File Cabinet in the
 * folder "FleetSuite Invoice PDFs" (made the first time) and attached to
 * NetSuite's invoice. The body:
 *   { action: 'attach_pdf', invoiceId: '123456',
 *     fileName: 'Invoice_INV10001_123456.pdf', pdfBase64: '...',
 *     replaceFileId: '9100' }   // optional: an earlier version's file, taken
 *                               // off the invoice once this one is on
 * Sent again with the same name (FleetSuite never heard the first answer), it
 * finds the file it kept and attaches that, so an invoice never gets two.
 * Returns JSON: { success: true, fileId: '9200', reused: false,
 *                 replaced: true | false | null }
 *           or: { success: false, error: "..." }
 * The deployment's role needs Documents and Files (Create) and Invoice (Edit).
 *
 * Setup in NetSuite:
 *   1. Upload this file to the File Cabinet (e.g. SuiteScripts/bmg-pdf-restlet.js)
 *   2. Create a Script record: Type = RESTlet, Entry Points: GET = onGet,
 *      POST = onPost. Re-uploading over a copy from before 2026-11-01.1:
 *      open the script record, Edit, and Save, so it picks up POST.
 *   3. Deploy the script and note the External URL
 *   4. Set NETSUITE_PDF_RESTLET_URL in your .env to that URL
 *
 * @NApiVersion 2.1
 * @NScriptType Restlet
 */
define(['N/render', 'N/record', 'N/file', 'N/search'], function (render, record, file, search) {

  // Bump on every functional edit — see the note in
  // scripts/netsuite-financials-restlet.js. Expected value lives in
  // src/lib/restlet-versions.ts and is asserted by a test.
  var SCRIPT_VERSION = '2026-11-01.1';

  // Where FleetSuite's own invoice PDFs are kept: a folder at the top of the
  // File Cabinet.
  var PDF_FOLDER_NAME = 'FleetSuite Invoice PDFs';
  // The names FleetSuite gives them (netsuitePdfFilename in
  // src/lib/books/own-invoice-pdf.ts), and NetSuite's internal ids.
  var FILE_NAME = /^[A-Za-z0-9_.-]{1,120}\.pdf$/;
  var INTERNAL_ID = /^[0-9]{1,20}$/;

  function onGet(requestParams) {
    requestParams = requestParams || {};
    // Deployment probe for the Integration Checkup. Answered before the
    // missing-parameter branch below, so a ping is never mistaken for a
    // malformed PDF request.
    if (requestParams.action === 'ping') {
      return { success: true, mode: 'ping', version: SCRIPT_VERSION };
    }

    var salesOrderId = requestParams.salesOrderId;
    var invoiceId = requestParams.invoiceId;
    var estimateId = requestParams.estimateId;
    var creditMemoId = requestParams.creditMemoId;

    if (!salesOrderId && !invoiceId && !estimateId && !creditMemoId) {
      return {
        success: false,
        error: 'Missing parameter: provide salesOrderId, invoiceId, estimateId, or creditMemoId'
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
      } else if (creditMemoId) {
        transactionId = parseInt(creditMemoId, 10);
        transactionType = record.Type.CREDIT_MEMO;
        filenamePrefix = 'CreditMemo';
      } else if (estimateId) {
        transactionId = parseInt(estimateId, 10);
        transactionType = record.Type.ESTIMATE;
        filenamePrefix = 'Quote';
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

  function errorText(e) {
    return (e && (e.message || e.name)) ? String(e.message || e.name) : String(e);
  }

  // The folder at the top of the File Cabinet, made the first time.
  function pdfFolderId() {
    var found = null;
    search.create({
      type: search.Type.FOLDER,
      filters: [['name', 'is', PDF_FOLDER_NAME], 'AND', ['parent', 'anyof', '@NONE@']],
      columns: ['internalid']
    }).run().each(function (r) { found = r.id; return false; });
    if (found) return String(found);
    var folder = record.create({ type: record.Type.FOLDER });
    folder.setValue({ fieldId: 'name', value: PDF_FOLDER_NAME });
    return String(folder.save());
  }

  // The file of that name already in the folder: one kept for a send whose
  // answer never reached FleetSuite.
  function keptFile(folderId, name) {
    var found = null;
    search.create({
      type: search.Type.FOLDER,
      filters: [['internalid', 'anyof', folderId], 'AND', ['file.name', 'is', name]],
      columns: [search.createColumn({ name: 'internalid', join: 'file' })]
    }).run().each(function (r) {
      found = r.getValue({ name: 'internalid', join: 'file' });
      return false;
    });
    return found ? String(found) : null;
  }

  // Whether the file is on the invoice already. A search that can't tell
  // says no, and attaching it again changes nothing.
  function onInvoice(invoiceId, fileId) {
    var found = false;
    try {
      search.create({
        type: search.Type.INVOICE,
        filters: [['internalid', 'anyof', invoiceId], 'AND', ['mainline', 'is', 'T'], 'AND', ['file.internalid', 'anyof', fileId]],
        columns: ['internalid']
      }).run().each(function () { found = true; return false; });
    } catch (e) {
      found = false;
    }
    return found;
  }

  function attachPdf(body) {
    var invoiceId = String(body.invoiceId || '');
    var fileName = String(body.fileName || '');
    var replaceFileId = body.replaceFileId === undefined || body.replaceFileId === null || body.replaceFileId === ''
      ? null : String(body.replaceFileId);
    if (!INTERNAL_ID.test(invoiceId)) return { success: false, error: 'attach_pdf needs the invoice\'s internal id' };
    if (!FILE_NAME.test(fileName)) return { success: false, error: 'attach_pdf needs a file name ending in .pdf, letters, digits, _ . - only' };
    if (typeof body.pdfBase64 !== 'string' || body.pdfBase64.length === 0) return { success: false, error: 'attach_pdf needs the PDF' };
    if (replaceFileId !== null && !INTERNAL_ID.test(replaceFileId)) return { success: false, error: 'attach_pdf: replaceFileId must be an internal id' };

    try {
      // An invoice that isn't there (or isn't an invoice) stops it here, before a file is kept.
      search.lookupFields({ type: search.Type.INVOICE, id: invoiceId, columns: ['tranid'] });

      var folderId = pdfFolderId();
      var fileId = keptFile(folderId, fileName);
      var reused = fileId !== null;
      if (!reused) {
        var pdf = file.create({
          name: fileName,
          fileType: file.Type.PDF,
          contents: body.pdfBase64,
          folder: Number(folderId),
          isOnline: false
        });
        fileId = String(pdf.save());
      }

      if (!onInvoice(invoiceId, fileId)) {
        record.attach({
          record: { type: 'file', id: Number(fileId) },
          to: { type: record.Type.INVOICE, id: Number(invoiceId) }
        });
      }

      // The earlier version comes off the invoice; its file stays in the
      // File Cabinet.
      var replaced = null;
      if (replaceFileId !== null && replaceFileId !== fileId) {
        try {
          record.detach({
            record: { type: 'file', id: Number(replaceFileId) },
            from: { type: record.Type.INVOICE, id: Number(invoiceId) }
          });
          replaced = true;
        } catch (e) {
          replaced = false;
        }
      }

      return { success: true, fileId: fileId, reused: reused, replaced: replaced };
    } catch (e) {
      return { success: false, error: 'Failed to attach the PDF: ' + errorText(e) };
    }
  }

  function onPost(body) {
    body = body || {};
    if (body.action === 'ping') {
      return { success: true, mode: 'ping', version: SCRIPT_VERSION };
    }
    if (body.action === 'attach_pdf') {
      return attachPdf(body);
    }
    return { success: false, error: 'Unknown action: send action attach_pdf' };
  }

  return {
    get: onGet,
    post: onPost
  };

});
