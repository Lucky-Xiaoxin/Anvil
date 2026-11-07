/**
 * hash → 路由（纯函数，可单测）。默认落主界面（docs/contracts/34 §已拍板）。
 *
 * 五个合法路径必须**逐一认领**（home / dashboard / settings / master / arena），
 * 未认领的落主界面。2026-11-08 事故：`dashboard` 一度从这张表里漏掉——
 * typecheck 抓不到（View 类型仍含它），结果是点「个人数据」永远弹回主界面，
 * 整个模块不可达；这正是本文件抽成纯函数并配测试的原因。
 */
import type { View } from './components/AppShell.tsx';
import type { MasterEntry } from './components/work/Workbench.tsx';

export interface ArenaRoute {
  path: string;
  /** 工坊 / 深链指定要打开的存档；null = 该场当前练习 / 终榜 */
  recordId: string | null;
  /** &legacy=restore：把旧 live 恢复为当前练习 */
  restoreLegacy: boolean;
}

export interface AppRoute {
  view: View;
  arena: ArenaRoute | null;
  master: MasterEntry | null;
}

export function routeFromHash(hash: string): AppRoute {
  const h = hash.replace(/^#\/?/, '');
  const [path, query = ''] = h.split('?');
  const view: View =
    path === 'home' || path === 'dashboard' || path === 'settings' || path === 'master' || path === 'arena'
      ? path
      : 'home';
  let arena: ArenaRoute | null = null;
  let master: MasterEntry | null = null;
  if (view === 'arena' && query !== '') {
    const params = new URLSearchParams(query);
    const p = params.get('path');
    if (p !== null && p !== '') {
      const record = params.get('record');
      arena = {
        path: p,
        recordId: record === null || record === '' ? null : record,
        restoreLegacy: params.get('legacy') === 'restore',
      };
    }
  } else if (view === 'master' && query !== '') {
    const params = new URLSearchParams(query);
    const objectId = params.get('object');
    if (objectId !== null && objectId !== '') {
      const progress = params.get('progress');
      master = {
        objectId,
        panel: params.get('panel') === 'problems' ? 'problems' : null,
        marksFilter: progress === 'todo' || progress === 'unmarked' ? progress : null,
      };
    }
  }
  return { view, arena, master };
}
