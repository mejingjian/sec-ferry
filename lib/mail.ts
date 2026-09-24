// 内网 SMTP 邮件通知（0010）：审批待办通知 + 收件通知。
//
// 设计要点（对应事项 ⑥ 的三个硬约束）：
//   * 不可新增依赖 —— 本机 npm 走代理会僵死、只能 --offline 安装，因此用 node:net/node:tls
//     手写最小 SMTP 客户端（EHLO/STARTTLS/AUTH PLAIN·LOGIN/MAIL/RCPT/DATA），仅覆盖发信所需子集。
//   * 发送失败绝不阻断主流程 —— 提交/送达路径只做「入队」（mail_outbox 表），真正发信由
//     dispatchMailOutbox() 后台异步消费；发送异常只影响 outbox 行状态，不向上抛。
//   * SMTP 凭据加密存储 —— 复用 integration_settings 行（id='ldap'），
//     密码用 CONFIG_ENCRYPTION_KEY 做 AES-GCM 加密（与 LDAP 绑定密码同一套 encrypt/decrypt）。
//
// 为什么不用 nodemailer：见上；且项目依赖刻意保持最小（重构后仅 9 个运行依赖）。

import net from "node:net";
import tls from "node:tls";
import { and, eq, inArray, lt, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { integrationSettings, mailOutbox, roleAssignments } from "@/db/schema";
import { env } from "@/lib/env";
import { decryptSecret } from "@/lib/ldap-config";

const SMTP_TIMEOUT_MS = 10_000;
const MAIL_MAX_ATTEMPTS = 5;
const MAIL_OUTBOX_BATCH = 50;

export type SmtpConfig = {
  host: string;
  port: number;
  /** true = 隐式 TLS（通常 465）；false = 明文连接、服务器支持时自动升级 STARTTLS（通常 25/587） */
  secure: boolean;
  username: string | null;
  password: string | null;
  from: string;
};

export type OutgoingMail = { to: string[]; subject: string; body: string };

// ---------- 配置读取 ----------

/** 发信配置：未配置（缺 host 或 from）返回 null，配置不完整/密码解不开抛错。 */
export async function getSmtpConfig(): Promise<SmtpConfig | null> {
  const rows = await getDb().select().from(integrationSettings).where(eq(integrationSettings.id, "ldap")).limit(1);
  const row = rows[0];
  if (!row?.smtpHost || !row.smtpFrom) return null;
  let password: string | null = null;
  if (row.smtpEncryptedSecret) {
    password = await decryptSecret(row.smtpEncryptedSecret);
  }
  return {
    host: row.smtpHost,
    port: row.smtpPort || (row.smtpSecure ? 465 : 25),
    secure: Boolean(row.smtpSecure),
    username: row.smtpUsername || null,
    password,
    from: row.smtpFrom,
  };
}

// ---------- 最小 SMTP 客户端 ----------

function rejectUnauthorized(): boolean {
  // 内网中继常见自签名证书：SMTP_TLS_REJECT_UNAUTHORIZED=0 可关闭校验（默认严格校验）
  return env.SMTP_TLS_REJECT_UNAUTHORIZED !== "0";
}

/** RFC 2047 编码词：非 ASCII 主题按 UTF-8 Base64 编码，避免依赖服务器 8BITMIME */
function encodeSubject(subject: string): string {
  if (/^[\x20-\x7e]*$/.test(subject)) return subject;
  const encoded = Buffer.from(subject, "utf8").toString("base64");
  return `=?UTF-8?B?${encoded}?=`;
}

type Reply = { code: number; lines: string[]; text: string };

class SmtpClient {
  private socket: net.Socket;
  private buffer = "";
  private waiter: { resolve: (reply: Reply) => void; reject: (error: Error) => void } | null = null;
  private closed = false;

  private constructor(socket: net.Socket) {
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.setTimeout(SMTP_TIMEOUT_MS);
    socket.on("data", (chunk: string) => {
      this.buffer += chunk;
      this.tryResolve();
    });
    socket.on("timeout", () => this.fail(new Error(`SMTP 响应超时（${SMTP_TIMEOUT_MS}ms）`)));
    socket.on("error", (error: Error) => this.fail(error));
    socket.on("close", () => {
      this.closed = true;
      this.fail(new Error("SMTP 连接被对端关闭"));
    });
  }

  private fail(error: Error) {
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.reject(error);
  }

  /** 逐行解析应答：多行应答以「250-…」继续、「250 …」（第 4 字符为空格）结束 */
  private tryResolve() {
    if (!this.waiter) return;
    const lines = this.buffer.split("\r\n");
    for (let index = 0; index < lines.length; index += 1) {
      const match = /^(\d{3})([ -])/.exec(lines[index] ?? "");
      if (!match) continue;
      if (match[2] === "-") continue; // 多行应答的中间行，继续等
      const replyLines = lines.slice(0, index + 1).filter((line) => /^\d{3}[ -]/.test(line));
      this.buffer = lines.slice(index + 1).join("\r\n");
      const waiter = this.waiter;
      this.waiter = null;
      waiter.resolve({ code: Number(match[1]), lines: replyLines, text: replyLines.join("\n") });
      return;
    }
  }

  private readReply(): Promise<Reply> {
    if (this.closed) return Promise.reject(new Error("SMTP 连接已关闭"));
    return new Promise((resolve, reject) => { this.waiter = { resolve, reject }; });
  }

  private send(command: string): Promise<Reply> {
    this.socket.write(`${command}\r\n`);
    return this.readReply();
  }

  static connect(config: SmtpConfig): Promise<SmtpClient> {
    return new Promise((resolve, reject) => {
      const onError = (error: Error) => { socket?.destroy(); reject(error); };
      let socket: net.Socket;
      if (config.secure) {
        socket = tls.connect({ host: config.host, port: config.port, rejectUnauthorized: rejectUnauthorized() }, () => resolve(new SmtpClient(socket)));
      } else {
        socket = net.connect({ host: config.host, port: config.port }, () => resolve(new SmtpClient(socket)));
      }
      socket.once("error", onError);
      socket.setTimeout(SMTP_TIMEOUT_MS, () => onError(new Error(`SMTP 连接超时（${config.host}:${config.port}，${SMTP_TIMEOUT_MS}ms）`)));
    });
  }

  async greeting(): Promise<Reply> {
    return this.readReply();
  }

  /** STARTTLS 升级：返回新实例（socket 被替换，监听器随原生实现保留在 socket 上） */
  async starttls(config: SmtpConfig): Promise<SmtpClient> {
    const { socket } = this;
    socket.removeAllListeners("data");
    socket.removeAllListeners("timeout");
    socket.removeAllListeners("error");
    socket.removeAllListeners("close");
    this.closed = true; // 旧实例不再接收应答
    const upgraded = await new Promise<net.Socket>((resolve, reject) => {
      const secureSocket = tls.connect({ socket, host: config.host, port: config.port, rejectUnauthorized: rejectUnauthorized() }, () => resolve(secureSocket));
      secureSocket.once("error", reject);
    });
    const next = new SmtpClient(upgraded);
    return next;
  }

  private ehloLines: string[] = [];

  async ehlo(hostname = "transfer-platform"): Promise<Reply> {
    const reply = await this.send(`EHLO ${hostname}`);
    if (reply.code === 250) this.ehloLines = reply.lines;
    return reply;
  }

  capabilities(): string[] {
    return this.ehloLines.map((line) => line.toUpperCase());
  }

  async auth(username: string, password: string): Promise<void> {
    const caps = this.capabilities().join("\n");
    if (caps.includes("AUTH PLAIN") || !caps.includes("AUTH")) {
      // 服务器未声明 AUTH 时按 PLAIN 直试（多数内网中继接受）；失败会在上层给出明确报错
      const token = Buffer.from(`\u0000${username}\u0000${password}`, "utf8").toString("base64");
      const reply = await this.send(`AUTH PLAIN ${token}`);
      if (reply.code !== 235) throw new Error(`SMTP 认证失败（${reply.code}）：${reply.text}`);
      return;
    }
    const hello = await this.send("AUTH LOGIN");
    if (hello.code !== 334) throw new Error(`SMTP 服务器不支持 AUTH LOGIN（${hello.code}）`);
    const userReply = await this.send(Buffer.from(username, "utf8").toString("base64"));
    if (userReply.code !== 334) throw new Error(`SMTP 认证帐号被拒（${userReply.code}）：${userReply.text}`);
    const passReply = await this.send(Buffer.from(password, "utf8").toString("base64"));
    if (passReply.code !== 235) throw new Error(`SMTP 认证失败（${passReply.code}）：${passReply.text}`);
  }

  async sendMail(mail: { from: string; to: string[]; subject: string; body: string }): Promise<void> {
    const fromReply = await this.send(`MAIL FROM:<${mail.from}>`);
    if (fromReply.code !== 250) throw new Error(`SMTP 发件人被拒（${fromReply.code}）：${fromReply.text}`);
    for (const recipient of mail.to) {
      const rcptReply = await this.send(`RCPT TO:<${recipient}>`);
      if (rcptReply.code !== 250 && rcptReply.code !== 251) throw new Error(`SMTP 收件人 ${recipient} 被拒（${rcptReply.code}）：${rcptReply.text}`);
    }
    const dataReply = await this.send("DATA");
    if (dataReply.code !== 354) throw new Error(`SMTP 服务器拒绝进入 DATA（${dataReply.code}）：${dataReply.text}`);
    // 正文 base64 传输（Content-Transfer-Encoding），彻底避开 8bit/换行兼容性问题；点填充按 RFC 5321
    const headerTo = mail.to.length === 1 ? mail.to[0]! : `${mail.to[0]}, ...（共 ${mail.to.length} 位收件人）`;
    const payload = [
      `From: <${mail.from}>`,
      `To: ${headerTo}`,
      `Subject: ${encodeSubject(mail.subject)}`,
      `Date: ${new Date().toUTCString()}`,
      "MIME-Version: 1.0",
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from(mail.body, "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n"),
    ].join("\r\n").replace(/\r\n\./g, "\r\n.."); // 点填充
    const done = await this.send(`${payload}\r\n.`);
    if (done.code !== 250) throw new Error(`SMTP 投递被拒（${done.code}）：${done.text}`);
  }

  async quit(): Promise<void> {
    try { await this.send("QUIT"); } catch { /* 对端先关是常态 */ }
    this.socket.destroy();
  }

  destroy(): void {
    this.socket.destroy();
  }
}

/**
 * 同步发送一封邮件（SMTP 事务）。仅在 outbox 消费者与管理员「测试发送」中直接使用；
 * 业务路径请走 queueMails + dispatchMailOutbox（失败不阻断）。
 */
export async function smtpDeliver(config: SmtpConfig, mail: OutgoingMail): Promise<void> {
  let client = await SmtpClient.connect(config);
  try {
    const greeting = await client.greeting();
    if (greeting.code !== 220) throw new Error(`SMTP 服务器问候异常（${greeting.code}）：${greeting.text}`);
    let ehlo = await client.ehlo();
    if (ehlo.code !== 250) throw new Error(`SMTP EHLO 失败（${ehlo.code}）：${ehlo.text}`);
    if (!config.secure && ehlo.text.toUpperCase().includes("STARTTLS")) {
      client = await client.starttls(config);
      ehlo = await client.ehlo();
      if (ehlo.code !== 250) throw new Error(`SMTP STARTTLS 后 EHLO 失败（${ehlo.code}）：${ehlo.text}`);
    }
    if (config.username && config.password) await client.auth(config.username, config.password);
    await client.sendMail({ from: config.from, to: mail.to, subject: mail.subject, body: mail.body });
    await client.quit();
  } catch (error) {
    client.destroy();
    throw error instanceof Error ? error : new Error(String(error));
  }
}

// ---------- 发件队列 ----------

export type QueuedMessage = { to: string; subject: string; body: string };

/** 通知入队（不发送）。返回入队条数。收件人列表为空时是 no-op。 */
export async function queueMails(kind: "APPROVAL_PENDING" | "DELIVERED" | "TEST", applicationId: string | null, messages: QueuedMessage[]): Promise<number> {
  const valid = messages.filter((message) => message.to.includes("@"));
  if (!valid.length) return 0;
  const now = new Date().toISOString();
  await getDb().insert(mailOutbox).values(valid.map((message) => ({
    id: `MAIL-${crypto.randomUUID().slice(0, 12).toUpperCase()}`,
    applicationId,
    kind,
    toAddress: message.to,
    subject: message.subject,
    body: message.body,
    status: "pending",
    attempts: 0,
    lastError: null,
    createdAt: now,
    sentAt: null,
  })));
  return valid.length;
}

/** 消费发件队列：逐条投递（串行，避免冲击内网中继）。单条失败只记状态，不影响其余。 */
export async function processMailOutbox(): Promise<{ sent: number; failed: number; skipped: number }> {
  const config = await getSmtpConfig();
  const db = getDb();
  const cutoff = new Date(Date.now() - 86_400_000 * 3).toISOString(); // 超过 3 天的失败项不再重试
  const pending = config
    ? await db.select().from(mailOutbox).where(and(
        or(eq(mailOutbox.status, "pending"), eq(mailOutbox.status, "failed")),
        lt(mailOutbox.attempts, MAIL_MAX_ATTEMPTS),
        sql`${mailOutbox.createdAt} > ${cutoff}`,
      )).orderBy(mailOutbox.createdAt).limit(MAIL_OUTBOX_BATCH)
    : [];
  if (!config) {
    // 未配置 SMTP：队列原样保留（等管理员配置后自动发出），不算失败
    const backlog = await db.select({ count: sql<number>`count(*)` }).from(mailOutbox).where(eq(mailOutbox.status, "pending"));
    return { sent: 0, failed: 0, skipped: Number(backlog[0]?.count ?? 0) };
  }
  let sent = 0;
  let failed = 0;
  for (const item of pending) {
    const attempts = item.attempts + 1;
    try {
      await smtpDeliver(config, { to: [item.toAddress], subject: item.subject, body: item.body });
      await db.update(mailOutbox).set({ status: "sent", attempts, lastError: null, sentAt: new Date().toISOString() }).where(eq(mailOutbox.id, item.id));
      sent += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await db.update(mailOutbox).set({ status: "failed", attempts, lastError: message.slice(0, 500) }).where(eq(mailOutbox.id, item.id));
      failed += 1;
    }
  }
  return { sent, failed, skipped: 0 };
}

/** fire-and-forget：调用方只管入队，发信在后台进行，任何异常都不冒泡（Next 会把未处理的 rejection 记为崩溃日志） */
export function dispatchMailOutbox(): void {
  void processMailOutbox().catch(() => undefined);
}

// ---------- 业务通知 ----------

// 与 lib/server.ts 的 formatSize 口径一致（mail.ts 不能反向 import server.ts：server.ts 会引入本模块，避免环）
function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0).replace(/\.0$/, "")} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0).replace(/\.0$/, "")} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 转人工审批时的审批待办通知（发给规则指派审批人；未指派时由调用方传入兜底名单） */
export async function notifyApprovalPending(application: { id: string; fileName: string; sizeBytes: number; requesterName: string; department: string; description: string; decisionReason: string | null }, approverEmails: string[]): Promise<number> {
  const subject = `【文件安全收发平台】发送单 ${application.id} 等待审批`;
  const body = [
    `${application.requesterName}（${application.department}）提交的发送单等待您审批。`,
    "",
    `发送单编号：${application.id}`,
    `文件名：${application.fileName}`,
    `大小：${formatSize(application.sizeBytes)}`,
    `发送说明：${application.description || "（无）"}`,
    application.decisionReason ? `转人工原因：${application.decisionReason}` : "",
    "",
    "请登录文件安全收发平台，在「审批中心」处理该发送单。",
  ].filter((line) => line !== "").join("\n");
  return queueMails("APPROVAL_PENDING", application.id, approverEmails.map((to) => ({ to, subject, body })));
}

/** 文件送达后的收件通知（发给各站内收件人） */
export async function notifyDelivered(application: { id: string; fileName: string; sizeBytes: number; requesterName: string; description: string }, recipients: Array<{ email: string; name: string }>): Promise<number> {
  const subject = `【文件安全收发平台】${application.requesterName} 向您发送了文件 ${application.fileName}（${application.id}）`;
  const body = [
    `${application.requesterName} 通过文件安全收发平台向您发送了一个文件，已可下载。`,
    "",
    `文件名：${application.fileName}`,
    `大小：${formatSize(application.sizeBytes)}`,
    `发送说明：${application.description || "（无）"}`,
    "",
    "请登录文件安全收发平台，在「我的收件箱」下载该文件。",
  ].join("\n");
  return queueMails("DELIVERED", application.id, recipients.map((recipient) => ({ to: recipient.email, subject, body })));
}

/** 审批人兜底名单：角色指派表中的审批人 + 环境变量 PLATFORM_APPROVER_EMAILS */
export async function fallbackApproverEmails(): Promise<string[]> {
  const assigned = await getDb().select().from(roleAssignments).where(eq(roleAssignments.role, "审批人"));
  const fromEnv = (env.PLATFORM_APPROVER_EMAILS || "").split(",").map((value) => value.trim().toLowerCase()).filter((value) => value.includes("@"));
  return Array.from(new Set([...assigned.map((row) => row.email.toLowerCase()), ...fromEnv]));
}

/** outbox 统计（管理页展示）：按状态计数 */
export async function mailOutboxStats(): Promise<{ pending: number; sent: number; failed: number }> {
  const rows = await getDb().select({ status: mailOutbox.status, count: sql<number>`count(*)` }).from(mailOutbox).groupBy(mailOutbox.status);
  const stats = { pending: 0, sent: 0, failed: 0 };
  for (const row of rows) {
    if (row.status === "pending" || row.status === "sent" || row.status === "failed") stats[row.status] = Number(row.count);
  }
  return stats;
}

/** 按发送单清出队列（发送单被撤回等场景下不再需要历史通知时可用；当前仅管理端展示用） */
export async function mailOutboxForApplication(applicationId: string) {
  return getDb().select().from(mailOutbox).where(inArray(mailOutbox.applicationId, [applicationId]));
}
