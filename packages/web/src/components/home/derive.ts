/**
 * 主界面锻台的纯映射（无 DOM、无 React，可单测）：DTO → 跳转架 / 深链。
 * 语义口径见 docs/contracts/34：待补 = problemMarkSummary.todo（未建立时为 null，不拿 0 冒充）。
 */
import type { WorkRecentContestEntryDto } from '@anvil/shared';

/** 跳转架一条：短日期 + 场次 + 待补数 + 深链 */
export interface HomeChip {
  contestId: string;
  title: string;
  /** 存档更新的短日期：当年 `MM-DD`，跨年 `YYYY-MM-DD`（读不出时间的原样给空串，不编） */
  date: string;
  /** null = 题目标记未建立；0 = 建立了但没有待补 */
  todo: number | null;
  href: string;
}

/** 工坊题目标记深链：有待补带 `progress=todo` 预筛，没有就只开面板 */
export const marksHref = (contestId: string, todo: number | null): string =>
  todo !== null && todo > 0
    ? `#/master?object=${encodeURIComponent(contestId)}&panel=problems&progress=todo`
    : `#/master?object=${encodeURIComponent(contestId)}&panel=problems`;

/** 存档 updatedAt → 短日期（当年只报月-日，跨年带年份；解析不出返回空串） */
export const chipDate = (iso: string, now = new Date()): string => {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  const y = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return y === now.getFullYear() ? `${mm}-${dd}` : `${y}-${mm}-${dd}`;
};

/** recents → 跳转架 chips：主角（最近保存那场）已在砧上，这里排除它自己 */
export const chipsOf = (
  recents: readonly WorkRecentContestEntryDto[],
  excludeContestId: string | null,
  now = new Date(),
): HomeChip[] =>
  recents
    .filter((e) => e.contest.id !== excludeContestId)
    .map((e) => {
      const todo = e.contest.problemMarkSummary?.todo ?? null;
      return {
        contestId: e.contest.id,
        title: e.contest.title,
        date: chipDate(e.record.updatedAt, now),
        todo,
        href: marksHref(e.contest.id, todo),
      };
    });
