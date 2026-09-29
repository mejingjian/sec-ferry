// 运行时版本闸门（单一真相）：本项目对 Node 版本有硬性下限，低于它时症状**非常不直观**，
// 所以在这里显式判断并给出可执行的提示，而不是让使用者去读 Node 内部的报错。
//
// 为什么下限是 22.16.0（而不是早先写的 22.13.0）：
//   `node:sqlite` 自 v22.5.0 引入，v22.13.0 起不再需要 `--experimental-sqlite` 标志 ——
//   但**本项目实际用到的两个 API 更晚才提供**：
//     * `sqlite.backup()`               → v22.16.0（scripts/backup.mjs 的在线热备）
//     * `statement.setReturnArrays()`   → v22.16.0（db/sqlite-client.mjs 的 raw() 适配）
//   低于该版本时的失败有两种，都不是「功能降级」而是直接崩：
//     * `import { backup } from "node:sqlite"` 在**模块链接期**就失败（没有该导出）；
//     * `stmt.setReturnArrays(true)` 抛 `TypeError: ... is not a function`。
//   2026-09-29 首次推送 GitHub 时 CI 就是被这一点绊倒的：ci.yml 当时锁在 22.13，
//   而本地开发机（22.22）与容器基础镜像（node:22 最新）都高于下限，所以本地全绿。

export const NODE_MIN = "22.16.0";

/** @param {string} version @returns {[number, number, number]} */
function parse(version) {
  const parts = String(version).replace(/^v/, "").split(".").map((part) => Number.parseInt(part, 10) || 0);
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

/** 当前（或指定）Node 版本是否满足下限 */
export function nodeVersionOk(version = process.versions.node) {
  const [major, minor, patch] = parse(version);
  const [minMajor, minMinor, minPatch] = parse(NODE_MIN);
  if (major !== minMajor) return major > minMajor;
  if (minor !== minMinor) return minor > minMinor;
  return patch >= minPatch;
}

/**
 * 低于下限时抛出可执行的错误；满足则什么都不做。
 * @param {string} where 出问题的位置，出现在错误信息开头（便于定位是哪条路径先撞上）
 */
export function assertNodeVersion(where = "") {
  if (nodeVersionOk()) return;
  const prefix = where ? `${where}：` : "";
  throw new Error(
    `${prefix}需要 Node.js >= ${NODE_MIN}，当前 ${process.versions.node}。\n` +
      `  原因：本项目使用 node:sqlite 的 sqlite.backup() 与 statement.setReturnArrays()，二者自 ${NODE_MIN} 起提供。\n` +
      `  处理：升级 Node（如 nvm install ${NODE_MIN}），或改用容器部署（镜像已固定合适的运行时）。`,
  );
}
