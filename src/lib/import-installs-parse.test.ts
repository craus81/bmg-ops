import { describe, it, expect } from 'vitest';
import { parsePastedText, parseSpreadsheetFile } from './import-installs-parse';

const VIN1 = '1FTBW2CM9PKA12345';
const VIN2 = '1GCHK23U03F123456';

async function xlsxFile(sheets: { name: string; rows: unknown[][] }[], name = 'installs.xlsx'): Promise<File> {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name);
    for (const r of s.rows) ws.addRow(r);
  }
  const buf = await wb.xlsx.writeBuffer();
  return new File([buf as unknown as ArrayBuffer], name);
}

describe('parsePastedText', () => {
  it('maps a tab-separated paste with alias headers', () => {
    const out = parsePastedText(
      `VIN\tSerial No\tIMEI\tICCID\tModel Year\tMake\tModel\tUnit No\n` +
      `${VIN1}\tABC123\t357000000000001\t89148000000000000000\t2024\tFord\tTransit\tU-9\n`,
    );
    expect(out.mode).toBe('header');
    expect(out.rows).toEqual([{
      vin: VIN1,
      serialNumber: 'ABC123',
      imei: '357000000000001',
      iccid: '89148000000000000000',
      vehicleYear: '2024',
      vehicleMake: 'Ford',
      vehicleModel: 'Transit',
      unitNumber: 'U-9',
      partNumber: '',
    }]);
  });

  it('picks up a per-row part column (K8 multi-part import)', () => {
    const out = parsePastedText(
      `VIN\tPart Number\n` +
      `${VIN1}\t06N5TR\n` +
      `${VIN2}\t\n`,
    );
    expect(out.mode).toBe('header');
    expect(out.rows[0].partNumber).toBe('06N5TR');
    // A blank cell means "use the run default" — stays empty here.
    expect(out.rows[1].partNumber).toBe('');
  });

  it('falls back to positional order without a header row', () => {
    const out = parsePastedText(`${VIN1}\tSN1\t357000000000001\t89148000000000000000\n`);
    expect(out.mode).toBe('positional');
    expect(out.rows[0].vin).toBe(VIN1);
    expect(out.rows[0].iccid).toBe('89148000000000000000');
  });

  it('handles quoted CSV fields containing commas', () => {
    const out = parsePastedText(`VIN,SN,IMEI,CCID,Make\n${VIN1},SN1,357000000000001,89148000000000000000,"Ford, Inc."\n`);
    expect(out.mode).toBe('header');
    expect(out.rows[0].vehicleMake).toBe('Ford, Inc.');
  });

  it('finds the header row below a title row', () => {
    const out = parsePastedText(
      `RFID installs — July\nVIN\tSN\tIMEI\tCCID\n${VIN1}\tSN1\t357000000000001\t89148000000000000000\n`,
    );
    expect(out.mode).toBe('header');
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0].serialNumber).toBe('SN1');
  });

  it('returns empty mode for blank input', () => {
    expect(parsePastedText('  \n \n').mode).toBe('empty');
  });
});

describe('parseSpreadsheetFile', () => {
  it('parses a .xlsx with headers, keeping numeric IMEI/ICCID cells out of scientific notation', async () => {
    const file = await xlsxFile([{
      name: 'Sheet1',
      rows: [
        ['VIN', 'SN', 'IMEI', 'CCID', 'Year'],
        [VIN1, 'ABC123', 357000000000001, 89148000000000000000, 2024],
      ],
    }]);
    const out = await parseSpreadsheetFile(file);
    expect(out.mode).toBe('header');
    expect(out.sheetName).toBeUndefined();
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0].vin).toBe(VIN1);
    expect(out.rows[0].imei).toBe('357000000000001');
    // Excel already rounded digits past double precision; we only require
    // plain digits (no "8.9148e+19") so validation sees a real ICCID shape.
    expect(out.rows[0].iccid).toMatch(/^891480\d{14}$/);
    expect(out.rows[0].vehicleYear).toBe('2024');
  });

  it('skips a leading notes sheet and reports which sheet it read', async () => {
    const file = await xlsxFile([
      { name: 'Notes', rows: [['Send to BMG by Friday'], ['Thanks!']] },
      { name: 'Installs', rows: [['VIN', 'SN', 'IMEI', 'CCID'], [VIN2, 'SN2', '357000000000002', '89148000000000000001']] },
    ]);
    const out = await parseSpreadsheetFile(file);
    expect(out.mode).toBe('header');
    expect(out.sheetName).toBe('Installs');
    expect(out.sheetCount).toBe(2);
    expect(out.rows[0].vin).toBe(VIN2);
  });

  it('parses a .csv file', async () => {
    const file = new File([`VIN,SN,IMEI,CCID\n${VIN1},SN1,357000000000001,89148000000000000000\n`], 'installs.csv');
    const out = await parseSpreadsheetFile(file);
    expect(out.mode).toBe('header');
    expect(out.rows[0].iccid).toBe('89148000000000000000');
  });

  it('rejects legacy .xls with a save-as hint', async () => {
    await expect(parseSpreadsheetFile(new File(['x'], 'old.xls'))).rejects.toThrow(/\.xlsx/);
  });

  it('rejects unsupported file types', async () => {
    await expect(parseSpreadsheetFile(new File(['x'], 'scan.pdf'))).rejects.toThrow(/Unsupported/);
  });

  it('rejects a corrupt workbook with a friendly message', async () => {
    await expect(parseSpreadsheetFile(new File(['not a zip'], 'bad.xlsx'))).rejects.toThrow(/re-save/);
  });
});
