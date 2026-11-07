/**
 * 榜单键盘导航的纯逻辑（无 DOM、无 React，可单测）：焦点身份 = `{ti, p}`。
 *
 * - `ti` 是队伍序号（幽灵行 = `-1`，与 `engine.ts` 的 `BoardRow.ti` 同源），**不是行下标**：
 *   排序、过滤（仅正式队）、每分钟重建都会挪动行的位置，但「我停在哪一行」跟着队走。
 * - `p` 是列位：`-1`（`TEAM_COL`）= 队名列，`0..cols-1` = 第 p 题。左右就是 `-1 → 0 → … → cols-1`。
 *
 * 为什么不用行下标当身份：`Board.rows` 每次重建都是新数组，下标会随名次跳动；
 * 用 `ti` 才能在同一分钟里"原地不动"，只在行真的消失时退让（见 `resolveFocus`）。
 */

/** 焦点身份：哪一行的哪一列 */
export interface BoardFocus {
  readonly ti: number;
  readonly p: number;
}

/** 当前显示的棋盘：按显示顺序排好的 `ti` 列表 + 题目列数 */
export interface BoardGrid {
  readonly rows: readonly number[];
  readonly cols: number;
}

/** 队名列（第 0 列之外的"第 -1 列"） */
export const TEAM_COL = -1;

/** 最右可聚焦列：没有题目列时只有队名列 */
export const lastCol = (grid: BoardGrid): number => (grid.cols > 0 ? grid.cols - 1 : TEAM_COL);

/** 列位收进 `[TEAM_COL, lastCol]`：列数变少（换场次）时不会留在悬空列上 */
export const clampCol = (grid: BoardGrid, p: number): number => Math.min(Math.max(p, TEAM_COL), lastCol(grid));

/** `ti` 在当前显示顺序里的位置；不在榜上 = -1 */
export const rowIndexOf = (grid: BoardGrid, ti: number): number => grid.rows.indexOf(ti);

export const sameFocus = (a: BoardFocus | null, b: BoardFocus | null): boolean =>
  a !== null && b !== null && a.ti === b.ti && a.p === b.p;

/** 方向键语义（Home/End 带 Ctrl 时兼作"整个榜的首行 / 末行"） */
export type MoveDir = 'left' | 'right' | 'up' | 'down' | 'home' | 'end';

/**
 * 从 `from` 走一步，越界一律夹住（不环绕：环形在几百行的榜上会把人甩到看不见的地方）。
 * 空榜 = null。返回值是新对象，"有没有真的动"由调用方用 `sameFocus` 判。
 */
export function moveFocus(grid: BoardGrid, from: BoardFocus | null, dir: MoveDir, ctrl = false): BoardFocus | null {
  if (grid.rows.length === 0) return null;
  const cur: BoardFocus = from ?? { ti: grid.rows[0]!, p: TEAM_COL };
  // 当前行已经不在榜上（重建后消失）：先把它当第一条行，键位才不会整个失灵
  let idx = rowIndexOf(grid, cur.ti);
  if (idx < 0) idx = 0;
  let p = clampCol(grid, cur.p);
  switch (dir) {
    case 'left':
      p = Math.max(TEAM_COL, p - 1);
      break;
    case 'right':
      p = Math.min(lastCol(grid), p + 1);
      break;
    case 'up':
      idx = Math.max(0, idx - 1);
      break;
    case 'down':
      idx = Math.min(grid.rows.length - 1, idx + 1);
      break;
    case 'home':
      if (ctrl) idx = 0;
      p = TEAM_COL;
      break;
    case 'end':
      if (ctrl) idx = grid.rows.length - 1;
      p = lastCol(grid);
      break;
  }
  return { ti: grid.rows[idx]!, p };
}

/**
 * 榜重建 / 过滤后把旧焦点解释到新棋盘上：
 * - 空榜 → null（榜里一个 `tabIndex=0` 都不留，Tab 直接跳过，不做人造陷阱）；
 * - 焦点行还在 → 保持同一 `ti`（排序换了位置也不跳走），只在列数变少时夹一下列；
 * - 焦点行没了（勾了"仅正式队"、幽灵清掉、切了存档）→ 退回**第一条还在的行**，列位尽量保留；
 * - 从未聚焦过 → 第一条行的队名列，给 Tab 一个稳定的落点。
 *
 * 不变时**返回原对象引用**：调用方可以直接 `setFocus(resolveFocus(...))`，React 会自己短路。
 */
export function resolveFocus(grid: BoardGrid, prev: BoardFocus | null): BoardFocus | null {
  if (grid.rows.length === 0) return null;
  const wantP = clampCol(grid, prev === null ? TEAM_COL : prev.p);
  const idx = prev === null ? 0 : rowIndexOf(grid, prev.ti);
  const ti = idx < 0 ? grid.rows[0]! : grid.rows[idx]!;
  if (prev !== null && prev.ti === ti && prev.p === wantP) return prev;
  return { ti, p: wantP };
}

/** 焦点身份 → DOM 查询用的 `data-*` 值对（选择器由调用方拼，这里只管取值） */
export const focusKey = (f: BoardFocus): string => `${f.ti}:${f.p}`;
