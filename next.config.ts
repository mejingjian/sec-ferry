import type { NextConfig } from "next";

// Drizzle 的 SQLite 同步驱动会 `import Client from "better-sqlite3"`，而本项目实际用的是
// Node 内置的 node:sqlite（见 db/sqlite-client.mjs）。把模块名映射到本地兼容层，
// 就不必引入那个需要按平台准备预编译二进制的原生包。
const betterSqliteAlias = { "better-sqlite3": "./db/better-sqlite3.mjs" };

const nextConfig: NextConfig = {
  // 局域网自托管形态：产出 .next/standalone（含最小 node_modules 与 server.js），
  // 运行阶段只需 `node server.js`，不再需要 wrangler / workerd / 任何安装步骤。
  output: "standalone",

  // ⚠️ 这里**故意不**用 `serverExternalPackages`。
  //
  // 曾把 ldapts 标为外部包（理由：它做裸 net/tls 通信，交给 Node 直接 require 更直观），
  // 结果 Next 16 + Turbopack + output:standalone 会为外部包在 `.next/node_modules/ldapts-<hash>`
  // 生成一个**软链**指向 `node_modules/ldapts`。这个软链在拷贝进 standalone 时（Windows 下）
  // 退化成空目录，运行期直接抛：
  //   Failed to load external module ldapts-<hash>: Cannot find package '...\.next\node_modules\ldapts-<hash>\index.js'
  // 表现为「构建全绿、服务能起，但一登录就 500」——很难从构建日志发现问题。
  // 让打包器把 ldapts 及其纯 JS 依赖一起打进 server chunk 即可绕开该机制；
  // ldapts 的依赖（asn1 / debug / tslib / uuid）都是纯 JS，打包无副作用。
  serverExternalPackages: [],

  turbopack: {
    resolveAlias: betterSqliteAlias,
  },

  // 若将来改用 webpack 构建，别名同样生效
  webpack: (config) => {
    config.resolve = config.resolve ?? {};
    config.resolve.alias = { ...(config.resolve.alias ?? {}), ...betterSqliteAlias };
    return config;
  },

  poweredByHeader: false,
};

export default nextConfig;
