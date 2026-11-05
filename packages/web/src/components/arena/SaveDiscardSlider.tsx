/**
 * 保存 / 丢弃 滑动分裂按钮（打磨批次 1）。
 *
 * 固定总宽的圆角壳（overflow hidden）里两张「脸」，宽度互为消长、总宽不变：
 *   save（默认）   保存脸全宽（琥珀黄 · 软盘 + 保存），丢弃脸压成贴右缘 8px 红条；
 *   discard        点红条铺开丢弃脸（红 · 垃圾桶 + 删除），保存脸压成贴左缘 8px 黄条；
 *   armed（警示）  discard 态再点「删除」进入：深红 + 「再点一次」轻微脉动，
 *                  再点才真正执行丢弃；Esc 或点黄脸取消警示退回 discard。
 *
 * 收起色条悬停探头变宽并淡入图标（让人不用点就知道是什么）；初次点开丢弃侧之前
 * 红条轻微呼吸（brightness 脉动），点开过一次记进 localStorage（anvil.arena.discardHintSeen=1）
 * 永不再闪。每次换脸后有 0.5s 哨兵锁，双击/连点不会一路冲到删除。
 * 状态机是纯函数 `sdsTransition`（副作用用 fire 交给调用方），组件只管渲染与装配，
 * 单测不打 DOM。
 */
import { useEffect, useRef, useState } from 'react';
import { Icon } from '../ui.tsx';
import './SaveDiscardSlider.css';

export type SdsState = 'save' | 'discard' | 'armed';

export type SdsAction =
  | { type: 'save-click' }
  | { type: 'discard-click' }
  | { type: 'escape' };

/** 一步转移：`fire` 是要执行的副作用（保存 / 丢弃），由调用方消费；null = 只是换脸 */
export interface SdsTransition {
  next: SdsState;
  fire: 'save' | 'discard' | null;
}

export function sdsTransition(state: SdsState, action: SdsAction): SdsTransition {
  switch (action.type) {
    case 'save-click':
      // save 态点保存脸 = 保存；discard 态点黄条 = 收回保存侧（不触发保存）；armed 态点黄脸 = 取消警示
      if (state === 'save') return { next: 'save', fire: 'save' };
      if (state === 'discard') return { next: 'save', fire: null };
      return { next: 'discard', fire: null };
    case 'discard-click':
      // save 态点红条 = 铺开丢弃侧；discard 态点删除 = 进入警示；armed 态再点 = 执行丢弃并复位
      if (state === 'save') return { next: 'discard', fire: null };
      if (state === 'discard') return { next: 'armed', fire: null };
      return { next: 'save', fire: 'discard' };
    case 'escape':
      // 只在警示态有语义：退回 discard，不执行
      return state === 'armed' ? { next: 'discard', fire: null } : { next: state, fire: null };
  }
}

export const SDS_HINT_KEY = 'anvil.arena.discardHintSeen';

/** 读不到 / 没有 localStorage（隐私模式、node 单测环境）当「看过」，不闪 */
export function sdsHintSeen(): boolean {
  try {
    return window.localStorage.getItem(SDS_HINT_KEY) === '1';
  } catch {
    return true;
  }
}

export function sdsMarkHintSeen(): void {
  try {
    window.localStorage.setItem(SDS_HINT_KEY, '1');
  } catch {
    /* 存不进去就下次再闪一次，不阻塞 */
  }
}

export interface SaveDiscardSliderProps {
  /** bar = 回放顶栏（对齐 .btn--sm：28px 高 / 68px 宽）；row = 目录行（对齐 .btn--xs：24px 高 / 60px 宽） */
  size?: 'bar' | 'row';
  /** 保存脸点击（沿用原保存逻辑） */
  onSave: () => void;
  /** 丢弃脸二击确认后调用（统一的「丢弃未保存练习」处理） */
  onDiscard: () => void;
  /** 保存请求在途 / 目标冲突等：两脸都不可点 */
  busy?: boolean;
  /** 保存脸文案（默认「保存」；保存中传「保存中…」） */
  saveLabel?: string;
  /** 丢弃脸铺开文案（默认「删除」） */
  discardLabel?: string;
  /** 警示态文案（默认「再点一次」） */
  confirmLabel?: string;
}

export function SaveDiscardSlider({
  size = 'bar',
  onSave,
  onDiscard,
  busy = false,
  saveLabel = '保存',
  discardLabel = '删除',
  confirmLabel = '再点一次',
}: SaveDiscardSliderProps) {
  const [state, setState] = useState<SdsState>('save');
  const [hint, setHint] = useState(() => !sdsHintSeen());
  const lockUntilRef = useRef(0);

  const apply = (action: SdsAction): void => {
    if (busy) return;
    // 0.5s 哨兵：每次换脸后短暂锁死，双击/连点不会一路冲到删除；状态没变（如保存）不受影响
    if (Date.now() < lockUntilRef.current) return;
    const t = sdsTransition(state, action);
    if (t.next !== state) lockUntilRef.current = Date.now() + 500;
    // 初见提示：第一次点开丢弃侧就记账，永不再闪
    if (state === 'save' && t.next === 'discard' && hint) {
      sdsMarkHintSeen();
      setHint(false);
    }
    setState(t.next);
    if (t.fire === 'save') onSave();
    else if (t.fire === 'discard') onDiscard();
  };

  /* 警示态的 Esc 取消：照弹层的老路子挂 window，卸载 / 退出警示即摘 */
  useEffect(() => {
    if (state !== 'armed') return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') apply({ type: 'escape' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <div className={`sds${size === 'row' ? ' sds--row' : ''}`} data-state={state} role="group" aria-label="保存或丢弃这条练习">
      <button type="button" className="sds__face sds__face--save" disabled={busy} onClick={() => apply({ type: 'save-click' })}>
        <Icon id="i-save" className="sds__ic" />
        <span className="sds__lab">{saveLabel}</span>
      </button>
      <button
        type="button"
        className={`sds__face sds__face--drop${state === 'save' && hint ? ' is-hint' : ''}${state === 'armed' ? ' is-armed' : ''}`}
        disabled={busy}
        aria-label={state === 'save' ? '丢弃这条练习（先铺开）' : undefined}
        onClick={() => apply({ type: 'discard-click' })}
      >
        <Icon id="i-trash" className="sds__ic" />
        <span className="sds__lab">{state === 'armed' ? confirmLabel : discardLabel}</span>
      </button>
    </div>
  );
}
