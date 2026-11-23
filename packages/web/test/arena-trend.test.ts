/**
 * 排名趋势重建单测（docs/contracts/35 §7）：纯函数、零网络、夹具自造。
 *
 * 形状照 2026-10-09 实测的 srk.json：`solutions[].time` = [值, 'ms']。
 * 每个用例都尽量回到同一个不变量：趋势末点必须与 `buildBoard` 的对应行完全一致。
 */
import { describe, expect, it } from 'vitest';
import { buildBoard, buildModel, type SrkDoc, type SrkSolution } from '../src/components/arena/engine.ts';
import { rankTrend } from '../src/components/arena/trend.ts';

const M = 60_000;

const sol = (result: string, ms: number): SrkSolution => ({ result, time: [ms, 'ms'], language: 'C++17' });

/**
 * 100 分钟、封榜最后 20 分钟（80′ 起）：
 *  T0 正式：A 10′ AC；B 15′ WA → 20′ AC → 终局 2 题 / 罚时 50
 *  T1 正式：A 10′ AC（与 T0 同分同罚时）
 *  T2 打星：A 5′ AC（更快）
 *  T3 正式：B 90′ AC（封榜段内，终局才揭晓）
 *  T4 正式：只有 CE，不罚时
 */
function fixture(): SrkDoc {
  return {
    contest: { title: { 'zh-CN': '趋势测试站' }, startAt: '2026-11-23T09:00:00+08:00', duration: [100, 'min'], frozenDuration: [20, 'min'] },
    problems: [{ alias: 'A', title: 'Alpha' }, { alias: 'B', title: 'Bravo' }],
    rows: [
      {
        user: { name: '两队同分', id: 'T0', organization: '甲大学', official: true },
        statuses: [
          { result: 'AC', time: [600, 's'], tries: 1, solutions: [sol('AC', 10 * M)] },
          { result: 'AC', time: [1200, 's'], tries: 2, solutions: [sol('WA', 15 * M), sol('AC', 20 * M)] },
        ],
      },
      {
        user: { name: '同分第二队', id: 'T1', organization: '乙大学', official: true },
        statuses: [
          { result: 'AC', time: [600, 's'], tries: 1, solutions: [sol('AC', 10 * M)] },
          { result: null, time: [0, 's'], tries: 0, solutions: [] },
        ],
      },
      {
        user: { name: '打星快队', id: 'S2', organization: '丙大学', official: false },
        statuses: [
          { result: 'AC', time: [300, 's'], tries: 1, solutions: [sol('AC', 5 * M)] },
          { result: null, time: [0, 's'], tries: 0, solutions: [] },
        ],
      },
      {
        user: { name: '封榜后过题', id: 'T3', organization: '丁大学', official: true },
        statuses: [
          { result: null, time: [0, 's'], tries: 0, solutions: [] },
          { result: 'AC', time: [5400, 's'], tries: 1, solutions: [sol('AC', 90 * M)] },
        ],
      },
      {
        user: { name: '编译不过', id: 'T4', organization: '戊大学', official: true },
        statuses: [
          { result: 'RJ', time: [0, 's'], tries: 1, solutions: [sol('CE', 3 * M)] },
          { result: null, time: [0, 's'], tries: 0, solutions: [] },
        ],
      },
    ],
  };
}

describe('rankTrend 排名趋势', () => {
  it('开局全部并列第 1；AC 后名次变化，同分并列', () => {
    const m = buildModel(fixture());
    const tr = rankTrend(m, 0, { elapsed: 100 * M, onlyFormal: false, unsealed: true })!;
    expect(tr).not.toBeNull();
    expect(tr.points[0]).toMatchObject({ m: 0, rank: 1, solved: 0, pen: 0 });
    // 5′ 打星队先过 A：T0 掉到第 2
    expect(tr.points.find((p) => p.m === 5)).toMatchObject({ rank: 2, solved: 0, pen: 0 });
    // 10′ T0 / T1 同过 A、同罚时 → 并列第 2
    expect(tr.points.find((p) => p.m === 10)).toMatchObject({ rank: 2, solved: 1, pen: 10 });
    // 20′ T0 再过 B → 回到第 1
    expect(tr.points.find((p) => p.m === 20)).toMatchObject({ rank: 1, solved: 2, pen: 50 });
    expect(tr.final).toMatchObject({ rank: 1, solved: 2, pen: 50 });
    expect(tr.best).toBe(1);
    expect(tr.worst).toBe(2);
    expect(tr.changes.map((p) => p.rank)).toEqual([1, 2, 1]);
    expect(tr.changes.map((p) => p.m)).toEqual([0, 5, 20]);
    // 小点只落在该队自己的提交时刻，不是每次名次变化
    expect(tr.marks.map((p) => [p.m, p.rank])).toEqual([
      [10, 2],
      [15, 2],
      [20, 1],
    ]);
    expect(tr.totalMin).toBe(100);
  });

  it('并列同名次、其后跳号（1,2,2,4）', () => {
    const m = buildModel(fixture());
    // 10′：T0 / T1 并列第 2；T3 / T4 无过题排第 4
    const trT3 = rankTrend(m, 3, { elapsed: 10 * M, onlyFormal: false, unsealed: true })!;
    expect(trT3.final.rank).toBe(4);
    expect(rankTrend(m, 0, { elapsed: 10 * M, onlyFormal: false, unsealed: true })!.final.rank).toBe(2);
    expect(rankTrend(m, 1, { elapsed: 10 * M, onlyFormal: false, unsealed: true })!.final.rank).toBe(2);
  });

  it('「仅正式队」过滤打星队', () => {
    const m = buildModel(fixture());
    const all = rankTrend(m, 0, { elapsed: 10 * M, onlyFormal: false, unsealed: true })!;
    const formal = rankTrend(m, 0, { elapsed: 10 * M, onlyFormal: true, unsealed: true })!;
    expect(all.final.rank).toBe(2);
    expect(formal.final.rank).toBe(1);
    // 目标本身是打星队且开了过滤 → 它不在榜上，不给趋势
    expect(rankTrend(m, 2, { elapsed: 10 * M, onlyFormal: true, unsealed: true })).toBeNull();
  });

  it('幽灵行在传入时参与比较，不传则不计入', () => {
    const m = buildModel(fixture());
    const ghost = [{ p: 0, t: 1, r: 'AC' as const }];
    const plain = rankTrend(m, 0, { elapsed: 10 * M, onlyFormal: false, unsealed: false })!;
    const withGhost = rankTrend(m, 0, { elapsed: 10 * M, onlyFormal: false, unsealed: false, ghost })!;
    expect(plain.final.rank).toBe(2);
    expect(withGhost.final.rank).toBe(3);
    // 空数组 = 没有幽灵
    expect(rankTrend(m, 0, { elapsed: 10 * M, onlyFormal: false, unsealed: false, ghost: [] })!.final.rank).toBe(2);
  });

  it('封榜段走平，解封视界恢复变化', () => {
    const m = buildModel(fixture());
    // 90′ 练习回放：cap = 80′，90′ 的 AC 不计入
    const live = rankTrend(m, 3, { elapsed: 90 * M, onlyFormal: false, unsealed: false })!;
    expect(live.final).toMatchObject({ solved: 0, pen: 0, rank: 4 });
    // 回顾解封到 90′：同一发 AC 计入
    const review = rankTrend(m, 3, { elapsed: 90 * M, onlyFormal: false, unsealed: true })!;
    expect(review.final).toMatchObject({ solved: 1, pen: 90, rank: 4 });
    // 走到终点（100′）时练习模式也全量解封
    const end = rankTrend(m, 3, { elapsed: 100 * M, onlyFormal: false, unsealed: false })!;
    expect(end.final).toMatchObject({ solved: 1, pen: 90, rank: 4 });
  });

  it('无逐次提交的近似场次返回 null', () => {
    const m = buildModel({
      contest: { title: { 'zh-CN': '只有终局' }, startAt: '', duration: [100, 'min'], frozenDuration: [20, 'min'] },
      problems: [{ alias: 'A' }],
      rows: [{ user: { name: '摘要队', official: true }, statuses: [{ result: 'AC', time: [600, 's'], tries: 1 }] }],
    });
    expect(m.approx).toBe(true);
    expect(rankTrend(m, 0, { elapsed: 100 * M, onlyFormal: false, unsealed: true })).toBeNull();
  });

  it('幽灵行也能画自己的趋势，末点与榜面幽灵行一致', () => {
    const m = buildModel(fixture());
    const ghost = [
      { p: 0, t: 1, r: 'AC' as const },
      { p: 1, t: 50, r: 'WA' as const },
    ];
    const tr = rankTrend(m, -1, { elapsed: 100 * M, onlyFormal: false, unsealed: true, ghost })!;
    const row = buildBoard(m, 100 * M, false, true, ghost).rows.find((r) => r.ti === -1)!;
    expect(tr.final).toMatchObject({ rank: row.rank, solved: row.solved, pen: row.pen });
    expect(tr.marks.map((p) => p.m)).toEqual([1, 50]);
    // 没有幽灵逐发时不给曲线
    expect(rankTrend(m, -1, { elapsed: 100 * M, onlyFormal: false, unsealed: true })).toBeNull();
  });

  it('打点落在真实提交时刻；同分钟只留最后一发', () => {
    const m = buildModel({
      contest: { title: { 'zh-CN': '秒级' }, startAt: '', duration: [100, 'min'], frozenDuration: [20, 'min'] },
      problems: [{ alias: 'A' }, { alias: 'B' }],
      rows: [
        {
          user: { name: '秒级队', official: true },
          statuses: [
            { result: 'AC', time: [630, 's'], tries: 1, solutions: [sol('AC', 10.5 * M)] },
            { result: 'RJ', time: [642, 's'], tries: 1, solutions: [sol('WA', 10.7 * M)] },
          ],
        },
      ],
    });
    const tr = rankTrend(m, 0, { elapsed: 100 * M, onlyFormal: false, unsealed: true })!;
    expect(tr.marks.map((p) => p.m)).toEqual([10.7]);
    expect(tr.points.some((p) => p.m === 10.5)).toBe(true);
  });

  it('末点名次 / 过题 / 罚时与 buildBoard 完全一致（含打星、幽灵、封榜、解封）', () => {
    const m = buildModel(fixture());
    const ghost = [{ p: 0, t: 1, r: 'AC' as const }];
    for (const elapsed of [0, 5 * M, 10 * M, 30 * M, 90 * M, 100 * M]) {
      for (const onlyFormal of [false, true]) {
        for (const unsealed of [false, true]) {
          for (const g of [null, ghost]) {
            const board = buildBoard(m, elapsed, onlyFormal, unsealed, g);
            const tr = rankTrend(m, 0, { elapsed, onlyFormal, unsealed, ghost: g });
            expect(tr).not.toBeNull();
            const row = board.rows.find((r) => r.ti === 0)!;
            expect(tr!.final).toMatchObject({ rank: row.rank, solved: row.solved, pen: row.pen });
            if (g !== null) {
              const gtr = rankTrend(m, -1, { elapsed, onlyFormal, unsealed, ghost: g })!;
              const grow = board.rows.find((r) => r.ti === -1)!;
              expect(gtr.final).toMatchObject({ rank: grow.rank, solved: grow.solved, pen: grow.pen });
            }
          }
        }
      }
    }
  });

  it('视界超过全场时长时按终点截断', () => {
    const m = buildModel(fixture());
    const tr = rankTrend(m, 0, { elapsed: 200 * M, onlyFormal: false, unsealed: true })!;
    expect(tr.final.m).toBe(100);
    expect(tr.points[tr.points.length - 1]!.m).toBe(100);
  });
});
