import { env } from "@/lib/env";
import { getDb } from "@/db";
import { ldapUsers } from "@/db/schema";
import { LdapBindError, LdapError, ldapAuthenticate } from "@/lib/ldap-client";
import { ldapReadiness } from "@/lib/ldap-config";
import { identityFromEntry, type LdapIdentity } from "@/lib/ldap-user";
import { clearLoginFailures, loginPolicy, loginLockState, normalizeIdentifier, registerLoginFailure } from "@/lib/login-guard";
import { appendAudit, jsonError, roleFor, type Actor } from "@/lib/server";
import { createSession, sessionCookieHeader } from "@/lib/session";

type LoginBody = { account?: string; email?: string; password?: string; displayName?: string; local?: boolean };

function clientIp(request: Request): string | null {
  return request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
}

/**
 * 自声明登录（只填邮箱、不校验密码）的开关：
 * 只有「未完成身份接入」的联调态才允许 —— 即未配置 PLATFORM_ADMIN_EMAILS 时。
 * 生产必须配置管理员名单，届时自声明登录与本地兜底一起失效，只剩 LDAP bind 一条路。
 * 也可用 ALLOW_SELF_DECLARED_LOGIN=true/false 强制覆盖（true 仅限联调环境）。
 */
function selfDeclaredLoginAllowed(): boolean {
  if (env.ALLOW_SELF_DECLARED_LOGIN === "false") return false;
  if (env.ALLOW_SELF_DECLARED_LOGIN === "true") return true;
  return !env.PLATFORM_ADMIN_EMAILS;
}

// 登录成功后把目录最新属性回写 ldap_users：登录本身就是一次"该账号真实存在且可用"的验证，
// 顺带回填域账号（account）与部门，让收件人选择、规则部门匹配拿到最新数据。
async function upsertUserFromLogin(identity: LdapIdentity, accountInput: string): Promise<void> {
  const db = getDb();
  const now = new Date().toISOString();
  const account = identity.account || (identity.identityIsEmail ? accountInput : identity.identity);
  const values = {
    email: identity.identity,
    account,
    employeeId: identity.identityIsEmail ? null : identity.identity,
    name: identity.name,
    department: identity.department,
    ouPath: identity.ouPath,
    active: true,
    lastSyncedAt: now,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(ldapUsers).values(values).onConflictDoUpdate({
    target: ldapUsers.email,
    set: { account, name: identity.name, department: identity.department, ouPath: identity.ouPath, active: true, lastSyncedAt: now, updatedAt: now },
  });
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as LoginBody;
    const hasOaiIdentity = Boolean(request.headers.get("oai-authenticated-user-id") || request.headers.get("oai-authenticated-user-email"));
    if (hasOaiIdentity) return jsonError("当前会话已由平台统一认证，无需再次登录", 409);

    // ---------- 路径 0：本地兜底（未配置管理员名单时的初始化 / 联调入口）----------
    if (body.local === true) {
      if (env.PLATFORM_ADMIN_EMAILS) return jsonError("已配置平台管理员名单，本地兜底登录已禁用", 403);
      const token = await createSession({ email: null, displayName: (body.displayName || "本地管理员").trim().slice(0, 40), local: true, authMethod: "local" });
      return finish(request, token, "本地兜底登录", { audit: false });
    }

    const account = String(body.account || body.email || "").trim();
    const password = String(body.password || "");
    if (!account) return jsonError("请输入域账号或企业邮箱", 422);

    const readiness = await ldapReadiness();

    // ---------- 路径 1：LDAP bind 校验域账号 + 域密码 ----------
    if (readiness.status === "ready") {
      if (!password) return jsonError("请输入域密码", 422);
      const identifier = normalizeIdentifier(account);
      const lock = await loginLockState(identifier);
      if (lock.locked) {
        return jsonError(`该账号登录失败次数过多，已锁定，请约 ${lock.remainingMinutes} 分钟后再试（或联系管理员解锁）`, 429);
      }

      let identity: LdapIdentity;
      try {
        const result = await ldapAuthenticate(readiness.config, account, password);
        const fromDirectory = result.entry ? identityFromEntry(result.entry) : null;
        // 目录能验证密码但取不到条目（服务帐号无搜索权限）时，退化为「用输入值当身份」，
        // 密码校验依然有效，只是拿不到姓名/部门。
        identity = fromDirectory || {
          identity: identifier,
          identityIsEmail: account.includes("@"),
          account: account.includes("@") ? null : account,
          name: account.split("@")[0],
          department: null,
          ouPath: null,
          active: true,
        };
      } catch (error) {
        const bindFailure = error instanceof LdapBindError;
        const message = bindFailure
          ? "域账号或域密码不正确"
          : error instanceof LdapError
            ? error.message
            : "域认证失败，请稍后重试";
        const state = await registerLoginFailure(identifier, clientIp(request));
        const { maxFailures } = loginPolicy();
        const lockedMinutes = state.lockedUntil ? Math.round((new Date(state.lockedUntil).getTime() - Date.now()) / 60_000) : 0;
        await appendAudit(
          { id: `ldap:${identifier}`, email: account.includes("@") ? identifier : null, display: displayFromAccount(account) },
          "登录失败",
          "AUTH",
          "FAILED",
          JSON.stringify({
            channel: "LDAP",
            target: readiness.label,
            reason: message,
            failureCount: state.failureCount,
            threshold: maxFailures,
            lockedUntil: state.lockedUntil,
          }),
        );
        const hint = state.lockedUntil
          ? `；连续失败 ${state.failureCount} 次，账号已锁定 ${lockedMinutes} 分钟`
          : state.remainingAttempts <= 2
            ? `；还可尝试 ${state.remainingAttempts} 次`
            : "";
        return jsonError(`${message}${hint}`, bindFailure ? 401 : 502);
      }

      await clearLoginFailures(identifier);
      await upsertUserFromLogin(identity, account);
      const token = await createSession({ email: identity.identity, displayName: identity.name, local: false, authMethod: "ldap" });
      return finish(request, token, "域账号登录", { detail: { channel: "LDAP", target: readiness.label, account: identity.account } });
    }

    // ---------- 路径 2：自声明邮箱（仅联调态保留，生产必须走 LDAP）----------
    if (!selfDeclaredLoginAllowed()) {
      const reason = readiness.status === "broken" ? readiness.reason : "尚未配置 LDAP 认证源";
      return jsonError(`${reason}，无法使用域账号登录。请联系管理员在「LDAP 与权限」页完成认证源配置（或配置 ALLOW_SELF_DECLARED_LOGIN=true 仅限联调环境）`, 400);
    }
    const rawEmail = account.toLowerCase();
    if (!rawEmail.includes("@")) return jsonError("请输入有效的企业邮箱（联调态自声明登录不支持域账号短名）", 422);
    const token = await createSession({
      email: rawEmail,
      displayName: (body.displayName || rawEmail.split("@")[0]).trim().slice(0, 40),
      local: false,
      authMethod: "self-declared",
    });
    await appendAudit(
      { id: rawEmail, email: rawEmail, display: rawEmail },
      "登录成功",
      "AUTH",
      "SELF_DECLARED",
      JSON.stringify({ channel: "self-declared", warning: "未配置 LDAP 认证源，登录未校验密码（仅限联调）" }),
    );
    return finish(request, token, "自声明登录", { audit: false });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "登录失败", 500);
  }
}

function displayFromAccount(account: string): string {
  return account.includes("@") ? account.split("@")[0] : account;
}

// 统一收尾：先按会话身份算角色，保证登录接口返回与后续请求一致；成功登录再写一条审计。
// 只传令牌、不信任前端，角色一律由服务端按会话重算。
async function finish(request: Request, token: string, action: string, options?: { audit?: boolean; detail?: Record<string, unknown> }) {
  const fakeRequest = new Request(request.url, { headers: { cookie: `tp_session=${token}` } });
  const identity = await roleFor(fakeRequest);
  if (identity.role === "未登录" || !identity.actor) return jsonError("会话创建失败", 500);
  const actor: Actor = identity.actor;
  if (options?.audit !== false) {
    await appendAudit(actor, "登录成功", "AUTH", "SUCCESS", JSON.stringify({ ...options?.detail }));
  }
  return Response.json(
    { displayName: actor.display, email: actor.email, role: identity.role },
    { status: 200, headers: { "set-cookie": sessionCookieHeader(token) } },
  );
}
