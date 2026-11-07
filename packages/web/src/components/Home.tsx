/**
 * 主界面（锻台）：功能只有一件——快速回上一场；其余全是装饰，且装饰不编数据
 * （网格 / 水印 / 双气球 / O(n log n) 全部 aria-hidden）。视觉定稿 design/home-demo.html（docs/contracts/34 §依据）。
 *
 * 数据 = `GET /api/work/recent-contest` 的 `recents`（同一口径排序、每场一条、上限 5）；
 * 砧上工件 = recents[0]，跳转架 = recents[1..]。取数机制沿用原「最近保存」卡：
 * 挂载即取、卸载作废未落地响应、模块级缓存让每次回到主界面先画旧值再核对，不吃骨架闪烁。
 */
import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import type { WorkRecentContestDto } from '@anvil/shared';
import { ApiError, getWorkRecentContest } from '../api.ts';
import { messageOf } from '../format.ts';
import { Icon } from './ui.tsx';
import { chipsOf, marksHref } from './home/derive.ts';

type State =
  | { status: 'loading' }
  | { status: 'ready'; dto: WorkRecentContestDto }
  | { status: 'setup'; message: string }
  | { status: 'error'; message: string };

/** 工坊根还没就绪不是故障：与 Workbench 同一批 kind，给一句诚实的空态 + 去处 */
const SETUP_KINDS = new Set(['workspace-unconfigured', 'workspace-uninitialized', 'root-missing', 'root-invalid', 'root-version']);

const go = (hash: string): void => {
  window.location.hash = hash;
};

let lastKnown: WorkRecentContestDto | null = null;

export function Home() {
  const [state, setState] = useState<State>(() => (lastKnown === null ? { status: 'loading' } : { status: 'ready', dto: lastKnown }));
  const abort = useRef<AbortController | null>(null);
  const seq = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const token = ++seq.current;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setState((prev) => (prev.status === 'ready' ? prev : { status: 'loading' }));
    try {
      const dto = await getWorkRecentContest(controller.signal);
      if (token !== seq.current) return;
      lastKnown = dto;
      setState({ status: 'ready', dto });
    } catch (error) {
      if (token !== seq.current) return;
      const api = error instanceof ApiError ? error : new ApiError(messageOf(error));
      if (api.kind === 'aborted') return;
      setState(SETUP_KINDS.has(api.kind) ? { status: 'setup', message: api.message } : { status: 'error', message: api.message });
    } finally {
      if (token === seq.current && abort.current === controller) abort.current = null;
    }
  }, []);

  useEffect(() => {
    void load();
    return () => {
      seq.current += 1;
      abort.current?.abort();
      abort.current = null;
    };
  }, [load]);

  let body: ReactNode;
  if (state.status === 'loading') {
    body = (
      <div className="home-skel" role="status">
        <i />
        正在读最近保存…
      </div>
    );
  } else if (state.status === 'setup') {
    body = (
      <div className="wk-empty wk-empty--small home-flat">
        <div>工坊还没就绪，这里没有可读的存档。</div>
        <div className="home-flat__hint">{state.message}</div>
        <button type="button" className="btn btn--xs" onClick={() => go('/master')}>
          <Icon id="i-arrow" />
          去工坊初始化
        </button>
      </div>
    );
  } else if (state.status === 'error') {
    body = (
      <div className="alert alert--err home-flat" role="status">
        <Icon id="i-plug" />
        <div>最近保存读不出来：{state.message}</div>
        <button type="button" className="alert__x" onClick={() => void load()}>
          重试
        </button>
      </div>
    );
  } else {
    const { dto } = state;
    const recent = dto.recent;
    const warn =
      dto.warnings.length === 0 ? null : (
        <div className="alert alert--warn home-warn" role="status">
          <Icon id="i-warn" />
          <div>
            <b>{dto.warnings.length} 处存档没读全</b> · 砧上这条只是「已知里最近」，不代表全局最新
            <br />
            {dto.warnings[0]}
            {dto.warnings.length > 1 ? ` （另有 ${dto.warnings.length - 1} 条）` : null}
          </div>
        </div>
      );
    body = (
      <>
        {warn}
        {recent === null ? (
          <div className="home-scene">
            <div className="home-head">
              <div className="home-cold-title">炉子是冷的。</div>
              <div className="home-cold-sub">打完一场，在回放页保存，这里就有你的工件。</div>
            </div>
            <div className="home-anvil">
              <svg viewBox="0 0 340 150" aria-hidden="true">
                <path
                  d="M24 40 H232 C268 40 296 46 312 54 C296 60 268 64 232 64 H196 C194 78 188 90 178 98 L206 124 H222 Q236 124 236 136 V148 H104 V136 Q104 124 118 124 H134 L162 98 C152 90 146 78 144 64 H24 Z"
                  fill="#12161D"
                  stroke="#232C39"
                  strokeWidth="1.5"
                />
              </svg>
            </div>
            <div className="home-floor" aria-hidden="true" />
            <div className="home-empty-acts">
              <button type="button" className="btn" onClick={() => go('/arena')}>
                <Icon id="i-play" />
                去回放
              </button>
            </div>
          </div>
        ) : (
          <RecentForge dto={dto} />
        )}
      </>
    );
  }

  return (
    <div className="content home">
      <div className="home-dbg" aria-hidden="true">
        <div className="home-glyph">O(n log n)</div>
        <div className="home-bin">01100001 01101110 01110110 01101001 01101100 · 01100001 01101110 01110110 01101001 01101100</div>
        <svg className="home-bal home-bal-w" viewBox="-20 -24 40 84">
          <path d="M0 -20 C11 -20 15 -10 15 -1 C15 9 8 15 0 15 C-8 15 -15 9 -15 -1 C-15 -10 -11 -20 0 -20 Z" fill="rgba(232,236,243,.04)" />
          <path d="M-3 15 L3 15 L0 20 Z M0 20 C5 30 -5 38 0 50 C2 54 3 56 2 58" />
        </svg>
        <svg className="home-bal home-bal-a" viewBox="-20 -24 40 84">
          <path d="M0 -20 C11 -20 15 -10 15 -1 C15 9 8 15 0 15 C-8 15 -15 9 -15 -1 C-15 -10 -11 -20 0 -20 Z" fill="rgba(245,165,36,.07)" />
          <path d="M-3 15 L3 15 L0 20 Z M0 20 C5 30 -5 38 0 50 C2 54 3 56 2 58" />
        </svg>
      </div>
      {body}
    </div>
  );
}

/** 砧上工件 + 跳转架（有数据的主体） */
function RecentForge({ dto }: { dto: WorkRecentContestDto }): ReactElement {
  const recent = dto.recent!;
  const { contest, record } = recent;
  const summary = contest.problemMarkSummary;
  const todo = summary?.todo ?? null;
  const hotLabel = todo !== null && todo > 0 ? `待补 ${todo} 题` : '查看题目标记';
  const hotAria =
    todo !== null && todo > 0
      ? `继续补题：${contest.title}，待补 ${todo} 题`
      : `查看题目标记：${contest.title}`;
  const chips = chipsOf(dto.recents, contest.id);

  return (
    <div className="home-stage">
      <div className="home-ghost" aria-hidden="true">
        ANVIL
      </div>
      <div className="home-scene">
        <div className="home-glow" aria-hidden="true" />
        <div className="home-head">
          <div className="home-title">{contest.title}</div>
          <div className="home-meta num">
            {record.name} · {summary === undefined ? '题目标记未建立' : `${summary.total} 题 · 待补 ${summary.todo}`}
          </div>
        </div>
        <div className="home-anvil">
          <svg viewBox="0 0 340 150" aria-hidden="true">
            <path
              d="M24 40 H232 C268 40 296 46 312 54 C296 60 268 64 232 64 H196 C194 78 188 90 178 98 L206 124 H222 Q236 124 236 136 V148 H104 V136 Q104 124 118 124 H134 L162 98 C152 90 146 78 144 64 H24 Z"
              fill="#17130D"
              stroke="#3A2C19"
              strokeWidth="1.5"
            />
            <path d="M28 40 H228" stroke="#F5A524" strokeWidth="2" opacity=".35" />
          </svg>
          <button
            type="button"
            className="home-hot"
            aria-label={hotAria}
            title={todo !== null && todo > 0 ? '跳到工坊题目标记 · 按待补预筛' : '跳到工坊题目标记'}
            onClick={() => go(marksHref(contest.id, todo))}
          >
            {hotLabel}
          </button>
          <i className="home-spark s1" aria-hidden="true" />
          <i className="home-spark s2" aria-hidden="true" />
          <i className="home-spark s3" aria-hidden="true" />
          <i className="home-spark s4" aria-hidden="true" />
        </div>
        <div className="home-floor" aria-hidden="true" />
      </div>
      <div className="home-rack">
        {chips.map((chip) => (
          <button type="button" className="home-chip" key={chip.contestId} onClick={() => go(chip.href)}>
            {chip.date === '' ? null : <span className="d num">{chip.date}</span>}
            {chip.title}
            {chip.todo !== null && chip.todo > 0 ? <b className="num">待补 {chip.todo}</b> : null}
          </button>
        ))}
        <button type="button" className="home-more" onClick={() => go('/arena')}>
          回放目录 →
        </button>
      </div>
    </div>
  );
}
