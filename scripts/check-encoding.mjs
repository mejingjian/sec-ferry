#!/usr/bin/env node
// 校验 PowerShell 脚本的编码约定：UTF-8 BOM + CRLF。
//
// 为什么需要它：Windows PowerShell 5.1 在文件没有 BOM 时会按系统 ANSI 代码页解读，
// 中文字符串会变成乱码，甚至让 Parser 直接报语法错。历史上
// scripts/stop-dev-server.ps1 就是这么废掉的 —— 文件是无 BOM 的 LF，脚本一跑就报
// 4 处语法错误。
//
// 这条约定写在注释里、靠人记住，一定会漏。所以把它做成可执行的检查，交给 CI。

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 递归收集所有 .ps1 / .psm1 */
function collect(dir, out = []) {
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".next" || entry.name === ".git") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full, out);
    else if (/\.(ps1|psm1)$/i.test(entry.name)) out.push(full);
  }
  return out;
}

const files = collect(root);
const problems = [];

if (files.length === 0) {
  console.log("[check:encoding] 未发现 PowerShell 脚本，跳过。");
  process.exit(0);
}

for (const file of files) {
  const buf = readFileSync(file);
  const text = buf.toString("utf8");
  const rel = path.relative(root, file);
  const issues = [];

  const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  if (!hasBom) issues.push("缺少 UTF-8 BOM");

  const hasCrlf = text.includes("\r\n");
  const hasLoneLf = /\n/.test(text.replace(/\r\n/g, ""));
  if (!hasCrlf) issues.push("没有任何 CRLF 行尾");
  else if (hasLoneLf) issues.push("混有裸 LF 行尾");

  if (issues.length) problems.push({ rel, issues, size: statSync(file).size });
}

console.log(`[check:encoding] 检查了 ${files.length} 个 PowerShell 脚本。`);

if (problems.length) {
  console.log("\n不符合约定（要求 UTF-8 BOM + CRLF）：");
  for (const p of problems) {
    console.log(`  [x] ${p.rel}（${p.size}B）—— ${p.issues.join("；")}`);
  }
  console.log("\n修复方法：用编辑器另存为「UTF-8 带 BOM」，并把行尾统一为 CRLF。");
  console.log("注意：BOM 无法由 .gitattributes 保证，只能靠本检查把关。");
  process.exit(1);
}

console.log("[check:encoding] 全部符合约定：UTF-8 BOM + CRLF。");
