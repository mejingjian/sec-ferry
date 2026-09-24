// SQLite 客户端（纯 ESM）：基于 Node 22 内置的 `node:sqlite`，对外暴露 Drizzle
// `better-sqlite3` 驱动所需的接口形态。
//
// 为什么是 .mjs：`npm run db:migrate` 要直接 `node scripts/migrate.mjs` 跑，而迁移逻辑与
// 应用必须共用同一份（单一真相），因此客户端也做成纯 ESM，两边都能 import。
// 类型经 JSDoc 表达，TypeScript 侧可 `import type` 直接引用。
//
// 为什么不用 better-sqlite3 npm 包：
//   1. 它是原生模块，需要按平台/ABI 准备预编译二进制 —— 开发机是 Windows、生产是 Linux 容器，
//      两处都要能装上；本项目所处的网络环境对二进制下载并不稳定。
//   2. `node:sqlite` 是 Node 22.5+ 内置能力，零安装、零 ABI 风险，容器与开发机行为一致。
//
// 适配点只有一处：`node:sqlite` 默认把结果集映射成对象，而 Drizzle 的 better-sqlite3 驱动
// 在需要按列顺序取值时调用 `stmt.raw()` 拿数组。`node:sqlite` 的 `setReturnArrays(true)`
// 正好等价，因此把 `raw()` 接到「另一份按数组返回的语句」上。
//
// ⚠️ 为什么不直接在同一个语句上切来切去：`setReturnArrays` 是语句级状态，而语句按 SQL 文本缓存。
//    若在同一份语句上先当对象读、再当数组读，后续复用会拿到错误形状。故对象语句与数组语句分开缓存。
//
// ⚠️ `node:sqlite` 目前是 Node 的实验特性（启动时会打印 ExperimentalWarning），这是预期行为。
//    若将来该特性有破坏性变更，只需改本文件。

import { DatabaseSync } from "node:sqlite";

/**
 * @typedef {object} RunResult
 * @property {number|bigint} changes
 * @property {number|bigint} lastInsertRowid
 */

/**
 * @typedef {object} CompatStatement
 * @property {(...params: unknown[]) => RunResult} run
 * @property {(...params: unknown[]) => unknown} get
 * @property {(...params: unknown[]) => unknown[]} all
 * @property {(toggle?: boolean) => { run: CompatStatement["run"], get: CompatStatement["get"], all: CompatStatement["all"] }} raw
 * @property {boolean} reader
 */

/**
 * @typedef {object} CompatDatabase
 * @property {(sql: string) => CompatStatement} prepare
 * @property {(sql: string) => void} exec
 * @property {(fn: (...args: never[]) => unknown) => { (...args: never[]): unknown, deferred: (...args: never[]) => unknown, immediate: (...args: never[]) => unknown, exclusive: (...args: never[]) => unknown }} transaction
 * @property {(statement: string) => void} pragma
 * @property {() => void} close
 * @property {DatabaseSync} raw
 */

/**
 * `undefined` 在 better-sqlite3 里会直接报错，而 Drizzle 在可选参数缺省时可能传入 undefined。
 * 统一折算成 NULL，避免「同一个查询在两种驱动下成败不一致」。
 * @param {unknown[]} params
 */
function normalize(params) {
  return params.map((value) => (value === undefined ? null : value));
}

/** @param {import("node:sqlite").StatementSync} stmt */
function bindRun(stmt) {
  return (...params) => /** @type {RunResult} */ (stmt.run(...normalize(params)));
}
/** @param {import("node:sqlite").StatementSync} stmt */
function bindGet(stmt) {
  return (...params) => stmt.get(...normalize(params));
}
/** @param {import("node:sqlite").StatementSync} stmt */
function bindAll(stmt) {
  return (...params) => stmt.all(...normalize(params));
}

/**
 * 打开（并按需创建）一个 SQLite 库文件。
 * @param {string} file
 * @returns {CompatDatabase}
 */
export function openSqlite(file) {
  const db = new DatabaseSync(file);

  // WAL：读写并发不互斥；busy_timeout：单写者模型下等待锁而不是立刻报 SQLITE_BUSY。
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 10000");
  db.exec("PRAGMA foreign_keys = ON");
  // WAL 下 synchronous=NORMAL 是耐久性与吞吐的常见折中
  db.exec("PRAGMA synchronous = NORMAL");

  /** @type {Map<string, CompatStatement>} */
  const objectCache = new Map();
  /** @type {Map<string, { run: Function, get: Function, all: Function }>} */
  const arrayCache = new Map();

  /** @param {string} sql */
  function prepareArray(sql) {
    const cached = arrayCache.get(sql);
    if (cached) return cached;
    const stmt = db.prepare(sql);
    stmt.setReturnArrays(true);
    const compat = { run: bindRun(stmt), get: bindGet(stmt), all: bindAll(stmt) };
    arrayCache.set(sql, compat);
    return compat;
  }

  /** @param {string} sql */
  function prepare(sql) {
    const cached = objectCache.get(sql);
    if (cached) return cached;
    const stmt = db.prepare(sql);
    /** @type {CompatStatement} */
    const compat = {
      run: bindRun(stmt),
      get: bindGet(stmt),
      all: bindAll(stmt),
      // Drizzle 用 raw() 取「数组形态」的结果（按 SELECT 列顺序）
      raw: () => prepareArray(sql),
      reader: true,
    };
    objectCache.set(sql, compat);
    return compat;
  }

  /**
   * @param {"DEFERRED"|"IMMEDIATE"|"EXCLUSIVE"} mode
   * @param {Function} fn
   * @param {unknown[]} args
   */
  function runInTransaction(mode, fn, args) {
    db.exec(`BEGIN ${mode}`);
    try {
      const result = fn(...args);
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // 事务可能已因错误自动回滚，忽略
      }
      throw error;
    }
  }

  /** @param {Function} fn */
  const transaction = (fn) => {
    const wrapper = (...args) => runInTransaction("DEFERRED", fn, args);
    wrapper.deferred = (...args) => runInTransaction("DEFERRED", fn, args);
    wrapper.immediate = (...args) => runInTransaction("IMMEDIATE", fn, args);
    wrapper.exclusive = (...args) => runInTransaction("EXCLUSIVE", fn, args);
    return wrapper;
  };

  return {
    prepare,
    exec: (sql) => db.exec(sql),
    transaction,
    pragma: (statement) => db.exec(`PRAGMA ${statement}`),
    close: () => {
      objectCache.clear();
      arrayCache.clear();
      db.close();
    },
    raw: db,
  };
}
