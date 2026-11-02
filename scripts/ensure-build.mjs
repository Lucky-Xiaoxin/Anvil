import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

// 前端构建读到的源码与配置。只比较最大 mtime：只删文件、不动其他文件时会漏判一次，
// 个人工具接受这个边界，换来的是绝大多数启动都不用再等一次 Vite 构建。
const inputs = [
  'packages/web/src',
  'packages/web/index.html',
  'packages/web/vite.config.ts',
  'packages/web/tsconfig.json',
  'packages/web/package.json',
  'packages/shared/src',
  'packages/shared/tsconfig.json',
  'packages/shared/package.json',
  'tsconfig.base.json',
  'package.json',
  'package-lock.json',
];

const output = join(root, 'packages/web/dist/index.html');

function newestMtime(path) {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    return 0;
  }
  if (!stats.isDirectory()) return stats.mtimeMs;
  let newest = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    newest = Math.max(newest, newestMtime(join(path, entry.name)));
  }
  return newest;
}

const sourceMtime = Math.max(...inputs.map((input) => newestMtime(join(root, input))));
const distMtime = newestMtime(output);

if (distMtime > 0 && distMtime >= sourceMtime) {
  console.log('[anvil] web dist is up to date, skipping build.');
  process.exit(0);
}

console.log('[anvil] web sources changed, building...');
const result = spawnSync('npm run build', { cwd: root, shell: true, stdio: 'inherit' });
process.exit(result.status ?? 1);
