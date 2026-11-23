/**
 * 回放榜（docs/contracts/16 §5.2 / §5.3 + docs/contracts/29 §3 / §6）：
 * 同一张榜上区分「当前练习 / 查看历史 / 编辑历史 / 查看终榜」，历史只读、当前草稿单键保存。
 *
 * 走钟每秒一次，但**榜只在分钟滚过的那一刻重建**（§4 性能口径）；行组件 memo 化。
 *
 * 榜体是一张 roving-tabindex 网格：整张榜对外只有**一个** Tab 落点（当前焦点格），方向键在格间移动、
 * Enter/空格开弹层、Esc 关层并把焦点还给原来那格。焦点身份是 `{ti, p}`（`p=-1` 队伍列），重建后由
 * `board-focus.ts` 的纯函数解释到新榜上，行组件只多收一个「当前列或 null」，所以一次移动只重渲两行。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ArenaRecord, ArenaRecordResult, ArenaLegacyRecordDto } from '@anvil/shared';
import {
  ApiError,
  createArenaRecord,
  getArenaContest,
  getArenaLegacy,
  getArenaRecordItem,
  listArenaRecords,
  syncProblemMarks,
  updateArenaRecord,
} from '../../api.ts';
import { clockHMS, clockHM, messageOf } from '../../format.ts';
import { Icon } from '../ui.tsx';
import { useTip } from '../../tip.tsx';
import {
  bandRanges,
  buildBoard,
  buildModel,
  elapsedOf,
  inFreezeWindow,
  minutesOf,
  pause as pauseSession,
  problemHeadState,
  startSession,
  subsUntil,
  tick,
  toMs,
  unpause as unpauseSession,
  type Board,
  type BoardRow,
  type Cell,
  type ContestModel,
  type GhostSub,
  type Session,
  type SrkSolution,
  type TeamModel,
} from './engine.ts';
import type { LeafRow } from './catalog.ts';
import { GhostPanel } from './GhostPanel.tsx';
import { Popover, PopShell, resClass, type Anchor } from './pops.tsx';
import { TeamDetail } from './TeamDetail.tsx';
import { TEAM_COL, moveFocus, resolveFocus, sameFocus, type BoardFocus, type BoardGrid, type MoveDir } from './board-focus.ts';
import { SaveDiscardSlider } from './SaveDiscardSlider.tsx';
import {
  applySaveSuccess,
  buildCreatePayload,
  buildUpdatePayload,
  canSaveDraft,
  clearDraft,
  declareFinished,
  discardUnsavedDraft,
  draftFromLegacyLive,
  draftFromRecord,
  finishDraft,
  isDirty,
  loadDraft,
  migrateLegacy,
  newDraft,
  newManualDraft,
  replaceCaseOf,
  saveDraft,
  updateReconciled,
  type ArenaDraft,
  type ReplaceCase,
} from './draft.ts';
import { arenaTitleOf, copySaveName, firstSaveName, newRecordId, recordToGhost } from './record.ts';
import { draftKey } from './draft.ts';
import type { GhostData, Store } from './session.ts';
import { ConfirmDialog, HistoryDialog, NameDialog, ReplaceDialog, type HistoryState } from './ArenaDialogs.tsx';
import { ArenaMenu, type ArenaMenuItem } from './ArenaMenu.tsx';
import { problemsFromArena } from '../work/derive.ts';
import { getWorkObject } from '../../api.ts';
import type { ProblemMarksProblem } from '@anvil/shared';

export type ArenaEntryMode = 'practice' | 'review' | 'record' | 'restore-legacy';

interface Props {
  row: LeafRow;
  store: Store;
  onBack: () => void;
  mode: ArenaEntryMode;
  /** mode=record 时必填；来自 #/arena?...&record= */
  recordId?: string | null;
  /** 从目录「历史成绩」进来时直接打开选择层 */
  openHistory?: boolean;
  /** 草稿 / 正式档变化后通知目录刷新 */
  onDraftChanged?: () => void;
}

type Load = { kind: 'loading' } | { kind: 'error'; text: string; missing: boolean } | { kind: 'ready'; model: ContestModel };

type Identity = { kind: 'practice' } | { kind: 'review' } | { kind: 'view'; recordId: string } | { kind: 'edit' };

interface ViewState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  recordId: string | null;
  record: ArenaRecord | null;
  revision: string | null;
  error: string | null;
}

interface SwitchAction {
  kind: 'new-practice' | 'manual' | 'edit' | 'restore-legacy';
  record?: ArenaRecord;
  revision?: string;
  legacy?: ArenaLegacyRecordDto;
}

interface NameState {
  mode: 'save' | 'save-as' | 'switch';
  initial: string;
  draft: ArenaDraft;
  action?: SwitchAction;
}

interface ConflictState {
  kind: 'conflict' | 'unknown';
  message: string;
  recordId: string;
}

interface LegacyConfirmState {
  record: ArenaRecord;
  revision: string;
  after: 'edit' | 'reload';
}

/**
 * 弹层状态。`origin` = 这层是从榜上哪一格打开的（键盘导航的还焦目标）；
 * 从顶栏菜单打开的幽灵面板没有格子来源，置 null，关闭时不动焦点。
 */
type Pop =
  | { anchor: Anchor; kind: 'sub'; ti: number; p: number; origin: BoardFocus | null }
  | { anchor: Anchor; kind: 'team'; ti: number; origin: BoardFocus | null }
  | { anchor: Anchor; kind: 'ghost'; origin: null };

/** 保存成功后的顶层提示（docs/contracts/30 §6.1）：不阻塞、不自动跳转 */
type MarksPrompt =
  | { status: 'syncing'; contestId: string }
  | { status: 'ok'; contestId: string; archived: boolean }
  | {
      status: 'failed';
      contestId: string;
      recordId: string;
      problems: ProblemMarksProblem[];
      message: string;
      /** 题目清单 alias 集合变化：重试不会成功，且详情里没有「从榜单补齐」 */
      mismatch: boolean;
    };

const pct = (ms: number, dur: number): string => `${(ms / dur) * 100}%`;

/** 幽灵签名：拼进 minuteKey，改了逐发就重建榜 */
const ghostSig = (g: GhostData | null): string =>
  g === null ? 'none' : `${g.show ? 1 : 0}|${g.subs.map((s) => `${s.p}:${s.t}:${s.r}`).join(',')}`;

const isUnknownError = (err: unknown): boolean =>
  err instanceof ApiError && (err.kind === 'timeout' || err.kind === 'offline' || err.kind === 'aborted');

/** 榜里格子的地标：`data-ti`（队伍序号，幽灵 = -1）+ `data-p`（-1 = 队伍列，≥0 = 第 p 题） */
const CELL_SELECTOR = '[data-ti][data-p]';

/** 空榜时 `rows` 保持同一引用，别让焦点 effect 每次渲染都跑一遍 */
const NO_ROWS: readonly number[] = [];

/** 键盘 → 方向语义（Enter / 空格不在这里：原生 button 自己会变点击） */
const KEY_DIR: Readonly<Record<string, MoveDir>> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
  Home: 'home',
  End: 'end',
};

/** 焦点身份 → 榜里那个格子（找不到 = 行 / 列已经不在当前榜上） */
const cellOf = (box: HTMLElement, f: BoardFocus): HTMLElement | null =>
  box.querySelector<HTMLElement>(`[data-ti="${f.ti}"][data-p="${f.p}"]`);

export function ArenaBoard({ row, store, onBack, mode, recordId = null, openHistory = false, onDraftChanged }: Props) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [tryNo, setTryNo] = useState(0);
  const [draft, setDraft] = useState<ArenaDraft | null>(null);
  const draftRef = useRef<ArenaDraft | null>(null);
  const [draftErr, setDraftErr] = useState<string | null>(null);
  const [storageWarn, setStorageWarn] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const staleRef = useRef(false);
  staleRef.current = stale;
  const [reloadNo, setReloadNo] = useState(0);
  const [draftBooted, setDraftBooted] = useState(false);
  const [identity, setIdentity] = useState<Identity>(
    mode === 'record' && recordId !== null ? { kind: 'view', recordId } : mode === 'review' ? { kind: 'review' } : { kind: 'practice' },
  );
  const [view, setView] = useState<ViewState>({ status: 'idle', recordId: null, record: null, revision: null, error: null });
  const [viewGhost, setViewGhost] = useState<GhostData | null>(null);
  const [viewRetry, setViewRetry] = useState(0);
  const viewSeq = useRef(0);
  const [elapsed, setElapsed] = useState(0);
  const [scrubMs, setScrubMs] = useState(0);
  const [frozenView, setFrozenView] = useState(false);
  const [onlyFormal, setOnlyFormal] = useState(false);
  const [pop, setPop] = useState<Pop | null>(null);
  const boardBox = useRef<HTMLDivElement | null>(null);
  const topbarRef = useRef<HTMLDivElement | null>(null);
  /*
   * ---------- 榜体键盘导航（roving tabindex：整张榜只有一个 Tab 落点）----------
   * `focus` 是"选中身份"`{ti, p}`，不是 DOM 引用：榜每分钟重建、随时可能重排 / 过滤，
   * 身份由 `board-focus.ts` 解释到新榜上，实际焦点再由下面的同步 effect 补到对应格子上。
   */
  const [focus, setFocus] = useState<BoardFocus | null>(null);
  const focusRef = useRef<BoardFocus | null>(null);
  focusRef.current = focus;
  /** 焦点当前是否在榜体内：false 时绝不把焦点从工具栏 / 别的视图抢回来 */
  const focusInBoard = useRef(false);
  /** 下一次同步允许滚动定位（键盘导航 = true，重建还原 = false） */
  const focusScroll = useRef(false);
  /** 上一个弹层（关闭时从它的 `origin` 还焦） */
  const prevPop = useRef<Pop | null>(null);
  const { show, hide } = useTip();

  const [saveBusy, setSaveBusy] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [saveFlash, setSaveFlash] = useState<string | null>(null);
  const [marksPrompt, setMarksPrompt] = useState<MarksPrompt | null>(null);
  const marksSyncSeq = useRef(0);
  const flashTimer = useRef<number | null>(null);
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const [historyOpen, setHistoryOpen] = useState(openHistory);
  const [history, setHistory] = useState<HistoryState>({ status: 'loading', dto: null, error: null });
  const historySeq = useRef(0);

  const [nameState, setNameState] = useState<NameState | null>(null);
  const [nameErr, setNameErr] = useState<string | null>(null);
  const [pending, setPending] = useState<{ action: SwitchAction; case: Exclude<ReplaceCase, 'none'> } | null>(null);
  const [replaceErr, setReplaceErr] = useState<string | null>(null);
  const [legacyConfirm, setLegacyConfirm] = useState<LegacyConfirmState | null>(null);
  const [resetConfirm, setResetConfirm] = useState(false);
  /** 切换前被替换的草稿：保存失败时恢复它（进行中不能因保存失败变成已结束） */
  const switchOriginalRef = useRef<ArenaDraft | null>(null);
  const bootRestoreRef = useRef(mode === 'restore-legacy');
  const initialModeRef = useRef(mode);
  const initialDraftBoot = useRef(true);
  /** 编辑 / 恢复旧进度的异步入口也要“最后意图胜出” */
  const editSeq = useRef(0);
  const restoreSeq = useRef(0);

  /* ---------- 取数：进回放才拉那 1.5MB；失败给重试 ---------- */
  useEffect(() => {
    let cancel = false;
    setLoad({ kind: 'loading' });
    void (async () => {
      try {
        const res = await getArenaContest(row.path);
        if (cancel) return;
        const model = buildModel(res.data as Parameters<typeof buildModel>[0]);
        if (model.duration <= 0) {
          setLoad({ kind: 'error', text: '本场快照的时长读不懂，无法回放', missing: false });
          return;
        }
        setLoad({ kind: 'ready', model });
      } catch (err) {
        if (cancel) return;
        const missing = err instanceof ApiError && err.kind === 'not-found';
        setLoad({ kind: 'error', text: messageOf(err), missing });
      }
    })();
    return () => {
      cancel = true;
    };
  }, [row.path, tryNo]);

  const commit = useCallback(
    (next: ArenaDraft | null, persist = true): boolean => {
      if (staleRef.current && persist) {
        setStale(true);
        return false;
      }
      draftRef.current = next;
      setDraft(next);
      if (next === null) {
        if (persist) clearDraft(store, row.path);
        return true;
      }
      if (!persist) return true;
      const ok = saveDraft(store, row.path, next);
      setStorageWarn(ok ? null : '浏览器存储写不进去：当前练习无法自动保留，请勿关闭页面');
      return ok;
    },
    [row.path, store],
  );

  /* ---------- 草稿：新键优先；旧键只在没有新键时迁移一次（需要本场时长） ---------- */
  useEffect(() => {
    if (load.kind !== 'ready') return;
    const duration = load.model.duration;
    setSaveErr(null);
    setSaveFlash(null);
    setConflict(null);
    const loaded = loadDraft(store, row.path);
    if (loaded.kind === 'error') {
      setDraftErr(loaded.message);
      commit(null, false);
      setDraftBooted(true);
      return;
    }
    if (loaded.kind === 'draft') {
      let d = loaded.draft;
      if (d.session !== null && d.session.durationMs === 0) d = { ...d, session: { ...d.session, durationMs: duration } };
      setDraftErr(null);
      commit(d);
      setDraftBooted(true);
      return;
    }
    const migrated = migrateLegacy(store, row.path, duration);
    if (migrated.kind === 'error') {
      setDraftErr(migrated.message);
      commit(null, false);
      setDraftBooted(true);
      return;
    }
    if (migrated.kind === 'migrated') {
      setDraftErr(null);
      commit(migrated.draft);
      setDraftBooted(true);
      return;
    }
    setDraftErr(null);
    commit(null, false);
    if (initialModeRef.current === 'practice' && initialDraftBoot.current) {
      const s = { ...startSession(Date.now()), durationMs: duration };
      const d: ArenaDraft = { ...newDraft(Date.now()), session: s };
      commit(d);
      setIdentity({ kind: 'practice' });
    }
    setDraftBooted(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load.kind === 'ready' ? load.model.duration : 0, reloadNo, row.path]);

  useEffect(() => {
    if (draftBooted) initialDraftBoot.current = false;
  }, [draftBooted]);

  /* ---------- 查看指定档：失败留在错误态，不退回本地草稿 ---------- */
  const viewRecordId = identity.kind === 'view' ? identity.recordId : null;
  useEffect(() => {
    if (viewRecordId === null) return;
    const seq = ++viewSeq.current;
    setView({ status: 'loading', recordId: viewRecordId, record: null, revision: null, error: null });
    setViewGhost(null);
    void (async () => {
      try {
        const item = await getArenaRecordItem(row.path, viewRecordId);
        if (seq !== viewSeq.current) return;
        setView({ status: 'ready', recordId: viewRecordId, record: item.record, revision: item.revision, error: null });
        setViewGhost(recordToGhost(item.record.ghost));
      } catch (err) {
        if (seq !== viewSeq.current) return;
        setView({ status: 'error', recordId: viewRecordId, record: null, revision: null, error: messageOf(err) });
      }
    })();
  }, [viewRecordId, row.path, viewRetry]);

  /* 查看历史不暂停当前练习：tab 里的 started 不动，回来仍按真实时钟接上 */
  const practiceRunning = draft?.phase === 'running';
  useEffect(() => {
    if (identity.kind === 'view') setFrozenView(false);
  }, [identity.kind, viewRecordId]);

  const duration = load.kind === 'ready' ? load.model.duration : 0;
  const runningHere = identity.kind === 'practice' && draft?.phase === 'running' && !stale;

  /* ---------- 进入练习 / 已结束后把滑条摆到停止位置 ---------- */
  const identityKey = identity.kind === 'view' ? `view:${identity.recordId}` : identity.kind;
  useEffect(() => {
    if (load.kind !== 'ready') return;
    if (identity.kind === 'practice' && draft !== null) {
      if (draft.phase === 'finished') setScrubMs(draft.result?.stoppedAtMs ?? duration);
      else if (draft.phase === 'legacy-unconfirmed') setScrubMs(duration);
      else setElapsed(elapsedOf(draft.session ?? startSession(Date.now()), duration, Date.now()));
    }
    if (identity.kind === 'edit' && draft !== null) setScrubMs(draft.result?.stoppedAtMs ?? duration);
    if (identity.kind === 'view' && view.status === 'ready') setScrubMs(duration);
    if (identity.kind === 'review') setScrubMs(duration);
    // 只随身份 / 草稿代次 / 查看目标变化：拖轴、改逐发不重置位置
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identityKey, draft?.draftId, draft?.phase, view.status, load.kind === 'ready' ? duration : 0]);

  /* ---------- 走钟：每秒一次；到点落回顾并写结束信息 ---------- */
  useEffect(() => {
    if (!runningHere || load.kind !== 'ready' || draft === null || draft.session === null) return;
    const span = load.model.duration;
    let s = draft.session;
    const run = (): void => {
      const next = tick(s, span, Date.now());
      s = next.session;
      setElapsed(next.elapsed);
      if (next.session !== draft.session) {
        // 用 ref 取最新草稿：计时期间可能刚补录了逐发，不能拿本次 effect 起点的旧快照收尾
        const current = draftRef.current;
        if (current === null || current.draftId !== draft.draftId) return;
        const ended = finishDraft(current, span, span, Date.now());
        commit(ended);
        setScrubMs(span);
        onDraftChanged?.();
      }
    };
    run();
    const id = window.setInterval(run, 1000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runningHere, draft?.draftId, draft?.session?.hold, draft?.session?.started, load.kind === 'ready' ? load.model.duration : 0]);

  /* ---------- 多标签：另一页改了本场草稿 → 旧页面只读，提示重新读取 ---------- */
  useEffect(() => {
    const key = draftKey(row.path);
    const onStorage = (e: StorageEvent): void => {
      if (e.key !== key) return;
      // 同场共用一份草稿：另一个标签只要写成功（同 draftId 也算），这个页面的副本就过期了
      setStale(true);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [row.path]);

  /* ---------- 历史成绩层：进回放即读一次档数（菜单计数 / 首次多档提示） ---------- */
  const loadHistory = useCallback(
    async (silent = false): Promise<void> => {
      const seq = ++historySeq.current;
      if (!silent) setHistory((h) => ({ ...h, status: 'loading', error: null }));
      try {
        const dto = await listArenaRecords(row.path);
        if (seq !== historySeq.current) return;
        setHistory({ status: 'ready', dto, error: null });
      } catch (err) {
        if (seq !== historySeq.current) return;
        if (silent) {
          setHistory((h) => (h.dto === null ? { status: 'error', dto: null, error: messageOf(err) } : h));
        } else {
          setHistory({ status: 'error', dto: null, error: messageOf(err) });
        }
      }
    },
    [row.path],
  );

  useEffect(() => {
    void loadHistory(true);
  }, [loadHistory]);

  useEffect(() => {
    if (historyOpen) void loadHistory();
  }, [historyOpen, loadHistory]);

  const recordCount = history.dto?.records.length ?? 0;

  useEffect(() => {
    if (history.status !== 'ready' || recordCount < 2) return;
    try {
      if (localStorage.getItem('arena:history-hint') === '1') return;
      localStorage.setItem('arena:history-hint', '1');
    } catch {
      /* 存储不可用也照常提示一次 */
    }
    setNote('这场已有多档成绩 · 「历史成绩」已收进「更多」菜单');
  }, [history.status, recordCount]);

  const openHistoryLayer = useCallback((): void => {
    setHistoryOpen(true);
    setActionErr(null);
  }, []);

  /* ---------- 切换动作 ---------- */
  const applySwitch = useCallback(
    (action: SwitchAction): void => {
      if (load.kind !== 'ready') return;
      setSaveErr(null);
      setSaveFlash(null);
      setConflict(null);
      setActionErr(null);
      setFrozenView(false);
      if (action.kind === 'new-practice') {
        const s = { ...startSession(Date.now()), durationMs: load.model.duration };
        commit({ ...newDraft(Date.now()), session: s });
        setIdentity({ kind: 'practice' });
        setElapsed(0);
        setScrubMs(0);
        setNote('新的练习已开始');
        onDraftChanged?.();
        return;
      }
      if (action.kind === 'manual') {
        commit(newManualDraft(load.model.duration));
        setIdentity({ kind: 'practice' });
        setScrubMs(load.model.duration);
        setNote('补录草稿已建立 · 录入逐发后保存');
        onDraftChanged?.();
        return;
      }
      if (action.kind === 'edit' && action.record !== undefined && action.revision !== undefined) {
        const record = action.record;
        const legacy = record.result.origin === 'legacy-review';
        const result = legacy
          ? { origin: 'manual' as const, finish: 'declared' as const, durationMs: load.model.duration, stoppedAtMs: null }
          : record.result;
        commit(draftFromRecord(record, result, action.revision, record.result));
        setIdentity({ kind: 'edit' });
        setScrubMs(record.result.stoppedAtMs ?? load.model.duration);
        setNote(legacy ? '旧回顾已确认结束 · 保存才会升级为正式档' : `正在编辑「${record.name}」`);
        onDraftChanged?.();
        return;
      }
      if (action.kind === 'restore-legacy' && action.legacy !== undefined) {
        const legacy = action.legacy;
        const viewMs = legacy.record.view.viewMs;
        commit(draftFromLegacyLive(recordToGhost(legacy.record.ghost), viewMs, load.model.duration, Date.now()));
        setIdentity({ kind: 'practice' });
        setScrubMs(viewMs);
        setElapsed(viewMs);
        setNote('旧进度已恢复为当前练习（暂停）· 点继续才开始走钟');
        onDraftChanged?.();
      }
    },
    [commit, load, onDraftChanged],
  );

  const requestSwitch = useCallback(
    (action: SwitchAction): void => {
      if (staleRef.current) {
        setStale(true);
        setActionErr('另一个标签页改了本场草稿：先重新读取，再做切换');
        return;
      }
      if (saveBusy) {
        setActionErr('正在保存：先等这次保存结束，再切换');
        return;
      }
      if (draftRef.current?.pendingSave != null) {
        setSaveErr('上次新建请求的结果还没确认：先重试对账，再切换或另存');
        return;
      }
      const c = replaceCaseOf(draftRef.current);
      setReplaceErr(null);
      if (c === 'none') {
        applySwitch(action);
        return;
      }
      setPending({ action, case: c });
    },
    [applySwitch, saveBusy],
  );

  const fetchRecord = useCallback(
    async (recordIdValue: string): Promise<{ record: ArenaRecord; revision: string } | null> => {
      if (identity.kind === 'view' && view.status === 'ready' && view.recordId === recordIdValue && view.record !== null && view.revision !== null) {
        return { record: view.record, revision: view.revision };
      }
      try {
        const item = await getArenaRecordItem(row.path, recordIdValue);
        return { record: item.record, revision: item.revision };
      } catch (err) {
        setActionErr(`读取存档失败：${messageOf(err)}`);
        return null;
      }
    },
    [identity, row.path, view.status, view.recordId, view.record, view.revision],
  );

  const beginEdit = useCallback(
    async (recordIdValue: string): Promise<void> => {
      if (saveBusy) {
        setActionErr('正在保存：先等这次保存结束，再进入编辑');
        return;
      }
      const seq = ++editSeq.current;
      setHistoryOpen(false);
      const got = await fetchRecord(recordIdValue);
      if (seq !== editSeq.current || got === null) return;
      if (got.record.result.origin === 'legacy-review') {
        setLegacyConfirm({ record: got.record, revision: got.revision, after: 'edit' });
        return;
      }
      requestSwitch({ kind: 'edit', record: got.record, revision: got.revision });
    },
    [fetchRecord, requestSwitch, saveBusy],
  );

  const beginRestoreLegacy = useCallback(async (): Promise<void> => {
    if (saveBusy) {
      setActionErr('正在保存：先等这次保存结束，再恢复旧进度');
      return;
    }
    const seq = ++restoreSeq.current;
    setHistoryOpen(false);
    setActionErr(null);
    try {
      const legacy = await getArenaLegacy(row.path);
      if (seq !== restoreSeq.current) return;
      if (legacy.mode !== 'live') {
        setActionErr('旧根记录已经升级为正式存档，不能再按旧进度恢复');
        return;
      }
      requestSwitch({ kind: 'restore-legacy', legacy });
    } catch (err) {
      if (seq === restoreSeq.current) setActionErr(`读取旧进度失败：${messageOf(err)}`);
    }
  }, [requestSwitch, row.path, saveBusy]);

  const beginManual = useCallback((): void => {
    if (saveBusy) return;
    if (draftRef.current !== null) requestSwitch({ kind: 'manual' });
    else applySwitch({ kind: 'manual' });
  }, [applySwitch, requestSwitch, saveBusy]);

  const beginNewPractice = useCallback((): void => {
    requestSwitch({ kind: 'new-practice' });
  }, [requestSwitch]);

  /* mode=restore-legacy 的启动流程：草稿读完、榜单就绪后执行一次 */
  useEffect(() => {
    if (!bootRestoreRef.current || !draftBooted || load.kind !== 'ready') return;
    bootRestoreRef.current = false;
    void beginRestoreLegacy();
  }, [beginRestoreLegacy, draftBooted, load.kind]);

  /* ---------- 保存 ---------- */
  /** 保存成功后同步题目清单并预填 AC（30 §3.4 / §6.1）；失败只影响提示条，不回滚成绩 */
  const runMarksSync = useCallback(
    (contestId: string, recordId: string, problems: ProblemMarksProblem[]): void => {
      const seq = ++marksSyncSeq.current;
      setMarksPrompt({ status: 'syncing', contestId });
      void (async () => {
        try {
          const [res, detail] = await Promise.all([
            syncProblemMarks({ arenaPath: row.path, problems, recordId }),
            getWorkObject(contestId).catch(() => null),
          ]);
          if (seq !== marksSyncSeq.current) return;
          setMarksPrompt({ status: 'ok', contestId: res.problemMarks.contestId, archived: detail?.archived === true });
        } catch (err) {
          if (seq !== marksSyncSeq.current) return;
          setMarksPrompt({
            status: 'failed',
            contestId,
            recordId,
            problems,
            message: messageOf(err),
            mismatch: err instanceof ApiError && err.kind === 'problem-set-mismatch',
          });
        }
      })();
    },
    [row.path],
  );

  const syncMarksAfterSave = useCallback(
    (record: ArenaRecord, model: ContestModel | null): void => {
      if (model === null) return;
      const problems = problemsFromArena({ problems: model.problems });
      if (problems.length === 0) return;
      runMarksSync(record.contestId, record.recordId, problems);
    },
    [runMarksSync],
  );

  const flashSaved = useCallback((name: string): void => {
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    setSaveFlash(`已保存到 ${name}`);
    flashTimer.current = window.setTimeout(() => {
      flashTimer.current = null;
      setSaveFlash(null);
    }, 3000);
  }, []);
  useEffect(
    () => () => {
      if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    },
    [],
  );

  const finishSave = useCallback(
    (base: ArenaDraft, record: ArenaRecord, revision: string, after?: () => void): void => {
      const next = applySaveSuccess(base, record, revision);
      const persisted = commit(next);
      if (!persisted) {
        setSaveErr('已写入服务端，但本地草稿写不进去：刷新页面可重新读回；不要在这个页面继续编辑');
        return;
      }
      flashSaved(record.name);
      syncMarksAfterSave(record, load.kind === 'ready' ? load.model : null);
      setSaveErr(null);
      setConflict(null);
      setNameState(null);
      setReplaceErr(null);
      setPending(null);
      switchOriginalRef.current = null;
      void loadHistory(true);
      onDraftChanged?.();
      after?.();
    },
    [commit, flashSaved, load, loadHistory, onDraftChanged, syncMarksAfterSave],
  );

  const doCreate = useCallback(
    async (base: ArenaDraft, name: string, after?: () => void, restoreOnReject?: ArenaDraft): Promise<boolean> => {
      const recordIdValue = newRecordId();
      const payload = buildCreatePayload(base, {
        arenaPath: row.path,
        contestTitle: arenaTitleOf(row),
        recordId: recordIdValue,
        name,
      });
      if (payload === null) {
        setSaveErr('还没有结束信息，不能保存');
        return false;
      }
      const frozen: ArenaDraft = { ...base, pendingSave: { recordId: recordIdValue, payload } };
      if (staleRef.current) {
        setStale(true);
        setSaveErr('另一个标签页改了本场草稿：先重新读取，不能在这里保存');
        return false;
      }
      // pendingSave 必须先落盘再发请求；落盘失败就不发（契约 §5.3）
      if (!saveDraft(store, row.path, frozen)) {
        setSaveErr('浏览器存储写不进去：没有发送保存请求');
        return false;
      }
      draftRef.current = frozen;
      setDraft(frozen);
      setStorageWarn(null);
      setSaveBusy(true);
      try {
        const res = await createArenaRecord(payload);
        finishSave(frozen, res.record, res.revision, after);
        return true;
      } catch (err) {
        if (isUnknownError(err)) {
          setSaveErr('保存结果未知：本次提交已冻结，先点「重试对账」确认结果');
          return false;
        }
        // 明确拒绝：恢复提交前的草稿（进行中的练习不能因为保存失败变成已结束）
        const restored = restoreOnReject ?? base;
        if (!saveDraft(store, row.path, restored)) setStorageWarn('浏览器存储写不进去：草稿只在内存里');
        draftRef.current = restored;
        setDraft(restored);
        setSaveErr(messageOf(err));
        return false;
      } finally {
        setSaveBusy(false);
      }
    },
    [finishSave, row.path, store],
  );

  /** 目标存档被删（404）：解除 target，保留本地成绩，直接改名保存为新档（29 §6.2） */
  const detachMissingTarget = useCallback(
    (base: ArenaDraft): boolean => {
      const detached: ArenaDraft = { ...base, target: null, savedBaseline: null };
      if (!saveDraft(store, row.path, detached)) {
        setSaveErr('原存档已不存在；本地成绩还在，但浏览器存储写不进去，先别离开本页');
        return false;
      }
      draftRef.current = detached;
      setDraft(detached);
      setSaveErr(null);
      setConflict(null);
      setNote('原存档已被删除：本地成绩还在，确认名称后保存为新档。');
      setNameErr(null);
      setNameState({ mode: 'save', initial: firstSaveName(), draft: detached });
      return true;
    },
    [row.path, store],
  );

  const doUpdate = useCallback(
    async (base: ArenaDraft, after?: () => void): Promise<boolean> => {
      if (staleRef.current) {
        setStale(true);
        setSaveErr('另一个标签页改了本场草稿：先重新读取，不能在这里保存');
        return false;
      }
      const target = base.target;
      const payload = target === null ? null : buildUpdatePayload(base, {
        arenaPath: row.path,
        recordId: target.recordId,
        expectedRevision: target.revision,
      });
      if (target === null || payload === null) {
        setSaveErr('没有明确的保存目标');
        return false;
      }
      setSaveBusy(true);
      setSaveErr(null);
      try {
        const res = await updateArenaRecord(payload);
        finishSave(base, res.record, res.revision, after);
        return true;
      } catch (err) {
        if (err instanceof ApiError && err.kind === 'not-found') {
          detachMissingTarget(base);
          return false;
        }
        if (isUnknownError(err)) {
          try {
            const item = await getArenaRecordItem(row.path, target.recordId);
            if (updateReconciled(base, item.record)) {
              finishSave(base, item.record, item.revision, after);
              return true;
            }
          } catch {
            /* 读不回就按冲突处理，保留本地修改 */
          }
          setConflict({ kind: 'unknown', message: '保存结果未知：重新读取后与本次提交不一致', recordId: target.recordId });
          return false;
        }
        if (err instanceof ApiError && err.kind === 'conflict') {
          setConflict({ kind: 'conflict', message: messageOf(err), recordId: target.recordId });
          return false;
        }
        setSaveErr(messageOf(err));
        return false;
      } finally {
        setSaveBusy(false);
      }
    },
    [detachMissingTarget, finishSave, row],
  );

  const saveDraftWithName = useCallback(
    (base: ArenaDraft, name: string, saveAs: boolean, after?: () => void): void => {
      setSaveErr(null);
      setSaveFlash(null);
      if (!saveAs && base.target !== null) void doUpdate(base, after);
      else void doCreate(base, name, after, switchOriginalRef.current ?? undefined);
    },
    [doCreate, doUpdate],
  );

  const requestSaveCurrent = useCallback((): void => {
    if (staleRef.current) {
      setStale(true);
      setSaveErr('另一个标签页改了本场草稿：先重新读取，不能在这里保存');
      return;
    }
    const current = draftRef.current;
    if (current === null || !canSaveDraft(current)) return;
    setSaveErr(null);
    if (current.pendingSave !== null) {
      void (async () => {
        setSaveBusy(true);
        try {
          const res = await createArenaRecord(current.pendingSave!.payload);
          finishSave(current, res.record, res.revision);
        } catch (err) {
          if (!isUnknownError(err)) {
            commit({ ...current, pendingSave: null });
            setSaveErr(messageOf(err));
          } else {
            setSaveErr('仍然没有确认到保存结果；稍后再点「重试对账」');
          }
        } finally {
          setSaveBusy(false);
        }
      })();
      return;
    }
    if (current.target !== null) {
      void doUpdate(current);
      return;
    }
    setNameErr(null);
    setNameState({ mode: 'save', initial: firstSaveName(), draft: current });
  }, [commit, doUpdate, finishSave]);

  const requestSaveAs = useCallback((): void => {
    if (staleRef.current) {
      setStale(true);
      setSaveErr('另一个标签页改了本场草稿：先重新读取，不能在这里另存');
      return;
    }
    const current = draftRef.current;
    if (current === null || !canSaveDraft(current)) return;
    if (current.pendingSave !== null) {
      setSaveErr('上次新建请求的结果还没确认：先重试对账，再另存');
      return;
    }
    setNameErr(null);
    setNameState({
      mode: 'save-as',
      initial: copySaveName(current.target?.name ?? '成绩'),
      draft: current,
    });
  }, []);

  /* ---------- 丢弃未保存练习（打磨批次 1）：守卫统一在 draft.ts，顶栏与目录共用同一份 ---------- */
  const discardUnsavedHere = useCallback((): void => {
    if (saveBusy) {
      setActionErr('正在保存：先等这次保存结束，再丢弃');
      return;
    }
    const res = discardUnsavedDraft(store, row.path);
    if (!res.ok) {
      setActionErr('只有「已结束 · 未保存」的练习可以丢弃');
      return;
    }
    commit(null, false);
    setSaveErr(null);
    setSaveFlash(null);
    setConflict(null);
    onDraftChanged?.();
    onBack();
  }, [commit, onBack, onDraftChanged, row.path, saveBusy, store]);

  const confirmName = useCallback(
    (name: string): void => {
      if (nameState === null) return;
      const state = nameState;
      setNameState(null);
      saveDraftWithName(state.draft, name, state.mode !== 'save', state.action === undefined ? undefined : () => applySwitch(state.action!));
    },
    [applySwitch, nameState, saveDraftWithName],
  );

  /* 替换确认：进行中先结束再保存；保存失败 / 命名取消都不切换 */
  const saveAndSwitch = useCallback((): void => {
    if (pending === null) return;
    const base = draftRef.current;
    if (base === null) {
      applySwitch(pending.action);
      setPending(null);
      return;
    }
    let ready = base;
    if (pending.case === 'running') {
      const span = duration;
      const at = base.session === null ? 0 : elapsedOf(base.session, span, Date.now());
      ready = finishDraft(base, span, at, Date.now());
    } else if (pending.case === 'legacy') {
      ready = declareFinished(base, duration);
    }
    switchOriginalRef.current = base;
    setReplaceErr(null);
    if (!canSaveDraft(ready)) {
      setReplaceErr('还不能保存：缺少结束信息');
      return;
    }
    if (ready.target !== null) {
      void doUpdate(ready, () => applySwitch(pending.action));
      return;
    }
    setNameErr(null);
    setNameState({
      mode: 'switch',
      initial: firstSaveName(),
      draft: ready,
      action: pending.action,
    });
  }, [applySwitch, doUpdate, duration, pending]);

  const discardAndSwitch = useCallback((): void => {
    if (pending === null) return;
    switchOriginalRef.current = null;
    commit(null);
    applySwitch(pending.action);
    setPending(null);
  }, [applySwitch, commit, pending]);

  const confirmLegacyEdit = useCallback((): void => {
    if (legacyConfirm === null) return;
    const { record, revision, after } = legacyConfirm;
    setLegacyConfirm(null);
    const result = { origin: 'manual' as const, finish: 'declared' as const, durationMs: duration, stoppedAtMs: null };
    if (after === 'edit') requestSwitch({ kind: 'edit', record: { ...record, result: legacyConfirm.record.result }, revision });
    else {
      commit(draftFromRecord(record, result, revision, record.result));
      setIdentity({ kind: 'edit' });
      setScrubMs(duration);
      setNote('旧回顾已确认结束 · 保存才会升级为正式档');
    }
  }, [commit, duration, legacyConfirm, requestSwitch]);

  /* 更新冲突：重新读取只认服务端现状，本地修改需先另存 */
  const reloadFromServer = useCallback((): void => {
    const target = conflict;
    if (target === null) return;
    void (async () => {
      try {
        const item = await getArenaRecordItem(row.path, target.recordId);
        if (item.record.result.origin === 'legacy-review') {
          setLegacyConfirm({ record: item.record, revision: item.revision, after: 'edit' });
          setConflict(null);
          return;
        }
        commit(draftFromRecord(item.record, item.record.result, item.revision));
        setIdentity({ kind: 'edit' });
        setScrubMs(item.record.result.stoppedAtMs ?? duration);
        setConflict(null);
        setSaveErr(null);
        setNote('已重新读取服务端存档');
      } catch (err) {
        setSaveErr(`重新读取失败：${messageOf(err)}`);
      }
    })();
  }, [commit, conflict, duration, row.path]);

  /* ---------- 操作 ---------- */
  const togglePause = (): void => {
    if (saveBusy || draft === null || draft.session === null) return;
    const e = elapsedOf(draft.session, duration, Date.now());
    commit({ ...draft, session: draft.session.paused ? unpauseSession(draft.session, e, Date.now()) : pauseSession(draft.session, e) });
  };

  const endPractice = (): void => {
    if (saveBusy || draft === null || draft.session === null) return;
    const e = elapsedOf(draft.session, duration, Date.now());
    const ended = finishDraft(draft, duration, e, Date.now());
    commit(ended);
    setScrubMs(ended.result?.stoppedAtMs ?? duration);
    setNote(null);
    onDraftChanged?.();
  };

  const confirmLegacyDraft = (): void => {
    if (saveBusy || draft === null) return;
    commit(declareFinished(draft, duration));
    setScrubMs(duration);
    onDraftChanged?.();
  };

  const scrub = (minutes: number): void => setScrubMs(minutes * 60_000);
  const jump = (to: '0' | 'freeze' | 'end'): void => {
    if (load.kind !== 'ready') return;
    scrub(to === '0' ? 0 : to === 'end' ? minutesOf(load.model.duration) : minutesOf(load.model.freezeStart) + 1);
  };

  const onGhostChange = useCallback(
    (next: GhostData): void => {
      if (saveBusy || identity.kind === 'review') return;
      setSaveFlash(null);
      setSaveErr(null);
      setConflict(null);
      if (identity.kind === 'view') {
        setViewGhost(next);
        return;
      }
      if (draft === null) return;
      commit({ ...draft, ghost: next });
    },
    [commit, draft, identity.kind, saveBusy],
  );

  const onGhostClear = useCallback((): void => {
    if (saveBusy || identity.kind === 'view' || identity.kind === 'review') return;
    if (draft === null) return;
    setSaveFlash(null);
    setSaveErr(null);
    commit({ ...draft, ghost: { show: true, subs: [] } });
  }, [commit, draft, identity.kind, saveBusy]);

  /* 幽灵归属只跟身份走：查看终榜不借用当前练习的录入，避免两个身份串数据 */
  const currentGhost: GhostData | null =
    identity.kind === 'view'
      ? viewGhost
      : identity.kind === 'practice' || identity.kind === 'edit'
        ? draft?.ghost ?? null
        : null;

  /* ---------- 弹层 ---------- */
  useEffect(() => {
    if (pop === null) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setPop(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pop]);

  /*
   * 开层只认元素，不认鼠标事件：键盘（原生 button 变出来的 click）与鼠标走同一条路，
   * 锚点都取自那一格自己的矩形，`origin` 记下"从哪格开的"，关闭时原样还焦。
   */
  const openCellPop = useCallback((el: HTMLElement, ti: number, p: number): void => {
    const r = el.getBoundingClientRect();
    setPop({ kind: 'sub', ti, p, origin: { ti, p }, anchor: { left: r.left, top: r.top, width: r.width, height: r.height } });
  }, []);
  const openTeamPop = useCallback((el: HTMLElement, ti: number): void => {
    // 队伍弹层锚在整行上（沿用稿内落点）：从队名列按钮或行空白处点进来都量同一只 `.brow`
    const box = el.closest<HTMLElement>('.brow') ?? el;
    const r = box.getBoundingClientRect();
    setPop({ kind: 'team', ti, origin: { ti, p: TEAM_COL }, anchor: { left: r.left, top: r.top, width: r.width, height: r.height } });
  }, []);

  /* 所有 hook 必须在提前 return 之前：榜的 useMemo 不能跟着“是否 ready”改变调用顺序 */
  const readyModel = load.kind === 'ready' ? load.model : null;
  const span = readyModel?.duration ?? 0;
  const review = !runningHere;
  const viewMs = runningHere ? elapsed : Math.max(0, Math.min(scrubMs, span));
  const inFrz =
    readyModel !== null &&
    (review ? frozenView && inFreezeWindow(viewMs, span, readyModel.freezeStart) : inFreezeWindow(elapsed, span, readyModel.freezeStart));
  const ghostSubs: GhostSub[] | null =
    currentGhost !== null && currentGhost.show && currentGhost.subs.length > 0 ? currentGhost.subs : null;
  const minuteKey = `${minutesOf(viewMs)}|${onlyFormal}|${review ? 'r' : 'l'}|${frozenView ? 'fz' : 'un'}|${Math.min(1, viewMs >= span ? 1 : 0)}|${ghostSig(currentGhost)}`;
  const boardMaybe: Board | null = useMemo(
    () =>
      readyModel === null
        ? null
        : buildBoard(readyModel, review ? viewMs : Math.min(viewMs, span), onlyFormal, review && !frozenView, ghostSubs),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [readyModel, minuteKey],
  );

  /*
   * ---------- 榜体焦点（下列 hook 同样必须排在提前 return 之前）----------
   * 当前显示顺序：`board` 只在分钟滚过时换引用，所以这份 `rows` 每分钟算一次，不是每秒。
   */
  const boardGrid: BoardGrid = useMemo(
    () => ({ rows: boardMaybe === null ? NO_ROWS : boardMaybe.rows.map((r) => r.ti), cols: readyModel?.problems.length ?? 0 }),
    [boardMaybe, readyModel],
  );

  /* 重建 / 过滤 / 排序后解释焦点：行还在就保住那一行，行没了退到第一条还在的行，空榜就整个不留焦点 */
  useEffect(() => {
    setFocus((prev) => resolveFocus(boardGrid, prev));
  }, [boardGrid]);

  /*
   * 把"选中身份"落到真实焦点上：只在焦点本来就待在榜里时动手 —— 重建后 React 挪动 DOM 节点、
   * 行列夹位、还焦路径都走这里，绝不会把焦点从工具栏 / 时间轴 / 别的视图抢进榜里。
   */
  useEffect(() => {
    const scroll = focusScroll.current;
    focusScroll.current = false;
    const box = boardBox.current;
    if (box === null || !focusInBoard.current || focus === null) return;
    const el = cellOf(box, focus);
    if (el === null || document.activeElement === el) return;
    el.focus({ preventScroll: true });
    // 键盘导航要让新格子进视野（含榜体自己的横向滚动）；重建还原则原地不动
    if (scroll) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });

  /* 弹层从"有"到"无"：把焦点还给当初那一格（`preventScroll` —— 还焦不该推滚动位置） */
  useEffect(() => {
    const before = prevPop.current;
    prevPop.current = pop;
    if (pop !== null || before === null) return;
    const box = boardBox.current;
    if (box === null) return;
    // 从顶栏菜单开的幽灵面板没有格子来源（origin=null），不动别人的焦点
    const origin = before.origin;
    if (origin === null) return;
    // 格子在弹层开着的时候消失了（行被过滤掉 / 分钟重建）：退到当前选中的那一格，别让焦点掉回 body
    const fallback = focusRef.current === null ? null : cellOf(box, focusRef.current);
    const el = cellOf(box, origin) ?? fallback;
    if (el === null) return;
    el.focus({ preventScroll: true });
  }, [pop]);

  /** 方向键 / Home / End：算出新身份交给 state，真实焦点由上面的 effect 补，格子自己不带 onClick 分支 */
  const onBoardKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>): void => {
      const dir = KEY_DIR[e.key];
      if (dir === undefined) return;
      const el = (e.target as HTMLElement).closest<HTMLElement>(CELL_SELECTOR);
      if (el === null) return;
      const from: BoardFocus = { ti: Number(el.dataset.ti), p: Number(el.dataset.p) };
      e.preventDefault(); // 网格内部方向键不滚页面；Home/End 不去文档头尾
      const next = moveFocus(boardGrid, from, dir, e.ctrlKey);
      if (next === null || sameFocus(next, from)) return;
      focusInBoard.current = true;
      focusScroll.current = true;
      setFocus(next);
    },
    [boardGrid],
  );

  /** 真实焦点落在哪格，选中身份就是哪格（鼠标点格子、还焦、Tab 进来都走这条） */
  const onBoardFocus = useCallback((e: React.FocusEvent<HTMLDivElement>): void => {
    const el = (e.target as HTMLElement).closest<HTMLElement>(CELL_SELECTOR);
    if (el === null) return;
    focusInBoard.current = true;
    const next: BoardFocus = { ti: Number(el.dataset.ti), p: Number(el.dataset.p) };
    setFocus((prev) => (sameFocus(prev, next) ? prev : next));
  }, []);

  const onBoardBlur = useCallback((e: React.FocusEvent<HTMLDivElement>): void => {
    const to = e.relatedTarget as HTMLElement | null;
    if (to === null || !e.currentTarget.contains(to)) focusInBoard.current = false;
  }, []);

  if (load.kind === 'error') {
    return (
      <>
        <div className="topbar">
          <button className="btn btn--ghost btn--sm" onClick={onBack}>
            <Icon id="i-chev" className="flip" />
            回到目录
          </button>
          <span aria-hidden="true" className="vsep" />
          <h2 className="rbname">{row.name}</h2>
          <span className="topbar__spacer" />
        </div>
        <div className="content">
          <div className="catwrap">
            <div className="alert alert--err">
              <Icon id="i-plug" />
              <div>
                {load.missing ? (
                  <b>上游没有这份榜单</b>
                ) : (
                  <>
                    <b>榜单拉取失败</b> · {load.text} · 本地没有这一场的缓存
                  </>
                )}
              </div>
              <button className="alert__x" onClick={() => setTryNo((n) => n + 1)}>
                重试
              </button>
            </div>
            <p className="hint">
              {load.missing
                ? '目录里有这一场，但快照仓库里取不到对应文件 —— 不做假数填空，取不到就是空。'
                : '两条源都试过还不通才算取不到，隔一两秒点重试通常就好；缓存过的场次断网也照常回放。'}
            </p>
          </div>
        </div>
      </>
    );
  }

  if (load.kind === 'loading' || draftBooted === false) {
    return (
      <div className="content">
        <div className="catwrap">
          <div className="skel">
            <i />
            正在拉取本场榜单 <code>official/…</code>（约 1.5 MB）…
          </div>
        </div>
      </div>
    );
  }

  const model = load.model;
  const board = boardMaybe;
  if (board === null) return null;
  const frozen = board.cap < viewMs || inFrz;
  const freezeLabel = clockHM(model.freezeStart);
  const teamCount = board.rows.length - (board.ghostTeam ? 1 : 0);
  const ghostRow = board.ghostTeam === null || board.ghostTeam === undefined ? null : board.rows.find((r) => r.ghost === true) ?? null;
  /* 练习进行中且一笔都没录：顶栏胶囊常驻为占位「我 —」。
     只动顶栏渲染，榜上幽灵行的注入条件（subs>0，engine 口径）不动 —— 占位态榜上没有这一行 */
  const ghostCapsuleEmpty = ghostRow === null && runningHere && (currentGhost === null || currentGhost.subs.length === 0);

  const recordForView = identity.kind === 'view' ? view.record : null;

  const timingText = (result: ArenaRecordResult | null | undefined): string => {
    if (result === null || result === undefined) return '结束信息未知';
    if (result.origin === 'legacy-review') return '结束时间未知';
    if (result.origin === 'manual') return '手动记录';
    if (result.finish === 'stopped') {
      return result.stoppedAtMs === null ? '提前结束' : `${clockHMS(result.stoppedAtMs)} 提前结束`;
    }
    return result.durationMs === null ? '计时结束' : `跑满 ${clockHMS(result.durationMs)}`;
  };

  const status = ((): { text: string; tone: string } => {
    if (identity.kind === 'practice') {
      if (draft === null) return { text: '当前练习 · 未开始', tone: 'practice' };
      if (draft.phase === 'running') {
        const paused = draft.session?.paused === true;
        return { text: `当前练习 · 计时 ${clockHMS(elapsed)}${paused ? ' · 已暂停' : ''}`, tone: 'practice' };
      }
      if (draft.phase === 'legacy-unconfirmed') return { text: '旧成绩 · 需确认是否已结束', tone: 'warn' };
      const dirty = isDirty(draft);
      if (draft.result?.origin === 'manual') {
        return { text: `当前练习 · 手动记录，${dirty ? '未保存' : '已保存'}`, tone: dirty ? 'dirty' : 'ok' };
      }
      return { text: `当前练习 · ${dirty ? '已结束，未保存' : '已保存'}`, tone: dirty ? 'dirty' : 'ok' };
    }
    if (identity.kind === 'edit') {
      const dirty = draft !== null && isDirty(draft);
      return { text: `编辑：${draft?.target?.name ?? '…'} · ${dirty ? '有修改未保存' : '已保存'}`, tone: dirty ? 'dirty' : 'view' };
    }
    if (identity.kind === 'view') {
      if (view.status === 'error') return { text: '查看：… · 读取失败', tone: 'warn' };
      if (view.status !== 'ready' || recordForView === null) return { text: '查看：… · 读取中', tone: 'view' };
      const bg = practiceRunning ? ' · 当前练习仍在计时' : '';
      return { text: `查看：${recordForView.name} · ${timingText(recordForView.result)}${bg}`, tone: 'view' };
    }
    return { text: `查看终榜 · 只读${practiceRunning ? ' · 当前练习仍在计时' : ''}`, tone: 'review' };
  })();

  const canSaveHere = (identity.kind === 'practice' || identity.kind === 'edit') && canSaveDraft(draft) && !stale && draftErr === null;
  /* 「已结束 · 未保存」（当前练习、无保存目标、无在途请求）才用滑动分裂按钮：
     编辑存档 / 保存结果未对账时维持原保存按钮（丢弃对它们不适用，重试对账入口也保持原样） */
  const sliderHere = identity.kind === 'practice' && canSaveHere && draft !== null && draft.target === null && draft.pendingSave === null;
  const targetName = draft?.target?.name ?? null;
  const showTargetArrow = canSaveHere && targetName !== null && recordCount >= 2 && saveFlash === null;

  /** 「我的成绩」面板锚在触发它的控件上（人形按钮 / 空态胶囊），不锚死某个固定入口 */
  const openGhostPop = (el: HTMLElement | null): void => {
    const r = el?.getBoundingClientRect();
    if (r === undefined || r === null) return;
    setPop({ kind: 'ghost', origin: null, anchor: { left: r.left, top: r.top, width: r.width, height: r.height } });
  };

  const menuItems: ArenaMenuItem[] = [];
  menuItems.push({
    key: 'history',
    label: '历史成绩',
    ...(recordCount > 1 ? { meta: String(recordCount) } : {}),
    onSelect: openHistoryLayer,
  });
  // 「我的成绩」不进菜单：顶栏常驻人形按钮是唯一入口（2026-11-15 恢复 v8 口径；契约 29 §6.1.1「同一动作不得双入口」）
  if ((identity.kind === 'practice' || identity.kind === 'edit') && canSaveDraft(draft)) {
    menuItems.push({
      key: 'save-as',
      label: '另存一份',
      disabled: saveBusy || conflict !== null || draft?.pendingSave != null,
      onSelect: requestSaveAs,
    });
  }
  if ((identity.kind === 'practice' || identity.kind === 'edit') && draft !== null) {
    menuItems.push({ key: 'again', label: '再练一次', onSelect: beginNewPractice });
  }
  if (identity.kind === 'review' && (draft === null || draft.phase === 'finished')) {
    menuItems.push({ key: 'manual', label: '手动记一场', disabled: !draftBooted, onSelect: beginManual });
  }
  if (identity.kind === 'practice' && draft?.phase === 'legacy-unconfirmed') {
    menuItems.push({ key: 'legacy-done', label: '标记旧成绩已结束', onSelect: confirmLegacyDraft });
  }
  if (draft?.pendingSave != null && canSaveHere) {
    menuItems.push({ key: 'retry', label: '重试对账', disabled: saveBusy, onSelect: requestSaveCurrent });
  }
  if (identity.kind === 'review' && draft !== null) {
    menuItems.push({ key: 'back-practice', label: '回到当前练习', onSelect: () => setIdentity({ kind: 'practice' }) });
  }

  const nameTip = {
    x: 0,
    y: 0,
    date: model.title,
    value: row.name === '' ? row.path : `${row.date} ${row.name}`.trim(),
    zero: false,
    valueClass: 'is-dim',
    sub: [
      `开赛 ${model.startAt}`,
      `封榜 ${freezeLabel}（${model.freezeDeclared ? '本场声明' : '本场未声明 · 按缺省最后 60 分钟'}）`,
      `时长 ${clockHM(span)} · ${model.teams.length} 队（正式 ${model.teams.filter((t) => !t.star).length} · 打星 ${model.teams.filter((t) => t.star).length}）`,
      model.approx ? '本场快照无逐次提交 · 榜按终局判名近似重建' : '',
    ],
  };

  const viewError = identity.kind === 'view' && view.status === 'error';
  const viewLoading = identity.kind === 'view' && view.status === 'loading';

  return (
    <>
      <div className="topbar arena-topbar" ref={topbarRef}>
        <button className="btn btn--ghost btn--sm" onClick={onBack}>
          <Icon id="i-chev" className="flip" />
          回到目录
        </button>
        <span aria-hidden="true" className="vsep" />
        <h2
          className="rbname"
          onMouseEnter={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            show({ ...nameTip, x: r.left + Math.min(r.width / 2, 180), y: r.bottom, below: true });
          }}
          onMouseLeave={hide}
        >
          {model.title}
        </h2>
        <span className={`arena-status arena-status--${status.tone}`} title={status.text}>
          {status.text}
        </span>
        {runningHere && draft?.session != null ? (
          <span className="transport">
            <button className="tbtn" disabled={saveBusy} aria-label={draft.session.paused ? '继续' : '暂停'} title={draft.session.paused ? '继续' : '暂停'} onClick={togglePause}>
              <Icon id={draft.session.paused ? 'i-play' : 'i-pause'} />
            </button>
            <button className="tbtn" disabled={saveBusy} aria-label="结束本次练习" title="结束本次练习（提前结束会记录真实停止时间）" onClick={endPractice}>
              <Icon id="i-stop" />
            </button>
          </span>
        ) : null}

        <span className="topbar__spacer" />

        {ghostRow !== null ? (
          <button
            className="ghrank"
            onClick={() => {
              const el = boardBox.current?.querySelector<HTMLElement>('.brow.is-ghost') ?? null;
              if (el !== null) {
                el.scrollIntoView({ block: 'center' });
                el.classList.remove('is-jump');
                void el.offsetWidth;
                el.classList.add('is-jump');
              }
            }}
            title={`我的成绩 · ${ghostRow.solved} 题 / ${ghostRow.pen} 罚时 · 点击跳到榜上那一行`}
          >
            <i className="dot dot--ok" />我 <b>第 {ghostRow.rank} 名</b>
          </button>
        ) : ghostCapsuleEmpty ? (
          <button className="ghrank ghrank--empty" onClick={(e) => openGhostPop(e.currentTarget)} title="我的成绩 · 0 题 · 0 罚时 · 点击打开我的成绩面板">
            <i className="dot dot--idle" />我 <b>—</b>
          </button>
        ) : null}

        {/* 「我的成绩」常驻入口（v8 口径回归，2026-11-15）：条件同原菜单项，不随成绩数据出现/消失；「我 第 N 名」胶囊仍只管跳行 */}
        {identity.kind === 'view' || identity.kind === 'edit' || (identity.kind === 'practice' && draft !== null) ? (
          <button
            className="btn btn--ghost btn--sm"
            aria-label="我的成绩"
            title="我的成绩 · 录入 VP 成绩，看自己在榜上的位置"
            onClick={(e) => openGhostPop(e.currentTarget)}
          >
            <Icon id="i-user" />
          </button>
        ) : null}

        <ArenaMenu items={menuItems} />

        {identity.kind === 'view' ? (
          <>
            <button className="btn btn--sm btn--ghost" onClick={() => (draft === null ? beginNewPractice() : setIdentity({ kind: 'practice' }))}>
              {draft === null ? '开始新练习' : '回到当前练习'}
            </button>
            <button className="btn btn--sm btn--primary" disabled={view.status !== 'ready'} onClick={() => void beginEdit(identity.recordId)}>
              <Icon id="i-pencil" />
              编辑成绩
            </button>
          </>
        ) : identity.kind === 'edit' ? (
          <button className="btn btn--sm btn--ghost" onClick={() => setIdentity({ kind: 'practice' })}>
            回到当前练习
          </button>
        ) : null}

        {canSaveHere ? (
          <>
            {sliderHere ? (
              <SaveDiscardSlider
                size="bar"
                busy={saveBusy || conflict !== null}
                saveLabel={saveBusy ? '保存中…' : '保存'}
                onSave={requestSaveCurrent}
                onDiscard={discardUnsavedHere}
              />
            ) : (
              <button
                className="btn btn--sm btn--primary"
                disabled={saveBusy || conflict !== null || draft?.pendingSave !== null}
                title={draft?.pendingSave !== null ? '上次保存结果未确认：先重试对账' : draft?.target != null ? `保存到：${draft.target.name}` : '首次保存会新建一档'}
                onClick={requestSaveCurrent}
              >
                <Icon id="i-save" />
                {saveBusy ? '保存中…' : '保存'}
              </button>
            )}
            {saveFlash !== null ? (
              <span className="arena-saveflash" role="status">
                {saveFlash}
              </span>
            ) : showTargetArrow ? (
              <span className="arena-target" title={`保存目标：${targetName}`}>
                → {targetName}
              </span>
            ) : null}
          </>
        ) : null}
      </div>
      <div className="content content--fit">
        <div className="simcol">
          {marksPrompt !== null ? (
            <div className={`alert ${marksPrompt.status === 'failed' ? 'alert--warn' : 'alert--ok'} marks-prompt`} role="status">
              <Icon id={marksPrompt.status === 'failed' ? 'i-warn' : 'i-check'} />
              <div>
                {marksPrompt.status === 'syncing' ? (
                  <b>成绩已保存 · 正在同步题目清单…</b>
                ) : marksPrompt.status === 'ok' ? (
                  <>
                    <b>成绩已保存 · 去标记这场题目？</b>
                    <div className="hint">只标记你在意的题；没标记的不影响统计。</div>
                    {marksPrompt.archived ? <div className="hint">这场已归档，题目标记仍可修改。</div> : null}
                  </>
                ) : marksPrompt.mismatch ? (
                  <>
                    <b>成绩已保存 · 题目清单与当前榜单不一致</b>
                    <div className="hint">
                      这场已有题目清单，alias 集合与当前榜单不同；暂不自动重建，避免丢标记。成绩与已有标记不受影响。
                    </div>
                  </>
                ) : (
                  <>
                    <b>成绩已保存 · 题目清单同步失败</b> · {marksPrompt.message}
                    <div className="hint">成绩不受影响；可重试，或到工坊详情处理。</div>
                  </>
                )}
              </div>
              {marksPrompt.status === 'ok' ? (
                <span className="arena-alert-acts">
                  <button
                    className="btn btn--xs btn--primary"
                    onClick={() => {
                      window.location.hash = `/master?object=${encodeURIComponent(marksPrompt.contestId)}&panel=problems`;
                    }}
                  >
                    去标记
                  </button>
                  <button className="btn btn--xs btn--ghost" onClick={() => setMarksPrompt(null)}>
                    暂不
                  </button>
                </span>
              ) : marksPrompt.status === 'failed' ? (
                <span className="arena-alert-acts">
                  {marksPrompt.mismatch ? (
                    <>
                      <button
                        className="btn btn--xs btn--primary"
                        onClick={() => {
                          window.location.hash = `/master?object=${encodeURIComponent(marksPrompt.contestId)}&panel=problems`;
                        }}
                      >
                        去工坊
                      </button>
                      <button className="btn btn--xs btn--ghost" onClick={() => setMarksPrompt(null)}>
                        知道了
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        className="btn btn--xs"
                        disabled={saveBusy}
                        onClick={() => runMarksSync(marksPrompt.contestId, marksPrompt.recordId, marksPrompt.problems)}
                      >
                        重试
                      </button>
                      <button
                        className="btn btn--xs btn--ghost"
                        onClick={() => {
                          window.location.hash = `/master?object=${encodeURIComponent(marksPrompt.contestId)}&panel=problems`;
                        }}
                      >
                        去工坊
                      </button>
                    </>
                  )}
                </span>
              ) : null}
            </div>
          ) : null}
          {stale ? (
            <div className="alert alert--warn" role="status">
              <Icon id="i-warn" />
              <div>
                <b>另一个标签页改了本场草稿</b> · 这个页面不再写入，避免互相覆盖
              </div>
              <button
                className="alert__x"
                type="button"
                onClick={() => {
                  setStale(false);
                  setReloadNo((n) => n + 1);
                }}
              >
                重新读取
              </button>
            </div>
          ) : null}
          {draftErr !== null ? (
            <div className="alert alert--err" role="status">
              <Icon id="i-warn" />
              <div>
                <b>当前草稿读不出来</b> · {draftErr}
              </div>
              <button className="alert__x" type="button" onClick={() => setResetConfirm(true)}>
                重置草稿
              </button>
            </div>
          ) : null}
          {storageWarn !== null ? (
            <div className="alert alert--warn" role="status">
              <Icon id="i-warn" />
              <div>{storageWarn}</div>
            </div>
          ) : null}
          {saveErr !== null ? (
            <div className="alert alert--err" role="status">
              <Icon id="i-plug" />
              <div>{saveErr}</div>
              {draft?.pendingSave !== null ? (
                <button className="alert__x" type="button" disabled={saveBusy} onClick={requestSaveCurrent}>
                  重试对账
                </button>
              ) : null}
            </div>
          ) : null}
          {conflict !== null ? (
            <div className="alert alert--err" role="status">
              <Icon id="i-warn" />
              <div>
                <b>{conflict.kind === 'conflict' ? '存档在别处改过了' : '保存结果未知'}</b> · {conflict.message}
                <div className="hint">本地修改还在。可以重新读取服务端现状（会丢掉本地修改），或另存一份保留本地内容。</div>
              </div>
              <span className="arena-alert-acts">
                <button className="btn btn--xs btn--ghost" type="button" onClick={reloadFromServer}>
                  重新读取
                </button>
                <button className="btn btn--xs" type="button" onClick={requestSaveAs}>
                  另存
                </button>
              </span>
            </div>
          ) : null}
          {actionErr !== null ? (
            <div className="alert alert--err" role="status">
              <Icon id="i-plug" />
              <div>{actionErr}</div>
              <button className="alert__x" type="button" onClick={() => setActionErr(null)}>
                知道了
              </button>
            </div>
          ) : null}
          {note !== null ? (
            <div className="alert alert--ok" role="status">
              <Icon id="i-check" />
              <div>{note}</div>
              <button className="alert__x" type="button" onClick={() => setNote(null)}>
                知道了
              </button>
            </div>
          ) : null}
          {viewError ? (
            <div className="alert alert--err" role="status">
              <Icon id="i-plug" />
              <div>
                <b>读档失败</b> · {view.error}
              </div>
              <span className="arena-alert-acts">
                <button className="btn btn--xs btn--ghost" type="button" onClick={() => setViewRetry((n) => n + 1)}>
                  重试
                </button>
                <button className="btn btn--xs btn--ghost" type="button" onClick={openHistoryLayer}>
                  历史成绩
                </button>
              </span>
            </div>
          ) : null}
          {draft === null && identity.kind === 'practice' ? (
            <div className="alert alert--warn" role="status">
              <Icon id="i-warn" />
              <div>这场还没有当前练习的草稿。</div>
              <button className="alert__x" type="button" onClick={beginNewPractice}>
                开始练习
              </button>
            </div>
          ) : null}

          {viewLoading ? (
            <div className="skel">
              <i />
              正在读取存档…
            </div>
          ) : null}

          {review ? (
            <div className="scrub">
              <span className="scrub__lab">回放</span>
              <span className="scrub__t" style={{ color: viewMs > model.freezeStart ? '#B4C0CF' : 'var(--accent-2)' }}>
                {clockHMS(viewMs)}
              </span>
              <span className="tl">
                <span className="tl__rail" />
                <span className="tl__fill" style={{ width: pct(viewMs, span) }} />
                <span className="tl__frz" style={{ left: pct(model.freezeStart, span), right: 0 }} />
                <span className="tl__mk" style={{ left: pct(model.freezeStart, span) }}>
                  <span>封榜 {freezeLabel}</span>
                </span>
                <input type="range" min={0} max={minutesOf(span)} step={1} value={minutesOf(viewMs)} aria-label="时间轴" onChange={(e) => scrub(Number(e.target.value))} />
              </span>
              <span className="scrub__acts">
                <button className="btn btn--xs btn--ghost" onClick={() => jump('0')}>
                  起点
                </button>
                <button className="btn btn--xs btn--ghost" onClick={() => jump('freeze')}>
                  封榜
                </button>
                <button className="btn btn--xs btn--ghost" onClick={() => jump('end')}>
                  终榜
                </button>
              </span>
            </div>
          ) : null}

          <div className="boardwrap" style={{ ['--np' as string]: model.problems.length }}>
            <div className="boardtools">
              <label className="switch">
                <input type="checkbox" checked={onlyFormal} onChange={(e) => setOnlyFormal(e.target.checked)} />
                仅正式队
              </label>
              {review ? (
                <label className="switch">
                  <input type="checkbox" checked={frozenView} onChange={(e) => setFrozenView(e.target.checked)} />
                  封榜视角
                </label>
              ) : null}
              <span className="spacer" />
              {inFrz ? (
                <span className="pill">
                  {review ? '定格视角' : '封榜中'} · 剩 {clockHMS(span - (review ? viewMs : elapsed))}
                </span>
              ) : null}
              {model.approx ? (
                <span
                  className="pill"
                  onMouseEnter={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    show({
                      x: r.left + r.width / 2,
                      y: r.bottom,
                      below: true,
                      date: '近似榜',
                      value: '本场快照没有逐次提交',
                      zero: false,
                      sub: ['榜按终局判名 + 次数重建，逐发时刻上游未记', '所以格子只在判名那一刻出现，中间过程看不到'],
                    });
                  }}
                  onMouseLeave={hide}
                >
                  近似回放
                </span>
              ) : null}
            </div>
            {inFrz ? (
              <div
                className="frost"
                onMouseEnter={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  show({
                    x: r.left + 220,
                    y: r.bottom,
                    below: true,
                    date: `封榜段 = 最后 ${clockHM(span - model.freezeStart)}`,
                    value: `定格在 ${freezeLabel}`,
                    zero: false,
                    valueClass: 'is-dim',
                    sub: ['段内提交只显时刻与次数，判名显示 ?', `名次与罚时定格在 ${freezeLabel} · 终局自动解封`],
                  });
                }}
                onMouseLeave={hide}
              >
                <Icon id="i-noflag" />
                <span>
                  {review ? '定格视角' : '封榜中'} · 名次定格在 <b>{freezeLabel}</b>
                </span>
                <span className="frost__r">
                  结果未知 {board.frzCells} 格 · 涉及 {board.frozenRows} 队
                </span>
              </div>
            ) : null}

            <div
              className="boardscroll"
              ref={boardBox}
              role="grid"
              aria-label="回放榜"
              aria-describedby="arena-keyhint"
              onMouseLeave={hide}
              onKeyDown={onBoardKeyDown}
              onFocus={onBoardFocus}
              onBlur={onBoardBlur}
            >
              <div className="brow bhead" role="row">
                <div
                  className="h-r"
                  role="columnheader"
                  onMouseEnter={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    show({
                      x: r.left + 40,
                      y: r.bottom,
                      below: true,
                      date: '名次 R#',
                      value: model.bands.length > 0 ? `奖牌 = 正式队 ${bandRanges(model.bands)}` : '本场无奖牌规则',
                      zero: model.bands.length === 0,
                      sub: ['全场位置 · 打星队占位不计奖牌', '并列同名次、其后跳号'],
                    });
                  }}
                >
                  R#
                </div>
                <div
                  className="h-s"
                  role="columnheader"
                  onMouseEnter={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    show({ x: r.left + 20, y: r.bottom, below: true, date: '学校排名 S#', value: '每校头队', zero: false, sub: ['只标各校最好的一支', '打星队不计'] });
                  }}
                >
                  S#
                </div>
                <div className="h-org" role="columnheader">Organization</div>
                <div className="h-team" role="columnheader">Team</div>
                <div
                  className="h-sol"
                  role="columnheader"
                  onMouseEnter={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    show({ x: r.left + 24, y: r.bottom, below: true, date: '过题 Slv', value: frozen ? `定格在 ${freezeLabel}` : '实时', zero: false, sub: [`封榜段内定格在 ${freezeLabel}`] });
                  }}
                >
                  Slv
                </div>
                <div
                  className="h-pen"
                  role="columnheader"
                  onMouseEnter={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    show({ x: r.left + 30, y: r.bottom, below: true, date: '罚时 Pen', value: 'AC 分钟 + 20 × 失败', zero: false, sub: ['过题前的失败次数', 'CE 不罚'] });
                  }}
                >
                  Pen
                </div>
                {model.problems.map((p, i) => (
                  <ProblemHead key={p.alias ?? i} problem={p} col={board.col[i] ?? { ac: 0, sub: 0, frz: 0, postAc: 0 }} rows={teamCount} cap={board.cap} model={model} board={board} index={i} />
                ))}
              </div>

              {board.rows.map((r) => (
                <BoardRowView
                  key={r.ti}
                  row={r}
                  team={r.ghost ? board.ghostTeam! : model.teams[r.ti]!}
                  problems={model.problems}
                  model={model}
                  focusCol={focus !== null && focus.ti === r.ti ? focus.p : null}
                  onCell={openCellPop}
                  onTeam={openTeamPop}
                />
              ))}
            </div>

            <div className="board__foot">
              <span>
                榜上 <b>{teamCount}</b> 队 · 累计过题 <b>{board.solvedTotal}</b>
              </span>
              {/* 键盘操作口径常驻在榜脚：`id` 给上面的 grid 做 aria-describedby，读屏进格子就念到。
                  窄屏的横向滚动由原生滚动条自己说话 —— 会不会滚跟题目数有关，写死一句反而失真 */}
              <span className="arena-keyhint" id="arena-keyhint">
                方向键移动 · Enter/空格查看 · Esc 返回
              </span>
              <span className="spacer" />
              <span className="key key--head">
                <span className="key__i">
                  <i className="phk is-quiet" />
                  无人提交
                </span>
                <span className="key__i">
                  <i className="phk is-pending" />
                  待定
                </span>
                <span className="key__i">
                  <i className="phk is-noone" />
                  交而没过
                </span>
                <span className="key__i">
                  <i className="phk is-any" />
                  有人过
                </span>
                <span className="key__i">
                  <i className="phk is-late" />
                  封榜后才解开
                </span>
              </span>
              <span className="key">
                <span className="key__i">
                  <i className="key__s key__s--pen">−</i>罚时
                </span>
                <span className="key__i">
                  <i className="key__s key__s--ac">✓</i>AC
                </span>
                <span className="key__i">
                  <i className="key__s key__s--fb">✦</i>首杀
                </span>
                <span className="key__i">
                  <i className="key__s key__s--frz">?</i>冻结
                </span>
                <span className="key__i">
                  <i className="key__s key__s--post" />封榜后
                </span>
              </span>
            </div>
          </div>
        </div>
      </div>

      {pop !== null ? (
        <Popover
          anchor={pop.anchor}
          viewport={{ w: window.innerWidth, h: window.innerHeight }}
          onClose={() => setPop(null)}
          width={pop.kind === 'ghost' ? 330 : pop.kind === 'team' ? 520 : 270}
          height={pop.kind === 'ghost' ? 500 : pop.kind === 'team' ? 520 : 260}
          label={pop.kind === 'ghost' ? '我的成绩' : pop.kind === 'team' ? (pop.ti === -1 ? '我的成绩' : '队伍详情') : '明细'}
          cls={pop.kind === 'ghost' ? 'pop--panel' : pop.kind === 'team' ? 'pop--panel pop--team' : undefined}
        >
          {pop.kind === 'sub' ? (
            <SubPop model={model} ti={pop.ti} p={pop.p} viewMs={viewMs} cap={board.cap} ghost={currentGhost} />
          ) : pop.kind === 'team' ? (
            <TeamDetail
              model={model}
              ti={pop.ti}
              board={board}
              viewMs={viewMs}
              cap={board.cap}
              onlyFormal={onlyFormal}
              unsealed={review && !frozenView}
              ghost={ghostSubs}
            />
          ) : (
            <GhostPanel
              problems={model.problems}
              durationMs={span}
              data={currentGhost}
              readOnly={identity.kind === 'view' || saveBusy}
              nowMin={runningHere ? () => Math.floor(elapsed / 60_000) : undefined}
              onChange={onGhostChange}
              onClear={onGhostClear}
            />
          )}
        </Popover>
      ) : null}

      {historyOpen ? (
        <HistoryDialog
          state={history}
          archived={false}
          hasDraft={draft !== null}
          currentId={identity.kind === 'view' ? identity.recordId : null}
          onRetry={() => void loadHistory()}
          onView={(id) => {
            setHistoryOpen(false);
            setIdentity({ kind: 'view', recordId: id });
          }}
          onEdit={(id) => void beginEdit(id)}
          onRestoreLegacy={() => void beginRestoreLegacy()}
          onClose={() => setHistoryOpen(false)}
        />
      ) : null}

      {nameState !== null ? (
        <NameDialog
          title={nameState.mode === 'save-as' ? '另存一份' : nameState.mode === 'switch' ? '保存后切换' : '保存成绩'}
          sub={
            nameState.mode === 'save-as'
              ? '另存会生成新的存档 ID，原档不变；保存成功后编辑目标切换到新档。'
              : nameState.mode === 'switch'
                ? '先给这份成绩起名并保存，成功后才切换；命名取消不会切换。'
                : '这是第一次保存这份草稿；名称默认本地日期时间，可修改。'
          }
          initial={nameState.initial}
          confirmLabel={saveBusy ? '保存中…' : '保存'}
          busy={saveBusy}
          error={nameErr}
          onCancel={() => {
            setNameState(null);
            setNameErr(null);
            switchOriginalRef.current = null;
          }}
          onConfirm={confirmName}
        />
      ) : null}

      {pending !== null && nameState === null ? (
        <ReplaceDialog
          kind={pending.case}
          targetLabel={
            pending.case === 'running'
              ? '当前练习'
              : pending.case === 'legacy'
                ? '旧成绩'
                : draft?.target !== null && draft !== null
                  ? `「${draft.target.name}」`
                  : '当前草稿'
          }
          busy={saveBusy}
          error={replaceErr ?? saveErr ?? conflict?.message ?? null}
          onCancel={() => {
            setPending(null);
            setReplaceErr(null);
            switchOriginalRef.current = null;
          }}
          onSaveSwitch={saveAndSwitch}
          onDiscardSwitch={discardAndSwitch}
        />
      ) : null}

      {legacyConfirm !== null ? (
        <ConfirmDialog
          title="旧成绩 · 先标记结束"
          body={
            <>
              这份旧存档保存时停在回顾模式，<b>不能证明它跑满了时长或真实的停止时间</b>。
              <br />
              标记“这份成绩已经结束”后，会按手动记录（manual / declared）进入编辑；保存时才把根文件升级为 schema 2。
            </>
          }
          confirmLabel="标记旧成绩已结束"
          onCancel={() => setLegacyConfirm(null)}
          onConfirm={confirmLegacyEdit}
        />
      ) : null}

      {resetConfirm ? (
        <ConfirmDialog
          title="重置本场草稿"
          body={
            <>
              当前草稿的格式读不懂。重置会删掉这份浏览器草稿并重新开始 —— 不会动工坊里的正式存档。
            </>
          }
          confirmLabel="重置草稿"
          danger
          onCancel={() => setResetConfirm(false)}
          onConfirm={() => {
            setResetConfirm(false);
            clearDraft(store, row.path);
            setDraftErr(null);
            commit(null, false);
            setReloadNo((n) => n + 1);
            setIdentity({ kind: 'review' });
          }}
        />
      ) : null}
    </>
  );
}

/* ---------- 列头 ---------- */

const HEAD_HINT = {
  quiet: '全场无人提交',
  pending: '封榜段内有活动 · 结果未定',
  noone: '有人交 · 无人过',
  any: '封榜前已有人过',
  late: '直到封榜后才被解开',
} as const;

const ProblemHead = memo(function ProblemHead({
  problem,
  col,
  rows,
  cap,
  model,
  board,
  index,
}: {
  problem: ContestModel['problems'][number];
  col: Board['col'][number];
  rows: number;
  cap: number;
  model: ContestModel;
  board: Board;
  index: number;
}) {
  const { show, hide } = useTip();
  const fb = board.rows.find((r) => r.cells[index]?.st === 'fb');
  const state = problemHeadState(col);
  const fbText =
    fb !== undefined
      ? `首杀 ${model.teams[fb.ti]?.org || model.teams[fb.ti]?.name || '队伍信息未收录'} · ${minutesOf(fb.cells[index]?.t ?? 0)}′`
      : col.ac > 0
        ? '当前视图无首杀'
        : cap >= model.duration
          ? '全场无人通过'
          : '尚无通过';
  return (
    <div
      className={`ph is-${state}`}
      role="columnheader"
      aria-label={`${problem.alias ?? String.fromCharCode(65 + index)} 题 ${problem.title ?? ''} · ${col.ac} / ${rows} 队过`}
      onMouseEnter={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        show({
          x: r.left + r.width / 2,
          y: r.bottom,
          below: true,
          date: `${problem.alias ?? ''} · ${problem.title ?? ''}`,
          value: `${col.ac} / ${rows} 队过`,
          zero: col.ac === 0,
          sub: [HEAD_HINT[state], `交 ${col.sub} 次`, fbText, col.frz > 0 ? `另有 ${col.frz} 格封榜未定` : '', col.postAc > 0 && col.postAc < col.ac ? `其中 ${col.postAc} 队封榜后才过` : ''].filter((s) => s !== ''),
        });
      }}
      onMouseLeave={hide}
    >
      <b>{problem.alias}</b>
      <i>{col.ac}</i>
    </div>
  );
});

/* ---------- 一行 ---------- */

interface RowProps {
  row: BoardRow;
  team: TeamModel;
  problems: ContestModel['problems'];
  model: ContestModel;
  /**
   * 这一行是不是焦点行 —— `null` = 不是，否则 = 当前焦点列（`-1` 队伍列 / `≥0` 第 p 题）。
   * 只传这一个数（不传焦点对象）：一次方向键移动只让旧、新两行过 memo，几百行的榜不动。
   */
  focusCol: number | null;
  onCell: (el: HTMLElement, ti: number, p: number) => void;
  onTeam: (el: HTMLElement, ti: number) => void;
}

const BoardRowView = memo(function BoardRowView(props: RowProps) {
  const { row, team, problems, model, focusCol, onCell, onTeam } = props;
  const { show, hide } = useTip();
  const ti = team.ti;

  const cellNodes = row.cells.map((c, p) => (
    <CellView key={p} cell={c} ti={ti} p={p} problem={problems[p] ?? {}} row={row} team={team} approx={model.approx} focused={focusCol === p} onCell={onCell} />
  ));

  const teamTip = (e: React.MouseEvent): void => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const title = team.name === '' ? team.org || '队伍信息未收录' : team.name;
    show({
      x: r.left + Math.min(r.width / 2, 150),
      y: r.top,
      date: team.org === '' || team.name === '' ? title : `${title} · ${team.org}`,
      value: `第 ${row.rank} 名 · 过 ${row.solved} 题 · 罚时 ${row.pen}`,
      zero: false,
      valueClass: row.medal ? `is-${row.medal}` : 'is-dim',
      sub: row.ghost ? [`VP 手动录入${row.medal ? ` · ${row.medalTitle}` : ''}`, '点击看每题逐发'] : [`机位 #${team.seat}${row.star ? ' · 打星不占奖牌' : row.medal ? ` · ${row.medalTitle}` : ' · 正式队'}`, team.members.length > 0 ? '点击查看队员' : '队员名单未收录 · 点击看队伍信息'],
    });
  };

  const who = team.name === '' ? team.org || '队伍信息未收录' : team.name;

  return (
    <div
      className={`brow brow--body${row.medal ? ` m-${row.medal}` : ''}${row.star ? ' is-star' : ''}${row.ghost ? ' is-ghost' : ''}`}
      role="row"
      onMouseEnter={teamTip}
      onMouseLeave={hide}
      onClick={(e) => {
        // 鼠标点行上任意处仍开队伍弹层（原口径）；队名列与格子自己 stopPropagation，不会二次触发
        hide();
        onTeam(e.currentTarget, ti);
      }}
    >
      <div className="c-r" role="gridcell">
        <b>{row.rank}</b>
      </div>
      <div className="c-s" role="gridcell">{row.srank === '' ? '' : <b>{row.srank}</b>}</div>
      <div className="c-org" role="gridcell">{team.org}</div>
      {/* 队名列是原生 button：Enter / 空格浏览器自己变点击，role 改成 gridcell 只为网格语义，不改行为 */}
      <button
        type="button"
        className="c-team"
        role="gridcell"
        data-ti={ti}
        data-p={TEAM_COL}
        tabIndex={focusCol === TEAM_COL ? 0 : -1}
        aria-label={`第 ${row.rank} 名 · ${who} · 查看队伍`}
        onClick={(e) => {
          e.stopPropagation();
          hide();
          onTeam(e.currentTarget, ti);
        }}
      >
        <span className={`c-team__n${row.ghost ? ' is-you' : ''}`}>{team.name}</span>
        {row.star ? <span className="c-team__star">★</span> : null}
      </button>
      <div className="c-sol" role="gridcell">
        <b>{row.solved}</b>
      </div>
      <div className="c-pen" role="gridcell">
        <b>{row.pen}</b>
      </div>
      {cellNodes}
    </div>
  );
});

interface CellProps {
  cell: Cell;
  ti: number;
  p: number;
  problem: ContestModel['problems'][number];
  row: BoardRow;
  team: TeamModel;
  approx: boolean;
  /** 这一格是不是当前焦点格（只有本行是当前行时才可能为 true） */
  focused: boolean;
  onCell: (el: HTMLElement, ti: number, p: number) => void;
}

const CellView = memo(function CellView({ cell, ti, p, problem, row, team, approx, focused, onCell }: CellProps) {
  const { show, hide } = useTip();
  /*
   * 空格子不再是一块"什么也不是"的 div：网格要每行同列、键盘要能停在任何一格，所以它一样可聚焦、
   * 一样开 SubPop —— 明细弹层本来就有「本场未提交。」/「本题还没录。」这一档，判名与格子读数不动
   * （engine 口径不变），只是把已经存在的空态入口暴露给键盘。
   */
  const empty = cell.st === 'none';
  const alias = problem.alias ?? String.fromCharCode(65 + p);

  const readout = (): { value: string; cls: string } => {
    if (empty) return { value: '暂无提交', cls: 'is-zero' };
    if (cell.st === 'ac') return { value: `AC ${minutesOf(cell.t)}′ ×${cell.n}${cell.post ? ' · 封榜后' : ''}`, cls: 'is-ok' };
    if (cell.st === 'fb') return { value: `首杀 ${minutesOf(cell.t)}′${cell.post ? ' · 封榜后' : ''}`, cls: 'is-ok' };
    if (cell.st === 'pen') return { value: `未过 −${cell.n} · 末次 ${minutesOf(cell.t)}′${cell.post ? ' · 封榜后' : ''}`, cls: 'is-bad' };
    if (cell.st === 'ce') return { value: `CE · 不罚 · ${minutesOf(cell.t)}′`, cls: 'is-zero' };
    return { value: `封榜 ?${cell.n} · 末次 ${minutesOf(cell.t)}′`, cls: 'is-zero' };
  };
  const tip = readout();
  const sub: string[] = [];
  if (empty) sub.push(row.ghost ? '我的成绩这一题在当前回放时刻还没有可显示的提交' : '这一题在当前回放时刻还没有提交');
  if (cell.post) sub.push('发生在封榜段 · 不计入定格名次');
  sub.push(`${team.name} · 第 ${row.rank} 名`);
  sub.push(approx ? '点击查看判名与次数' : '点击查看逐次提交');

  return (
    <button
      type="button"
      className={`pcell is-${cell.st} is-hit${cell.post ? ' is-post' : ''}`}
      role="gridcell"
      data-ti={ti}
      data-p={p}
      tabIndex={focused ? 0 : -1}
      aria-label={`${alias} 题 · ${tip.value} · 查看明细`}
      onMouseEnter={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        show({ x: r.left + r.width / 2, y: r.top, date: `${alias} · ${problem.title ?? ''}`, value: tip.value, zero: tip.cls === 'is-zero', valueClass: tip.cls, sub });
      }}
      onMouseLeave={hide}
      onClick={(e) => {
        e.stopPropagation();
        hide();
        onCell(e.currentTarget, ti, p);
      }}
    >
      {empty ? null : (
        <span className="pcell__b">
          <span className="pcell__t">{minutesOf(cell.t)}</span>
          <span className="pcell__n">{cell.st === 'ac' ? (cell.n > 1 ? `×${cell.n}` : '') : cell.st === 'fb' ? 'FB' : cell.st === 'pen' ? `−${cell.n}` : cell.st === 'ce' ? 'CE' : `?${cell.n}`}</span>
          {cell.post ? <i className="pcell__dot" /> : null}
        </span>
      )}
    </button>
  );
});

/* ---------- 弹层内容 ---------- */

function SubPop({ model, ti, p, viewMs, cap, ghost }: { model: ContestModel; ti: number; p: number; viewMs: number; cap: number; ghost: GhostData | null }) {
  const problem = model.problems[p];
  if (ti === -1) {
    if (problem === undefined) return null;
    const head = { title: `${problem.alias ?? ''} · ${problem.title ?? ''}`, sub: '你 @我的成绩' };
    const rows = (ghost?.subs ?? [])
      .filter((s) => s.p === p && s.t * 60_000 <= viewMs)
      .sort((a, b) => a.t - b.t)
      .map((s) => ({ r: s.r, t: s.t * 60_000, frozen: s.t * 60_000 > cap }));
    return (
      <PopShell head={head}>
        {rows.length === 0 ? (
          <div className="hint">本题还没录。</div>
        ) : (
          <>
            {rows.map((x, i) => (
              <div className="pop__row" key={i}>
                <span className={x.frozen ? 'res res--frz' : resClass(x.r)}>{x.frozen ? 'Frozen' : x.r}</span>
                <span className="pop__tm num">{clockHMS(x.t)}</span>
                <span className="pop__lg">手动录入</span>
              </div>
            ))}
            {/* Frozen 说明只留在真队明细弹层那处（更贴近冻结格出现的场景），这里不再重复 */}
            <div className="hint" style={{ marginTop: 8 }}>
              罚时 = 过题分钟 + 20 ×（过题前失败 · CE 不罚）
            </div>
          </>
        )}
      </PopShell>
    );
  }
  const team = model.teams[ti];
  if (team === undefined || problem === undefined) return null;
  const list = subsUntil(team.subs[p] ?? [], viewMs, cap, team.verdicts[p]);
  const verdict = team.verdicts[p];
  const fb = verdict === undefined || verdict === 'FB' ? team.subs[p]?.find((x) => x.result === 'FB') : undefined;
  const who = team.name === '' ? team.org || '队伍信息未收录' : team.org === '' ? team.name : `${team.name} @${team.org}`;
  const head = { title: `${problem.alias ?? ''} · ${problem.title ?? ''}`, sub: `${who}${fb !== undefined && toCap(fb) <= cap ? ' · 本题首杀' : ''}` };
  if (list.length === 0) {
    const s = team.summaries[p];
    if (s === undefined || s.t > viewMs) return <PopShell head={head}><div className="hint">本场未提交。</div></PopShell>;
    const shown = s.unknown || s.t > cap;
    return (
      <PopShell head={head}>
        <div className="pop__row">
          <span className={shown ? 'res res--frz' : s.accepted ? 'res res--ac' : 'res res--bad'}>{shown ? 'Frozen' : s.accepted ? (s.fb ? 'FB' : 'AC') : '未过'}</span>
          <span className="pop__tm num">{clockHMS(s.t)}</span>
          <span className="pop__lg">{s.tries} 发</span>
        </div>
        <div className="hint" style={{ marginTop: 8 }}>这题没有逐次提交记录，只有终局判名与总次数。</div>
      </PopShell>
    );
  }
  return (
    <PopShell head={head}>
      {list.map((x, i) => (
        <div className="pop__row" key={i}>
          <span className={x.frozen ? 'res res--frz' : resClass(x.r)}>{x.frozen ? 'Frozen' : x.r}</span>
          <span className="pop__tm num">{clockHMS(x.t)}</span>
          <span className="pop__lg">{x.language}</span>
        </div>
      ))}
      {/* 两句重复的 Frozen 说明去重后留下的这一处：紧挨着逐发明细里真正的 Frozen 行 */}
      <div className="hint" style={{ marginTop: 8 }}>
        {viewMs > model.freezeStart && viewMs < model.duration ? '封榜段内一律显示 Frozen · ' : ''}
        罚时 = 过题分钟 + 20 ×（过题前失败 · CE 不罚）
      </div>
    </PopShell>
  );
}

const toCap = (x: SrkSolution): number => toMs(x.time);
