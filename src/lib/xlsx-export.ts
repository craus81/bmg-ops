/**
 * Browser-side .xlsx export built on exceljs (dynamically imported so it
 * stays out of the initial bundle). Replaces the SheetJS `xlsx` package,
 * which was dropped for unpatched CVEs in 0.18.x.
 *
 * Rows are plain objects; the keys of the first row become the header row.
 */
export async function downloadXlsx(
  rows: Record<string, unknown>[],
  opts: { sheetName: string; filename: string; colWidths?: number[] }
): Promise<void> {
  const ExcelJS = (await import('exceljs')).default;
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(opts.sheetName);

  const headers = rows.length > 0 ? Object.keys(rows[0]) : [];
  sheet.columns = headers.map((header, i) => ({
    header,
    key: header,
    width: opts.colWidths?.[i],
  }));
  for (const row of rows) sheet.addRow(row);

  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = opts.filename;
  a.click();
  URL.revokeObjectURL(url);
}
