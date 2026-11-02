/**
 * 工坊列表排序偏好（契约 32 §4.2）：localStorage 里只放排序键 + 方向。
 * 读写一律包 try —— 隐私模式下 localStorage 访问本身就可能抛，偏好丢了不该让列表打不开。
 */
import { WORK_SORT_DEFAULT, parseWorkSort, type WorkSort } from './derive.ts';

export const WORK_SORT_KEY = 'work:sort';

/** 界面只需要一个能读写字符串的存储；测试注入桩件，不必造整个 DOM */
export interface WorkSortStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** 浏览器 localStorage 的安全包装：隐私模式下访问本身就可能抛 */
export function browserStore(): WorkSortStore | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function loadWorkSort(store: WorkSortStore | null): WorkSort {
  if (store === null) return WORK_SORT_DEFAULT;
  try {
    const raw = store.getItem(WORK_SORT_KEY);
    return raw === null ? WORK_SORT_DEFAULT : parseWorkSort(JSON.parse(raw));
  } catch {
    return WORK_SORT_DEFAULT;
  }
}

export function saveWorkSort(store: WorkSortStore | null, sort: WorkSort): void {
  if (store === null) return;
  try {
    store.setItem(WORK_SORT_KEY, JSON.stringify(sort));
  } catch {
    /* 只丢偏好，不阻塞列表 */
  }
}

/** 方向按钮文案：路径用正序 / 倒序，时间用新→旧 / 旧→新（契约 32 §6.1） */
export function workSortDirLabel(sort: WorkSort): string {
  if (sort.key === 'path') return sort.dir === 'asc' ? '↑ 正序' : '↓ 倒序';
  return sort.dir === 'desc' ? '↓ 新→旧' : '↑ 旧→新';
}

export function workSortDirHint(sort: WorkSort): string {
  if (sort.key === 'path') {
    return sort.dir === 'asc' ? '当前按路径正序（A→Z）；点击改为倒序' : '当前按路径倒序（Z→A）；点击改为正序';
  }
  return sort.dir === 'desc' ? '当前最新在前；点击改为最旧在前' : '当前最旧在前；点击改为最新在前';
}
