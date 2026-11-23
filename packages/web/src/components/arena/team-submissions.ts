/**
 * 队伍提交页的行（docs/contracts/35 §3.3）：纯函数、零 DOM。
 *
 * 正常场次把逐题 `solutions` 拍平成时间倒序；某题没有可读的逐发时，降级成题级终局摘要 ——
 * 与格子弹层 `SubPop` 的兜底同口径，不把「上游没给逐发」伪装成「没有提交」。
 */
import { subsUntil, type ContestModel, type GhostSub, type TeamModel } from './engine.ts';

export interface SubRow {
  key: string;
  p: number;
  alias: string;
  r: string;
  t: number;
  language: string;
  frozen: boolean;
}

export function subRowsOf(model: ContestModel, team: TeamModel, viewMs: number, cap: number): SubRow[] {
  const rows: SubRow[] = [];
  for (let p = 0; p < model.problems.length; p++) {
    const alias = model.problems[p]?.alias ?? String.fromCharCode(65 + p);
    const subs = team.subs[p] ?? [];
    const list = subs.length === 0 ? [] : subsUntil(subs, viewMs, cap, team.verdicts[p]);
    if (list.length === 0) {
      const s = team.summaries[p];
      if (s === undefined || s.t > viewMs) continue;
      const frozen = s.unknown || s.t > cap;
      rows.push({
        key: `sum-${p}`,
        p,
        alias,
        r: frozen ? 'Frozen' : s.accepted ? (s.fb ? 'FB' : 'AC') : '未过',
        t: s.t,
        language: `${s.tries} 发`,
        frozen,
      });
      continue;
    }
    list.forEach((x, i) => {
      rows.push({
        key: `${p}-${x.t}-${i}`,
        p,
        alias,
        r: x.frozen ? 'Frozen' : x.r,
        t: x.t,
        language: x.language,
        frozen: x.frozen,
      });
    });
  }
  rows.sort((a, b) => b.t - a.t || a.p - b.p);
  return rows;
}

/** 幽灵行（「我的成绩」）的提交页：手动录入的逐发，口径照格子弹层（封榜段 Frozen） */
export function ghostRowsOf(model: ContestModel, subs: readonly GhostSub[], viewMs: number, cap: number): SubRow[] {
  const rows: SubRow[] = [];
  subs.forEach((s, i) => {
    const t = s.t * 60_000;
    if (t > viewMs) return;
    const frozen = t > cap;
    rows.push({
      key: `g-${s.p}-${s.t}-${i}`,
      p: s.p,
      alias: model.problems[s.p]?.alias ?? String.fromCharCode(65 + s.p),
      r: frozen ? 'Frozen' : s.r,
      t,
      language: '手动录入',
      frozen,
    });
  });
  rows.sort((a, b) => b.t - a.t || a.p - b.p);
  return rows;
}
