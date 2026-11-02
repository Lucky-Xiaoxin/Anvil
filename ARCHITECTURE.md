# ANVIL 架构说明

ANVIL（铁砧）是一个只在本机运行的 ICPC 训练工作台。判题在各在线平台完成；ANVIL 负责把公开数据、赛事回放和本地代码 / 标记收进同一个界面。

## 技术栈与约束

- Node.js ≥ 24 + TypeScript strict
- Fastify 5，服务只监听 `127.0.0.1`
- 内置 `node:sqlite`，不依赖任何需要编译的原生模块
- React 18 + Vite，手写 CSS；活跃格子图用 CSS Grid 自绘
- vitest；单测全部 mock 网络，不打真实上游

## 目录

```text
packages/shared/   共享类型、纯函数（题目标记解析、排序、路径校验）
packages/server/   Fastify API、同步、SQLite、文件扫描、榜单缓存
packages/web/      React 界面
scripts/           开发 / 启动辅助脚本
vault.example/     运行时数据目录模板；真实 vault/ 不入库
start.bat / stop.bat
```

## 三个模块

### 个人数据

- 输入：Codeforces 官方 API；AtCoder 参赛史 + AtCoder Problems 社区数据；heimaom.cn 的 XCPC 社区快照。
- 存储：`vault/anvil.db`（`node:sqlite`），按 source 分表；同步状态也在库里。
- 输出：仪表盘（热力图 / rating / 提交统计）与 XCPC 档案长卷。

### 模拟榜单

- 目录：algoux/srk-collection 的公开赛事快照目录（AGPL-3.0，仅运行时拉取）。
- 缓存：`vault/arena/` 下的 `srk.json`；按需拉取，不打包进仓库。
- 功能：目录、计时、封榜定格、终局解封、逐秒回放、我的成绩（手动逐发 / 幽灵）。

### 工坊

- 受管工作区：用户在设置里指定一个根目录；ANVIL 只管理根目录下的对象。
- 对象：比赛（contest）/ 题组（problemset）/ 旧题目（problem）/ 模板（template）/ 笔记（note）。
- 一个对象 = 一个目录 + `.anvil.json` 元数据；归档 = 只读定格。
- `problem-marks.json` 是比赛级题目标记的唯一真相（待补题 / 已补 / 已过 + 重点 + 自由标签）。
- 成绩存档在 `.anvil-records/`；与题目标记分开，标记跟着比赛走。

## 数据流

```text
平台 API / 社区快照 → 服务端同步器 → SQLite → Fastify DTO → React
                                  ↘ vault/arena/ 缓存（榜单）

工坊：文件系统 ⇄ 服务端扫描 / 原子写 ⇄ React（外部编辑器打开文件）
```

所有写接口要求 JSON + 本机 Origin；路径解析会拒绝逃逸受管根目录的输入。

## 测试

`npm test` 运行 vitest；服务端覆盖同步、路由、存储、榜单缓存、工坊标记等，前端以纯函数与构建为主。公开快照的 `npm run verify` = typecheck + test + build（不含私有仓库的文档索引检查）。

## 公开快照说明

这个仓库是某个里程碑的只读快照，开发在私有仓库进行，更新按里程碑同步。截图中的选手数据来自公开榜单，仅作演示。
