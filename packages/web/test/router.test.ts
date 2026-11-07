/**
 * 路由解析单测（fix/dashboard-route 回归）。纯函数、零 DOM。
 * 核心回归：五个合法路径必须逐一认领——2026-11-08 `dashboard` 一度从表里漏掉，
 * 点「个人数据」永远弹回主界面（默认分支），整个模块不可达。
 */
import { describe, expect, it } from 'vitest';
import { routeFromHash } from '../src/router.ts';

describe('routeFromHash · 默认与合法路径', () => {
  it('空 hash / 根 hash / 未知路径 → 主界面', () => {
    expect(routeFromHash('').view).toBe('home');
    expect(routeFromHash('#').view).toBe('home');
    expect(routeFromHash('#/').view).toBe('home');
    expect(routeFromHash('#/garbage').view).toBe('home');
    expect(routeFromHash('#/garbage?x=1').view).toBe('home');
  });

  it('五个合法路径逐一认领（dashboard 是本次事故的回归位）', () => {
    expect(routeFromHash('#/home').view).toBe('home');
    expect(routeFromHash('#/dashboard').view).toBe('dashboard');
    expect(routeFromHash('#/dashboard?x=1').view).toBe('dashboard');
    expect(routeFromHash('#/settings').view).toBe('settings');
    expect(routeFromHash('#/master').view).toBe('master');
    expect(routeFromHash('#/arena').view).toBe('arena');
  });

  it('dashboard 路由不带 arena / master 入参', () => {
    const r = routeFromHash('#/dashboard');
    expect(r.arena).toBeNull();
    expect(r.master).toBeNull();
  });
});

describe('routeFromHash · 深链入参', () => {
  it('arena：path 必带才给 entry；record 缺省 null；legacy=restore 识别', () => {
    expect(routeFromHash('#/arena').arena).toBeNull();
    expect(routeFromHash('#/arena?x=1').arena).toBeNull();
    expect(routeFromHash('#/arena?path=official/a.srk.json')).toMatchObject({
      arena: { path: 'official/a.srk.json', recordId: null, restoreLegacy: false },
    });
    expect(routeFromHash('#/arena?path=p&record=rec1')).toMatchObject({
      arena: { path: 'p', recordId: 'rec1', restoreLegacy: false },
    });
    expect(routeFromHash('#/arena?path=p&legacy=restore')).toMatchObject({
      arena: { path: 'p', recordId: null, restoreLegacy: true },
    });
  });

  it('master：object 必带才给 entry；panel / progress 白名单外收 null', () => {
    expect(routeFromHash('#/master').master).toBeNull();
    expect(routeFromHash('#/master?x=1').master).toBeNull();
    expect(routeFromHash('#/master?object=o1')).toMatchObject({
      master: { objectId: 'o1', panel: null, marksFilter: null },
    });
    expect(routeFromHash('#/master?object=o1&panel=problems&progress=todo')).toMatchObject({
      master: { objectId: 'o1', panel: 'problems', marksFilter: 'todo' },
    });
    expect(routeFromHash('#/master?object=o1&progress=unmarked')).toMatchObject({
      master: { objectId: 'o1', panel: null, marksFilter: 'unmarked' },
    });
    expect(routeFromHash('#/master?object=o1&progress=bogus&panel=other')).toMatchObject({
      master: { objectId: 'o1', panel: null, marksFilter: null },
    });
  });
});
