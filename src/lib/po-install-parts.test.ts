import { describe, it, expect } from 'vitest';
import {
  isInstallDescription,
  correctInstallPartNumber,
  applyInstallPartRule,
  partNumberIsDrawingNumber,
  type InstallRuleLine,
} from './po-install-parts';

// 02 = the physical part, 06 = the install charge for it, and the two share a
// suffix. The description is the tiebreaker: an install line is always an 06.

describe('isInstallDescription', () => {
  it('catches install in the forms these POs use', () => {
    for (const d of [
      'INSTALL GRAPHIC KIT',
      'Installation of shelving',
      'KIT INSTALLED AT PLANT',
      'INSTL PARTITION',
      'INST LADDER RACK',
      'labor to install rack',
    ]) {
      expect(isInstallDescription(d), d).toBe(true);
    }
  });

  it('leaves physical-part descriptions alone', () => {
    for (const d of ['GRAPHIC KIT-FORD TRANSIT', 'SHELF UNIT 48IN', 'PARTITION', '', null, undefined]) {
      expect(isInstallDescription(d as any), String(d)).toBe(false);
    }
  });
});

describe('correctInstallPartNumber', () => {
  it('rewrites a 02 on an install line to its 06 counterpart', () => {
    expect(correctInstallPartNumber('02T278', 'INSTALL GRAPHIC KIT'))
      .toEqual({ value: '06T278', corrected: true });
    expect(correctInstallPartNumber(' 02t278 ', 'Installation'))
      .toEqual({ value: '06t278', corrected: true });
  });

  it('leaves everything else as read', () => {
    // Already correct
    expect(correctInstallPartNumber('06T278', 'INSTALL KIT')).toEqual({ value: '06T278', corrected: false });
    // Physical-part line keeps its 02
    expect(correctInstallPartNumber('02T278', 'GRAPHIC KIT-FORD TRANSIT')).toEqual({ value: '02T278', corrected: false });
    // Not a 02/06 number at all
    expect(correctInstallPartNumber('RM530432', 'INSTALL KIT')).toEqual({ value: 'RM530432', corrected: false });
    // No number
    expect(correctInstallPartNumber('', 'INSTALL KIT')).toEqual({ value: '', corrected: false });
    expect(correctInstallPartNumber(null, 'INSTALL KIT')).toEqual({ value: '', corrected: false });
  });

  it('never rewrites an 06 down to an 02 on a non-install line', () => {
    // Absence of the word "install" isn't proof of a misread, so leave it.
    expect(correctInstallPartNumber('06T278', 'GRAPHIC KIT')).toEqual({ value: '06T278', corrected: false });
  });
});

describe('applyInstallPartRule', () => {
  it('corrects both the buyer part and the supplier part, and flags the line', () => {
    const { lines, correctedCount } = applyInstallPartRule<InstallRuleLine>([
      { part_number: '02T278', supplier_part: '02T278', description: 'GRAPHIC KIT-FORD TRANSIT', quantity: 10 },
      { part_number: '02T278', supplier_part: '02T278', description: 'INSTALL GRAPHIC KIT-FORD TRANSIT', quantity: 10 },
    ]);
    expect(correctedCount).toBe(1);
    expect(lines[0]).toEqual({ part_number: '02T278', supplier_part: '02T278', description: 'GRAPHIC KIT-FORD TRANSIT', quantity: 10 });
    expect(lines[1].part_number).toBe('06T278');
    expect(lines[1].supplier_part).toBe('06T278');
    expect(lines[1].install_prefix_corrected).toBe(true);
    // Other fields survive
    expect(lines[1].quantity).toBe(10);
  });

  it('corrects a supplier part even when the buyer part uses another scheme', () => {
    const { lines, correctedCount } = applyInstallPartRule([
      { part_number: 'RM530432', supplier_part: '02T278', description: 'INSTALL KIT' },
    ]);
    expect(correctedCount).toBe(1);
    expect(lines[0].part_number).toBe('RM530432');
    expect(lines[0].supplier_part).toBe('06T278');
  });

  it('leaves a clean extraction untouched', () => {
    const input = [
      { part_number: '02T278', description: 'GRAPHIC KIT' },
      { part_number: '06T278', description: 'INSTALL GRAPHIC KIT' },
    ];
    const { lines, correctedCount } = applyInstallPartRule(input);
    expect(correctedCount).toBe(0);
    expect(lines).toEqual(input);
    expect(lines[0]).toBe(input[0]); // untouched lines aren't cloned
  });

  it('handles empty / missing input', () => {
    expect(applyInstallPartRule([])).toEqual({ lines: [], correctedCount: 0, drawingColumnCount: 0 });
    expect(applyInstallPartRule(null)).toEqual({ lines: [], correctedCount: 0, drawingColumnCount: 0 });
  });
});

// PO 35050312 as it actually arrived: the item number is 06U233 (left of the
// description) and 02U233 is the Drawing Number & Revision (far right). The
// extractor read the drawing column, which looks exactly like a part number.
describe('drawing-column misreads', () => {
  it('spots a part number that is really the drawing number', () => {
    expect(partNumberIsDrawingNumber({ part_number: '02U233', drawing_number: '02U233' })).toBe(true);
    expect(partNumberIsDrawingNumber({ part_number: '02u233', drawing_number: ' 02U233 ' })).toBe(true);
    // The correctly-read row: item number and drawing number differ
    expect(partNumberIsDrawingNumber({ part_number: '06U233', drawing_number: '02U233' })).toBe(false);
    // Nothing to compare against
    expect(partNumberIsDrawingNumber({ part_number: '06U233' })).toBe(false);
    expect(partNumberIsDrawingNumber({ drawing_number: '02U233' })).toBe(false);
    expect(partNumberIsDrawingNumber(null)).toBe(false);
  });

  it('repairs the real PO 35050312 rows through the install rule', () => {
    const { lines, correctedCount, drawingColumnCount } = applyInstallPartRule<InstallRuleLine>([
      { part_number: '02U233', drawing_number: '02U233', description: 'INSTALL DCL VERIZON VZT 2026 CHEVY EXPRESS' },
      { part_number: '02U259', drawing_number: '02U259', description: 'INSTALL DCL VERIZON FIOS DECAL CHEVY EXPRESS' },
    ]);
    expect(correctedCount).toBe(2);
    // Install lines, so the 06 number is knowable — no human needed
    expect(drawingColumnCount).toBe(0);
    expect(lines.map(l => l.part_number)).toEqual(['06U233', '06U259']);
    expect(lines.every(l => l.install_prefix_corrected)).toBe(true);
    expect(lines.some(l => l.part_from_drawing_column)).toBe(false);
  });

  it('flags a drawing-column misread it cannot repair', () => {
    // No install wording, so the item number is not derivable — say so rather
    // than guess a prefix.
    const { lines, correctedCount, drawingColumnCount } = applyInstallPartRule<InstallRuleLine>([
      { part_number: '02U233', drawing_number: '02U233', description: 'DCL VERIZON VZT 2026 CHEVY EXPRESS' },
    ]);
    expect(correctedCount).toBe(0);
    expect(drawingColumnCount).toBe(1);
    expect(lines[0].part_number).toBe('02U233'); // left as read — not invented
    expect(lines[0].part_from_drawing_column).toBe(true);
  });
});
