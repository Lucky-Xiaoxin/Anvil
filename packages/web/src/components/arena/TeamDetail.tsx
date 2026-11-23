/**
 * 队伍详情三页（docs/contracts/35）：简介 / 提交 / 统计。
 *
 * 弹层壳子仍由 `Popover` + `PopShell` 提供（锚定、焦点、Esc 还焦都不动），
 * 这里只负责三页内容；统计页的排名趋势由 `rankTrend` 纯函数重建、`RankTrendChart` 绘制。
 */
import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { Board, ContestModel, GhostSub } from './engine.ts';
import { clockHMS } from '../../format.ts';
import { PopShell, resClass } from './pops.tsx';
import { RankTrendChart } from './RankTrendChart.tsx';
import { rankTrend } from './trend.ts';
import { subRowsOf, ghostRowsOf } from './team-submissions.ts';

type TabId = 'intro' | 'subs' | 'stats';

const TABS: readonly (readonly [TabId, string])[] = [
  ['intro', '简介'],
  ['subs', '提交'],
  ['stats', '统计'],
];

interface Props {
  model: ContestModel;
  ti: number;
  board: Board;
  /** 当前视界的精确时刻（毫秒）：提交页读到这一刻为止 */
  viewMs: number;
  /** 与 board.cap 相同：提交页的冻结判据 */
  cap: number;
  onlyFormal: boolean;
  /** 回顾解封：统计页按全量结果算；false = 按封榜口径冻结 */
  unsealed: boolean;
  ghost: GhostSub[] | null;
}

export function TeamDetail({ model, ti, board, viewMs, cap, onlyFormal, unsealed, ghost }: Props) {
  const [tab, setTab] = useState<TabId>('intro');
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const isGhost = ti === -1;
  const team = isGhost ? board.ghostTeam ?? null : model.teams[ti] ?? null;
  const row = board.rows.find((r) => r.ti === ti);

  /*
   * 趋势按「整分钟」算，与榜体的 minuteKey 同粒度：榜面每分钟重建一次，
   * 图末点就对到那一分钟，避免同一分钟内两者差一名。
   */
  const trendMinute = Math.min(Math.floor(viewMs / 60_000) * 60_000, model.duration);
  const trend = useMemo(
    () => (tab === 'stats' && team !== null ? rankTrend(model, ti, { elapsed: trendMinute, onlyFormal, unsealed, ghost }) : null),
    [tab, model, ti, team, trendMinute, onlyFormal, unsealed, ghost],
  );

  const subRows = useMemo(() => {
    if (tab !== 'subs' || team === null) return [];
    return isGhost ? ghostRowsOf(model, ghost ?? [], viewMs, cap) : subRowsOf(model, team, viewMs, cap);
  }, [tab, model, team, isGhost, ghost, viewMs, cap]);

  if (team === null) return null;
  const title = isGhost ? team.name : team.name === '' ? team.org || '队伍信息未收录' : team.name;
  const head = { title, sub: isGhost ? team.org : team.name === '' || team.org === '' ? '' : team.org };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const i = TABS.findIndex(([id]) => id === tab);
    const j =
      e.key === 'ArrowRight' ? (i + 1) % TABS.length : e.key === 'ArrowLeft' ? (i + TABS.length - 1) % TABS.length : e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : -1;
    if (j < 0) return;
    e.preventDefault();
    setTab(TABS[j]![0]);
    tabRefs.current[j]?.focus();
  };

  const frozenRows = subRows.some((x) => x.frozen);

  return (
    <PopShell head={head}>
      <div className="pop__tabs" role="tablist" aria-label="队伍详情页签" onKeyDown={onKeyDown}>
        {TABS.map(([id, label], i) => (
          <button
            key={id}
            ref={(el) => {
              tabRefs.current[i] = el;
            }}
            type="button"
            className={`pop__tab${tab === id ? ' is-on' : ''}`}
            role="tab"
            id={`teamtab-${id}`}
            aria-selected={tab === id}
            aria-controls="teampanel"
            tabIndex={tab === id ? 0 : -1}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="pop__tabbody" role="tabpanel" id="teampanel" aria-labelledby={`teamtab-${tab}`}>
        {tab === 'intro' ? (
          <>
            <div className="pop__who">
              {isGhost ? (
                <div className="hint">VP 成绩手动录入，点格子看每题明细。</div>
              ) : team.members.length === 0 ? (
                <div className="hint">快照未收录队员名单。</div>
              ) : (
                team.members.map((m, i) => (
                  <div className="pop__p" key={i}>
                    <span className="av">{m.slice(0, 1)}</span>
                    <span>{m}</span>
                  </div>
                ))
              )}
            </div>
            <div className="pop__rule" />
            <div className="pop__kv">
              <span className="pop__k">Seat</span>
              <span className="pop__v num">{isGhost ? team.seat : `#${team.seat}`}</span>
            </div>
            <div className="pop__kv">
              <span className="pop__k">状态</span>
              <span className="pop__v">{team.star ? <span className="tgtag">打星</span> : row?.medal ? `${row.medalTitle}` : '正式队'}</span>
            </div>
            <div className="pop__kv">
              <span className="pop__k">成绩</span>
              <span className="pop__v">
                {row === undefined ? '当前过滤下不显示' : `第 ${row.rank} 名 · 过 ${row.solved} 题 · 罚时 ${row.pen}`}
              </span>
            </div>
          </>
        ) : tab === 'subs' ? (
          subRows.length === 0 ? (
            <div className="hint">本场没有提交记录。</div>
          ) : (
            <>
              <div className="hint" style={{ marginBottom: 4 }}>
                共 {subRows.length} 发 · 时间倒序
              </div>
              {subRows.map((x) => (
                <div className="pop__subrow" key={x.key}>
                  <span className={x.frozen ? 'res res--frz' : resClass(x.r)}>{x.r}</span>
                  <span className="pop__tm num">{clockHMS(x.t)}</span>
                  <span className="pop__alias">{x.alias}</span>
                  <span className="pop__lg">{x.language}</span>
                </div>
              ))}
              <div className="hint" style={{ marginTop: 8 }}>
                {frozenRows ? '封榜段内的提交判名显示 Frozen · ' : ''}
                罚时 = 过题分钟 + 20 ×（过题前失败 · CE 不罚）
              </div>
            </>
          )
        ) : model.approx ? (
          <div className="hint">本场快照没有逐次提交，无法还原排名变化。</div>
        ) : trend === null ? (
          <div className="hint">没有可用的排名数据。</div>
        ) : (
          <>
            <RankTrendChart trend={trend} freezeMin={model.freezeStart / 60_000} />
            <div className="rankchart__note">
              名次按{onlyFormal ? '仅正式队' : '榜面排名（含打星队）'}口径
              {isGhost ? '；这是「我的成绩」的曲线' : ghost !== null ? '，含「我的成绩」' : ''}；横轴为比赛分钟。
              {!unsealed && viewMs > model.freezeStart && viewMs < model.duration ? ' 当前处于封榜段，曲线走平。' : ''}
            </div>
          </>
        )}
      </div>
    </PopShell>
  );
}
