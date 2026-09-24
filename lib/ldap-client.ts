// LDAP 直连客户端：基于 `ldapts`（成熟第三方实现），替代原先手写的 300 余行 BER 编解码。
//
// 为什么换：旧实现用 `cloudflare:sockets` 手工拼 LDAP v3 报文，只覆盖 simple bind +
// subtree search。这类代码没有现成的测试与超时语义，出问题只能靠抓包 —— 历史上
// `typesOnly` 标志位写错（0xff 而非 0x00）导致 openldap 只回属性名、值全空，
// 而 mock 目录忽略该标志，所以本地一直没暴露。换成库以后这类协议级错误由上游负责。
//
// 保留的对外契约（上层零改动）：
//   LdapDirectConfig / LdapEntry / LDAP_USER_ATTRIBUTES
//   LdapError / LdapBindError / describeBindFailure
//   openLdapSession / ldapSearchUsers / ldapAuthenticate
//   escapeLdapFilterValue / buildUserLookupFilter
//
// 行为要点（与旧实现刻意保持一致）：
//   1. 两步登录：服务帐号搜索出用户 DN → 用「用户 DN + 用户密码」重新建连 bind；
//      搜不到且输入不像 DN 时直接判失败（不区分「无此账号」与「密码错」，防账号枚举）。
//   2. 服务帐号自身配错（密码过期/被禁用）必须原样抛给管理员，不被兜底路径掩盖。
//   3. 搜索请求必须请求属性值（returnAttributeValues: true），否则会重演上面那个 bug。

import { Client, type ClientOptions, type Entry, type SearchOptions } from "ldapts";
import { env } from "@/lib/env";

export type LdapDirectConfig = {
  host: string;
  port: number;
  ldaps: boolean;
  bindDn: string;
  bindPassword: string;
  baseDn: string;
  filter?: string;
  timeoutMs?: number;
  /** 每页条目数；>0 时启用 RFC 2696 分页搜索（AD 默认单次最多返回 1000 条，目录越大越需要） */
  pageSize?: number;
};

export type LdapEntry = { dn: string; attributes: Record<string, string[]> };

// 解析 AD 绑定失败的子错误码（诊断消息里的 "data XXXX" 十六进制段），映射成具体原因。
// 参考：https://ldapwiki.com/wiki/Common%20Active%20Directory%20Bind%20Errors
export function describeBindFailure(code: number, diagnostic?: string): string {
  if (code !== 49) {
    if (code === 34) return "帐号 DN 格式不合法：请确认「帐号」是完整 DN、UPN（user@domain.com）或 域\\用户 格式，且 Base DN 拼写正确";
    if (code === 32) return "找不到绑定对象：请确认「帐号」的 DN/UPN 拼写，以及与 Base DN 是否在同一目录层级";
    if (code === 53) return "目录服务器拒绝操作：绑定账号可能被锁定或目录处于只读状态";
    if (code === 48) return "认证方式不被允许：AD 通常要求简单绑定走 LDAPS（勾选 LDAPS 改用 636 端口）";
    return "请检查「帐号」与「密码」以及服务器地址、端口设置";
  }
  const match = /\bdata\s+([0-9a-fA-F]{3,4})\b/.exec(diagnostic || "");
  const sub = match ? parseInt(match[1], 16) : null;
  const hint: Record<number, string> = {
    0x525: "帐号在目录中不存在（用户名/DN 拼写错误，或不在该 Base DN 范围内）",
    0x52e: "用户名存在但密码不正确（检查密码是否复制了多余空格、是否为最新密码）",
    0x530: "该时间不允许登录（账号配置了登录时段限制）",
    0x531: "不允许在该工作站登录（AD 账号限制了登录计算机）",
    0x532: "密码已过期",
    0x533: "账号已被禁用（在 AD 用户属性中启用后再试）",
    0x701: "账号已过期（AD 账号设置了账户过期时间）",
    0x773: "用户必须先重置密码（AD 勾选了「用户下次登录时须更改密码」）",
    0x775: "账号已被锁定（多次登录失败触发锁定策略，需管理员解锁）",
  };
  if (sub !== null && hint[sub]) return `AD 诊断码 data ${match![1]}：${hint[sub]}`;
  return "请检查「帐号」与「密码」";
}

export class LdapError extends Error {}

/** 绑定被目录拒绝（凭据错误 / 账号状态问题）。与连接类错误区分，登录接口据此给出准确提示。 */
export class LdapBindError extends LdapError {
  code: number;
  constructor(code: number, diagnostic?: string) {
    super(`LDAP 绑定失败（resultCode ${code}）：${diagnostic || "账号或密码错误"}。${describeBindFailure(code, diagnostic)}`);
    this.code = code;
  }
}

/** 同步与登录统一拉取的属性集：身份判定 + 部门 + 组 */
export const LDAP_USER_ATTRIBUTES = ["mail", "userPrincipalName", "sAMAccountName", "uid", "displayName", "cn", "department", "distinguishedName", "memberOf"];

const DEFAULT_SEARCH_FILTER = "(objectClass=person)";

// ---------- 错误归一化 ----------

const CONNECTION_HINTS: Record<string, string> = {
  ECONNREFUSED: "目标端口没有服务在监听（地址/端口写错，或目录服务未启动）",
  ENOTFOUND: "服务器地址无法解析（检查主机名拼写与 DNS）",
  EAI_AGAIN: "服务器地址解析超时（检查 DNS 与网络连通性）",
  ETIMEDOUT: "连接超时（网络不通或被防火墙拦截）",
  ECONNRESET: "连接被对端重置（可能是端口被中间设备阻断）",
  EHOSTUNREACH: "主机不可达（检查网段与路由）",
  CERT_HAS_EXPIRED: "LDAPS 证书已过期",
  DEPTH_ZERO_SELF_SIGNED_CERT: "LDAPS 证书为自签名；需在目录侧换成受信证书，或确认容忍自签名",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "LDAPS 证书链无法验证（缺少中间证书）",
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 把库/系统抛出的任意错误统一成 LdapError（保留原始信息，附加人话提示） */
function asLdapError(error: unknown, context: string): LdapError {
  if (error instanceof LdapError) return error;
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && CONNECTION_HINTS[code]) {
    return new LdapError(`${context}失败：${CONNECTION_HINTS[code]}（${messageOf(error)}）`);
  }
  if (typeof code === "number") {
    return new LdapError(`${context}失败（resultCode ${code}）：${messageOf(error)}`);
  }
  return new LdapError(`${context}失败：${messageOf(error)}`);
}

/** 结果码错误（ldapts 的 ResultCodeError 系列都带数字 code）→ LdapBindError */
function asBindError(error: unknown): LdapBindError | null {
  if (error instanceof LdapBindError) return error;
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "number") return new LdapBindError(code, messageOf(error));
  return null;
}

// ---------- 连接与查询 ----------

function ldapUrl(config: LdapDirectConfig): string {
  return `${config.ldaps ? "ldaps" : "ldap"}://${config.host}:${config.port}`;
}

function createClient(config: LdapDirectConfig): Client {
  const timeoutMs = config.timeoutMs ?? 10000;
  const options: ClientOptions = {
    url: ldapUrl(config),
    timeout: timeoutMs,
    connectTimeout: timeoutMs,
    // ⚠️ 必须关闭严格 DN 解析：登录兜底路径要用「域账号短名」或「UPN」直接 bind，
    //    它们不是合法 DN，严格模式下会在本地就抛错、根本发不出去。
    strictDN: false,
    tlsOptions: config.ldaps
      // 内网 AD 常用自签名证书；默认不校验（与旧实现行为一致），
      // 需要严格校验时设 LDAP_TLS_REJECT_UNAUTHORIZED=true。
      ? { rejectUnauthorized: env.LDAP_TLS_REJECT_UNAUTHORIZED === "true" }
      : undefined,
  };
  return new Client(options);
}

function toLdapEntry(entry: Entry): LdapEntry {
  const attributes: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (key === "dn" || key === "controls" || value === undefined) continue;
    const list = Array.isArray(value) ? value : [value];
    attributes[key.toLowerCase()] = list
      .filter((item) => item !== undefined && item !== null)
      .map((item) => (typeof item === "string" ? item : Buffer.isBuffer(item) ? item.toString("utf8") : String(item)));
  }
  return { dn: entry.dn, attributes };
}

async function bindOrThrow(client: Client, dn: string, password: string): Promise<void> {
  try {
    await client.bind(dn, password);
  } catch (error) {
    const bindError = asBindError(error);
    // 数字 resultCode = 目录明确拒绝了这次绑定（凭据/账号状态）→ 抛 LdapBindError
    if (bindError) throw bindError;
    // 其余（连不上、超时、TLS）→ 连接类错误
    throw asLdapError(error, "连接目录服务");
  }
}

async function searchEntries(
  client: Client,
  baseDn: string,
  attributes: string[],
  filter: string | undefined,
  config: LdapDirectConfig,
): Promise<LdapEntry[]> {
  const options: SearchOptions = {
    scope: "sub",
    derefAliases: "never",
    // ⚠️ 必须为 true：等价于旧实现的 typesOnly=FALSE。若为 false，目录只回属性名、值全空，
    //    同步出来的用户会全是「DN 当邮箱、名字未命名」。
    returnAttributeValues: true,
    sizeLimit: 0,
    timeLimit: 10,
    filter: filter?.trim() || DEFAULT_SEARCH_FILTER,
    attributes,
  };
  if (config.pageSize && config.pageSize > 0) options.paged = { pageSize: config.pageSize };
  try {
    const result = await client.search(baseDn, options);
    return result.searchEntries.map(toLdapEntry);
  } catch (error) {
    throw asLdapError(error, `搜索目录（Base DN ${baseDn}，过滤器 ${options.filter}）`);
  }
}

async function safeUnbind(client: Client): Promise<void> {
  try {
    await client.unbind();
  } catch {
    // 连接可能已断开或超时，忽略
  }
}

// ---------- 对外接口 ----------

export type LdapSession = {
  bind: (bindDn: string, password: string) => Promise<void>;
  search: (baseDn: string, attributes: string[], filter?: string) => Promise<LdapEntry[]>;
  unbind: () => Promise<void>;
  close: () => void;
};

/**
 * 建立一次 LDAP 会话（含整体超时保护）。
 * 调用方负责在 finally 里 unbind + close —— 失败路径也不能漏，否则连接会挂到超时。
 */
export async function openLdapSession(config: LdapDirectConfig): Promise<LdapSession> {
  const client = createClient(config);
  return {
    bind: (bindDn, password) => bindOrThrow(client, bindDn, password),
    search: (baseDn, attributes, filter) => searchEntries(client, baseDn, attributes, filter, config),
    unbind: () => safeUnbind(client),
    close: () => {
      void safeUnbind(client);
    },
  };
}

/** 目录同步：服务帐号 bind → subtree search */
export async function ldapSearchUsers(config: LdapDirectConfig): Promise<LdapEntry[]> {
  const client = createClient(config);
  try {
    await bindOrThrow(client, config.bindDn, config.bindPassword);
    return await searchEntries(client, config.baseDn, LDAP_USER_ATTRIBUTES, config.filter, config);
  } finally {
    await safeUnbind(client);
  }
}

export type LdapAuthResult = {
  /** 真正通过密码校验的绑定 DN */
  dn: string;
  /** 目录里的用户条目（搜索命中时才有），用于回填 ldap_users 与取显示名/部门 */
  entry: LdapEntry | null;
  matchedBy: "search" | "direct";
};

/** RFC 4515：过滤值中的 \ ( ) * 与 NUL 必须转义 */
export function escapeLdapFilterValue(value: string): string {
  return value.replace(/[\\*()\u0000]/g, (char) => `\\${char.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

/** 登录定位用的过滤器：域账号 / 邮箱 / UPN / uid / CN 任一命中即可 */
export function buildUserLookupFilter(account: string): string {
  const value = escapeLdapFilterValue(account);
  return `(|(sAMAccountName=${value})(mail=${value})(userPrincipalName=${value})(uid=${value})(cn=${value}))`;
}

const DN_LIKE = /[=,]/;

/**
 * 域账号密码校验（simple bind，RFC 4513）。
 *
 * 两步走，兼容 AD 与 OpenLDAP：
 *   1) 用配置中的服务帐号搜索出目标用户 DN（域账号 / 邮箱 / UPN 任一形式都能定位）；
 *   2) 以「用户 DN + 用户密码」重新建连 bind —— 密码只在本进程内递给目录，不落库、不进审计。
 * 目录不允许服务帐号搜索（或输入本身就是 DN）时退化为直接 bind；
 * 搜索无结果且输入不像 DN 时，直接判失败（不区分「无此账号」与「密码错误」，避免账号枚举）。
 *
 * 失败统一抛 LdapBindError。
 */
export async function ldapAuthenticate(config: LdapDirectConfig, account: string, password: string): Promise<LdapAuthResult> {
  const login = account.trim();
  let dn: string | null = null;
  let entry: LdapEntry | null = null;
  let matchedBy: LdapAuthResult["matchedBy"] = "direct";

  // 步骤 1：定位 DN —— 失败不致命，属"锦上添花"（能拿到条目才能回填姓名/部门）
  const lookup = createClient(config);
  try {
    await bindOrThrow(lookup, config.bindDn, config.bindPassword);
    const entries = await searchEntries(lookup, config.baseDn, LDAP_USER_ATTRIBUTES, buildUserLookupFilter(login), config);
    if (entries.length) {
      entry = entries[0];
      dn = entry.dn;
      matchedBy = "search";
    }
  } catch (error) {
    // 服务帐号自身配错（密码过期/被禁用）必须原样抛给管理员，不能被兜底路径掩盖
    if (error instanceof LdapBindError) throw error;
    // 其它情况（搜索被拒、目录不支持该过滤器）走直接 bind 兜底
  } finally {
    await safeUnbind(lookup);
  }

  if (!dn && !DN_LIKE.test(login)) throw new LdapBindError(49, "账号或密码不正确");

  // 步骤 2：以用户凭据 bind —— 唯一能证明密码正确的一步
  const verify = createClient(config);
  try {
    await bindOrThrow(verify, dn || login, password);
    return { dn: dn || login, entry, matchedBy };
  } finally {
    await safeUnbind(verify);
  }
}
