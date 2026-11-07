import { describe, expect, it } from 'vitest';
import {
  TEAM_COL,
  clampCol,
  lastCol,
  moveFocus,
  resolveFocus,
  sameFocus,
  type BoardFocus,
  type BoardGrid,
} from '../src/components/arena/board-focus.ts';

const grid = (rows: number[], cols: number): BoardGrid => ({ rows, cols });
const at = (ti: number, p: number): BoardFocus => ({ ti, p });

describe('榜单键盘导航（board-focus）', () => {
  it('空榜：焦点与移动都是 null，Tab 不会掉进格子里', () => {
    const empty = grid([], 5);
    expect(resolveFocus(empty, null)).toBeNull();
    expect(resolveFocus(empty, at(2, 3))).toBeNull();
    for (const dir of ['left', 'right', 'up', 'down', 'home', 'end'] as const) {
      expect(moveFocus(empty, at(2, 3), dir)).toBeNull();
    }
  });

  it('单行单列（只有队名列）：四个方向都夹在原位', () => {
    const one = grid([7], 0);
    expect(lastCol(one)).toBe(TEAM_COL);
    expect(clampCol(one, 4)).toBe(TEAM_COL);
    const only = at(7, TEAM_COL);
    for (const dir of ['left', 'right', 'up', 'down', 'home', 'end'] as const) {
      expect(moveFocus(one, only, dir)).toEqual(only);
    }
    expect(sameFocus(moveFocus(one, only, 'left')!, only)).toBe(true);
  });

  it('左右：队名列 → A → … → 末列，两端夹住不环绕', () => {
    const g = grid([0, 1, 2], 3);
    expect(moveFocus(g, at(1, TEAM_COL), 'right')).toEqual(at(1, 0));
    expect(moveFocus(g, at(1, 0), 'right')).toEqual(at(1, 1));
    expect(moveFocus(g, at(1, 1), 'right')).toEqual(at(1, 2));
    expect(moveFocus(g, at(1, 2), 'right')).toEqual(at(1, 2)); // 末列不再往右
    expect(moveFocus(g, at(1, 0), 'left')).toEqual(at(1, TEAM_COL));
    expect(moveFocus(g, at(1, TEAM_COL), 'left')).toEqual(at(1, TEAM_COL)); // 队名列是左端
    // 1 列榜：队名列 ↔ 唯一一题
    const single = grid([0, 1], 1);
    expect(moveFocus(single, at(0, TEAM_COL), 'right')).toEqual(at(0, 0));
    expect(moveFocus(single, at(0, 0), 'right')).toEqual(at(0, 0));
    expect(moveFocus(single, at(0, 0), 'left')).toEqual(at(0, TEAM_COL));
  });

  it('上下按当前显示顺序走（排序 / 过滤后的行序，不是 ti 大小）', () => {
    const g = grid([3, 1, 0], 4);
    expect(moveFocus(g, at(3, 2), 'down')).toEqual(at(1, 2));
    expect(moveFocus(g, at(1, 2), 'up')).toEqual(at(3, 2));
    expect(moveFocus(g, at(3, 2), 'up')).toEqual(at(3, 2)); // 榜首不再往上
    expect(moveFocus(g, at(0, 2), 'down')).toEqual(at(0, 2)); // 榜尾不再往下
    // 列位越界时跟着夹住：换场次题目变少
    expect(moveFocus(grid([3, 1], 2), at(3, 3), 'down')).toEqual(at(1, 1));
  });

  it('Home / End 走整行两端，Ctrl 走整榜两端', () => {
    const g = grid([0, 1, 2], 4);
    expect(moveFocus(g, at(1, 2), 'home')).toEqual(at(1, TEAM_COL));
    expect(moveFocus(g, at(1, 2), 'end')).toEqual(at(1, 3));
    expect(moveFocus(g, at(1, 2), 'home', true)).toEqual(at(0, TEAM_COL));
    expect(moveFocus(g, at(1, 2), 'end', true)).toEqual(at(2, 3));
  });

  it('重排后保住同一行（ti 跟着队走），未变时返回原引用', () => {
    const before = grid([0, 1, 2], 4);
    const f = at(1, 3);
    // 名次互换：显示顺序变了，但焦点还在同一支队伍上
    const after = grid([2, 1, 0], 4);
    const kept = resolveFocus(after, f);
    expect(kept).toEqual(f);
    expect(kept).toBe(f); // 同一引用 → setFocus 不会引发多余渲染
    // 幽灵行沉底 / 冒头同理
    expect(resolveFocus(grid([-1, 0, 1], 4), at(-1, 2))).toEqual(at(-1, 2));
  });

  it('行被移除（勾了仅正式队 / 幽灵清掉 / 切存档）：退回第一条还在的行，列位保留', () => {
    // 打星队被过滤掉：榜上只剩 [0, 2]，焦点那支 ti=1 消失 → 第一条行，列位仍是 3
    expect(resolveFocus(grid([0, 2], 4), at(1, 3))).toEqual(at(0, 3));
    // 幽灵行消失（清空我的成绩）：同理落回首行
    expect(resolveFocus(grid([0, 1], 4), at(-1, 0))).toEqual(at(0, 0));
    // 消失 + 列数也变少：列位一起夹到新末列
    expect(resolveFocus(grid([0, 1], 1), at(5, 4))).toEqual(at(0, 0));
    // 首行本身被删：落到新的首行，不是旧下标
    expect(resolveFocus(grid([1, 2], 4), at(0, 2))).toEqual(at(1, 2));
  });

  it('列数下限 / 上限：clampCol 与 lastCol 一致；从未聚焦过落在队名列', () => {
    expect(lastCol(grid([0], 0))).toBe(TEAM_COL);
    expect(lastCol(grid([0], 1))).toBe(0);
    expect(lastCol(grid([0], 13))).toBe(12);
    expect(clampCol(grid([0], 13), -5)).toBe(TEAM_COL);
    expect(clampCol(grid([0], 13), 99)).toBe(12);
    expect(resolveFocus(grid([4, 5, 6], 13), null)).toEqual(at(4, TEAM_COL));
    // 旧焦点列超出新题数：夹到末列，行不变
    expect(resolveFocus(grid([4, 5], 2), at(5, 7))).toEqual(at(5, 1));
  });

  it('焦点行消失时键位不失灵：moveFocus 从首行接着走', () => {
    expect(moveFocus(grid([0, 1, 2], 3), at(9, 1), 'down')).toEqual(at(1, 1));
    expect(moveFocus(grid([0, 1, 2], 3), at(9, 1), 'up')).toEqual(at(0, 1));
  });
});
