// Redmine 风格直连 LDAP 客户端（Workers 环境通过 cloudflare:sockets 出站 TCP）。
// 仅实现用户同步所需的最小 LDAP v3 协议子集：simple bind → subtree search → unbind。
// 支持 ldap://（389 明文）与 ldaps://（636 TLS）。参考 RFC 4511。

export type LdapDirectConfig = {
  host: string;
  port: number;
  ldaps: boolean;
  bindDn: string;
  bindPassword: string;
  baseDn: string;
  filter?: string;
  timeoutMs?: number;
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


// ---------- BER 编码 ----------

const encoder = new TextEncoder();

function bytes(...parts: Array<Uint8Array>): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

function berLengthBytes(length: number): Uint8Array {
  if (length < 0x80) return new Uint8Array([length]);
  const content: number[] = [];
  let rest = length;
  while (rest > 0) { content.unshift(rest & 0xff); rest = Math.floor(rest / 256); }
  return new Uint8Array([0x80 | content.length, ...content]);
}

function tlv(tag: number, content: Uint8Array): Uint8Array {
  return bytes(new Uint8Array([tag]), berLengthBytes(content.length), content);
}

function berIntegerContent(value: number): Uint8Array {
  if (value === 0) return new Uint8Array([0]);
  const content: number[] = [];
  let rest = value;
  while (rest > 0) { content.unshift(rest & 0xff); rest = Math.floor(rest / 256); }
  return new Uint8Array(content);
}

const berInteger = (value: number) => tlv(0x02, berIntegerContent(value));
const berString = (text: string) => tlv(0x04, encoder.encode(text));
const berEnumerated = (value: number) => tlv(0x0a, berIntegerContent(value));

// LDAP 消息 ID 由会话内自增计数器分配（见 openLdapSession），不再使用固定 ID

function buildBindRequest(bindDn: string, password: string): Uint8Array {
  // BindRequest ::= [APPLICATION 0] SEQUENCE { version INTEGER 3, name LDAPDN, simple [0] password }
  const version = new Uint8Array([0x02, 0x01, 0x03]);
  const simpleAuth = tlv(0x80, encoder.encode(password));
  return tlv(0x60, bytes(version, berString(bindDn), simpleAuth));
}

// ---------- 搜索过滤器编译（RFC 4515 子集 → BER） ----------

// 支持语法：(attr=*) 存在性、(attr=value) 相等、(attr>=v)/(attr<=v)/(attr~=v)、(&(...)(...))、(|(...))、(!(..))
function compileLdapFilter(filter: string): Uint8Array {
  let pos = 0;
  const fail = (why: string): never => { throw new LdapError(`LDAP 过滤器语法错误（位置 ${pos}）：${why}`); };
  const parseFilter = (): Uint8Array => {
    if (filter[pos] !== "(") fail(`应以 "(" 开始`);
    pos += 1;
    const op = filter[pos];
    let result: Uint8Array;
    if (op === "&" || op === "|") {
      pos += 1;
      const parts: Uint8Array[] = [];
      while (filter[pos] === "(") parts.push(parseFilter());
      if (!parts.length) fail(`(&...) 或 (|...) 至少需要一个条件`);
      if (filter[pos] !== ")") fail(`缺少闭合 ")"`);
      pos += 1;
      result = tlv(op === "&" ? 0xa0 : 0xa1, bytes(...parts));
    } else if (op === "!") {
      pos += 1;
      const inner = parseFilter();
      if (filter[pos] !== ")") fail(`缺少闭合 ")"`);
      pos += 1;
      result = tlv(0xa2, inner);
    } else {
      const attrStart = pos;
      while (pos < filter.length && !"=<>~)".includes(filter[pos])) pos += 1;
      const attr = filter.slice(attrStart, pos).trim();
      if (!attr || attr.includes("(")) fail(`属性名不合法`);
      let tag = 0xa3;
      if (filter[pos] === ">" && filter[pos + 1] === "=") { tag = 0xa5; pos += 2; }
      else if (filter[pos] === "<" && filter[pos + 1] === "=") { tag = 0xa6; pos += 2; }
      else if (filter[pos] === "~" && filter[pos + 1] === "=") { tag = 0xa8; pos += 2; }
      else if (filter[pos] !== "=") fail(`缺少 "=value" 比较`);
      else pos += 1;
      const close = filter.indexOf(")", pos);
      if (close === -1) fail(`缺少闭合 ")"`);
      const value = filter.slice(pos, close).trim();
      pos = close + 1;
      if (tag === 0xa3 && value === "*") result = tlv(0x87, encoder.encode(attr)); // 存在性
      else result = tlv(tag, bytes(berString(attr), berString(value)));
    }
    return result;
  };
  const compiled = parseFilter();
  if (pos !== filter.trim().length) fail(`过滤器末尾有多余内容`);
  return compiled;
}

const DEFAULT_SEARCH_FILTER = "(objectClass=person)";

function buildSearchRequest(baseDn: string, attributes: string[], filter?: string): Uint8Array {
  // SearchRequest ::= [APPLICATION 3] SEQUENCE { baseObject, scope(sub=2), deref(never=0),
  //   sizeLimit 0, timeLimit 10, typesOnly false, filter, attributes }
  let searchFilter: Uint8Array;
  try {
    searchFilter = filter?.trim() ? compileLdapFilter(filter.trim()) : compileLdapFilter(DEFAULT_SEARCH_FILTER);
  } catch (error) {
    throw error instanceof LdapError ? new LdapError(`${error.message}（过滤器原文：${filter}）`) : error;
  }
  const attrSelection = tlv(0x30, bytes(...attributes.map((name) => berString(name))));
  return tlv(0x63, bytes(
    berString(baseDn),
    berEnumerated(2),
    berEnumerated(0),
    berInteger(0),
    berInteger(10),
    // typesOnly 必须为 FALSE（0x00）。0xff=TRUE 会让 openldap 只回属性名、值全为空 SET，
    // 目录同步出来的用户全是「DN 当邮箱、名字未命名」（mock LDAP 忽略该标志所以从未暴露）。
    new Uint8Array([0x01, 0x01, 0x00]),
    searchFilter,
    attrSelection,
  ));
}

const buildUnbind = () => tlv(0x42, new Uint8Array(0));

// LDAPMessage ::= SEQUENCE { messageID INTEGER, protocolOp } —— 所有消息都必须带这层包装
const ldapMessage = (id: number, op: Uint8Array) => tlv(0x30, bytes(berInteger(id), op));

// ---------- BER 解码 ----------

type BerTlv = { tag: number; content: Uint8Array; end: number };

function readTlv(buffer: Uint8Array, offset: number): BerTlv | null {
  if (offset + 2 > buffer.length) return null;
  const tag = buffer[offset];
  const first = buffer[offset + 1];
  let contentLength = 0;
  let headerLength = 2;
  if (first < 0x80) {
    contentLength = first;
  } else {
    const count = first & 0x7f;
    if (count === 0 || count > 4) throw new Error(`LDAP 响应长度编码异常（${first}）`);
    if (offset + 2 + count > buffer.length) return null;
    for (let index = 0; index < count; index += 1) contentLength = contentLength * 256 + buffer[offset + 2 + index];
    headerLength = 2 + count;
  }
  const end = offset + headerLength + contentLength;
  if (end > buffer.length) return null;
  return { tag, content: buffer.subarray(offset + headerLength, end), end };
}

const berToString = (content: Uint8Array) => new TextDecoder().decode(content);
const berToInteger = (content: Uint8Array) => content.reduce((sum, byte) => sum * 256 + byte, 0);

function parseResultCode(content: Uint8Array): { code: number; message: string } {
  // 兼容两种编码：protocolOp 直接是 resultCode 序列，或内层再包一层 SEQUENCE
  const first = readTlv(content, 0);
  const body = first && first.tag === 0x30 ? first.content : content;
  let offset = 0;
  let code = 0;
  let message = "";
  const enumerated = readTlv(body, offset);
  if (enumerated) { code = berToInteger(enumerated.content); offset = enumerated.end; }
  const matchedDn = readTlv(body, offset);
  if (matchedDn) offset = matchedDn.end;
  const diagnostic = readTlv(body, offset);
  if (diagnostic) message = berToString(diagnostic.content);
  return { code, message };
}

function parseSearchEntry(content: Uint8Array): LdapEntry {
  // 兼容两种编码：条目体直接是 [objectName, attributes]，或内层再包一层 SEQUENCE
  const first = readTlv(content, 0);
  const body = first && first.tag === 0x30 ? first.content : content;
  let offset = 0;
  const objectName = readTlv(body, offset);
  const dn = objectName ? berToString(objectName.content) : "";
  if (objectName) offset = objectName.end;
  const attributes: Record<string, string[]> = {};
  const attrList = readTlv(body, offset);
  if (attrList) {
    let attrOffset = 0;
    while (true) {
      const partial = readTlv(attrList.content, attrOffset);
      if (!partial) break;
      attrOffset = partial.end;
      let innerOffset = 0;
      const type = readTlv(partial.content, innerOffset);
      if (!type) break;
      innerOffset = type.end;
      const values: string[] = [];
      const set = readTlv(partial.content, innerOffset);
      if (set) {
        let valueOffset = 0;
        while (true) {
          const value = readTlv(set.content, valueOffset);
          if (!value) break;
          values.push(berToString(value.content));
          valueOffset = value.end;
        }
      }
      attributes[berToString(type.content).toLowerCase()] = values;
    }
  }
  return { dn, attributes };
}

// ---------- 连接与会话 ----------

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
  const timeoutMs = config.timeoutMs ?? 10000;
  const { connect } = await import("cloudflare:sockets");
  const socket = connect({ hostname: config.host, port: config.port }, { secureTransport: config.ldaps ? "on" : "off", allowHalfOpen: false });
  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();
  let closed = false;
  // 用 slice 而非 subarray 维护缓冲区：避免 Uint8Array<ArrayBufferLike> 与 ArrayBuffer 的类型不兼容，
  // 同时防止残留视图长期持有已消费的底层内存。
  let buffer: Uint8Array = new Uint8Array(0);
  let nextMessageId = 1;

  function close() {
    if (closed) return;
    closed = true;
    try { writer.releaseLock(); } catch { /* 已释放 */ }
    try { reader.releaseLock(); } catch { /* 已释放 */ }
    try { socket.close(); } catch { /* 已关闭 */ }
  }

  const timer = setTimeout(close, timeoutMs);

  async function nextMessage(): Promise<Uint8Array> {
    while (true) {
      const message = readTlv(buffer, 0);
      if (message) { buffer = buffer.slice(message.end); return message.content; }
      const { value, done } = await reader.read();
      if (done || !value || value.length === 0) throw new LdapError("LDAP 连接在收到完整响应前被关闭");
      buffer = bytes(buffer, value);
    }
  }

  // 取回指定 messageID 的 protocolOp：LDAPMessage = SEQUENCE { messageID INTEGER, protocolOp }
  async function readProtocolOp(messageId: number): Promise<BerTlv> {
    while (true) {
      const message = await nextMessage();
      let offset = 0;
      const id = readTlv(message, offset);
      if (!id) continue;
      offset = id.end;
      const protocolOp = readTlv(message, offset);
      if (!protocolOp) continue;
      if (berToInteger(id.content) !== messageId) continue;
      return protocolOp;
    }
  }

  async function bind(bindDn: string, password: string): Promise<void> {
    const messageId = nextMessageId++;
    await writer.write(ldapMessage(messageId, buildBindRequest(bindDn, password)));
    const protocolOp = await readProtocolOp(messageId);
    if (protocolOp.tag !== 0x61) throw new LdapError(`LDAP 绑定响应异常（tag 0x${protocolOp.tag.toString(16)}）`);
    const result = parseResultCode(protocolOp.content);
    if (result.code !== 0) throw new LdapBindError(result.code, result.message);
  }

  async function search(baseDn: string, attributes: string[], filter?: string): Promise<LdapEntry[]> {
    const messageId = nextMessageId++;
    await writer.write(ldapMessage(messageId, buildSearchRequest(baseDn, attributes, filter)));
    const entries: LdapEntry[] = [];
    while (true) {
      const protocolOp = await readProtocolOp(messageId);
      if (protocolOp.tag === 0x64) { // searchResEntry
        entries.push(parseSearchEntry(protocolOp.content));
        continue;
      }
      if (protocolOp.tag === 0x65) { // searchResDone
        const result = parseResultCode(protocolOp.content);
        if (result.code !== 0 && result.code !== 4) { // 4 = sizeLimitExceeded，返回已收到的条目
          throw new LdapError(`LDAP 搜索失败（resultCode ${result.code}）：${result.message || "未知错误"}，请检查 Base DN 与过滤器`);
        }
        break;
      }
    }
    return entries;
  }

  async function unbind(): Promise<void> {
    try { await writer.write(ldapMessage(nextMessageId++, buildUnbind())); } catch { /* 忽略 unbind 失败 */ }
  }

  return {
    bind,
    search,
    unbind,
    close: () => { clearTimeout(timer); close(); },
  };
}

/** 目录同步：服务帐号 bind → subtree search */
export async function ldapSearchUsers(config: LdapDirectConfig): Promise<LdapEntry[]> {
  const session = await openLdapSession(config);
  try {
    await session.bind(config.bindDn, config.bindPassword);
    return await session.search(config.baseDn, LDAP_USER_ATTRIBUTES, config.filter);
  } finally {
    await session.unbind().catch(() => undefined);
    session.close();
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
  const lookup = await openLdapSession(config);
  try {
    await lookup.bind(config.bindDn, config.bindPassword);
    const entries = await lookup.search(config.baseDn, LDAP_USER_ATTRIBUTES, buildUserLookupFilter(login));
    if (entries.length) { entry = entries[0]; dn = entry.dn; matchedBy = "search"; }
  } catch (error) {
    // 服务帐号自身配错（密码过期/被禁用）必须原样抛给管理员，不能被兜底路径掩盖
    if (error instanceof LdapBindError) throw error;
    // 其它情况（搜索被拒、目录不支持该过滤器）走直接 bind 兜底
  } finally {
    await lookup.unbind().catch(() => undefined);
    lookup.close();
  }

  if (!dn && !DN_LIKE.test(login)) throw new LdapBindError(49, "账号或密码不正确");

  // 步骤 2：以用户凭据 bind —— 唯一能证明密码正确的一步
  const verify = await openLdapSession(config);
  try {
    await verify.bind(dn || login, password);
    return { dn: dn || login, entry, matchedBy };
  } finally {
    await verify.unbind().catch(() => undefined);
    verify.close();
  }
}
