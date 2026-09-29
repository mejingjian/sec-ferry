#!/usr/bin/env node
/**
 * 运行期镜像白名单守卫（npm run check:image）
 *
 * 背景：docker/Dockerfile.platform 的运行阶段是**逐文件白名单**拷贝 ——
 *   * `.next/standalone` 只含「被应用打包进去」的代码，不会自动带上 CLI 需要的同目录模块；
 *   * 所以 db/*.mjs、scripts/*.mjs 必须逐个 COPY。
 * 漏掉一个的后果特别隐蔽：**镜像构建成功、能启动容器，却在 entrypoint 第一步就崩**
 *   （ERR_MODULE_NOT_FOUND）。曾经漏过一次 db/runtime.mjs，靠人工比对发现。
 *
 * 本脚本做两件精确、无副作用的事：
 *   1. 白名单里列的每个文件都真实存在（防拼写错误）；
 *   2. 白名单内文件的**相对导入闭包**仍然闭合 —— 即被 import 的同仓模块也在白名单里。
 *
 * `--self-test` 会拿「故意去掉 runtime.mjs」的 Dockerfile 文本跑一遍，确认守卫真的能发现问题
 * （守卫自己也要有人守）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOCKERFILE = path.join(ROOT, "docker", "Dockerfile.platform");

/** 从 Dockerfile 文本中解析「从 builder 拷贝进运行阶段」的文件清单（/app 相对路径，posix 风格）。 */
export function parseImageWhitelist(dockerfileText) {
  const files = new Set();
  for (const rawLine of dockerfileText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!/^COPY\b/.test(line) || !/--from=builder/.test(line)) continue;
    for (const token of line.split(/\s+/)) {
      if (!token.startsWith("/app/")) continue; // 目标（./db/ 等）与构建参数都跳过
      if (!/\.(mjs|cjs|js|json)$/.test(token)) continue; // 目录（.next/standalone）跳过
      files.add(token.slice("/app/".length));
    }
  }
  return files;
}

/** 抽取源码里的相对导入目标（`from "./x.mjs"`、`import("./x.mjs")`）。 */
export function relativeImportsOf(sourceText) {
  const specs = new Set();
  for (const re of [/from\s+["']([^"']+)["']/g, /import\s*\(\s*["']([^"']+)["']\s*\)/g]) {
    let m;
    while ((m = re.exec(sourceText))) {
      if (m[1].startsWith(".")) specs.add(m[1]);
    }
  }
  return [...specs];
}

/**
 * 校验清单。返回 { ok, problems[] }，纯函数（只读磁盘上的源码，不写任何东西）。
 * dockerfileText 可注入，便于自测。
 */
export function checkManifest(dockerfileText, { root = ROOT } = {}) {
  const whitelist = parseImageWhitelist(dockerfileText);
  const problems = [];

  for (const rel of whitelist) {
    const abs = path.join(root, ...rel.split("/"));
    if (!fs.existsSync(abs)) {
      problems.push(`白名单里的文件不存在（Dockerfile 拼写错误？）：${rel}`);
      continue;
    }
    const source = fs.readFileSync(abs, "utf8");
    for (const spec of relativeImportsOf(source)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec));
      if (whitelist.has(target)) continue;
      problems.push(
        `${rel} 导入了 ${spec}（即 ${target}），但它不在镜像白名单里 —— ` +
          `容器会在 entrypoint 阶段抛 ERR_MODULE_NOT_FOUND。请把 /app/${target} 加进 ` +
          `docker/Dockerfile.platform 的 COPY 白名单。`,
      );
    }
  }
  return { ok: problems.length === 0, whitelist: [...whitelist].sort(), problems };
}

function main() {
  const selfTest = process.argv.includes("--self-test");
  const text = fs.readFileSync(DOCKERFILE, "utf8");

  const real = checkManifest(text);
  if (!real.ok) {
    console.error("✗ 镜像白名单不闭合：");
    for (const p of real.problems) console.error("   -", p);
    process.exit(1);
  }
  console.log(`✓ 镜像白名单闭合（${real.whitelist.length} 个文件）：`);
  console.log("   " + real.whitelist.join("\n   "));

  if (selfTest) {
    // 守卫自测：把 runtime.mjs 从白名单里拿掉，必须被判定为「不闭合」
    const broken = text.replace("/app/db/runtime.mjs", "");
    const brokenResult = checkManifest(broken);
    const caught = brokenResult.problems.some((p) => p.includes("db/runtime.mjs"));
    if (brokenResult.ok || !caught) {
      console.error("✗ 自测失败：去掉 db/runtime.mjs 后守卫没有报错（守卫本身失效了）");
      process.exit(1);
    }
    console.log("✓ 自测通过：故意去掉 db/runtime.mjs 时守卫能准确报出缺失");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
