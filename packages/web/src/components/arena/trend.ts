/**
 * 排名趋势重建（docs/contracts/35 §3）：纯函数、零 DOM、零网络。
 *
 * 榜单本身是按「逐发提交」重建出来的（engine.ts），所以每队的历史名次也能从同一份数据里重算。
 * 关键在于 ICPC 罚时制下**只有首次 AC 会改变分数**：WA / TLE / RE 在 AC 之前不进过题数、也不进罚时，
 * 因此趋势只处理 AC 事件，不需要为每个提交重建整张榜。
 *
 * 口径与 `buildBoard` 严格同源：
 * - 每队每题的首次 AC 时刻与罚时用 `cellAt` 在终局取一次（CE 不罚、重判撤销、无逐发走 summary 兜底）；
 * - 采样时刻的计分截止点 `cap` 与 `buildBoard` 相同（练习 / 封榜视角 = min(时刻, 封榜起点)，回顾解封 = 时刻）；
 * - 名次 = 1 + 比它强的队数，强 = 过题更多或同过题罚时更少；并列同名次、其后跳号（与 `sameScore` 一致）。
 *
 * 采样按「整分钟 + 精确末点」：末点保证图上的最后一名就是当前榜面行的名次（契约 D6 的不变量）。
 */
import {
  capAt,
  cellAt,
  ghostCell,
  minutesOf,
  toMsOrNull,
  type Cell,
  type ContestModel,
  type GhostSub,
} from './engine.ts';

export interface TrendOpts {
  /** 当前视界（毫秒）：练习 = 已走时钟，回顾 = 滑条位置 */
  elapsed: number;
  /** 与榜面「仅正式队」开关一致 */
  onlyFormal: boolean;
  /** 回顾解封：cap 直接取采样时刻；false = 按封榜口径冻结 */
  unsealed: boolean;
  /** 「展示我」开启时的幽灵逐发；不传 = 不计入 */
  ghost?: GhostSub[] | null;
}

export interface TrendPoint {
  /** 比赛分钟；只有末点可能带小数 */
  m: number;
  rank: number;
  solved: number;
  pen: number;
}

export interface RankTrend {
  /** 从 0 到视界的采样点（首点恒为第 1 名） */
  points: TrendPoint[];
  /** 名次发生变化的点（含首点；不含未变化的末点） */
  changes: TrendPoint[];
  /**
   * 黄色小点：只标目标队**自己的提交时刻**（同分钟只留最后一发），不按每次名次变化打点。
   * 名次会被其他队的 AC 不断推着走（300 分钟里可能变 150 次），逐次打点会糊成一条黄带。
   */
  marks: TrendPoint[];
  best: number;
  worst: number;
  final: TrendPoint;
  /** 全场时长（分钟），图表横轴封顶 */
  totalMin: number;
}

interface AcEvent {
  /** 首次 AC 时刻（毫秒） */
  t: number;
  /** 该题贡献的罚时（分钟 + 20 × AC 前失败） */
  pen: number;
}

/** 事件数组按时刻升序，附带罚时前缀和，采样时二分 + O(1) 取罚时 */
interface Timeline {
  times: number[];
  prefix: number[];
}

const eventOf = (c: Cell): AcEvent | null =>
  c.st === 'ac' || c.st === 'fb' ? { t: c.t, pen: minutesOf(c.t) + c.fails * 20 } : null;

function makeTimeline(events: AcEvent[]): Timeline {
  events.sort((a, b) => a.t - b.t);
  const times: number[] = [];
  const prefix: number[] = [0];
  for (const e of events) {
    times.push(e.t);
    prefix.push(prefix[prefix.length - 1]! + e.pen);
  }
  return { times, prefix };
}

/** 某队在 `cap` 时刻的分数：二分找最后一个 ≤ cap 的事件，罚时读前缀和 */
function scoreAt(tl: Timeline, cap: number): { solved: number; pen: number } {
  let lo = 0;
  let hi = tl.times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tl.times[mid]! <= cap) lo = mid + 1;
    else hi = mid;
  }
  return { solved: lo, pen: tl.prefix[lo]! };
}

/** 幽灵行的 AC 事件线；没有逐发（或没传幽灵）→ null */
function ghostTimeline(model: ContestModel, subs: GhostSub[] | null | undefined): Timeline | null {
  if (subs === undefined || subs === null || subs.length === 0) return null;
  const byP = new Map<number, GhostSub[]>();
  for (const s of subs) {
    const list = byP.get(s.p);
    if (list === undefined) byP.set(s.p, [s]);
    else list.push(s);
  }
  const events: AcEvent[] = [];
  for (let p = 0; p < model.problems.length; p++) {
    const e = eventOf(ghostCell(byP.get(p), model.duration, model.duration, model.freezeStart));
    if (e !== null) events.push(e);
  }
  return makeTimeline(events);
}

/**
 * 重建目标队的名次趋势。
 *
 * - `ti >= 0`：`model.teams[ti]`；`ti === -1`：幽灵行（必须传 `opts.ghost` 且非空），
 *   它也参与榜面排名，所以自己的曲线同样能画；
 * - `onlyFormal` 且目标本身是打星队 → `null`（它不在榜上）；幽灵不受该开关影响；
 * - `model.approx`（整场没有逐次提交）→ `null`，调用方给诚实空态，不画假曲线。
 */
export function rankTrend(model: ContestModel, ti: number, opts: TrendOpts): RankTrend | null {
  if (model.approx) return null;
  const target = ti === -1 ? undefined : model.teams[ti];
  if (ti !== -1 && target === undefined) return null;
  if (ti !== -1 && opts.onlyFormal && target!.star) return null;
  const { duration, freezeStart, problems } = model;
  if (!Number.isFinite(duration) || duration <= 0) return null;

  const end = Math.max(0, Math.min(opts.elapsed, duration));
  const endMin = Math.floor(end / 60_000);

  /* 目标队自己的提交时刻：小点只打在这里；同分钟只留最后一发 */
  const subTimes: number[] = [];
  if (ti === -1) {
    for (const s of opts.ghost ?? []) subTimes.push(s.t * 60_000);
  } else {
    for (const list of target!.subs) {
      for (const x of list) {
        const t = toMsOrNull(x.time);
        if (t !== null) subTimes.push(t);
      }
    }
  }

  /* 采样 = 整分钟 + 精确末点 + 每次提交时刻（让打点落在真实提交那一秒） */
  const sampleSet = new Set<number>();
  for (let m = 0; m <= endMin; m++) sampleSet.add(m * 60_000);
  if (endMin * 60_000 < end) sampleSet.add(end);
  for (const t of subTimes) if (t > 0 && t <= end) sampleSet.add(t);
  const samples = [...sampleSet].sort((a, b) => a - b);

  const ghostTl = ghostTimeline(model, opts.ghost);
  const timelines: Timeline[] = [];
  let targetTl: Timeline | null = ti === -1 ? ghostTl : null;
  if (ti === -1 && targetTl === null) return null;

  /* 每队一条 AC 事件时间线；打星队按开关跳过 */
  for (const team of model.teams) {
    if (opts.onlyFormal && team.star) continue;
    const events: AcEvent[] = [];
    for (let p = 0; p < problems.length; p++) {
      const c = cellAt(team.subs[p] ?? [], duration, duration, freezeStart, team.summaries[p], team.verdicts[p]);
      const e = eventOf(c);
      if (e !== null) events.push(e);
    }
    const tl = makeTimeline(events);
    if (team.ti === ti) targetTl = tl;
    timelines.push(tl);
  }
  if (ghostTl !== null) timelines.push(ghostTl);
  if (targetTl === null) return null;

  const points: TrendPoint[] = samples.map((ms) => {
    const cap = opts.unsealed ? ms : capAt(ms, duration, freezeStart);
    const ts = scoreAt(targetTl!, cap);
    let rank = 1;
    for (const tl of timelines) {
      if (tl === targetTl) continue;
      const s = scoreAt(tl, cap);
      if (s.solved > ts.solved || (s.solved === ts.solved && s.pen < ts.pen)) rank++;
    }
    return { m: ms / 60_000, rank, solved: ts.solved, pen: ts.pen };
  });

  const changes: TrendPoint[] = [];
  for (const p of points) {
    if (changes.length === 0 || changes[changes.length - 1]!.rank !== p.rank) changes.push(p);
  }

  /* 小点：按分钟取该队最后一发，再在采样点里找到那一个精确时刻 */
  const markByMinute = new Map<number, number>();
  for (const t of subTimes) {
    if (t > end) continue;
    const minute = Math.floor(t / 60_000);
    const prev = markByMinute.get(minute);
    if (prev === undefined || t > prev) markByMinute.set(minute, t);
  }
  const marks: TrendPoint[] = [];
  samples.forEach((ms, i) => {
    if (markByMinute.get(Math.floor(ms / 60_000)) === ms) marks.push(points[i]!);
  });

  let best = Number.POSITIVE_INFINITY;
  let worst = 0;
  for (const p of points) {
    if (p.rank < best) best = p.rank;
    if (p.rank > worst) worst = p.rank;
  }
  return {
    points,
    changes,
    marks,
    best,
    worst,
    final: points[points.length - 1]!,
    totalMin: duration / 60_000,
  };
}
