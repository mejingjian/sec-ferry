// LDAP 用户身份归一化：把「目录条目 / 任意网关返回结构」统一成平台内部身份。
//
// 这一层是登录（LDAP bind）与目录同步（/api/ldap/sync）共用的唯一口径 —— 两处必须一致，
// 否则会出现「登录成功但同步出的身份查不到角色」这类难查的问题。
//
// 身份（identity）规则：
//   1. 目录里有邮箱（mail / userPrincipalName / 含 @ 的 uid）→ 用邮箱，identityIsEmail=true；
//   2. 否则用域账号（sAMAccountName / uid），再退到 DN —— 兼容只有 DN 的老目录。
// ldap_users.email 列存的即这个 identity（列名历史遗留，语义是「身份标识」）。

import type { LdapEntry } from "@/lib/ldap-client";

export type LdapIdentity = {
  /** 平台内部身份标识：邮箱优先，其次域账号，最后 DN；统一小写 */
  identity: string;
  identityIsEmail: boolean;
  /** 域账号（sAMAccountName/uid），登录时可用它替代邮箱 */
  account: string | null;
  name: string;
  department: string | null;
  ouPath: string | null;
  active: boolean;
};

/** 按候选键顺序取第一个非空字符串（兼容各目录/网关的字段别名） */
export function pickString(source: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return undefined;
}

const ACTIVE_TRUE = /^(true|1|active|enabled|enable|在职|是)$/i;
const ACTIVE_FALSE = /^(false|0|inactive|disabled|disable|离职|停用|否)$/i;

export function normalizeLdapIdentity(raw: unknown): LdapIdentity | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Record<string, unknown>;
  const email = pickString(source, ["email", "mail", "userEmail", "emailAddress"]);
  const hasEmail = Boolean(email && email.includes("@"));
  const account = pickString(source, ["sAMAccountName", "samaccountname", "uid", "userId", "username", "userName"]) ?? null;
  const dn = pickString(source, ["dn", "distinguishedName"]) ?? null;
  if (!hasEmail && !account && !dn) return null;

  const rawActive = pickString(source, ["active", "enabled", "isActive", "status", "disabled"]);
  let active = true;
  if (rawActive !== undefined) {
    if (ACTIVE_FALSE.test(rawActive)) active = false;
    else if (ACTIVE_TRUE.test(rawActive)) active = true;
  }

  const groups = Array.isArray(source.groups) ? source.groups.map((group) => String(group).trim()).filter(Boolean) : [];
  const name = pickString(source, ["name", "displayName", "realName", "cn", "userName"])
    || account
    || dn?.match(/^CN=([^,]+)/i)?.[1]
    || "未命名";

  return {
    identity: (hasEmail ? email! : (account || dn)!).toLowerCase(),
    identityIsEmail: hasEmail,
    account,
    name,
    department: pickString(source, ["department", "dept", "departmentName", "departmentNumber", "ou"]) || groups[0] || null,
    ouPath: dn || pickString(source, ["ouPath", "ou_path"]) || null,
    active,
  };
}

/**
 * 把 LDAP 条目转成与旧网关一致的「原始用户」结构，复用 normalizeLdapIdentity。
 * 邮箱多属性兜底：mail → userPrincipalName（AD 常见未配 mail 但有 UPN）→ 含 @ 的 uid。
 * 组信息：memberOf（AD）解析组名 CN，department 属性为空时回退为第一个组名。
 */
export function entryToRawUser(entry: LdapEntry): Record<string, unknown> {
  const first = (name: string) => entry.attributes[name]?.[0];
  const uid = first("uid");
  const email = first("mail") || first("userprincipalname") || (uid && uid.includes("@") ? uid : undefined);
  const groups = (entry.attributes["memberof"] || []).map((dn) => dn.match(/^CN=([^,]+)/i)?.[1]?.trim()).filter(Boolean) as string[];
  const name = first("displayname") || first("cn") || entry.dn.match(/^CN=([^,]+)/i)?.[1] || "";
  return {
    email,
    sAMAccountName: first("samaccountname"),
    uid,
    name,
    department: first("department") || groups[0],
    groups,
    dn: entry.dn,
    active: true,
  };
}

export function identityFromEntry(entry: LdapEntry): LdapIdentity | null {
  return normalizeLdapIdentity(entryToRawUser(entry));
}
