// 邮件通知 SMTP 配置（0010）：读写 integration_settings 的 smtp_* 字段 + 管理员测试发送。
//
// 与 LDAP 配置（/api/admin/config）分开成独立端点：LDAP 那条 PUT 是整行覆盖语义，
// 且有「只更新防护档位」的 guardOnly 分支；邮件配置塞进去会让两套校验互相纠缠。
// 密码加密口径与 LDAP 绑定密码一致（AES-GCM，密钥 = SHA-256(CONFIG_ENCRYPTION_KEY)）。

import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { integrationSettings } from "@/db/schema";
import { appendAudit, requireAdministrator, serverError } from "@/lib/server";
import { env } from "@/lib/env";
import { getSmtpConfig, mailOutboxStats, processMailOutbox, smtpDeliver } from "@/lib/mail";

async function encrypt(secret: string) {
  if (!env.CONFIG_ENCRYPTION_KEY) throw new Error("尚未配置服务端加密密钥");
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(env.CONFIG_ENCRYPTION_KEY));
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(secret));
  return `${Array.from(iv).map((v) => v.toString(16).padStart(2, "0")).join("")}.${Array.from(new Uint8Array(encrypted)).map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

export async function GET(request: Request) {
  try {
    await requireAdministrator(request);
    const rows = await getDb().select().from(integrationSettings).where(eq(integrationSettings.id, "ldap")).limit(1);
    const item = rows[0];
    return Response.json({
      smtp: item ? {
        smtpHost: item.smtpHost || "",
        smtpPort: item.smtpPort || (item.smtpSecure ? 465 : 25),
        smtpSecure: Boolean(item.smtpSecure),
        smtpFrom: item.smtpFrom || "",
        smtpUsername: item.smtpUsername || "",
        secretConfigured: Boolean(item.smtpEncryptedSecret),
      } : null,
      stats: await mailOutboxStats(),
    });
  } catch (error) { return serverError(error, "读取邮件配置失败"); }
}

export async function PUT(request: Request) {
  try {
    const actor = await requireAdministrator(request);
    const body = await request.json() as { smtpHost?: string; smtpPort?: number; smtpSecure?: boolean; smtpFrom?: string; smtpUsername?: string; secret?: string };
    const db = getDb();
    const now = new Date().toISOString();
    const host = body.smtpHost?.trim() || "";
    const from = body.smtpFrom?.trim() || "";
    const current = (await db.select().from(integrationSettings).where(eq(integrationSettings.id, "ldap")).limit(1))[0];
    // 整段清空 = 停用邮件通知（队列保留，配置后自动继续发送）
    if (!host && !from && body.secret === undefined && body.smtpUsername === undefined && body.smtpPort === undefined && body.smtpSecure === undefined) {
      if (!current) throw new Error("尚未配置邮件通知");
      await db.update(integrationSettings).set({ smtpHost: null, smtpPort: null, smtpSecure: false, smtpFrom: null, smtpUsername: null, updatedAt: now }).where(eq(integrationSettings.id, "ldap"));
      await appendAudit(actor, "停用邮件通知", "MAIL", "SUCCESS");
      return Response.json({ ok: true, disabled: true });
    }
    if (!host) throw new Error("请填写 SMTP 服务器地址");
    if (!from || !from.includes("@")) throw new Error("请填写有效的发件人地址");
    const secure = Boolean(body.smtpSecure);
    const port = Math.min(Math.max(Number(body.smtpPort) || (secure ? 465 : 25), 1), 65535);
    const username = body.smtpUsername?.trim() || "";
    if (username && !body.secret && !(current?.smtpEncryptedSecret)) throw new Error("填写了认证帐号时需要同时填写密码（或先保存过密码）");
    const encryptedSecret = body.secret ? await encrypt(body.secret) : current?.smtpEncryptedSecret || null;
    const row = {
      id: "ldap",
      smtpHost: host,
      smtpPort: port,
      smtpSecure: secure,
      smtpFrom: from,
      smtpUsername: username || null,
      smtpEncryptedSecret: encryptedSecret,
      updatedAt: now,
    };
    // SMTP 字段与 LDAP 认证源同表同行：只更新 smtp_* 列，绝不动 LDAP 字段
    if (current) {
      await db.update(integrationSettings).set(row).where(eq(integrationSettings.id, "ldap"));
    } else {
      await db.insert(integrationSettings).values(row);
    }
    await appendAudit(actor, "更新邮件通知配置", "MAIL", `SUCCESS`, JSON.stringify({ host, port, secure, from, auth: Boolean(username && encryptedSecret) }));
    return Response.json({ ok: true, secretConfigured: Boolean(encryptedSecret) });
  } catch (error) { return serverError(error, "保存邮件配置失败"); }
}

// 管理员测试发送：直接走 SMTP 事务（不走队列），失败原样返回错误信息便于排查。
// body.to 缺省发给发件人自己。
export async function POST(request: Request) {
  try {
    await requireAdministrator(request);
    const body = await request.json().catch(() => ({})) as { to?: string };
    const config = await getSmtpConfig();
    if (!config) throw new Error("尚未配置 SMTP 服务器，请先保存配置");
    const to = body.to?.trim() || config.from;
    if (!to.includes("@")) throw new Error("测试收件地址无效");
    const started = Date.now();
    await smtpDeliver(config, {
      to: [to],
      subject: "【文件安全收发平台】测试邮件",
      body: `这是一封测试邮件，用于验证平台的内网 SMTP 发信配置。\n\n服务器：${config.host}:${config.port}（${config.secure ? "隐式 TLS" : "STARTTLS/明文"}）\n时间：${new Date().toISOString()}\n\n收到此邮件说明邮件通知配置可用。`,
    });
    // 顺手把积压队列清一遍（管理员往往是在修完配置后点测试）
    const backlog = await processMailOutbox().catch(() => null);
    return Response.json({ ok: true, to, elapsedMs: Date.now() - started, backlogDispatched: backlog?.sent ?? 0 });
  } catch (error) { return serverError(error, "测试邮件发送失败"); }
}
