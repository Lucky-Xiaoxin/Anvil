/**
 * 排名趋势图的刻度纯函数（docs/contracts/35 §7）：不渲染 DOM，只测取整与边界。
 */
import { describe, expect, it } from 'vitest';
import { minuteTicks, pointAt, rankStep, rankTicks } from '../src/components/arena/RankTrendChart.tsx';
import type { TrendPoint } from '../src/components/arena/trend.ts';

describe('名次刻度', () => {
  it('小名次不造 0 名，逐名取刻度', () => {
    expect(rankStep(1)).toBe(1);
    expect(rankTicks(1)).toEqual([1]);
    expect(rankTicks(2)).toEqual([1, 2]);
    expect(rankTicks(3)).toEqual([1, 2, 3]);
  });

  it('20 名按 5、200 名按 50、300 名按 100 取整', () => {
    expect(rankTicks(20)).toEqual([1, 5, 10, 15, 20]);
    expect(rankTicks(200)).toEqual([1, 50, 100, 150, 200]);
    expect(rankTicks(300)).toEqual([1, 100, 200, 300]);
  });

  it('最大名次不是整步长时不硬造刻度', () => {
    expect(rankTicks(12)).toEqual([1, 5, 10]);
  });
});

describe('时间刻度', () => {
  it('全场 4 等分并去重；0 时长给单点', () => {
    expect(minuteTicks(300)).toEqual([0, 75, 150, 225, 300]);
    expect(minuteTicks(100)).toEqual([0, 25, 50, 75, 100]);
    expect(minuteTicks(0)).toEqual([0]);
  });
});

describe('阶梯读数 pointAt', () => {
  const p = (m: number, rank: number): TrendPoint => ({ m, rank, solved: 0, pen: 0 });
  const points = [p(0, 1), p(5, 3), p(10, 2)];

  it('取最后一个 ≤ 目标分钟的采样点', () => {
    expect(pointAt(points, 0).m).toBe(0);
    expect(pointAt(points, 4.9).m).toBe(0);
    expect(pointAt(points, 5).m).toBe(5);
    expect(pointAt(points, 9.9).m).toBe(5);
    expect(pointAt(points, 10).m).toBe(10);
    expect(pointAt(points, 99).m).toBe(10);
  });

  it('早于首点回落首点', () => {
    expect(pointAt(points, -1).m).toBe(0);
  });
});
