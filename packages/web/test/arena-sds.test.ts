/**
 * 保存 / 丢弃 滑动分裂按钮（打磨批次 1）纯逻辑单测：状态机 + 初见提示 flag。
 * 组件只做渲染装配，交互规则全部收敛在 sdsTransition —— 不打 DOM、零网络。
 */
import { describe, expect, it } from 'vitest';
import {
  SDS_HINT_KEY,
  sdsHintSeen,
  sdsMarkHintSeen,
  sdsTransition,
  type SdsState,
} from '../src/components/arena/SaveDiscardSlider.tsx';

describe('滑动分裂按钮状态机', () => {
  it('save 态：点保存脸执行保存；点红条只铺开丢弃侧、不执行', () => {
    expect(sdsTransition('save', { type: 'save-click' })).toEqual({ next: 'save', fire: 'save' });
    expect(sdsTransition('save', { type: 'discard-click' })).toEqual({ next: 'discard', fire: null });
  });

  it('discard 态：点「删除」进警示门；点黄条收回保存侧（不触发保存）', () => {
    expect(sdsTransition('discard', { type: 'discard-click' })).toEqual({ next: 'armed', fire: null });
    expect(sdsTransition('discard', { type: 'save-click' })).toEqual({ next: 'save', fire: null });
  });

  it('警示门：armed 再点「删除」才执行丢弃并复位；Esc / 点黄脸只取消警示退回 discard', () => {
    expect(sdsTransition('armed', { type: 'discard-click' })).toEqual({ next: 'save', fire: 'discard' });
    expect(sdsTransition('armed', { type: 'escape' })).toEqual({ next: 'discard', fire: null });
    expect(sdsTransition('armed', { type: 'save-click' })).toEqual({ next: 'discard', fire: null });
  });

  it('Esc 在非警示态不动', () => {
    expect(sdsTransition('save', { type: 'escape' })).toEqual({ next: 'save', fire: null });
    expect(sdsTransition('discard', { type: 'escape' })).toEqual({ next: 'discard', fire: null });
  });

  it('完整二击序列：save → discard → armed → 执行丢弃，中途取消则不执行', () => {
    let s: SdsState = 'save';
    let t = sdsTransition(s, { type: 'discard-click' });
    s = t.next;
    expect(s).toBe('discard');
    t = sdsTransition(s, { type: 'discard-click' });
    s = t.next;
    expect(s).toBe('armed');
    // 先取消一次：警示解除，不执行
    t = sdsTransition(s, { type: 'escape' });
    s = t.next;
    expect(s).toBe('discard');
    expect(t.fire).toBeNull();
    // 重新进警示门，第二击才真正丢弃
    t = sdsTransition(s, { type: 'discard-click' });
    s = t.next;
    expect(s).toBe('armed');
    t = sdsTransition(s, { type: 'discard-click' });
    expect(t).toEqual({ next: 'save', fire: 'discard' });
  });
});

describe('初见提示 flag（anvil.arena.discardHintSeen）', () => {
  it('键名固定，主控 / 组件两端要一致', () => {
    expect(SDS_HINT_KEY).toBe('anvil.arena.discardHintSeen');
  });

  it('node 测试环境没有 localStorage：当「看过」处理（不闪），写入静默失败', () => {
    expect(sdsHintSeen()).toBe(true);
    expect(() => sdsMarkHintSeen()).not.toThrow();
  });
});
