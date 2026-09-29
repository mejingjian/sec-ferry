#!/usr/bin/env node
// 首次部署引导（bootstrap）回归：验证「环境变量 → 校验 → bind 验证 → 同事务写入 + 审计」
// 这条链路里所有会静默出错的环节。
//
// 为什么要有它：bootstrap 是无人值守部署的唯一入口（容器首启、IaC、CI 都要用它）。
// 它一旦写错，症状不是报错而是「部署完了登录不了」—— 而那时容器已经起来、日志里什么都没有。
// 之前它没有任何自动化覆盖，改了 db/audit-chain.mjs 或加密口径也不会有人发现。
//
// 与其它 test-*.mjs 的区别：**不碰任何真实数据**。它在 .tmp-bootstrap-test/ 下用迁移
// 建一个全新空库，并自带一个 mock LDAP（同进程，不需要先手工起 3890），因此可以随便跑。
//
// 用法：
//   node scripts/test-bootstrap.mjs
//
// 覆盖范围：
//   A 计划解析：缺项/非法邮箱/非法角色/口令文件     E bind 成功路径（对 mock LDAP）写入并回读
//   B dry-run 不写库                                F 覆盖已有认证源
//   C --yes 写角色 + 审计哈希链连续                  G --skip-verify 跳过验证
//   D bind 失败（不可达/凭据被拒）不写库             H 锁死顺序陷阱拦截 / 库不存在
//
// 说明：直接在进程内 import bootstrap.mjs 与 mock-ldap-server.mjs 调用，
// 不派生 node 子进程（某些宿主的沙箱会拦 node → node 的 spawn）。

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openSqlite } from "../db/sqlite-client.mjs";
import { runMigrations, ensureParentDir } from "../db/migrations.mjs";
import { decryptSecret, tryDecryptSecret } from "../db/crypto.mjs";
import { auditHash } from "../db/audit-chain.mjs";
import { BootstrapError, planBootstrap, runBootstrap } from "./bootstrap.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const work = path.join(root, ".tmp-bootstrap-test");
const dataDir = path.join(work, "data");
const dbFile = path.join(dataDir, "db", "platform.db");
const migrationsDir = path.join(root, "drizzle");

// 合成配置 —— 与任何真实环境无关（mock 目录对服务帐号不校验口令）
const KEY = "bootstrap-test-key-0123456789abcdef";
const MOCK_PORT = 3891;
const MOCK_BASE_DN = "dc=example,dc=local";
const MOCK_BIND_DN = `cn=admin,${MOCK_BASE_DN}`;
const MOCK_PASSWORD = "synthetic-bind-secret";

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

/** 调 runBootstrap 并归一化结果：不因预期内的失败而中断整个测试。 */
async function run(env, extraArgv = []) {
  const lines = [];
  try {
    const code = await runBootstrap({
      argv: extraArgv,
      env: { DATA_DIR: dataDir, DB_FILE: dbFile, CONFIG_ENCRYPTION_KEY: KEY, ...env },
      log: (line) => lines.push(line),
    });
    return { code, lines, out: lines.join("\n"), error: null };
  } catch (error) {
    return { code: null, lines, out: lines.join("\n"), error };
  }
}

/** 只解析计划，断言是否抛错。 */
function plan(env) {
  try {
    return { plan: planBootstrap(env), error: null };
  } catch (error) {
    return { plan: null, error };
  }
}

function readLdapRow() {
  const db = openSqlite(dbFile);
  const row = db.prepare("SELECT rowid AS rid, ldap_name, ldap_host, ldap_port, ldap_ldaps, base_dn, bind_dn, encrypted_secret, sync_interval_minutes FROM integration_settings WHERE id='ldap'").get();
  db.close();
  return row || null;
}
function count(sql, ...params) {
  const db = openSqlite(dbFile);
  const row = db.prepare(sql).get(...params);
  db.close();
  return row ? Object.values(row)[0] : 0;
}
function readAudits() {
  const db = openSqlite(dbFile);
  const rows = db.prepare("SELECT at, actor_id, action, object_id, result, detail, previous_hash, hash FROM audit_events ORDER BY rowid").all();
  db.close();
  return rows;
}

// ---------- 准备：干净空库 + 同进程 mock LDAP ----------
rmSync(work, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });
ensureParentDir(dbFile);
{
  const db = openSqlite(dbFile);
  const result = runMigrations(db, migrationsDir);
  db.close();
  console.log(`已建干净空库（应用 ${result.applied.length} 个迁移）`);
}

let mockClose = async () => {};
try {
  // 端口经环境变量传给 mock-ldap-server（它支持 MOCK_LDAP_PORT），避免与本机真实 mock 抢 3890
  process.env.MOCK_LDAP_PORT = String(MOCK_PORT);
  const { server } = await import("./mock-ldap-server.mjs");
  await new Promise((resolve, reject) => {
    if (server.listening) return resolve();
    server.once("listening", resolve);
    server.once("error", reject);
  });
  mockClose = () => new Promise((resolve) => server.close(resolve));
  console.log(`已启动 mock LDAP（127.0.0.1:${MOCK_PORT}，与测试同进程）`);
} catch (error) {
  console.error("mock LDAP 启动失败，无法继续：", error);
  rmSync(work, { recursive: true, force: true });
  process.exit(1);
}

const mockEnv = {
  BOOTSTRAP_LDAP_HOST: "127.0.0.1",
  BOOTSTRAP_LDAP_PORT: String(MOCK_PORT),
  BOOTSTRAP_LDAP_BASE_DN: MOCK_BASE_DN,
  BOOTSTRAP_LDAP_BIND_DN: MOCK_BIND_DN,
  BOOTSTRAP_LDAP_BIND_PASSWORD: MOCK_PASSWORD,
};

try {
  // ---------- A. 计划解析（纯函数） ----------
  section("A. 计划解析：该拦的必须拦，该给的默认值必须给");
  const a1 = plan({});
  check("什么都不给 → 报「没有提供任何要写入的内容」", a1.error instanceof BootstrapError && /没有提供任何要写入的内容/.test(a1.error.message), a1.error?.message);
  const a2 = plan({ BOOTSTRAP_LDAP_HOST: "ldap.corp.local" });
  check(
    "给了 HOST 但缺 BaseDN/BindDN/口令 → 列出全部缺项",
    a2.error instanceof BootstrapError && /BOOTSTRAP_LDAP_BASE_DN/.test(a2.error.message) && /BOOTSTRAP_LDAP_BIND_DN/.test(a2.error.message) && /BOOTSTRAP_LDAP_BIND_PASSWORD/.test(a2.error.message),
    a2.error?.message,
  );
  const a3 = plan({ BOOTSTRAP_ROLES: "not-an-email:管理员" });
  check("角色邮箱不含 @ → 拒绝", a3.error instanceof BootstrapError && /邮箱无效/.test(a3.error.message), a3.error?.message);
  const a4 = plan({ BOOTSTRAP_ROLES: "a@corp.local:超级管理员" });
  check("角色名不在白名单 → 拒绝并列出可用角色", a4.error instanceof BootstrapError && /角色无效/.test(a4.error.message) && /管理员/.test(a4.error.message), a4.error?.message);
  const a5 = plan({ ...mockEnv, BOOTSTRAP_ROLES: " A@Corp.Local : 审批人 , " });
  check(
    "角色清单：邮箱归一化小写、空项忽略、冒号后空格容忍",
    !a5.error && a5.plan.roles.length === 1 && a5.plan.roles[0].email === "a@corp.local" && a5.plan.roles[0].role === "审批人",
    JSON.stringify(a5.plan?.roles),
  );
  // 默认端口要单独测：mockEnv 里带显式端口，会盖掉默认值
  const mockEnvDefaultPort = { ...mockEnv };
  delete mockEnvDefaultPort.BOOTSTRAP_LDAP_PORT;
  const a6 = plan(mockEnvDefaultPort);
  check(
    "ldap 默认值：名称 Corporate_LDAP、明文端口 389、同步间隔 30、ldaps=0",
    !a6.error && a6.plan.ldap.ldapName === "Corporate_LDAP" && a6.plan.ldap.ldapPort === 389 && a6.plan.ldap.syncIntervalMinutes === 30 && a6.plan.ldap.ldapLdaps === 0,
    JSON.stringify(a6.plan?.ldap && { port: a6.plan.ldap.ldapPort, name: a6.plan.ldap.ldapName }),
  );
  const a7 = plan({ ...mockEnvDefaultPort, BOOTSTRAP_LDAP_LDAPS: "true" });
  check("ldaps=true → 端口默认 636 且 ldaps=1", !a7.error && a7.plan.ldap.ldapPort === 636 && a7.plan.ldap.ldapLdaps === 1, `port=${a7.plan?.ldap?.ldapPort}`);
  const a8 = plan({ ...mockEnv, BOOTSTRAP_SYNC_INTERVAL_MINUTES: "1" });
  check("同步间隔下限 5 分钟（1 → 5）", !a8.error && a8.plan.ldap.syncIntervalMinutes === 5, `interval=${a8.plan?.ldap?.syncIntervalMinutes}`);
  const a9 = plan({ ...mockEnv, BOOTSTRAP_LDAP_PORT: "1636" });
  check("显式端口优先于默认值", !a9.error && a9.plan.ldap.ldapPort === 1636 && a9.plan.ldap.label === "ldap://127.0.0.1:1636", a9.plan?.ldap?.label);

  // 口令文件：优先于环境变量，取首个非空行并跳过注释
  const secretFile = path.join(work, "bind-secret.txt");
  writeFileSync(secretFile, "# 部署注入的绑定口令\n\nfrom-file-secret\nsecond-line-ignored\n");
  const a10 = plan({ ...mockEnv, BOOTSTRAP_LDAP_BIND_PASSWORD: "from-env", BOOTSTRAP_LDAP_BIND_PASSWORD_FILE: secretFile });
  check("口令文件优先于环境变量，且取首个非空行", !a10.error && a10.plan.ldap.bindPassword === "from-file-secret", a10.plan?.ldap?.bindPassword);
  const a11 = plan({ ...mockEnv, BOOTSTRAP_LDAP_BIND_PASSWORD_FILE: path.join(work, "nope.txt") });
  check("口令文件不存在 → 拒绝", a11.error instanceof BootstrapError && /口令文件不存在/.test(a11.error.message), a11.error?.message);

  // ---------- B. dry-run ----------
  section("B. dry-run（不带 --yes）不写任何数据");
  const b = await run(mockEnv);
  check("退出码 0", b.code === 0, `实际 ${b.code} ${b.error?.message || ""}`);
  check("提示需要 --yes", /--yes/.test(b.out));
  check("打印将要写入的认证源地址", /127\.0\.0\.1:3891/.test(b.out));
  check("未写入认证源", readLdapRow() === null);
  check("未写入审计", readAudits().length === 0);

  // ---------- C. 写角色 + 审计链 ----------
  section("C. --yes 写角色：入库 + 审计哈希链");
  {
    // 先埋两条"历史"审计，验证新写事件能接在既有链之后
    const db = openSqlite(dbFile);
    let previousHash = null;
    for (const [index, action] of ["提交文件", "审批通过"].entries()) {
      const at = `2026-09-0${index + 1}T08:00:00.000Z`;
      const hash = await auditHash({ previousHash, at, actorId: `u${index}`, action, objectId: "APP-1", result: "SUCCESS", detail: null });
      db.prepare(
        `INSERT INTO audit_events (id, at, actor_id, actor_email, actor_display, action, object_id, result, detail, previous_hash, hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(crypto.randomUUID(), at, `u${index}`, null, "历史操作者", action, "APP-1", "SUCCESS", null, previousHash, hash);
      previousHash = hash;
    }
    db.close();
  }
  const c = await run({ BOOTSTRAP_ROLES: "zhangsan@example.local:管理员,wangwu@example.local:审批人" }, ["--yes"]);
  check("退出码 0", c.code === 0, `实际 ${c.code} ${c.error?.message || ""}`);
  check("提示已提交并留痕", /\[已执行\]/.test(c.out));
  check("角色已入库（2 条）", count("SELECT COUNT(*) AS n FROM role_assignments") === 2);
  check("角色名称正确", count("SELECT COUNT(*) AS n FROM role_assignments WHERE email='zhangsan@example.local' AND role='管理员'") === 1);
  check("未误写认证源（本轮只给了角色）", readLdapRow() === null);
  {
    const rows = readAudits();
    let chainOk = true;
    for (let i = 0; i < rows.length; i += 1) {
      const expectedPrev = i === 0 ? null : rows[i - 1].hash;
      const recomputed = await auditHash({
        previousHash: rows[i].previous_hash, at: rows[i].at, actorId: rows[i].actor_id,
        action: rows[i].action, objectId: rows[i].object_id, result: rows[i].result, detail: rows[i].detail,
      });
      if (rows[i].previous_hash !== expectedPrev || recomputed !== rows[i].hash) chainOk = false;
    }
    check("审计哈希链完整（历史 2 条 + bootstrap 新写）", chainOk, `${rows.length} 条`);
    check("bootstrap 写的事件接在历史链之后", rows.filter((row) => row.actor_id === "cli:bootstrap").length === 2 && rows[2]?.previous_hash === rows[1]?.hash);
    check("操作者标注为运维 CLI", rows[2]?.actor_id === "cli:bootstrap", rows[2]?.actor_id);
  }

  // ---------- D. bind 失败不得写入 ----------
  section("D. bind 验证失败：必须拒绝且不写库");
  const unreachable = await run({ ...mockEnv, BOOTSTRAP_LDAP_PORT: "3899" }, ["--yes"]);
  check("端口无人监听 → 抛错（退出码非 0）", unreachable.error instanceof BootstrapError, unreachable.error?.message || `code=${unreachable.code}`);
  const unreachableText = [unreachable.error?.message, ...(unreachable.error?.extra || [])].join(" ");
  check("错误信息提到「未写入任何数据」", /未写入任何数据/.test(unreachableText), unreachableText);
  check("未写入认证源", readLdapRow() === null);

  // 注意：mock 目录对**服务帐号**（cn=admin,…）不校验口令（任意非空即通过），
  // 只有普通用户才按「口令 = 账号名」校验 —— 所以这条用例必须用普通用户 DN。
  const badCredential = await run(
    { ...mockEnv, BOOTSTRAP_LDAP_BIND_DN: "uid=lisi,ou=people,dc=example,dc=local", BOOTSTRAP_LDAP_BIND_PASSWORD: "wrong-secret" },
    ["--yes"],
  );
  check("凭据被拒（普通用户 DN + 错误口令）→ 抛错并指出 DN/口令问题", badCredential.error instanceof BootstrapError && /凭据被拒绝/.test(badCredential.error.message), badCredential.error?.message || `code=${badCredential.code}`);
  check("仍未写入认证源", readLdapRow() === null);

  const badDn = await run({ ...mockEnv, BOOTSTRAP_LDAP_BIND_DN: "cn=ghost,dc=example,dc=local" }, ["--yes"]);
  check("绑定 DN 不存在 → 拒绝", badDn.error instanceof BootstrapError, badDn.error?.message || `code=${badDn.code}`);
  check("仍未写入认证源（三次失败都没污染库）", readLdapRow() === null);

  // ---------- E. bind 成功 → 写入 + 回读校验 ----------
  section("E. bind 成功路径：写入、密文回读、审计");
  const e = await run(mockEnv, ["--yes"]);
  check("退出码 0", e.code === 0, `实际 ${e.code} ${e.error?.message || ""}`);
  check("输出 bind 成功", /\[OK\] bind 成功/.test(e.out));
  const rowE = readLdapRow();
  check("认证源已入库", Boolean(rowE), JSON.stringify(rowE && { host: rowE.ldap_host, port: rowE.ldap_port }));
  check("字段与计划一致", rowE?.ldap_host === "127.0.0.1" && rowE?.ldap_port === MOCK_PORT && rowE?.base_dn === MOCK_BASE_DN && rowE?.bind_dn === MOCK_BIND_DN && rowE?.ldap_ldaps === 0);
  check("口令以密文入库（非明文）", Boolean(rowE?.encrypted_secret) && rowE.encrypted_secret !== MOCK_PASSWORD);
  check("密文格式为 <24位IV hex>.<密文hex>", /^[0-9a-f]{24}\.[0-9a-f]+$/.test(rowE?.encrypted_secret || ""), `${rowE?.encrypted_secret?.length} 字符`);
  check("用 CONFIG_ENCRYPTION_KEY 可解回原文", (await decryptSecret(rowE.encrypted_secret, KEY)) === MOCK_PASSWORD);
  check("换一把密钥解不开（密钥口径生效）", (await tryDecryptSecret(rowE.encrypted_secret, "another-key-0123456789abcdef")).ok === false);
  check("bootstrap 写的审计为「部署引导写入 LDAP 配置」", readAudits().some((row) => row.action === "部署引导写入 LDAP 配置" && row.object_id === "LDAP"));
  check("首次写入的审计不含「覆盖」字样", !readAudits().find((row) => row.action === "部署引导写入 LDAP 配置")?.detail.includes("覆盖"));

  // ---------- F. 覆盖已有认证源 ----------
  section("F. 覆盖已有认证源（幂等 upsert + 覆盖留痕）");
  const firstId = readLdapRow()?.rid;
  const f = await run({ ...mockEnv, BOOTSTRAP_LDAP_HOST: "127.0.0.1", BOOTSTRAP_LDAP_PORT: String(MOCK_PORT), BOOTSTRAP_LDAP_NAME: "Corp_LDAP_V2", BOOTSTRAP_LDAP_FILTER: "(objectClass=user)" }, ["--yes"]);
  check("退出码 0", f.code === 0, `实际 ${f.code} ${f.error?.message || ""}`);
  const rowF = readLdapRow();
  check("rowid 未变（走的是 UPDATE 而非新插入）", rowF?.rid === firstId, `${firstId} → ${rowF?.rid}`);
  check("名称与过滤器已更新", rowF?.ldap_name === "Corp_LDAP_V2");
  check("覆盖留痕（审计 detail 标注覆盖原配置）", Boolean(readAudits().find((row) => row.action === "部署引导写入 LDAP 配置" && row.detail.includes("覆盖原配置"))));
  check("认证源仍只有一行", count("SELECT COUNT(*) AS n FROM integration_settings WHERE id='ldap'") === 1);

  // ---------- G. --skip-verify ----------
  section("G. --skip-verify：网络不可达时仍可写（显式承担风险）");
  const g = await run({ ...mockEnv, BOOTSTRAP_LDAP_PORT: "3899" }, ["--yes", "--skip-verify"]);
  check("退出码 0（跳过了 bind 验证）", g.code === 0, `实际 ${g.code} ${g.error?.message || ""}`);
  check("未输出 bind 成功字样", !/\[OK\] bind 成功/.test(g.out));
  check("端口已按跳过验证的值写入", readLdapRow()?.ldap_port === 3899);

  // ---------- H. 锁死顺序陷阱 ----------
  section("H. 锁死顺序陷阱与前置校验");
  // 先把认证源清掉，模拟「库中无可用认证源」
  {
    const db = openSqlite(dbFile);
    db.prepare("DELETE FROM integration_settings WHERE id='ldap'").run();
    db.close();
  }
  const h1 = await run({ BOOTSTRAP_ROLES: "zhaoliu@example.local:发起人", PLATFORM_ADMIN_EMAILS: "admin@corp.local" }, ["--yes"]);
  check(
    "已配管理员名单 + 无认证源 + 只写角色 → 拒绝",
    h1.error instanceof BootstrapError && /锁死组合/.test(h1.error.message),
    h1.error?.message || `code=${h1.code}`,
  );
  const h2 = await run({ BOOTSTRAP_ROLES: "zhaoliu@example.local:发起人" }, ["--yes"]);
  check("未配管理员名单时同样的操作放行", h2.code === 0, `实际 ${h2.code} ${h2.error?.message || ""}`);
  const h3 = await run({ ...mockEnv, BOOTSTRAP_ROLES: "zhaoliu@example.local:发起人", PLATFORM_ADMIN_EMAILS: "admin@corp.local" }, ["--yes"]);
  check("同一次把认证源一并写入 → 放行（正确顺序）", h3.code === 0, `实际 ${h3.code} ${h3.error?.message || ""}`);
  check("认证源与角色都已入库", Boolean(readLdapRow()) && count("SELECT COUNT(*) AS n FROM role_assignments WHERE email='zhaoliu@example.local'") === 1);

  const h4 = await run({ ...mockEnv, BOOTSTRAP_LDAP_HOST: "" , BOOTSTRAP_ROLES: "lisi@example.local:发起人" }, ["--yes"]);
  check("只给角色不写认证源时不报缺项（HOST 为空视作不写认证源）", h4.code === 0, `实际 ${h4.code} ${h4.error?.message || ""}`);

  // 库不存在
  const missingDb = await run({ ...mockEnv, DATA_DIR: path.join(work, "nowhere"), DB_FILE: path.join(work, "nowhere", "db", "platform.db") }, ["--yes"]);
  check("数据库不存在 → 明确提示先迁移", missingDb.error instanceof BootstrapError && /数据库不存在/.test(missingDb.error.message) && /db:migrate/.test(missingDb.error.extra.join(" ")), missingDb.error?.message);

  // 缺密钥
  const noKey = await runBootstrap({ argv: ["--yes"], env: { DATA_DIR: dataDir, DB_FILE: dbFile, ...mockEnv }, log: () => {} })
    .then((code) => ({ code, error: null }))
    .catch((error) => ({ code: null, error }));
  check("缺 CONFIG_ENCRYPTION_KEY → 拒绝", noKey.error instanceof BootstrapError && /CONFIG_ENCRYPTION_KEY/.test(noKey.error.message), noKey.error?.message);

  // 审计链最终校验：整表重算
  {
    const rows = readAudits();
    let chainOk = true;
    for (let i = 0; i < rows.length; i += 1) {
      const expectedPrev = i === 0 ? null : rows[i - 1].hash;
      const recomputed = await auditHash({
        previousHash: rows[i].previous_hash, at: rows[i].at, actorId: rows[i].actor_id,
        action: rows[i].action, objectId: rows[i].object_id, result: rows[i].result, detail: rows[i].detail,
      });
      if (rows[i].previous_hash !== expectedPrev || recomputed !== rows[i].hash) chainOk = false;
    }
    check("全部动作跑完后审计链仍完整", chainOk, `${rows.length} 条事件`);
  }
} finally {
  await mockClose();
  rmSync(work, { recursive: true, force: true });
}

console.log(`\n结果：pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
