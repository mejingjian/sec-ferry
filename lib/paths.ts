// 数据目录解析：数据库、隔离区文件、备份三者的唯一真相。
//
// 旧架构把数据藏在 workerd 的持久化目录（.wrangler/state）里，需要 wrangler 才能定位；
// 现在改为显式的两个目录，备份与迁移都只需搬目录：
//
//   <DATA_DIR>/db/platform.db   —— SQLite 主库
//   <DATA_DIR>/files/…          —— 隔离区对象（按 objectKey 落盘）
//   <DATA_DIR>/backups/…        —— 备份 sidecar 的产物
//
// 容器内 DATA_DIR=/data（对应命名卷）；本地开发默认 <cwd>/.local-data。

import path from "node:path";
import { env } from "@/lib/env";

/**
 * 路径锚点：相对路径都按「仓库/应用根」解析，而不是进程当前目录。
 *
 * ⚠️ 为什么需要它：standalone 的 `server.js` 开头就执行 `process.chdir(__dirname)`，
 *    于是 cwd 变成 `.next/standalone`。若直接拿 cwd 当锚点：
 *      - 数据会落进构建产物目录，下一次 `next build`（cleanDistDir）会连数据一起删掉；
 *      - `.env` 里写的相对 DATA_DIR 也会被解释到错误的层级。
 *    容器里 cwd 就是 /app、数据固定 /data，不受影响；这里主要保护本地开发与直接跑 server.js 的场景。
 */
function anchorRoot(): string {
  const cwd = process.cwd();
  const segments = cwd.split(path.sep);
  const distIndex = segments.lastIndexOf(".next");
  if (distIndex > 0) return segments.slice(0, distIndex).join(path.sep) || path.sep;
  return cwd;
}

/** 相对路径按锚点解析，绝对路径原样规范化 */
function fromAnchor(value: string): string {
  return path.isAbsolute(value) ? path.normalize(value) : path.join(/* turbopackIgnore: true */ anchorRoot(), value);
}

export function dataDir(): string {
  return env.DATA_DIR ? fromAnchor(env.DATA_DIR) : path.join(/* turbopackIgnore: true */ anchorRoot(), ".local-data");
}

export function dbFile(): string {
  return env.DB_FILE ? fromAnchor(env.DB_FILE) : path.join(dataDir(), "db", "platform.db");
}

export function filesDir(): string {
  return env.FILES_DIR ? fromAnchor(env.FILES_DIR) : path.join(dataDir(), "files");
}

export function backupsDir(): string {
  return path.join(dataDir(), "backups");
}

/**
 * 迁移文件目录。standalone 产物里 drizzle/ 与 server.js 同级（assemble-standalone.mjs 复制进去，
 * Docker 镜像再 COPY 整个 standalone），本地开发时就是仓库根的 drizzle/。
 * 因此这里**故意**用 cwd 而不是 anchorRoot()：cwd 就是「server.js 所在的那个应用根」。
 */
export function migrationsDir(): string {
  if (env.MIGRATIONS_DIR) return fromAnchor(env.MIGRATIONS_DIR);
  return path.join(process.cwd(), "drizzle");
}
