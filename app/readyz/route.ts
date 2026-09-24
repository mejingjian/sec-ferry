// 就绪探针：检查「能不能真正提供服务」——数据库可查、文件目录可写。
//
// 与 /healthz 的分工见后者注释。这里刻意**不**主动连 LDAP：
//   认证源配置存在库里、由管理员在页面上维护，目录暂时不可达时平台本身仍然可用
//   （已登录会话照常工作），此时把整个实例判为未就绪会让所有人被摘流量，属于过度反应。
//   LDAP 的连通性由管理页的「测试绑定」按钮与登录错误提示负责反馈。
//
// 返回 503 表示依赖不可用，编排系统应当把该实例从负载里摘掉（单实例局域网部署下
// 主要表现为健康看板告警）。

import { sql } from "drizzle-orm";
import { access, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { getDb } from "@/db";
import { dataDir, filesDir } from "@/lib/paths";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

async function checkDatabase(): Promise<{ ok: boolean; detail: string }> {
  try {
    await getDb().run(sql`SELECT 1`);
    return { ok: true, detail: "SQLite 可读写" };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

async function checkStorage(): Promise<{ ok: boolean; detail: string }> {
  const dir = filesDir();
  const probe = path.join(dir, `.readyz-${process.pid}`);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(probe, "ok");
    await access(probe);
    await rm(probe, { force: true });
    return { ok: true, detail: dir };
  } catch (error) {
    return { ok: false, detail: `${dir}：${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function GET() {
  const [database, storage] = await Promise.all([checkDatabase(), checkStorage()]);
  const ok = database.ok && storage.ok;
  return Response.json(
    {
      status: ok ? "ready" : "not-ready",
      checks: { database, storage },
      // 只暴露目录与开关状态，不暴露任何密钥
      runtime: {
        dataDir: dataDir(),
        migrationsDir: env.MIGRATIONS_DIR || "(默认 ./drizzle)",
        encryptionKeyConfigured: Boolean(env.CONFIG_ENCRYPTION_KEY),
        adminAllowlistConfigured: Boolean(env.PLATFORM_ADMIN_EMAILS),
      },
      at: new Date().toISOString(),
    },
    { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } },
  );
}
