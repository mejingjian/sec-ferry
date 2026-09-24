// 兼容层：模块名 `better-sqlite3` 的本地实现。
//
// 背景：Drizzle 的 SQLite 同步驱动（`drizzle-orm/better-sqlite3`）在源码顶部写着
// `import Client from "better-sqlite3"`，构建器因此必须能解析到这个模块名。
// 但我们并不想引入这个原生包（需要按平台准备预编译二进制，Windows 开发机与 Linux 容器
// 都要各自搞定），实际用的是 Node 内置的 `node:sqlite`。
//
// 于是把模块名 `better-sqlite3` 在构建配置里映射到本文件（见 next.config.ts 的
// `turbopack.resolveAlias` / `webpack.resolve.alias`）。Drizzle 只会把外部传入的实例
// 包进它的 session 里，并不会自己 `new Client(...)`，因此这里主要是「让解析通过」+ 把
// 构造语义补齐，保证将来真有代码 `new Database(...)` 时行为也正确。

import { openSqlite } from "./sqlite-client.mjs";

/**
 * 与 better-sqlite3 的 Database 保持最小同构：构造即打开文件，实例上挂
 * prepare / exec / transaction / pragma / close。
 */
export default class Database {
  constructor(file, _options) {
    return openSqlite(file);
  }
}
