import { ldapAuthenticate, LdapBindError, LdapError } from "@/lib/ldap-client";
import { ldapReadiness } from "@/lib/ldap-config";
import { identityFromEntry } from "@/lib/ldap-user";
import { appendAudit, jsonError, requireAdministrator, serverError } from "@/lib/server";

/**
 * 域账号认证自检（管理员）：拿一个真实域账号 + 密码跑一遍与登录完全相同的 bind 流程。
 *
 * 用途：上线前验证「服务帐号能搜索 + 用户能 bind」这条链路，避免上线后才发现问题；
 * 与真实登录的区别是：不建会话、不计入失败锁定、不落 ldap_users（只写一条审计）。
 * 密码只在本次请求内存里使用，不落库、不进审计详情。
 */
export async function POST(request: Request) {
  try {
    const actor = await requireAdministrator(request);
    const body = await request.json() as { account?: string; password?: string };
    const account = String(body.account || "").trim();
    const password = String(body.password || "");
    if (!account || !password) return jsonError("请填写域账号与域密码", 422);

    const readiness = await ldapReadiness();
    if (readiness.status !== "ready") return jsonError(readiness.reason, 400);

    const startedAt = Date.now();
    try {
      const result = await ldapAuthenticate(readiness.config, account, password);
      const identity = result.entry ? identityFromEntry(result.entry) : null;
      const elapsedMs = Date.now() - startedAt;
      await appendAudit(actor, "LDAP 认证自检", "LDAP", "SUCCESS", JSON.stringify({ target: readiness.label, account, matchedBy: result.matchedBy, dn: result.dn, elapsedMs }));
      return Response.json({
        ok: true,
        elapsedMs,
        matchedBy: result.matchedBy,
        dn: result.dn,
        identity: identity ? { email: identity.identity, account: identity.account, name: identity.name, department: identity.department } : null,
        hint: identity ? null : "密码校验通过，但按当前域账号搜不到目录条目：请检查「Base DN」与「搜索过滤器」是否有搜索权限（不影响登录，仅影响姓名/部门回填）",
      });
    } catch (error) {
      const elapsedMs = Date.now() - startedAt;
      const message = error instanceof LdapBindError
        ? "域账号或域密码不正确（或账号已禁用/锁定/密码过期）"
        : error instanceof LdapError
          ? error.message
          : `认证失败：${error instanceof Error ? error.message : String(error)}`;
      await appendAudit(actor, "LDAP 认证自检", "LDAP", "FAILED", JSON.stringify({ target: readiness.label, account, reason: message, elapsedMs }));
      return jsonError(message, 401);
    }
  } catch (error) {
    return serverError(error, "LDAP 认证自检失败");
  }
}
