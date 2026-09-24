#!/usr/bin/env node
// 容器启动前的运行时配置准备。
//
// 设计目标：让「配置」和「数据」都落在持久卷里 —— 重启容器、换镜像、甚至换宿主机，
// 会话不失效、已加密的 LDAP 密码仍可解密、业务数据不丢。
//
// 用法：node docker/prepare-runtime-config.mjs --role platform
//
// 1) 在 $CONFIG_DIR/local.config.json 生成或更新本地配置。CONFIG_ENCRYPTION_KEY 优先取自环境变量；
//    环境变量没给就随机生成一次并持久化（⚠️ 该密钥一旦更换，所有会话失效、已存 LDAP 密码无法解密）。
// 2) 把项目根的 local.config.json 软链到持久卷上的那份，这样仓库里现有的
//    scripts/prepare-local-config.mjs 不用改代码就能读写持久化配置。
// 3) 调用 scripts/prepare-local-config.mjs 生成 dist/server/wrangler.local.json。
// 4) 再把 PLATFORM_* 等环境变量合并进该文件的 vars —— 这类变量只在 Worker 的 env 里可见，
//    local.config.json 管不到（这是仓库现有脚本没覆盖的一段）。
//
// 0007 起（单平台站内收发）不再有交付网关角色与 DELIVERY_* 变量。
import { existsSync, mkdirSync, readFileSync, symlinkSync, lstatSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";

const { projectRoot } = await import("../scripts/sites-env.mjs");

const args = process.argv.slice(2);
const role = args.includes("--role") ? args[args.indexOf("--role") + 1] : "platform";
if (role !== "platform") {
  console.error("用法：node docker/prepare-runtime-config.mjs --role platform（0007 起仅支持 platform 角色）");
  process.exit(2);
}

const configDir = process.env.CONFIG_DIR || "/data/config";
const platformPersistDir = process.env.PERSIST_DIR || "/data/state";

/** 把 env 里存在且非空的键写进 target.vars */
function mergeEnvVars(target, keys) {
  const merged = [];
  target.vars = target.vars || {};
  for (const key of keys) {
    const value = process.env[key];
    if (typeof value === "string" && value !== "") {
      target.vars[key] = value;
      merged.push(key);
    }
  }
  return merged;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

/** 确保仓库根的 local.config.json 指向持久卷上的真实文件（跨容器重建仍然稳定） */
function linkLocalConfig() {
  const linked = path.join(projectRoot, "local.config.json");
  const real = path.join(configDir, "local.config.json");
  mkdirSync(configDir, { recursive: true });
  let exists = false;
  try {
    exists = lstatSync(linked).isSymbolicLink() || lstatSync(linked).isFile();
  } catch {
    exists = false;
  }
  if (exists) {
    // 已经是指向持久卷的软链就复用；是普通文件（旧镜像残留）则搬走，避免配置漂移
    try {
      if (lstatSync(linked).isSymbolicLink()) return real;
    } catch {
      /* 忽略 */
    }
    unlinkSync(linked);
  }
  try {
    symlinkSync(real, linked);
  } catch (error) {
    console.error(`无法建立 local.config.json 软链：${error.message}`);
    process.exit(1);
  }
  return real;
}

function preparePlatformConfig() {
  const localConfigFile = linkLocalConfig();
  let local = {};
  if (existsSync(localConfigFile)) {
    local = readJson(localConfigFile);
  }

  if (typeof local.configEncryptionKey !== "string" || local.configEncryptionKey.length < 32) {
    const fromEnv = process.env.CONFIG_ENCRYPTION_KEY;
    local.configEncryptionKey = fromEnv && fromEnv.length >= 32 ? fromEnv : randomBytes(32).toString("hex");
    console.log(
      fromEnv
        ? "已从 CONFIG_ENCRYPTION_KEY 环境变量写入加密密钥。"
        : "环境变量未提供 CONFIG_ENCRYPTION_KEY，已随机生成并持久化（请务必备份该文件）。",
    );
  }

  if (typeof local.quarantineRetentionDays !== "string" && process.env.QUARANTINE_RETENTION_DAYS) {
    local.quarantineRetentionDays = process.env.QUARANTINE_RETENTION_DAYS;
  }
  writeJson(localConfigFile, local);

  const prepared = spawnSync(process.execPath, ["scripts/prepare-local-config.mjs"], {
    cwd: projectRoot,
    stdio: "inherit",
    env: process.env,
  });
  if (prepared.status !== 0) process.exit(prepared.status ?? 1);

  const runtimeConfig = path.join(projectRoot, "dist/server/wrangler.local.json");
  if (!existsSync(runtimeConfig)) {
    console.error("dist/server/wrangler.local.json 未生成，请确认镜像内已包含构建产物 dist/。");
    process.exit(1);
  }
  const wrangler = readJson(runtimeConfig);
  const merged = mergeEnvVars(wrangler, [
    "PLATFORM_ADMIN_EMAILS",
    "PLATFORM_APPROVER_EMAILS",
    "PLATFORM_AUDITOR_EMAILS",
    "QUARANTINE_RETENTION_DAYS",
    // 域账号登录相关：是否放开自声明登录（仅联调）、失败锁定阈值
    "ALLOW_SELF_DECLARED_LOGIN",
    "LOGIN_MAX_FAILURES",
    "LOGIN_LOCK_MINUTES",
  ]);
  writeJson(runtimeConfig, wrangler);
  mkdirSync(platformPersistDir, { recursive: true });
  console.log(`平台运行时配置就绪（持久卷 ${platformPersistDir}）；已注入变量：${merged.join(", ") || "（无）"}`);
}

preparePlatformConfig();
