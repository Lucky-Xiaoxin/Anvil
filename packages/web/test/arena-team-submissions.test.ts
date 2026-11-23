/**
 * 队伍提交页纯函数单测（docs/contracts/35 §3.3）：不碰 DOM、不碰网络。
 */
import { describe, expect, it } from 'vitest';
import { buildModel, type SrkDoc, type SrkSolution } from '../src/components/arena/engine.ts';
import { ghostRowsOf, subRowsOf } from '../src/components/arena/team-submissions.ts';

const M = 60_000;
const sol = (result: string, ms: number, language = 'C++17'): SrkSolution => ({ result, time: [ms, 'ms'], language });

function fixture(): SrkDoc {
  return {
    contest: { title: { 'zh-CN': '提交页测试站' }, startAt: '', duration: [100, 'min'], frozenDuration: [20, 'min'] },
    problems: [{ alias: 'A' }, { alias: 'B' }],
    rows: [
      {
        user: { name: '逐发队', official: true },
        statuses: [
          { result: 'AC', time: [1200, 's'], tries: 2, solutions: [sol('WA', 10 * M), sol('AC', 20 * M)] },
          { result: null, time: [1200, 's'], tries: 1, solutions: [sol('WA', 20 * M)] },
        ],
      },
      {
        user: { name: '封榜队', official: true },
        statuses: [
          { result: null, time: [0, 's'], tries: 0, solutions: [] },
          { result: 'AC', time: [5400, 's'], tries: 1, solutions: [sol('AC', 90 * M)] },
        ],
      },
    ],
  };
}

describe('队伍提交页 subRowsOf', () => {
  it('逐发拍平：时间倒序，同刻题号升序', () => {
    const m = buildModel(fixture());
    const rows = subRowsOf(m, m.teams[0]!, 100 * M, 100 * M);
    expect(rows.map((x) => [x.p, x.alias, x.r, x.t])).toEqual([
      [0, 'A', 'AC', 20 * M],
      [1, 'B', 'WA', 20 * M],
      [0, 'A', 'WA', 10 * M],
    ]);
    expect(rows.every((x) => !x.frozen)).toBe(true);
  });

  it('封榜段判名显示 Frozen，不泄露 AC', () => {
    const m = buildModel(fixture());
    const rows = subRowsOf(m, m.teams[1]!, 90 * M, 80 * M);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ p: 1, alias: 'B', r: 'Frozen', frozen: true, t: 90 * M });
  });

  it('没有逐发的题降级成题级摘要', () => {
    const m = buildModel({
      contest: { title: { 'zh-CN': '只有终局' }, startAt: '', duration: [100, 'min'], frozenDuration: [20, 'min'] },
      problems: [{ alias: 'A' }],
      rows: [{ user: { name: '摘要队', official: true }, statuses: [{ result: 'AC', time: [600, 's'], tries: 3 }] }],
    });
    const rows = subRowsOf(m, m.teams[0]!, 100 * M, 100 * M);
    expect(rows).toEqual([{ key: 'sum-0', p: 0, alias: 'A', r: 'AC', t: 10 * M, language: '3 发', frozen: false }]);
  });

  it('摘要时刻晚于当前视界就不出现', () => {
    const m = buildModel({
      contest: { title: { 'zh-CN': '只有终局' }, startAt: '', duration: [100, 'min'], frozenDuration: [20, 'min'] },
      problems: [{ alias: 'A' }],
      rows: [{ user: { name: '摘要队', official: true }, statuses: [{ result: 'AC', time: [5400, 's'], tries: 1 }] }],
    });
    expect(subRowsOf(m, m.teams[0]!, 60 * M, 60 * M)).toEqual([]);
  });
});

describe('幽灵提交页 ghostRowsOf', () => {
  it('时间倒序、手动录入、封榜段 Frozen', () => {
    const m = buildModel(fixture());
    const ghost = [
      { p: 0, t: 10, r: 'AC' as const },
      { p: 1, t: 90, r: 'WA' as const },
    ];
    const rows = ghostRowsOf(m, ghost, 100 * M, 80 * M);
    expect(rows.map((x) => [x.p, x.alias, x.r, x.t, x.language, x.frozen])).toEqual([
      [1, 'B', 'Frozen', 90 * M, '手动录入', true],
      [0, 'A', 'AC', 10 * M, '手动录入', false],
    ]);
  });

  it('晚于当前视界的幽灵提交不出现', () => {
    const m = buildModel(fixture());
    expect(ghostRowsOf(m, [{ p: 0, t: 10, r: 'AC' }], 5 * M, 5 * M)).toEqual([]);
  });
});
