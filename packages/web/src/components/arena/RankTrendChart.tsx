/**
 * 排名趋势图（docs/contracts/35 §6）：手写 SVG、零依赖。
 *
 * 纵轴名次倒置（第 1 名在上），横轴比赛分钟；阶梯折线因为名次只在 AC 时刻跳变。
 * 采样点由 `rankTrend` 给出（整分钟 + 精确末点），所以线末的名次就是榜面当前名次。
 *
 * 悬停手感：竖虚线跟随鼠标横向移动；靠近黄色小点（该队自己的提交）时吸附到点上并描边，
 * tooltip 跟着吸附点 / 指针走，避免「箭头在图上、鼠标在别处」的脱节感。
 */
import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { useTip } from '../../tip.tsx';
import type { RankTrend, TrendPoint } from './trend.ts';

const H = 196;
const PL = 34;
const PR = 14;
const PT = 18;
const PB = 26;
const FALLBACK_W = 452;
/** 吸附半径（viewBox 像素）：离黄点这么近就吸过去 */
const SNAP_PX = 12;

/** 1 / 2 / 5 × 10^k：让名次刻度落到整数上 */
export function rankStep(max: number): number {
  if (max <= 5) return 1;
  const raw = max / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
}

/** 名次刻度：从 1 起，再按步长取整；不硬造 0 名 */
export function rankTicks(maxRank: number): number[] {
  const step = rankStep(maxRank);
  const out = [1];
  for (let v = step; v <= maxRank; v += step) if (v > 1) out.push(v);
  return out;
}

/** 时间刻度：0 到全场时长的 4 等分（分钟） */
export function minuteTicks(totalMin: number): number[] {
  if (!(totalMin > 0)) return [0];
  const out: number[] = [];
  for (let i = 0; i <= 4; i++) {
    const m = Math.round((totalMin * i) / 4);
    if (!out.includes(m)) out.push(m);
  }
  return out;
}

/** 阶梯读数：找最后一个 `m ≤ minute` 的采样点（hover 不在采样点上时用） */
export function pointAt(points: readonly TrendPoint[], minute: number): TrendPoint {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid]!.m <= minute) lo = mid + 1;
    else hi = mid;
  }
  return points[Math.max(0, lo - 1)] ?? points[0]!;
}

/** 阶梯路径：名次在两次采样之间保持不变，到了下一个时刻才竖直跳变 */
function stepPath(points: TrendPoint[], X: (m: number) => number, Y: (r: number) => number): string {
  if (points.length === 0) return '';
  let d = `M${X(points[0]!.m).toFixed(2)},${Y(points[0]!.rank).toFixed(2)}`;
  for (let i = 1; i < points.length; i++) {
    const cur = points[i]!;
    d += ` H${X(cur.m).toFixed(2)} V${Y(cur.rank).toFixed(2)}`;
  }
  return d;
}

interface Hover {
  /** 竖虚线位置（viewBox x） */
  x: number;
  /** tooltip 锚点（viewBox y）：自由悬停 = 指针高度；吸附 = 黄点高度 */
  y: number;
  point: TrendPoint;
  snapped: boolean;
}

export function RankTrendChart({ trend, freezeMin }: { trend: RankTrend; freezeMin: number }) {
  const { show, hide } = useTip();
  const host = useRef<HTMLDivElement | null>(null);
  const [W, setW] = useState(FALLBACK_W);
  const [hover, setHover] = useState<Hover | null>(null);

  useEffect(() => {
    const el = host.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      const w = Math.round(el.clientWidth) || FALLBACK_W;
      setW((prev) => (Math.abs(prev - w) > 1 ? prev : w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const g = useMemo(() => {
    const maxRank = Math.max(1, trend.worst);
    const yMax = Math.max(2, maxRank);
    const totalMin = Math.max(1, trend.totalMin);
    const X = (m: number): number => PL + (m / totalMin) * (W - PL - PR);
    const Y = (r: number): number => PT + ((r - 1) / (yMax - 1)) * (H - PT - PB);
    return { X, Y, yMax, ticks: rankTicks(maxRank), xTicks: minuteTicks(trend.totalMin), totalMin };
  }, [trend, W]);

  const last = trend.final;
  const lastX = g.X(last.m);
  const lastY = g.Y(last.rank);
  const nowAnchor = lastX > W - PR - 64 ? 'end' : 'start';
  /* 阶梯路径只随趋势 / 宽度变，hover 移动时不重算这 300 多个点 */
  const path = useMemo(() => stepPath(trend.points, g.X, g.Y), [trend, g]);

  const clearHover = (): void => {
    setHover(null);
    hide();
  };

  /*
   * 鼠标横向移动 → 竖线跟随；靠近黄点（该队自己的提交）时吸附到点上并描边。
   * 自由悬停时 tooltip 锚在指针高度，吸附时锚在黄点高度 —— 箭头始终贴着鼠标或点。
   */
  const onMove = (e: MouseEvent<SVGSVGElement>): void => {
    const box = e.currentTarget.getBoundingClientRect();
    const vx = ((e.clientX - box.left) / box.width) * W;
    const vy = ((e.clientY - box.top) / box.height) * H;
    if (vx < PL || vx > W - PR || vy < PT || vy > H - PB) {
      if (hover !== null) clearHover();
      return;
    }

    const minute = ((vx - PL) / (W - PL - PR)) * g.totalMin;
    let snapped: TrendPoint | null = null;
    let best = SNAP_PX;
    for (const p of trend.marks) {
      const d = Math.abs(g.X(p.m) - vx);
      if (d <= best) {
        best = d;
        snapped = p;
      }
    }
    const point = snapped ?? pointAt(trend.points, minute);
    const x = snapped === null ? vx : g.X(snapped.m);
    const y = snapped === null ? vy : g.Y(snapped.rank);
    setHover({ x, y, point, snapped: snapped !== null });
    show({
      x: box.left + (x / W) * box.width,
      y: box.top + (y / H) * box.height,
      date: `比赛第 ${Math.round(point.m)} 分钟`,
      value: `第 ${point.rank} 名`,
      zero: false,
      valueClass: 'is-dim',
      sub: `过 ${point.solved} 题 · 罚时 ${point.pen}`,
    });
  };

  return (
    <>
      <div className="rankchart__title">排名变化趋势图</div>
      <div className="rankchart" ref={host}>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={`排名趋势：当前第 ${last.rank} 名，最高第 ${trend.best} 名，最低第 ${trend.worst} 名`}
          onMouseMove={onMove}
          onMouseLeave={clearHover}
        >
          {/* 横向名次网格 */}
          {g.ticks.map((r) => (
            <g key={r}>
              <line x1={PL} x2={W - PR} y1={g.Y(r)} y2={g.Y(r)} stroke="#222A36" strokeWidth={1} vectorEffect="non-scaling-stroke" />
              <text x={PL - 8} y={g.Y(r) + 3.4} textAnchor="end" fill="#6C7A8C" fontSize={10} fontFamily="Consolas, monospace">
                {r}
              </text>
            </g>
          ))}

          {/* 封榜起点：虚线只标边界，不泄露任何判名 */}
          {freezeMin > 0 && freezeMin < trend.totalMin ? (
            <line
              x1={g.X(freezeMin)}
              x2={g.X(freezeMin)}
              y1={PT}
              y2={H - PB}
              stroke="rgba(148,160,180,.28)"
              strokeDasharray="3 4"
              vectorEffect="non-scaling-stroke"
            />
          ) : null}

          {/* 跟随鼠标的竖虚线（吸附时落在黄点上） */}
          {hover !== null ? (
            <line x1={hover.x} x2={hover.x} y1={PT} y2={H - PB} stroke="rgba(196,208,224,.5)" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
          ) : null}

          <path d={path} fill="none" stroke="#4CC9F0" strokeWidth={1.9} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />

          {/* 黄色小点：只标该队自己的提交时刻（不是每次名次变化，否则会糊成一条黄带） */}
          {trend.marks.map((p, i) => (
            <circle key={`c${i}`} cx={g.X(p.m)} cy={g.Y(p.rank)} r={2.6} fill="#F5A524" />
          ))}

          {/* 吸附时给黄点描边 */}
          {hover !== null && hover.snapped ? (
            <circle
              cx={g.X(hover.point.m)}
              cy={g.Y(hover.point.rank)}
              r={6}
              fill="none"
              stroke="#F5A524"
              strokeWidth={1.4}
              vectorEffect="non-scaling-stroke"
            />
          ) : null}

          <circle cx={lastX} cy={lastY} r={8} fill="rgba(245,165,36,.14)" />
          <circle cx={lastX} cy={lastY} r={4} fill="#F5A524" stroke="#0A0C10" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />

          <text
            x={lastX + (nowAnchor === 'end' ? -9 : 9)}
            y={lastY - 8}
            textAnchor={nowAnchor}
            fill="#F5A524"
            stroke="#0F141B"
            strokeWidth={3}
            paintOrder="stroke"
            fontSize={11}
            fontFamily="Consolas, monospace"
          >
            第 {last.rank} 名
          </text>

          {/* 轴读数 */}
          <text x={PL - 8} y={PT - 6} textAnchor="end" fill="#6C7A8C" fontSize={9.5}>
            名次
          </text>
          {g.xTicks.map((m) => (
            <text key={m} x={g.X(m)} y={H - 8} textAnchor={m === 0 ? 'start' : m === trend.totalMin ? 'end' : 'middle'} fill="#6C7A8C" fontSize={10} fontFamily="Consolas, monospace">
              {m}
            </text>
          ))}

          {/* 透明捕获层：让整块绘图区都能接住 hover（事件冒泡到 svg 根） */}
          <rect x={PL} y={PT} width={W - PL - PR} height={H - PT - PB} fill="transparent" pointerEvents="all" />
        </svg>
      </div>
    </>
  );
}
