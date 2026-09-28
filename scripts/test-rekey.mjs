#!/usr/bin/env node
// 密钥轮换（rekey）回归：验证「CONFIG_ENCRYPTION_KEY 可更换」这条链路的每一环。
//
// 为什么要有这个脚本：密钥轮换是本项目里少见的**不可逆**操作 —— 它原地覆盖库里的密文。
// 一旦某条路径出错（用了错密钥、写了一半、新密文自己解不开、审计链断掉），
// 症状不是报错而是「平台突然读不出认证源」，而那时原密文已经被覆盖掉了。
// 因此这些路径必须有自动化覆盖，而不是靠发布前手动点一遍。
//
// 与其它 test-*.mjs 的区别：本脚本**不碰任何真实数据**。它在 .tmp-rekey-test/ 下
// 用迁移建一个全新的空库，再植入人造密文与历史审计事件，因此可以随便跑、随便失败。
// （其余脚本会真实写入发送单/角色/邮件配置，只能打开发/验收环境。）
//
// 用法：
//   node scripts/test-rekey.mjs
//
// 覆盖范围：
//   A 只读审计不写任何数据          E 往返轮换（新→旧）后明文仍可还原
//   B 缺 --yes 时只出计划           F 新旧密钥相同时拒绝
//   C 旧密钥错误时拒绝并解释        G 新密钥长度不足/占位符/旧密钥缺失时拒绝
//   D 正式轮换：快照、密文替换、     H 平台运行探测不阻断
//     新可解/旧不可解、审计链连续

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openSqlite } from "../db/sqlite-client.mjs";
import { encryptSecret, decryptSecret, tryDecryptSecret } from "../db/crypto.mjs";
import { auditHash } from "../db/audit-chain.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const work = path.join(root, ".tmp-rekey-test");
const dataDir = path.join(work, "data");
const dbFile = path.join(dataDir, "db", "platform.db");
const rekey = path.join(root, "scripts", "rekey.mjs");

// 合成密钥（32+ 字符）与人造"口令"——与任何真实环境无关
const OLD = "old-key-0123456789abcdef0123456789abcdef";
const NEW = "new-key-fedcba9876543210fedcba9876543210";
const PLAIN_LDAP = "cn=svc-ldap,ou=svc,dc=corp,dc=local";
const PLAIN_SMTP = "smtp-pass-synthetic";

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) {
    pass += 1;
    console.log(`  [OK]   ${name}${extra ? " — " + extra : ""}`);
  } else {
    fail += 1;
    console.log(`  [FAIL] ${name}${extra ? " — " + extra : ""}`);
  }
};
const section = (title) => console.log(`\n${"=".repeat(6)} ${title} ${"=".repeat(6)}`);

function runRekey(extraArgs) {
  const result = spawnSync(process.execPath, ["--no-warnings", rekey, ...extraArgs], {
    cwd: root,
    encoding: "utf8",
    // 显式清空 NODE_OPTIONS：宿主的 safe-delete 注入会干扰子进程
    env: { ...process.env, DATA_DIR: dataDir, NODE_OPTIONS: "" },
  });
  return { code: result.status, out: (result.stdout || "") + (result.stderr || "") };
}
function readRow() {
  const db = openSqlite(dbFile);
  const row = db.prepare("SELECT rowid AS rid, encrypted_secret, smtp_encrypted_secret FROM integration_settings WHERE id='ldap'").get();
  db.close();
  return row;
}
function listSnapshots() {
  const dir = path.join(dataDir, "backups", "db");
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".db")) : [];
}

/**
 * 按**改动前**的拼接口径写审计（原 lib/server.ts 的 payload 直接内联在这里）。
 * 用来验证共享模块 db/audit-chain.mjs 与历史实现逐字节一致，
 * 且 rekey 直连写审计时能接在既有链之后 —— 否则链会从新事件开始断掉，历史事件全部失去可信性。
 */
async function legacyAppendAudit(db, { at, actorId, actorEmail, actorDisplay, action, objectId, result, detail }) {
  const prev = db.prepare("SELECT hash FROM audit_events ORDER BY rowid DESC LIMIT 1").get();
  const previousHash = prev ? prev.hash : null;
  const payload = `${previousHash ?? "GENESIS"}|${at}|${actorId}|${action}|${objectId}|${result}|${detail ?? ""}`;
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  const hash = Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
  db.prepare(
    `INSERT INTO audit_events (id, at, actor_id, actor_email, actor_display, action, object_id, result, detail, previous_hash, hash)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(crypto.randomUUID(), at, actorId, actorEmail, actorDisplay, action, objectId, result, detail, previousHash, hash);
  return hash;
}

// ---------- 准备：干净库 + 人造密文 + 历史审计 ----------
rmSync(work, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });
const migration = spawnSync(process.execPath, ["--no-warnings", path.join(root, "scripts", "migrate.mjs")], {
  cwd: root,
  encoding: "utf8",
  env: { ...process.env, DATA_DIR: dataDir, NODE_OPTIONS: "" },
});
if (migration.status !== 0) {
  console.error("建库失败，无法继续：", migration.stdout, migration.stderr);
  rmSync(work, { recursive: true, force: true });
  process.exit(1);
}
console.log("已建干净空库（10 个迁移已应用）");

const ldapCiphertext = await encryptSecret(PLAIN_LDAP, OLD);
const smtpCiphertext = await encryptSecret(PLAIN_SMTP, OLD);
let plantedLastHash = null;
{
  const db = openSqlite(dbFile);
  db.prepare(
    `INSERT INTO integration_settings (id, ldap_name, ldap_host, ldap_port, ldap_ldaps, base_dn, bind_dn, encrypted_secret,
       sync_interval_minutes, content_type_guard, smtp_host, smtp_port, smtp_secure, smtp_from, smtp_username, smtp_encrypted_secret, updated_at)
     VALUES ('ldap','合成认证源','ldap.corp.local',389,0,'dc=corp,dc=local','cn=svc',?,30,'normal',
       'smtp.corp.local',25,0,'noreply@corp.local','noreply',?,?)`,
  ).run(ldapCiphertext, smtpCiphertext, new Date().toISOString());
  // 埋一个「像密文但未登记」的值：验证兜底扫描会告警（漏登记的列不会被轮换，且不会报错）
  db.prepare("INSERT INTO role_assignments (email, display_name, role, created_at, updated_at) VALUES ('a@corp.local', ?, '管理员', ?, ?)")
    .run(await encryptSecret("planted", OLD), new Date().toISOString(), new Date().toISOString());
  // 两条"历史"审计事件，用旧口径计算 —— 供后续验证 rekey 能否接上链
  await legacyAppendAudit(db, { at: "2026-09-01T08:00:00.000Z", actorId: "u1", actorEmail: "a@corp.local", actorDisplay: "张三", action: "提交文件", objectId: "APP-1", result: "PENDING_APPROVAL", detail: null });
  plantedLastHash = await legacyAppendAudit(db, { at: "2026-09-01T09:00:00.000Z", actorId: "u2", actorEmail: "b@corp.local", actorDisplay: "李四", action: "审批通过", objectId: "APP-1", result: "APPROVED", detail: "同意" });
  db.close();
}
console.log("已植入：LDAP 密文 + SMTP 密文 + 1 处未登记密文形状 + 2 条历史审计事件");

try {
  // ---------- 0. 密文格式契约 ----------
  // 库里的历史密文是用**既有格式**写下的，格式一旦变动，所有存量密文都会解不开。
  // 24 位 hex IV（12 字节）+ "." + (明文长度 + 16 字节 GCM 标签) * 2。
  // "admin" = 5 字节 → (5+16)*2 = 42 位 hex。
  section("0. 密文格式契约（改动会让存量密文全部解不开）");
  const sample = await encryptSecret("admin", OLD);
  check("格式为 <24位IV hex>.<密文 hex>", /^[0-9a-f]{24}\.[0-9a-f]{42}$/.test(sample), `${sample.length} 字符`);
  check(
    "同明文两次加密结果不同（IV 随机）",
    (await encryptSecret("admin", OLD)) !== sample,
  );

  // ---------- A. 只读审计 ----------
  section("A. 只读审计（不传新密钥）");
  const beforeA = readRow();
  const a = runRekey(["--old-key", OLD]);
  check("退出码 0", a.code === 0, `实际 ${a.code}`);
  check("识别出 2 处可解开密文", /可解开 2 处/.test(a.out), a.out.match(/合计：.*/)?.[0] || "");
  check("未写入任何数据", readRow().encrypted_secret === beforeA.encrypted_secret);
  check("未生成快照", listSnapshots().length === 0, `快照 ${listSnapshots().length} 份`);
  check("提示需追加 --new-key 与 --yes", /--new-key/.test(a.out) && /--yes/.test(a.out));

  // ---------- B. 缺 --yes ----------
  section("B. 给了新密钥但没 --yes（应只出计划）");
  const beforeB = readRow().encrypted_secret;
  const b = runRekey(["--old-key", OLD, "--new-key", NEW]);
  check("退出码 0", b.code === 0, `实际 ${b.code}`);
  check("说明了将要做什么", /将要执行/.test(b.out));
  check("数据未变", readRow().encrypted_secret === beforeB);
  check("仍未生成快照", listSnapshots().length === 0);

  // ---------- C. 旧密钥错误 ----------
  section("C. 旧密钥错误（必须拒绝）");
  const c = runRekey(["--old-key", "wrong-key-abcdefghijklmnopqrstuvwxyz012345"]);
  check("退出码 1", c.code === 1, `实际 ${c.code}`);
  check("报出解不开的密文", /解不开 2 处/.test(c.out), c.out.match(/合计：.*/)?.[0] || "");
  check("给出处理建议", /--old-key/.test(c.out));

  // ---------- D. 正式轮换 ----------
  section("D. 正式轮换（--yes）");
  const newKeyFile = path.join(work, "newkey.txt");
  writeFileSync(newKeyFile, `# 新密钥\n${NEW}\n`);
  const envFile = path.join(work, "test.env");
  writeFileSync(envFile, `# 合成配置\nCONFIG_ENCRYPTION_KEY=${OLD}\nPLATFORM_ADMIN_EMAILS=admin@corp.local\n`);
  const d = runRekey(["--old-key", OLD, "--new-key-file", newKeyFile, "--env-file", envFile, "--yes"]);
  check("退出码 0", d.code === 0, `实际 ${d.code}`);
  if (d.code !== 0) console.log(d.out);
  check("报告重加密数量", /2 处密文已用新密钥重新加密并提交/.test(d.out));
  check("生成写前快照", listSnapshots().some((name) => name.startsWith("platform-prerekey-")), listSnapshots().join(", "));
  check("审计留痕已写", /审计留痕/.test(d.out));
  check("复核通过", /复核通过/.test(d.out));

  const rowD = readRow();
  check("密文确实变了", rowD.encrypted_secret !== ldapCiphertext);
  check("新密钥可解出原文", (await decryptSecret(rowD.encrypted_secret, NEW)) === PLAIN_LDAP);
  check("SMTP 密文也换了并解密正确", (await decryptSecret(rowD.smtp_encrypted_secret, NEW)) === PLAIN_SMTP);
  check("旧密钥确实解不开", (await tryDecryptSecret(rowD.encrypted_secret, OLD)).ok === false);
  check("未登记的密文形状被告警", /未登记的密文形状字段/.test(d.out) && /role_assignments/.test(d.out));

  // 审计哈希链：逐条重算，并确认 CLI 写的事件接在既有链之后
  {
    const db = openSqlite(dbFile);
    const rows = db
      .prepare("SELECT at, actor_id, actor_display, action, object_id, result, detail, previous_hash, hash FROM audit_events ORDER BY rowid")
      .all();
    db.close();
    const chainOk = [];
    for (let i = 0; i < rows.length; i += 1) {
      const expectedPrev = i === 0 ? null : rows[i - 1].hash;
      const recomputed = await auditHash({
        previousHash: rows[i].previous_hash, at: rows[i].at, actorId: rows[i].actor_id,
        action: rows[i].action, objectId: rows[i].object_id, result: rows[i].result, detail: rows[i].detail,
      });
      chainOk.push(rows[i].previous_hash === expectedPrev && recomputed === rows[i].hash);
    }
    check("审计哈希链完整（历史 + CLI 新写）", chainOk.every(Boolean), `${rows.length} 条事件`);
    const rekeyEvent = rows.find((row) => row.action === "轮换服务端加密密钥");
    check("CLI 写的审计接在既有链之后", Boolean(rekeyEvent) && rekeyEvent.previous_hash === plantedLastHash);
    check("历史事件 hash 未被改写", rows[1]?.hash === plantedLastHash);
    check("轮换事件的对象标识正确", rekeyEvent?.object_id === "SECRET_KEY", `${rekeyEvent?.actor_display}`);
  }

  // 配置文件更新
  {
    const text = readFileSync(envFile, "utf8");
    const backups = readdirSync(work).filter((name) => name.startsWith("test.env.bak-"));
    check("配置文件已写入新密钥", text.includes(`CONFIG_ENCRYPTION_KEY=${NEW}`));
    check("保留了文件其余内容", text.includes("PLATFORM_ADMIN_EMAILS=admin@corp.local"));
    check("原文件已备份", backups.length === 1, backups.join(", "));
  }

  // ---------- E. 往返轮换 ----------
  section("E. 往返：再用旧密钥换回去");
  const e = runRekey(["--old-key", NEW, "--new-key", OLD, "--yes"]);
  check("退出码 0", e.code === 0, `实际 ${e.code}`);
  check("明文仍可还原", (await decryptSecret(readRow().encrypted_secret, OLD)) === PLAIN_LDAP);

  // ---------- F. 拒绝同值密钥 ----------
  section("F. 新密钥与旧密钥相同（必须拒绝）");
  const f = runRekey(["--old-key", OLD, "--new-key", OLD, "--yes"]);
  check("退出码 1", f.code === 1, `实际 ${f.code}`);
  check("说明轮换无意义", /相同/.test(f.out));

  // ---------- G. 新/旧密钥不合格 ----------
  section("G. 密钥不合格（必须拒绝）");
  const g1 = runRekey(["--old-key", OLD, "--new-key", "short", "--yes"]);
  check("新密钥长度不足 → 退出 1", g1.code === 1 && /长度不足/.test(g1.out), g1.out.match(/\[x\].*/)?.[0] || "");
  const g2 = runRekey(["--old-key", OLD, "--new-key", "changeme-please-replace-this-abcdefghijkl", "--yes"]);
  check("新密钥是占位符 → 退出 1", g2.code === 1, `实际 ${g2.code}`);
  const g3 = runRekey(["--new-key", OLD.slice(0, 31), "--yes"]);
  check("旧密钥缺失/过短 → 退出 1", g3.code === 1, `实际 ${g3.code}`);

  // ---------- H. 平台运行探测 ----------
  section("H. 平台运行探测不应导致崩溃");
  const h = runRekey(["--old-key", OLD, "--new-key", NEW, "--yes"]);
  check("退出码 0", h.code === 0, `实际 ${h.code}`);
  check("输出后续步骤指引", /接下来必须按顺序/.test(h.out));
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(`\n结果：pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
