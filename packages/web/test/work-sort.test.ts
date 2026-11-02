import { describe, expect, it } from 'vitest';
import type { WorkObjectDto } from '@anvil/shared';
import {
  WORK_SORT_DEFAULT,
  compareWorkObjects,
  defaultDirOf,
  groupWorkObjects,
  groupWorkObjectsBySource,
  isoDate,
  parseWorkSort,
  sortTimeOf,
  sortWorkObjects,
  sourceCrumbsOf,
  workDateLabel,
  type WorkSort,
} from '../src/components/work/derive.ts';
import { WORK_SORT_KEY, loadWorkSort, saveWorkSort, workSortDirHint, workSortDirLabel, type WorkSortStore } from '../src/components/work/work-sort.ts';

const obj = (patch: Partial<WorkObjectDto> = {}): WorkObjectDto => ({
  id: 'obj_0000000001',
  kind: 'problem',
  title: 'Cherry Tree',
  relPath: 'practice/2026-10/cherry-tree',
  parentId: null,
  labels: [],
  links: {},
  archived: false,
  effectiveArchived: false,
  createdAt: '2026-10-21T02:00:00.000Z',
  updatedAt: '2026-10-21T02:10:00.000Z',
  fileCount: 1,
  sourceCount: 0,
  ...patch,
});

const a = obj({ id: 'obj_0000000001', relPath: 'a', title: 'A', createdAt: '2026-08-02T02:00:00.000Z', contentMtime: 1785636000 });
const b = obj({ id: 'obj_0000000002', relPath: 'b', title: 'B', createdAt: '2026-08-11T02:00:00.000Z', contentMtime: 1786413600 });
// c 没有 contentMtime：有效时间退回 createdAt（比 b 新）
const c = obj({ id: 'obj_0000000003', relPath: 'c', title: 'C', createdAt: '2026-08-14T02:00:00.000Z' });
const ids = (list: WorkObjectDto[]): string[] => list.map((item) => item.id);

describe('列表排序（契约 32 §3.1）', () => {
  it('路径 / 创建时间 / 最后修改 × 正倒序', () => {
    const pathAsc: WorkSort = { key: 'path', dir: 'asc' };
    const pathDesc: WorkSort = { key: 'path', dir: 'desc' };
    const createdDesc: WorkSort = { key: 'created', dir: 'desc' };
    const createdAsc: WorkSort = { key: 'created', dir: 'asc' };
    const modifiedDesc: WorkSort = { key: 'modified', dir: 'desc' };
    const modifiedAsc: WorkSort = { key: 'modified', dir: 'asc' };

    expect(ids(sortWorkObjects([c, a, b], pathAsc))).toEqual([a.id, b.id, c.id]);
    expect(ids(sortWorkObjects([a, b, c], pathDesc))).toEqual([c.id, b.id, a.id]);
    expect(ids(sortWorkObjects([a, c, b], createdDesc))).toEqual([c.id, b.id, a.id]);
    expect(ids(sortWorkObjects([a, c, b], createdAsc))).toEqual([a.id, b.id, c.id]);
    // 最后修改：c 没有内容时间，退回 createdAt（8-14），排最上
    expect(ids(sortWorkObjects([a, b, c], modifiedDesc))).toEqual([c.id, b.id, a.id]);
    expect(ids(sortWorkObjects([a, b, c], modifiedAsc))).toEqual([a.id, b.id, c.id]);
  });

  it('时间并列用 relPath 正序兜底；兜底不随方向翻转', () => {
    const same = b.contentMtime;
    expect(sortTimeOf(a)).toBe(a.contentMtime);
    expect(sortTimeOf(c)).toBe(Date.parse(c.createdAt) / 1000);
    const x = obj({ id: 'obj_0000000010', relPath: 'z', contentMtime: same });
    const y = obj({ id: 'obj_0000000011', relPath: 'm', contentMtime: same });
    for (const dir of ['asc', 'desc'] as const) {
      expect(ids(sortWorkObjects([x, y], { key: 'modified', dir }))).toEqual([y.id, x.id]);
    }
    expect(compareWorkObjects(a, a, WORK_SORT_DEFAULT)).toBe(0);
  });

  it('默认方向：路径正序、时间新→旧；非法存储值回默认', () => {
    expect(defaultDirOf('path')).toBe('asc');
    expect(defaultDirOf('created')).toBe('desc');
    expect(defaultDirOf('modified')).toBe('desc');
    expect(parseWorkSort({ key: 'modified', dir: 'asc' })).toEqual({ key: 'modified', dir: 'asc' });
    expect(parseWorkSort({ key: 'nope', dir: 'asc' })).toEqual(WORK_SORT_DEFAULT);
    expect(parseWorkSort({ key: 'path', dir: 'sideways' })).toEqual(WORK_SORT_DEFAULT);
    expect(parseWorkSort(null)).toEqual(WORK_SORT_DEFAULT);
    expect(parseWorkSort('path')).toEqual(WORK_SORT_DEFAULT);
  });

  it('分节独立排序；比赛组与旧子题也按所选键；默认模板判据不受影响', () => {
    const c1 = obj({ id: 'obj_0000000020', kind: 'contest', relPath: 'contests/a', title: 'A', contentMtime: 100 });
    const c2 = obj({ id: 'obj_0000000021', kind: 'contest', relPath: 'contests/b', title: 'B', contentMtime: 300 });
    const p1 = obj({ id: 'obj_0000000022', kind: 'problem', relPath: 'contests/a/1', parentId: c1.id, contentMtime: 100 });
    const p2 = obj({ id: 'obj_0000000023', kind: 'problem', relPath: 'contests/a/2', parentId: c1.id, contentMtime: 200 });
    const s1 = obj({ id: 'obj_0000000024', kind: 'problemset', relPath: 'practice/2026-10/1', contentMtime: 100 });
    const s2 = obj({ id: 'obj_0000000025', kind: 'problemset', relPath: 'practice/2026-10/2', contentMtime: 300 });
    const t1 = obj({ id: 'obj_0000000026', kind: 'template', relPath: 'templates/1', contentMtime: 100, updatedAt: '2026-10-01T00:00:00.000Z' });
    const t2 = obj({ id: 'obj_0000000027', kind: 'template', relPath: 'templates/2', contentMtime: 300, updatedAt: '2026-10-02T00:00:00.000Z' });
    const all = [c1, c2, p1, p2, s1, s2, t1, t2];

    const model = groupWorkObjects(all, all, { key: 'modified', dir: 'desc' });
    expect(model.groups.map((group) => group.contest.id)).toEqual([c2.id, c1.id]);
    expect(model.groups[1]?.problems.map((p) => p.id)).toEqual([p2.id, p1.id]);
    expect(model.problemSets.map((s) => s.id)).toEqual([s2.id, s1.id]);
    expect(model.templates.map((t) => t.id)).toEqual([t2.id, t1.id]);
    // 默认模板仍按 updatedAt 最新（t2），与列表排序无关
    expect(model.defaultTemplateId).toBe(t2.id);
  });
});

describe('来源树排序（契约 32 §3.3 / §3.5）', () => {
  const sourced = (id: string, sourcePath: string): WorkObjectDto =>
    obj({ id, kind: 'problemset', relPath: `practice/2026-10/${id.slice(-1)}`, sourcePath });

  it('路径倒序时每层分组与对象倒序，树结构不变', () => {
    const a1 = sourced('obj_0000000030', '2026/7/A');
    const a2 = sourced('obj_0000000031', '2026/10/B');
    const a3 = sourced('obj_0000000032', '2026/10/C');
    const root = sourced('obj_0000000033', '2026_ICPC_1');

    const asc = groupWorkObjectsBySource([a1, a2, a3, root], 'asc');
    expect(asc.root?.children[0]?.children.map((node) => node.key)).toEqual(['2026/7', '2026/10']);
    expect(asc.root?.children[0]?.children[1]?.objects.map((set) => set.id)).toEqual([a2.id, a3.id]);

    const desc = groupWorkObjectsBySource([a1, a2, a3, root], 'desc');
    expect(desc.root?.children[0]?.children.map((node) => node.key)).toEqual(['2026/10', '2026/7']);
    expect(desc.root?.children[0]?.children[0]?.objects.map((set) => set.id)).toEqual([a3.id, a2.id]);
  });

  it('来源面包屑：有 sourcePath 才返回；根级为空数组', () => {
    expect(sourceCrumbsOf(sourced('obj_0000000030', '2026/8/x'))).toEqual(['2026', '8']);
    expect(sourceCrumbsOf(sourced('obj_0000000031', 'x'))).toEqual([]);
    expect(sourceCrumbsOf(obj())).toBeUndefined();
  });
});

describe('日期显示（契约 32 §6.2）', () => {
  it('ISO 转上海日历日；最后修改优先 contentMtime，没有退回 createdAt', () => {
    expect(isoDate('2026-10-20T16:30:00.000Z')).toBe('2026-10-21');
    expect(isoDate('2026-10-21T02:00:00.000Z')).toBe('2026-10-21');
    expect(isoDate('bad')).toBe('bad');
    expect(workDateLabel(a, 'modified')).toBe('2026-08-02');
    expect(workDateLabel(a, 'created')).toBe('2026-08-02');
    expect(workDateLabel(c, 'modified')).toBe('2026-08-14');
  });
});

describe('排序偏好存储（契约 32 §4.2）', () => {
  class MemoryStore implements WorkSortStore {
    map = new Map<string, string>();
    getItem(key: string): string | null {
      return this.map.get(key) ?? null;
    }
    setItem(key: string, value: string): void {
      this.map.set(key, value);
    }
  }

  it('保存后读回；缺失 / 损坏 / 存储抛错都回默认', () => {
    const store = new MemoryStore();
    expect(loadWorkSort(store)).toEqual(WORK_SORT_DEFAULT);
    saveWorkSort(store, { key: 'created', dir: 'asc' });
    expect(store.getItem(WORK_SORT_KEY)).toBe('{"key":"created","dir":"asc"}');
    expect(loadWorkSort(store)).toEqual({ key: 'created', dir: 'asc' });

    store.setItem(WORK_SORT_KEY, 'not json');
    expect(loadWorkSort(store)).toEqual(WORK_SORT_DEFAULT);
    store.setItem(WORK_SORT_KEY, '{"key":"modified"}');
    expect(loadWorkSort(store)).toEqual(WORK_SORT_DEFAULT);

    const broken: WorkSortStore = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    expect(loadWorkSort(broken)).toEqual(WORK_SORT_DEFAULT);
    expect(() => saveWorkSort(broken, WORK_SORT_DEFAULT)).not.toThrow();
    expect(loadWorkSort(null)).toEqual(WORK_SORT_DEFAULT);
  });

  it('方向按钮文案与提示随键变化', () => {
    expect(workSortDirLabel({ key: 'path', dir: 'asc' })).toBe('↑ 正序');
    expect(workSortDirLabel({ key: 'path', dir: 'desc' })).toBe('↓ 倒序');
    expect(workSortDirLabel({ key: 'modified', dir: 'desc' })).toBe('↓ 新→旧');
    expect(workSortDirLabel({ key: 'created', dir: 'asc' })).toBe('↑ 旧→新');
    expect(workSortDirHint({ key: 'modified', dir: 'desc' })).toContain('最新在前');
    expect(workSortDirHint({ key: 'path', dir: 'desc' })).toContain('路径倒序');
  });
});
