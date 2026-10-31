import { describe, it, expect } from 'vitest';
import { cleanOptionName, groupMaterialOptions, matchOption, type MaterialOption } from './graphics-material-options';

const opt = (kind: MaterialOption['kind'], name: string, sort_order = 0): MaterialOption => ({ id: `${kind}-${name}`, kind, name, sort_order });

describe('graphics material options', () => {
  it('cleans names', () => {
    expect(cleanOptionName('  3M   8519  Matte ')).toBe('3M 8519 Matte');
  });

  it('groups by kind in list order, then by name', () => {
    const lists = groupMaterialOptions([
      opt('laminate', '8508', 40), opt('vinyl', 'Banner', 60), opt('laminate', 'N/A', 10),
      opt('laminate', 'Zeta', 0), opt('laminate', 'Alpha', 0), opt('premask', 'R-Tape 4075', 20),
    ]);
    expect(lists.laminate.map(o => o.name)).toEqual(['Alpha', 'Zeta', 'N/A', '8508']);
    expect(lists.vinyl.map(o => o.name)).toEqual(['Banner']);
    expect(lists.premask.map(o => o.name)).toEqual(['R-Tape 4075']);
  });

  it('matches saved values ignoring case and spacing', () => {
    const list = [opt('laminate', '8428G'), opt('laminate', 'N/A')];
    expect(matchOption('8428g', list)?.name).toBe('8428G');
    expect(matchOption(' n/a ', list)?.name).toBe('N/A');
  });

  it('treats anything not on the list as Other', () => {
    const list = [opt('laminate', '8428G')];
    expect(matchOption('3M 8519 Matte', list)).toBeNull();
    expect(matchOption('Other', list)).toBeNull();
    expect(matchOption('', list)).toBeNull();
    expect(matchOption(null, list)).toBeNull();
  });
});
