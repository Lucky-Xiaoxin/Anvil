/**
 * 主界面锻台纯映射单测（docs/contracts/34）：DTO → 跳转架 chips / 深链。
 * 夹具自造；时间口径：当年短日期、跨年带年份、读不出给空串。
 */
import { describe, expect, it } from 'vitest';
import type { WorkObjectDto, WorkRecentContestEntryDto } from '@anvil/shared';
import { chipDate, chipsOf, marksHref } from '../src/components/home/derive.ts';

const entry = (id: string, title: string, updatedAt: string, todo?: number): WorkRecentContestEntryDto => ({
  contest: {
    id,
    kind: 'contest',
    title,
    relPath: `contests/${id}`,
    parentId: null,
    labels: [],
    links: { arenaPath: `official/x/${id}.srk.json` },
    archived: false,
    effectiveArchived: false,
    createdAt: updatedAt,
    updatedAt,
    fileCount: 1,
    sourceCount: 1,
    ...(todo === undefined ? {} : { problemMarkSummary: { total: 13, marked: 5, todo, starred: 1 } }),
  } as WorkObjectDto,
  record: {
    recordId: `rec_${id}`,
    name: '批次 2',
    createdAt: updatedAt,
    updatedAt,
    result: { origin: 'timed', finish: 'time-limit', durationMs: 18_000_000, stoppedAtMs: null },
    submissionCount: 3,
    revision: 'rev',
  },
});

describe('marksHref 深链', () => {
  it('有待补带 progress=todo 预筛；没有就只开面板', () => {
    expect(marksHref('obj_1', 4)).toBe('#/master?object=obj_1&panel=problems&progress=todo');
    expect(marksHref('obj_1', 0)).toBe('#/master?object=obj_1&panel=problems');
    expect(marksHref('obj_1', null)).toBe('#/master?object=obj_1&panel=problems');
  });

  it('contestId 会转义', () => {
    expect(marksHref('a b&c', 1)).toBe('#/master?object=a%20b%26c&panel=problems&progress=todo');
  });
});

describe('chipDate 短日期', () => {
  it('当年 MM-DD，跨年 YYYY-MM-DD', () => {
    const now = new Date(2026, 10, 8); // 2026-11-08
    expect(chipDate('2026-11-04T21:37:00+08:00', now)).toBe('11-04');
    expect(chipDate('2025-11-16T21:37:00+08:00', now)).toBe('2025-11-16');
  });

  it('读不出的时间给空串，不编日期', () => {
    expect(chipDate('not-a-date', new Date(2026, 0, 1))).toBe('');
  });
});

describe('chipsOf 跳转架', () => {
  it('排除砧上主角，待补数与深链一一对应', () => {
    const recents = [
      entry('hero', '深圳邀请赛', '2026-11-04T21:37:00+08:00', 4),
      entry('b', '武汉邀请赛', '2026-11-02T20:00:00+08:00', 2),
      entry('c', '寒假训练', '2026-02-21T20:00:00+08:00', 0),
      entry('d', '南京站', '2025-11-16T20:00:00+08:00'), // 标记未建立
    ];
    const chips = chipsOf(recents, 'hero', new Date(2026, 10, 8));
    expect(chips.map((c) => c.contestId)).toEqual(['b', 'c', 'd']);
    expect(chips[0]).toMatchObject({ date: '11-02', todo: 2, href: marksHref('b', 2) });
    expect(chips[1]).toMatchObject({ date: '02-21', todo: 0 });
    expect(chips[1]!.href).toBe('#/master?object=c&panel=problems');
    expect(chips[2]).toMatchObject({ todo: null });
    expect(chips[2]!.href).toBe('#/master?object=d&panel=problems');
  });

  it('主角不在架上：exclude 命中的那条不出现', () => {
    const recents = [entry('hero', '深圳邀请赛', '2026-11-04T21:37:00+08:00', 4)];
    expect(chipsOf(recents, 'hero', new Date(2026, 10, 8))).toEqual([]);
  });
});
