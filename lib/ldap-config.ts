// LDAP 认证源的读取与解密：登录（bind 校验）与目录同步共用。
//
// 把「取配置行 → 校验完整性 → 解密密码 → 组装直连配置」收敛到一处，
// 避免登录与同步各写一套解密逻辑（历史上两处口径不一致就会出「同步能用、登录不能用」）。

import { env } from "@/lib/env";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { integrationSettings } from "@/db/schema";
import { decryptSecret as decryptWithKey } from "@/db/crypto.mjs";
import type { LdapDirectConfig } from "@/lib/ldap-client";

export const LDAP_DEFAULT_TIMEOUT_MS = 10000;

// 分页搜索每页条目数。AD 对单次搜索有 MaxPageSize（默认 1000）限制，超出会直接返回
// sizeLimitExceeded 且不返回任何条目 —— 目录大的单位必须开分页，否则同步结果为空。
// LDAP_PAGE_SIZE=0 可关闭（此时完全依赖目录自身限制）。
export const LDAP_DEFAULT_PAGE_SIZE = 500;

function ldapPageSize(): number {
  const raw = env.LDAP_PAGE_SIZE;
  if (raw === undefined) return LDAP_DEFAULT_PAGE_SIZE;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : LDAP_DEFAULT_PAGE_SIZE;
}



export type LdapSettingsRow = typeof integrationSettings.$inferSelect;

export async function getLdapSettings(): Promise<LdapSettingsRow | null> {
  const rows = await getDb().select().from(integrationSettings).where(eq(integrationSettings.id, "ldap")).limit(1);
  return rows[0] ?? null;
}

/**
 * 解密配置里的密文（LDAP 绑定口令、SMTP 口令共用）。
 * 实现集中在 db/crypto.mjs —— 运行期与 `scripts/rekey.mjs` 密钥轮换工具必须逐字节一致，
 * 各自维护一份拷贝迟早会漂移成「轮换完平台读不了」。此处只负责绑定密钥来源。
 */
export async function decryptSecret(encrypted: string): Promise<string> {
  return decryptWithKey(encrypted, env.CONFIG_ENCRYPTION_KEY);
}

export function ldapPort(row: LdapSettingsRow): number {
  return row.ldapPort || (row.ldapLdaps ? 636 : 389);
}

export function ldapChannelLabel(row: LdapSettingsRow): string {
  return `${row.ldapLdaps ? "ldaps" : "ldap"}://${row.ldapHost}:${ldapPort(row)}`;
}

/** 表单里除密码外的必填项，返回缺失项名称（为空表示完整） */
export function missingLdapFields(row: LdapSettingsRow): string[] {
  const missing: string[] = [];
  if (!row.ldapHost) missing.push("服务器地址");
  if (!row.baseDn) missing.push("Base DN");
  if (!row.bindDn) missing.push("绑定帐号");
  if (!row.encryptedSecret) missing.push("绑定密码");
  return missing;
}

export async function toDirectConfig(row: LdapSettingsRow, secret: string): Promise<LdapDirectConfig> {
  return {
    host: row.ldapHost!,
    port: ldapPort(row),
    ldaps: Boolean(row.ldapLdaps),
    bindDn: row.bindDn!,
    bindPassword: secret,
    baseDn: row.baseDn!,
    filter: row.ldapFilter || undefined,
    timeoutMs: LDAP_DEFAULT_TIMEOUT_MS,
    pageSize: ldapPageSize(),
  };
}

export type LdapReadiness =
  | { status: "ready"; config: LdapDirectConfig; label: string }
  | { status: "unconfigured"; reason: string }
  | { status: "broken"; reason: string };

/**
 * 登录/同步前置检查：能不能用直连 LDAP，不能用时给出人话原因。
 * - unconfigured：还没配过（联调态允许自声明登录）
 * - broken：配了但不完整/密钥不可用（必须修配置，不能静默降级）
 */
export async function ldapReadiness(): Promise<LdapReadiness> {
  let row: LdapSettingsRow | null;
  try {
    row = await getLdapSettings();
  } catch (error) {
    return { status: "broken", reason: `读取 LDAP 配置失败：${error instanceof Error ? error.message : String(error)}` };
  }
  if (!row || (!row.ldapHost && !row.ldapGatewayUrl)) return { status: "unconfigured", reason: "尚未配置 LDAP 认证源" };
  if (!row.ldapHost) return { status: "broken", reason: "LDAP 认证源使用的是旧版网关地址，域账号登录需要直连（请填写服务器地址与端口）" };
  const missing = missingLdapFields(row);
  if (missing.length) return { status: "broken", reason: `LDAP 认证源缺少：${missing.join("、")}` };
  try {
    const secret = await decryptSecret(row.encryptedSecret!);
    return { status: "ready", config: await toDirectConfig(row, secret), label: ldapChannelLabel(row) };
  } catch {
    return { status: "broken", reason: "LDAP 绑定密码无法解密（CONFIG_ENCRYPTION_KEY 是否被更换过？需重新保存一次密码）" };
  }
}
