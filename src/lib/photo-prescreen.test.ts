import { describe, it, expect } from 'vitest';
import {
  parseModelReply, vinAgrees, decide, buildPrompt, VIN_MATCH_CHARS,
  type ModelReply,
} from './photo-prescreen';

const VIN = '1FTBW3XM4NKA12345';

const good = (over: Partial<ModelReply> = {}): ModelReply => ({
  depicts: 'front of a white cargo van',
  sharp: true, wellExposed: true, installVisible: true,
  vinCharacters: null, comment: null,
  ...over,
});

describe('parseModelReply', () => {
  it('reads a bare JSON object', () => {
    expect(parseModelReply('{"sharp":true}')).toEqual({ sharp: true });
  });
  it('reads one inside a fenced block', () => {
    expect(parseModelReply('```json\n{"sharp":false}\n```')).toEqual({ sharp: false });
  });
  it('reads one wrapped in prose', () => {
    expect(parseModelReply('Sure! {"sharp":true} Hope that helps.')).toEqual({ sharp: true });
  });
  it('returns null on unparseable output rather than an empty object', () => {
    // An empty object would read as "every check came back unknown", which
    // is a different and less honest thing than "we got nothing back".
    expect(parseModelReply('I could not analyse that image.')).toBeNull();
    expect(parseModelReply('{ not json')).toBeNull();
    expect(parseModelReply('')).toBeNull();
  });
});

describe('vinAgrees', () => {
  it('matches on the trailing characters, since plates are rarely fully readable', () => {
    expect(vinAgrees('NKA12345', VIN)).toBe(true);
    expect(vinAgrees('1FTBW3XM4NKA12345', VIN)).toBe(true);
  });

  it('is case- and punctuation-insensitive', () => {
    expect(vinAgrees('nka-12345', VIN)).toBe(true);
  });

  it('reports a genuine disagreement', () => {
    expect(vinAgrees('NKA99999', VIN)).toBe(false);
  });

  it('returns NULL when there is nothing to compare — that is not a mismatch', () => {
    // An unreadable plate is a photo-quality problem, not a wrong vehicle.
    // Collapsing the two would flag every glare-obscured plate as a mix-up.
    expect(vinAgrees(null, VIN)).toBeNull();
    expect(vinAgrees('', VIN)).toBeNull();
    expect(vinAgrees('NKA12345', null)).toBeNull();
  });

  it('will not call a too-short read a mismatch', () => {
    expect(vinAgrees('345', VIN)).toBeNull();
  });

  it('accepts a short read that IS a suffix of the expected VIN', () => {
    expect(vinAgrees('A12345', VIN)).toBe(true);
  });

  it('needs the full window before it will contradict', () => {
    expect(VIN_MATCH_CHARS).toBe(8);
    expect(vinAgrees('12345', '1FTBW3XM4NKA99999')).toBeNull();
  });
});

describe('decide', () => {
  const ctx = { photoType: 'front', expectedVin: VIN };

  it('passes a clean photo', () => {
    const r = decide(good(), ctx);
    expect(r.verdict).toBe('pass');
  });

  it('is NOT_SCREENED when nothing came back — never a pass', () => {
    const r = decide(null, ctx);
    expect(r.verdict).toBe('not_screened');
    expect(r.notes).toMatch(/has not been checked/);
    expect(r.findings).toEqual([]);
  });

  it('calls for a retake on a definite failure and quotes the model comment', () => {
    const r = decide(good({ sharp: false, comment: 'Photo is blurry — hold still and retake.' }), ctx);
    expect(r.verdict).toBe('retake');
    expect(r.notes).toBe('Photo is blurry — hold still and retake.');
  });

  it('falls back to the finding text when the model gave no comment', () => {
    const r = decide(good({ wellExposed: false, comment: null }), ctx);
    expect(r.verdict).toBe('retake');
    expect(r.notes).toMatch(/Too dark or too bright/);
  });

  it('never calls for a retake on uncertainty alone', () => {
    // Sending a crew back because the model was unsure is how the check gets
    // switched off.
    const r = decide(good({ sharp: null, wellExposed: null, installVisible: null, depicts: null }), ctx);
    expect(r.verdict).toBe('unsure');
  });

  it('still passes with a single unknown', () => {
    expect(decide(good({ sharp: null }), ctx).verdict).toBe('pass');
  });

  it('flags a photo filed as the wrong angle', () => {
    const r = decide(good({ depicts: 'rear doors of a van' }), { photoType: 'front', expectedVin: VIN });
    expect(r.verdict).toBe('retake');
    expect(r.findings.find(f => f.key === 'type_match')?.ok).toBe(false);
  });

  it('claims nothing about the angle for "other" and "detail"', () => {
    for (const photoType of ['other', 'detail']) {
      const r = decide(good({ depicts: 'a shelf bracket' }), { photoType, expectedVin: VIN });
      expect(r.findings.find(f => f.key === 'type_match')?.ok).toBeNull();
    }
  });

  it('checks the VIN only on a vin_plate photo', () => {
    const front = decide(good({ vinCharacters: 'NKA99999' }), { photoType: 'front', expectedVin: VIN });
    expect(front.findings.find(f => f.key === 'vin_match')).toBeUndefined();
    expect(front.verdict).toBe('pass');
  });

  it('calls a plate reading as a different vehicle a retake, and says so plainly', () => {
    const r = decide(
      good({ depicts: 'a VIN plate on a door jamb', vinCharacters: 'NKA99999', installVisible: null }),
      { photoType: 'vin_plate', expectedVin: VIN },
    );
    expect(r.verdict).toBe('retake');
    expect(r.findings.find(f => f.key === 'vin_match')?.detail).toMatch(/DIFFERENT vehicle/);
    expect(r.vinRead).toBe('NKA99999');
  });

  it('does NOT call an unreadable plate a wrong VIN', () => {
    const r = decide(
      good({ depicts: 'a VIN plate, glare across it', vinCharacters: null, installVisible: null }),
      { photoType: 'vin_plate', expectedVin: VIN },
    );
    expect(r.findings.find(f => f.key === 'vin_match')?.ok).toBeNull();
    expect(r.verdict).not.toBe('retake');
  });

  it('passes a legible plate that agrees', () => {
    const r = decide(
      good({ depicts: 'VIN sticker', vinCharacters: '1FTBW3XM4NKA12345', installVisible: null }),
      { photoType: 'vin_plate', expectedVin: VIN },
    );
    expect(r.verdict).toBe('pass');
    expect(r.findings.find(f => f.key === 'vin_match')?.ok).toBe(true);
  });

  it('does not ask about installed work on a VIN plate shot', () => {
    const r = decide(good({ installVisible: false, depicts: 'VIN sticker', vinCharacters: '1FTBW3XM4NKA12345' }),
      { photoType: 'vin_plate', expectedVin: VIN });
    expect(r.findings.find(f => f.key === 'install_visible')).toBeUndefined();
    expect(r.verdict).toBe('pass');
  });
});

describe('buildPrompt', () => {
  it('asks for observations, not judgements', () => {
    const p = buildPrompt('front');
    expect(p).toMatch(/Report only what you can see/);
    expect(p).toMatch(/Do not guess/);
    // The model is never told the VIN — asking "does this match X" invites
    // agreement with X. We compare in code.
    expect(p).not.toMatch(/1FTBW/);
    expect(p).toMatch(/Never complete or correct a partially readable VIN/);
  });

  it('names the declared angle so the model can disagree with it', () => {
    expect(buildPrompt('driver_side')).toMatch(/driver's side/);
  });
});
