#!/usr/bin/env node
// 本地 mock LDAP 服务器 —— 仅用于验证「域账号 + 域密码」登录链路（simple bind）与目录同步（search）。
//
// 为什么需要它：真实验证要连 AD 或 OpenLDAP。Docker 未就绪时，用这个纯 Node 实现（零依赖、无 TLS）
// 就能把「服务帐号搜索定位 DN → 用户凭据 bind 校验 → 属性回填」整条链路跑通。
//
// 用法：
//   node scripts/mock-ldap-server.mjs --port 3890
//
// 认证规则（刻意设计成不依赖任何密码常量，避免把口令写进仓库）：
//   • 服务帐号（cn=admin,<baseDn>）：任意非空密码都通过 —— 联调不校验服务帐号口令
//   • 普通用户：    密码必须等于其域账号（uid），例如 zhangsan / zhangsan
//   • 其它：        resultCode 49（带 AD 风格诊断码 data 52e），与真实 AD 的失败形态一致
//
// 支持的 LDAP 子集：simple bind、subtree search（AND/OR/NOT/相等/存在性过滤器）、unbind。
// ⚠️ 仅监听 127.0.0.1，仅供本机联调；生产必须对接真实 AD。

import net from "node:net";

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}
const PORT = Number(argValue("port", "3890"));
const BASE_DN = argValue("base-dn", "dc=example,dc=local");
const SERVICE_DN = `cn=admin,${BASE_DN}`;

// 测试目录（与 docker/ldap/seed.ldif 保持一致，便于两种联调方式得到相同结果）
const USERS = [
  { uid: "zhangsan", displayName: "张三", sn: "张三", mail: "zhangsan@example.local", department: "研发部" },
  { uid: "lisi", displayName: "李四", sn: "李四", mail: "lisi@example.local", department: "研发部" },
  { uid: "wangwu", displayName: "王五", sn: "王五", mail: "wangwu@example.local", department: "审批人" },
  { uid: "zhaoliu", displayName: "赵六", sn: "赵六", mail: "zhaoliu@example.local", department: "审计员" },
];

const ENTRIES = USERS.map((user) => {
  const dn = `uid=${user.uid},ou=people,${BASE_DN}`;
  const attributes = {
    uid: [user.uid],
    cn: [user.uid],
    sn: [user.sn],
    displayname: [user.displayName],
    mail: [user.mail],
    samaccountname: [user.uid],
    userprincipalname: [`${user.uid}@example.local`],
    department: [user.department],
    objectclass: ["inetOrgPerson", "posixAccount", "person"],
    distinguishedname: [dn],
  };
  // 密码 = 域账号：避免在仓库里出现任何口令字面量
  return { dn, uid: user.uid, password: user.uid, attributes };
});

// ---------- BER 编解码 ----------

const encoder = new TextEncoder();

function concat(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

function lengthBytes(length) {
  if (length < 0x80) return new Uint8Array([length]);
  const digits = [];
  let rest = length;
  while (rest > 0) { digits.unshift(rest & 0xff); rest = Math.floor(rest / 256); }
  return new Uint8Array([0x80 | digits.length, ...digits]);
}

const tlv = (tag, content) => concat([new Uint8Array([tag]), lengthBytes(content.length), content]);
const berString = (text) => tlv(0x04, encoder.encode(text));
const berEnumerated = (value) => tlv(0x0a, new Uint8Array([value]));
const berInteger = (value) => tlv(0x02, new Uint8Array([value]));
const ldapMessage = (id, op) => tlv(0x30, concat([berInteger(id), op]));

function readTlv(buffer, offset) {
  if (offset + 2 > buffer.length) return null;
  const tag = buffer[offset];
  const first = buffer[offset + 1];
  let contentLength = 0;
  let headerLength = 2;
  if (first < 0x80) {
    contentLength = first;
  } else {
    const count = first & 0x7f;
    if (count === 0 || count > 4 || offset + 2 + count > buffer.length) return null;
    for (let index = 0; index < count; index += 1) contentLength = contentLength * 256 + buffer[offset + 2 + index];
    headerLength = 2 + count;
  }
  const end = offset + headerLength + contentLength;
  if (end > buffer.length) return null;
  return { tag, content: buffer.subarray(offset + headerLength, end), end };
}

const toText = (content) => new TextDecoder().decode(content);

// ---------- 过滤器求值（AND / OR / NOT / 相等 / 存在性）----------

function evaluateFilter(node, entry) {
  if (!node) return false;
  if (node.tag === 0xa0 || node.tag === 0xa1) { // and / or
    const children = [];
    let offset = 0;
    while (true) {
      const child = readTlv(node.content, offset);
      if (!child) break;
      children.push(child);
      offset = child.end;
    }
    return node.tag === 0xa0 ? children.every((child) => evaluateFilter(child, entry)) : children.some((child) => evaluateFilter(child, entry));
  }
  if (node.tag === 0xa2) return !evaluateFilter(readTlv(node.content, 0), entry);
  if (node.tag === 0x87) { // 存在性
    return Boolean(entry.attributes[toText(node.content).toLowerCase()]);
  }
  if (node.tag === 0xa3 || node.tag === 0xa5 || node.tag === 0xa6 || node.tag === 0xa8) { // 相等（比较类一律按相等处理）
    const attr = readTlv(node.content, 0);
    if (!attr) return false;
    const value = readTlv(node.content, attr.end);
    if (!value) return false;
    const key = toText(attr.content).toLowerCase();
    const wanted = toText(value.content).toLowerCase();
    return (entry.attributes[key] || []).some((item) => item.toLowerCase() === wanted);
  }
  return false;
}

// ---------- 响应构造 ----------

const bindResponse = (id, code, diagnostic) => ldapMessage(id, tlv(0x61, concat([berEnumerated(code), berString(""), berString(diagnostic || "")])));

const searchEntry = (id, entry) => {
  const attributeList = tlv(0x30, concat(
    Object.entries(entry.attributes).map(([name, values]) => tlv(0x30, concat([berString(name), tlv(0x31, concat(values.map(berString)))]))),
  ));
  return ldapMessage(id, tlv(0x64, concat([berString(entry.dn), attributeList])));
};

const searchDone = (id, code = 0) => ldapMessage(id, tlv(0x65, concat([berEnumerated(code), berString(""), berString("")])));

// ---------- 连接处理 ----------

function handleConnection(socket) {
  const peer = `${socket.remoteAddress}:${socket.remotePort}`;
  let buffer = new Uint8Array(0);
  socket.on("error", (error) => console.log(`[mock-ldap] ${peer} 连接错误：${error.message}`));

  socket.on("data", (chunk) => {
    buffer = concat([buffer, new Uint8Array(chunk)]);
    while (true) {
      const message = readTlv(buffer, 0);
      if (!message) break;
      buffer = buffer.slice(message.end);
      if (message.tag !== 0x30) continue;

      const idTlv = readTlv(message.content, 0);
      if (!idTlv) continue;
      let messageId = 0;
      for (const byte of idTlv.content) messageId = messageId * 256 + byte;
      const op = readTlv(message.content, idTlv.end);
      if (!op) continue;

      if (op.tag === 0x60) { // BindRequest
        const name = readTlv(op.content, 0);
        // BindRequest 里 version 是 INTEGER，接着才是 name；统一从 content 里找 0x04 与 0x80
        let dn = "";
        let password = "";
        let offset = 0;
        while (true) {
          const field = readTlv(op.content, offset);
          if (!field) break;
          if (field.tag === 0x04) dn = toText(field.content);
          if (field.tag === 0x80) password = toText(field.content);
          offset = field.end;
        }
        void name;
        const normalized = dn.trim().toLowerCase();
        const isService = normalized === SERVICE_DN.toLowerCase();
        if (isService) {
          if (password.length > 0) {
            console.log(`[mock-ldap] ${peer} 服务帐号绑定成功：${dn}`);
            socket.write(bindResponse(messageId, 0));
          } else {
            console.log(`[mock-ldap] ${peer} 服务帐号绑定失败：密码为空`);
            socket.write(bindResponse(messageId, 49, "80090308: LdapErr: DSID-0C0903A9, comment: AcceptSecurityContext error, data 52e, v1db1"));
          }
        } else {
          const firstRdn = normalized.split(",")[0] || "";
          const entry = ENTRIES.find((item) => {
            const keys = [item.uid, (item.attributes.displayname || [""])[0]].map((key) => key.toLowerCase());
            return keys.some((key) => firstRdn === `uid=${key}` || firstRdn === `cn=${key}`);
          });
          if (entry && password === entry.password) {
            console.log(`[mock-ldap] ${peer} 用户绑定成功：${dn}`);
            socket.write(bindResponse(messageId, 0));
          } else {
            console.log(`[mock-ldap] ${peer} 用户绑定失败：${dn}`);
            socket.write(bindResponse(messageId, 49, "80090308: LdapErr: DSID-0C0903A9, comment: AcceptSecurityContext error, data 52e, v1db1"));
          }
        }
        continue;
      }

      if (op.tag === 0x63) { // SearchRequest
        const baseObject = readTlv(op.content, 0);
        const base = baseObject ? toText(baseObject.content) : "";
        // 过滤器是 SearchRequest 里第一个 tag 为 0xa0/0xa1/0xa2/0xa3/0x87 的元素
        let filter = null;
        let attributes = [];
        let offset = 0;
        while (true) {
          const field = readTlv(op.content, offset);
          if (!field) break;
          // 只认第一个匹配的元素：SearchRequest 末尾的 controls 字段（分页控制）与 AND 过滤器同为 tag 0xa0，
          // 若反复覆盖，带 controls 的请求会把控制报文当成过滤器求值，结果恒为空。
          if (filter === null && [0xa0, 0xa1, 0xa2, 0xa3, 0x87, 0xa5, 0xa6, 0xa8].includes(field.tag)) filter = field;
          if (field.tag === 0x30) {
            const requested = [];
            let attrOffset = 0;
            while (true) {
              const value = readTlv(field.content, attrOffset);
              if (!value) break;
              requested.push(toText(value.content).toLowerCase());
              attrOffset = value.end;
            }
            attributes = requested;
          }
          offset = field.end;
        }
        const matched = ENTRIES.filter((entry) => evaluateFilter(filter, entry));
        for (const entry of matched) socket.write(searchEntry(messageId, entry));
        socket.write(searchDone(messageId, 0));
        console.log(`[mock-ldap] ${peer} 搜索 base=${base} 命中 ${matched.length} 条（请求属性 ${attributes.join("/") || "全部"}）`);
        continue;
      }

      if (op.tag === 0x42) { // UnbindRequest
        socket.end();
        return;
      }

      // 未实现的操作：返回 unavailable(52)，避免调用方一直等
      console.log(`[mock-ldap] ${peer} 未实现的操作 tag=0x${op.tag.toString(16)}`);
      socket.write(ldapMessage(messageId, tlv(0x65, concat([berEnumerated(52), berString(""), berString("unsupported operation")]))));
    }
  });
}

const server = net.createServer(handleConnection);
server.listen(PORT, "127.0.0.1", () => {
  console.log(`[mock-ldap] 监听 ldap://127.0.0.1:${PORT}  baseDn=${BASE_DN}`);
  console.log(`[mock-ldap] 服务帐号：${SERVICE_DN}（任意非空密码）；用户：${ENTRIES.map((entry) => `${entry.uid}/${entry.password}`).join("、")}`);
  console.log("[mock-ldap] 仅本机联调使用；生产请连接内网真实 AD。Ctrl+C 退出。");
});
