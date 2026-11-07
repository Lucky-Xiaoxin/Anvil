/**
 * 首页「最近保存的比赛」只读汇总（GET /api/work/recent-contest）。
 * 夹具沿用仓库既有做法：临时工作区 + 注入的 `now` + Fastify inject，单测不出网（技术锁）。
 * 覆盖：跨场次的全局最新、题目标记不改变新旧、改名 / 更新的日期语义、归档与回收排除、
 * 没有存档与工作区未就绪、读不出来的存档只报 warning、同刻的稳定并列。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import Fastify, { type FastifyInstance } from 'fastify';
import { WORK_RECENT_CONTEST_RULE, WORK_RECENTS_LIMIT, type ArenaRecordSummaryDto, type WorkRecentContestDto } from '@anvil/shared';
import { initSchema } from '../src/db.ts';
import { registerWorkRoutes } from '../src/work/routes.ts';
import { WorkService } from '../src/work/store.ts';

const ARENA_A = 'official/icpc/icpc2025/shanghaina.srk.json';
const ARENA_B = 'official/icpc/icpc2025/hangzhoub.srk.json';
const ARENA_C = 'official/icpc/icpc2025/guangzhouc.srk.json';
const RA = `rec_${'a'.repeat(32)}`;
const RB = `rec_${'b'.repeat(32)}`;
const RC = `rec_${'c'.repeat(32)}`;
const DURATION = 5 * 3_600_000;
const PROBLEMS = [
  { alias: 'A', title: 'A. 某某题' },
  { alias: 'B', title: 'B. 另一题' },
  { alias: 'C', title: 'C. 第三题' },
];

let base: string;
let root: string;
let arenaDir: string;
let db: DatabaseSync;
let service: WorkService;
let app: FastifyInstance;
let now: Date;
let configRoot: string;

/** 存档时间只由注入的 `now` 决定：把它挪到几点，保存出来的 updatedAt 就是几点 */
function at(hour: number, minute = 0): void {
  now = new Date(2026, 9, 30, hour, minute);
}

function cacheBoard(path: string, problems = 3): void {
  const file = join(arenaDir, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({
      contest: { duration: [5, 'h'] },
      problems: Array.from({ length: problems }, (_, i) => ({ alias: String.fromCharCode(65 + i), title: `题 ${i + 1}` })),
    }),
  );
}

async function boot(): Promise<void> {
  base = mkdtempSync(join(tmpdir(), 'anvil-recent-'));
  root = join(base, 'root');
  arenaDir = join(base, 'vault', 'arena');
  mkdirSync(join(base, 'repo'));
  mkdirSync(arenaDir, { recursive: true });
  cacheBoard(ARENA_A);
  cacheBoard(ARENA_B);
  cacheBoard(ARENA_C);
  at(9);
  db = new DatabaseSync(':memory:');
  initSchema(db);
  configRoot = '';
  service = new WorkService({
    db,
    getRoot: () => configRoot,
    setRoot: (p) => {
      configRoot = p;
    },
    now: () => now,
    repoRoot: join(base, 'repo'),
    vaultDir: join(base, 'vault'),
    arenaDir,
  });
  app = Fastify();
  registerWorkRoutes(app, service);
  await app.ready();
}

beforeEach(boot);

afterEach(async () => {
  await app.close();
  db.close();
  rmSync(base, { recursive: true, force: true });
});

/** 受管根初始化：需要「已就绪」的用例自己调用，未就绪的形态才留给自己测 */
async function useWorkspace(): Promise<void> {
  await service.init({ path: root });
}

const save = (arenaPath: string, recordId: string, name: string) =>
  service.createArenaRecord({
    arenaPath,
    recordId,
    name,
    result: { origin: 'timed', finish: 'time-limit', durationMs: DURATION, stoppedAtMs: DURATION },
    ghost: { show: true, subs: [{ p: 0, t: 10, r: 'AC' }] },
  });

const createContest = (title: string, arenaPath: string) => service.create({ kind: 'contest', title, arenaPath });

const revisionOf = (arenaPath: string, recordId: string): string => {
  const found = service.listArenaRecords(arenaPath).records.find((r) => r.recordId === recordId);
  if (found === undefined) throw new Error(`夹具里找不到存档：${recordId}`);
  return found.revision;
};

async function getRecent(): Promise<WorkRecentContestDto> {
  const res = await app.inject({ method: 'GET', url: '/api/work/recent-contest' });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as WorkRecentContestDto;
}

describe('最近保存 · 取数口径', () => {
  it('跨场比赛取全局最新一份；dto 带对象与存档摘要', async () => {
    await useWorkspace();
    const a = await createContest('上海站 A', ARENA_A);
    const b = await createContest('杭州站 B', ARENA_B);
    at(9);
    await save(ARENA_A, RA, 'A 第一次');
    at(10);
    const later = await save(ARENA_B, RB, 'B 第一次');

    const dto = await getRecent();
    expect(dto.warnings).toEqual([]);
    expect(dto.rule).toBe(WORK_RECENT_CONTEST_RULE);
    expect(dto.recent?.contest.id).toBe(b.id);
    expect(dto.recent?.contest.title).toBe('杭州站 B');
    expect(dto.recent?.contest.links.arenaPath).toBe(ARENA_B);
    expect(dto.recent?.contest.effectiveArchived).toBe(false);
    expect(dto.recent?.record.recordId).toBe(RB);
    expect(dto.recent?.record.name).toBe('B 第一次');
    expect(dto.recent?.record.updatedAt).toBe(later.record.updatedAt);
    // 标记文件还没建立：dto 里就是没有这个字段，界面据此说「未建立」而不是「0 待补」
    expect(dto.recent?.contest.problemMarkSummary).toBeUndefined();

    // 更晚的存档落在这场比赛之后，方向反了也不影响：只比存档自己的 updatedAt
    at(8);
    expect((await getRecent()).recent?.record.recordId).toBe(RB);
  });

  it('同一时刻的并列按 contest id、再按 recordId 升序稳定收口', async () => {
    await useWorkspace();
    const a = await createContest('上海站 A', ARENA_A);
    const b = await createContest('杭州站 B', ARENA_B);
    at(10);
    await save(ARENA_A, RA, 'A 同刻');
    await save(ARENA_B, RB, 'B 同刻');

    const winner = a.id < b.id ? { contestId: a.id, recordId: RA } : { contestId: b.id, recordId: RB };
    const first = await getRecent();
    expect(first.recent?.contest.id).toBe(winner.contestId);
    expect(first.recent?.record.recordId).toBe(winner.recordId);
    // 再取一次、换个入口取一次，结果都一样：并列规则不依赖目录遍历顺序
    const again = await getRecent();
    expect(again.recent?.record.recordId).toBe(winner.recordId);
    expect(service.recentContest().recent?.record.recordId).toBe(winner.recordId);
  });

  it('同场同刻两份存档：recordId 升序那份胜', async () => {
    await useWorkspace();
    const c = await createContest('广州站 C', ARENA_C);
    at(10);
    await save(ARENA_C, RB, 'C 后写的');
    await save(ARENA_C, RA, 'C 先取的');

    const dto = await getRecent();
    expect(dto.recent?.contest.id).toBe(c.id);
    expect(dto.recent?.record.recordId).toBe(RA);
  });

  it('改名推进 updatedAt：旧档改一次名就成了最近保存', async () => {
    await useWorkspace();
    await createContest('上海站 A', ARENA_A);
    at(9);
    await save(ARENA_A, RA, '第一次');
    at(10);
    await save(ARENA_A, RB, '第二次');
    expect((await getRecent()).recent?.record.recordId).toBe(RB);

    at(11);
    const renamed = await service.renameArenaRecord({ arenaPath: ARENA_A, recordId: RA, expectedRevision: revisionOf(ARENA_A, RA), name: '改名' });
    const dto = await getRecent();
    expect(renamed.record.updatedAt).not.toBe(renamed.record.createdAt);
    expect(dto.recent?.record.recordId).toBe(RA);
    expect(dto.recent?.record.name).toBe('改名');
    expect(dto.recent?.record.updatedAt).toBe(renamed.record.updatedAt);

    at(12);
    const updated = await service.updateArenaRecord({
      arenaPath: ARENA_A,
      recordId: RB,
      expectedRevision: revisionOf(ARENA_A, RB),
      result: { origin: 'timed', finish: 'time-limit', durationMs: DURATION, stoppedAtMs: DURATION },
      ghost: { show: true, subs: [{ p: 1, t: 20, r: 'WA' }] },
    });
    expect((await getRecent()).recent?.record.updatedAt).toBe(updated.record.updatedAt);
  });

  it('题目标记同步与改标记都不改变新旧', async () => {
    await useWorkspace();
    await createContest('上海站 A', ARENA_A);
    const b = await createContest('杭州站 B', ARENA_B);
    at(9);
    await save(ARENA_A, RA, 'A 档');
    at(10);
    await save(ARENA_B, RB, 'B 档');
    const before = await getRecent();
    expect(before.recent?.contest.id).toBe(b.id);

    const synced = await service.syncProblemMarks({ arenaPath: ARENA_A, problems: PROBLEMS, recordId: RA });
    await service.updateProblemMarks({
      arenaPath: ARENA_A,
      expectedRevision: synced.revision,
      marks: { A: { progress: 'todo', star: false, tags: [] } },
    });

    const after = await getRecent();
    expect(after.recent?.contest.id).toBe(b.id);
    expect(after.recent?.record.updatedAt).toBe(before.recent?.record.updatedAt);
    expect(after.recent?.record.revision).toBe(before.recent?.record.revision);

    // A 场真存了一份新成绩之后才换座位，并且这时才带得出标记汇总
    at(11);
    await save(ARENA_A, RC, 'A 第二次');
    const moved = await getRecent();
    expect(moved.recent?.record.recordId).toBe(RC);
    expect(moved.recent?.contest.problemMarkSummary).toEqual({ total: 3, marked: 1, todo: 1, starred: 0 });
  });

  it('归档比赛与回收条目都不参与：存档跟着宿主一起出局', async () => {
    await useWorkspace();
    const a = await createContest('上海站 A', ARENA_A);
    const b = await createContest('杭州站 B', ARENA_B);
    at(9);
    await save(ARENA_A, RA, 'A 档');
    at(10);
    await save(ARENA_B, RB, 'B 档');

    await service.update({ id: b.id, archived: true });
    expect((await getRecent()).recent?.contest.id).toBe(a.id);

    await service.update({ id: b.id, archived: false });
    expect((await getRecent()).recent?.contest.id).toBe(b.id);

    await service.trashArenaRecord({ arenaPath: ARENA_B, recordId: RB, expectedRevision: revisionOf(ARENA_B, RB), confirm: true });
    expect((await getRecent()).recent?.contest.id).toBe(a.id);

    await service.trash(b.id);
    expect((await getRecent()).recent?.contest.id).toBe(a.id);

    await service.update({ id: a.id, archived: true });
    const none = await getRecent();
    expect(none.recent).toBeNull();
    expect(none.warnings).toEqual([]);
  });
});

describe('最近保存 · recents 快速跳转架（主界面 34）', () => {
  it('多场各一份：recents 按 updatedAt 降序全排，recent 恒为 recents[0]', async () => {
    await useWorkspace();
    await createContest('上海站 A', ARENA_A);
    await createContest('杭州站 B', ARENA_B);
    await createContest('广州站 C', ARENA_C);
    at(9);
    await save(ARENA_A, RA, 'A');
    at(10);
    await save(ARENA_B, RB, 'B');
    at(11);
    await save(ARENA_C, RC, 'C');

    const dto = await getRecent();
    expect(dto.recents.map((r) => r.record.recordId)).toEqual([RC, RB, RA]);
    expect(dto.recent).toEqual(dto.recents[0] ?? null);
  });

  it('同场多档去重：跳转架每场只留最新一份，第二份不占位', async () => {
    await useWorkspace();
    await createContest('上海站 A', ARENA_A);
    await createContest('杭州站 B', ARENA_B);
    at(9);
    await save(ARENA_A, RA, 'A 旧档');
    at(10);
    await save(ARENA_A, RB, 'A 新档');
    at(11);
    await save(ARENA_B, RC, 'B');

    const dto = await getRecent();
    expect(dto.recents).toHaveLength(2);
    expect(dto.recents.map((r) => r.record.recordId)).toEqual([RC, RB]);
  });

  it('超过上限按同一口径截断：只留最近 WORK_RECENTS_LIMIT 场', async () => {
    await useWorkspace();
    const paths = [
      ARENA_A,
      ARENA_B,
      ARENA_C,
      'official/icpc/icpc2025/d.srk.json',
      'official/icpc/icpc2025/e.srk.json',
      'official/icpc/icpc2025/f.srk.json',
    ];
    for (const p of paths.slice(3)) cacheBoard(p);
    for (let i = 0; i < paths.length; i++) {
      await createContest(`第 ${i + 1} 场`, paths[i]!);
    }
    // 保存时刻倒着排：第 1 场最晚，截断留下的必须是最近 5 场而不是先建的 5 场
    for (let i = 0; i < paths.length; i++) {
      at(12 - i);
      await save(paths[i]!, `rec_${String(i).repeat(32)}`, `第 ${i + 1} 场`);
    }
    const dto = await getRecent();
    expect(dto.recents).toHaveLength(WORK_RECENTS_LIMIT);
    expect(dto.recent?.contest.title).toBe('第 1 场');
    expect(dto.recents.at(-1)?.contest.title).toBe('第 5 场');
    expect(dto.recents.some((r) => r.contest.title === '第 6 场')).toBe(false);
  });

  it('没有存档：recents 为空数组，recent 为 null', async () => {
    await useWorkspace();
    await createContest('上海站 A', ARENA_A);
    const dto = await getRecent();
    expect(dto.recent).toBeNull();
    expect(dto.recents).toEqual([]);
  });
});

describe('最近保存 · 诚实的空态与部分结果', () => {
  it('工作区未配置 / 未初始化按原有错误形状返回，UI 走「未就绪」', async () => {
    let res = await app.inject({ method: 'GET', url: '/api/work/recent-contest' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.kind).toBe('workspace-unconfigured');

    mkdirSync(root);
    configRoot = root;
    res = await app.inject({ method: 'GET', url: '/api/work/recent-contest' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.kind).toBe('workspace-uninitialized');
  });

  it('有比赛没存档：recent 为 null，不算警告也不报错', async () => {
    await useWorkspace();
    await createContest('上海站 A', ARENA_A);
    const dto = await getRecent();
    expect(dto.recent).toBeNull();
    expect(dto.warnings).toEqual([]);
    expect(dto.rule).toBe(WORK_RECENT_CONTEST_RULE);
  });

  it('旧 live 草稿不是已保存成绩；旧 review 作为合法投影计入', async () => {
    await useWorkspace();
    const c = await createContest('广州站 C', ARENA_C);
    const legacy = (mode: 'live' | 'review') =>
      writeFileSync(
        join(root, c.relPath, 'record.json'),
        JSON.stringify({
          schema: 1,
          arenaPath: ARENA_C,
          title: '广州站 C',
          savedAt: '2026-11-01T00:00:00.000Z',
          ghost: { show: true, subs: [{ p: 0, t: 10, r: 'AC' }] },
          view: { mode, viewMs: 0, paused: mode === 'live', frozenView: false },
        }),
      );

    legacy('live');
    const draft = await getRecent();
    expect(draft.recent).toBeNull();
    expect(draft.warnings).toEqual([]);

    legacy('review');
    const reviewed = await getRecent();
    expect(reviewed.recent?.contest.id).toBe(c.id);
    expect(reviewed.recent?.record.recordId).toBe('legacy');
    expect(reviewed.recent?.record.updatedAt).toBe('2026-11-01T00:00:00.000Z');
    expect(reviewed.recent?.record.name).toContain('旧存档');
  });

  it('读不出来的存档只降为警告：结果仍给「已知里最近的」，不假装全局确定', async () => {
    await useWorkspace();
    const a = await createContest('上海站 A', ARENA_A);
    const b = await createContest('杭州站 B', ARENA_B);
    const c = await createContest('广州站 C', ARENA_C);
    at(9);
    await save(ARENA_A, RA, 'A 档');
    at(10);
    await save(ARENA_B, RB, 'B 档');

    // B 场目录里塞一份坏 JSON 与一个未知文件：好档照旧参与排序，坏档进警告
    writeFileSync(join(root, b.relPath, '.anvil-records', `rec_${'f'.repeat(32)}.json`), '{ 不是 JSON');
    writeFileSync(join(root, b.relPath, '.anvil-records', 'stray.txt'), 'unknown');
    // C 场的存档目录被换成了普通文件：整场读不出来，同样只报警告
    writeFileSync(join(root, c.relPath, '.anvil-records'), 'x');

    const dto = await getRecent();
    expect(dto.recent?.record.recordId).toBe(RB);
    expect(dto.warnings).toHaveLength(3);
    expect(dto.warnings.some((w) => w.includes('stray.txt'))).toBe(true);
    expect(dto.warnings.some((w) => w.includes(`rec_${'f'.repeat(32)}`))).toBe(true);
    expect(dto.warnings.some((w) => w.includes('广州站 C'))).toBe(true);

    // A 场读不出来的那份不参与：它自己的存档仍然正常，警告里也不会冒出 A 场
    expect(dto.warnings.some((w) => w.includes(a.title))).toBe(false);
  });

  it('GET 只读不写：重复请求结果一致、存档字节不变', async () => {
    await useWorkspace();
    await createContest('上海站 A', ARENA_A);
    at(10);
    await save(ARENA_B, RB, 'B 档');
    const file = join(root, (await service.tree()).objects.find((o) => o.links.arenaPath === ARENA_B)!.relPath, '.anvil-records', `${RB}.json`);
    const before = readFileSync(file, 'utf8');
    const first = await getRecent();
    const second = await getRecent();
    expect(second).toEqual(first);
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(first.recent?.record.name).toBe('B 档');
  });
});
