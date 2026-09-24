import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { integrationSettings, ldapSyncRuns, ldapUsers, roleAssignments } from "@/db/schema";
import { decryptSecret } from "@/lib/ldap-config";
import { ldapSearchUsers, LdapError as LdapClientError } from "@/lib/ldap-client";
import { entryToRawUser, normalizeLdapIdentity } from "@/lib/ldap-user";
import { appendAudit, jsonError, requireAdministrator, serverError } from "@/lib/server";

const GATEWAY_TIMEOUT_MS = 10000;

// 兼容常见 LDAP 网关返回结构：支持顶层 users / list / data，以及 data 下的 users/list/items/rows/records，data 本身为数组
function extractUsersList(payload: unknown): unknown[] | null {
  if (!payload || typeof payload !== "object") return null;
  const root = payload as Record<string, unknown>;
  const candidates: unknown[] = [root.users, root.list, root.data];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
    if (candidate && typeof candidate === "object") {
      const nested = candidate as Record<string, unknown>;
      for (const key of ["users", "list", "items", "rows", "records"]) {
        if (Array.isArray(nested[key])) return nested[key] as unknown[];
      }
    }
  }
  return null;
}

// 身份归一化统一走 lib/ldap-user（与 LDAP bind 登录同一口径，避免两处漂移）

export async function GET(request: Request) {
  try {
    await requireAdministrator(request);
    const runs = await getDb().select().from(ldapSyncRuns).orderBy(desc(ldapSyncRuns.startedAt)).limit(20);
    return Response.json(runs);
  } catch (error) {
    return serverError(error, "读取同步记录失败");
  }
}

export async function POST(request: Request) {
  const startedAt = new Date().toISOString();
  const runId = crypto.randomUUID();
  let actor: { id: string; email: string | null; display: string } | undefined;
  let gatewayUrl = "";
  let mode: "incremental" | "full" = "incremental";
  try {
    actor = await requireAdministrator(request);
    let body: { mode?: "incremental" | "full" } = {};
    try {
      body = await request.json() as { mode?: "incremental" | "full" };
    } catch {
      // 前端“测试同步”不携带请求体，按增量同步处理
    }
    mode = body.mode === "full" ? "full" : "incremental";
    const db = getDb();
    const settings = await db.select().from(integrationSettings).where(eq(integrationSettings.id, "ldap")).limit(1);
    const config = settings[0];
    const directMode = Boolean(config?.ldapHost);
    if (!config || (!directMode && !config.ldapGatewayUrl) || !config.baseDn || !config.bindDn || !config.encryptedSecret) {
      throw new Error("请先完整配置 LDAP 认证源（主机/端口/帐号/密码/Base DN）");
    }
    const secret = await decryptSecret(config.encryptedSecret);

    let rawUsers: unknown[];
    let channel: string;
    let gatewaySummaryText: string | undefined;
    if (directMode) {
      // Redmine 风格直连：平台内置 LDAP 客户端直接 bind + search
      const port = config.ldapPort || (config.ldapLdaps ? 636 : 389);
      const entries = await ldapSearchUsers({
        host: config.ldapHost!,
        port,
        ldaps: Boolean(config.ldapLdaps),
        bindDn: config.bindDn,
        bindPassword: secret,
        baseDn: config.baseDn,
        filter: config.ldapFilter || undefined,
        timeoutMs: GATEWAY_TIMEOUT_MS,
      }).catch((ldapError) => {
        throw new Error(ldapError instanceof LdapClientError ? ldapError.message : `无法连接 LDAP 服务器 ${config.ldapHost}:${port}（${ldapError instanceof Error ? ldapError.message : String(ldapError)}）`);
      });
      rawUsers = entries.map(entryToRawUser);
      channel = `直连 ${config.ldapLdaps ? "ldaps" : "ldap"}://${config.ldapHost}:${port}`;
    } else {
      gatewayUrl = config.ldapGatewayUrl!.replace(/\/$/, "");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GATEWAY_TIMEOUT_MS);
    let gateway: Response;
    try {
      gateway = await fetch(`${gatewayUrl}/sync`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
        body: JSON.stringify({ baseDn: config.baseDn, bindDn: config.bindDn, mode }),
        signal: controller.signal,
      });
    } catch (networkError) {
      const reason = networkError instanceof Error && networkError.name === "AbortError"
        ? `请求超时（超过 ${GATEWAY_TIMEOUT_MS / 1000} 秒无响应）`
        : `网络不可达（${networkError instanceof Error ? networkError.message : String(networkError)}）`;
      throw new Error(`无法连接 LDAP 网关 ${gatewayUrl}：${reason}，请确认网关地址可达且已启动`);
    } finally {
      clearTimeout(timer);
    }

    if (!gateway.ok) {
      const snippet = await gateway.text().catch(() => "");
      throw new Error(`LDAP 网关返回 HTTP ${gateway.status}${snippet ? `：${snippet.slice(0, 200)}` : ""}`);
    }

    const rawText = await gateway.text();
      let payload: unknown;
      try {
        payload = JSON.parse(rawText);
      } catch {
        throw new Error(`LDAP 网关返回的不是合法 JSON：${rawText.slice(0, 200)}`);
      }

      const users = extractUsersList(payload);
      if (!users) {
        throw new Error(`LDAP 网关返回格式无法识别：未找到用户列表（期望 users 数组），实际返回：${rawText.slice(0, 200)}`);
      }
      rawUsers = users;
      channel = `网关 ${gatewayUrl}`;
      const summaryCandidate = (payload as Record<string, unknown>)?.summary;
      if (typeof summaryCandidate === "string" && summaryCandidate) gatewaySummaryText = summaryCandidate;
    }

    let upserted = 0;
    let deactivated = 0;
    let skipped = 0;
    const skippedSamples: string[] = [];
    const now = new Date().toISOString();
    for (const rawUser of rawUsers) {
      const user = normalizeLdapIdentity(rawUser);
      if (!user?.identity) {
        skipped += 1;
        if (skippedSamples.length < 3) {
          const sample = rawUser as Record<string, unknown>;
          skippedSamples.push(String(sample.dn || sample.distinguishedName || JSON.stringify(sample).slice(0, 80)));
        }
        continue;
      }
      // identity：有邮箱用邮箱，否则用账号/DN（ldap_users.email 列即唯一标识）；
      // account 单独存域账号，供「用域账号登录」与短名检索使用
      const identity = user.identity;
      const name = user.name || (user.identityIsEmail ? identity.split("@")[0] : identity);
      await db.insert(ldapUsers).values({
        email: identity,
        account: user.account,
        employeeId: user.identityIsEmail ? null : identity,
        name,
        department: user.department || null,
        ouPath: user.ouPath || null,
        active: user.active !== false,
        lastSyncedAt: now,
        createdAt: now,
        updatedAt: now,
      }).onConflictDoUpdate({
        target: ldapUsers.email,
        set: {
          account: user.account,
          employeeId: user.identityIsEmail ? null : identity,
          name,
          department: user.department,
          ouPath: user.ouPath,
          active: user.active !== false,
          lastSyncedAt: now,
          updatedAt: now,
        },
      });
      upserted += 1;
      if (user.active === false) {
        const assigned = await db.select().from(roleAssignments).where(eq(roleAssignments.email, identity)).limit(1);
        if (assigned[0]) {
          await db.delete(roleAssignments).where(eq(roleAssignments.email, identity));
          deactivated += 1;
        }
      }
    }

    const suffix = `${skipped ? `，跳过 ${skipped} 条无法识别记录` : ""}${deactivated ? `，回收 ${deactivated} 人平台角色` : ""}`;
    let skipHint = "";
    if (!upserted && skipped) {
      skipHint = `：未写入任何用户，请检查「搜索过滤器」是否只匹配用户对象（如 (objectClass=user)）。被跳过记录需同时缺少邮箱、账号（sAMAccountName/uid）与 DN，示例：${skippedSamples.join("；")}`;
    }
    const summary = gatewaySummaryText && !directMode
      ? gatewaySummaryText
      : `${mode === "full" ? "全量" : "增量"}同步完成（${channel}），写入 ${upserted} 人${suffix}${skipHint}`;
    await db.insert(ldapSyncRuns).values({ id: runId, status: "成功", summary, startedAt, completedAt: now, actorId: actor.id });
    await appendAudit(actor, "LDAP 用户同步", "LDAP", summary, JSON.stringify({ mode, upserted, deactivated, skipped, skippedSamples }));
    return Response.json({ id: runId, status: "成功", summary, startedAt, completedAt: now, upserted, deactivated, skipped, skippedSamples }, { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "LDAP 同步请求失败";
    try {
      await getDb().insert(ldapSyncRuns).values({ id: runId, status: "失败", summary: message, startedAt, completedAt: new Date().toISOString(), actorId: actor?.id || "system" });
    } catch { /* 失败记录写入异常不影响主错误返回 */ }
    if (message.startsWith("请先")) return jsonError(message, 400);
    return serverError(error, "LDAP 同步请求失败");
  }
}
