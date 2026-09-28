import { env } from "@/lib/env";
import { and, desc, eq, isNotNull, lt, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { applications, applicationRecipients, auditEvents, downloadDeliveries, downloadEvents, roleAssignments, rules } from "@/db/schema";
import { auditHash } from "@/db/audit-chain.mjs";
import { readSession } from "@/lib/session";
import { createFileBucket, type FileBucket } from "@/lib/storage";
import { dispatchMailOutbox, notifyDelivered } from "@/lib/mail";

export type Actor = { id: string; email: string | null; display: string };

export async function actorFrom(request: Request): Promise<Actor | null> {
  const oaiEmail = request.headers.get("oai-authenticated-user-email");
  const oaiId = request.headers.get("oai-authenticated-user-id");
  if (oaiId || oaiEmail) {
    const email = oaiEmail || null;
    const id = oaiId || email || "local-user";
    return { id, email, display: email?.split("@")[0] || "当前用户" };
  }
  const session = await readSession(request);
  if (session) {
    if (session.local) return { id: "local-user", email: null, display: session.displayName || "本地管理员" };
    return { id: session.email || "session-user", email: session.email, display: session.displayName || session.email?.split("@")[0] || "当前用户" };
  }
  return null;
}

export type PlatformRole = "管理员" | "审批人" | "审计员" | "发起人";

function configuredEmails(value?: string) {
  return (value || "").split(",").map((email) => email.trim().toLowerCase()).filter(Boolean);
}

export async function roleFor(request: Request): Promise<{ actor: Actor | null; role: PlatformRole | "未登录" }> {
  const actor = await actorFrom(request);
  if (!actor) return { actor: null, role: "未登录" };
  if (actor.id === "local-user" && !env.PLATFORM_ADMIN_EMAILS) return { actor, role: "管理员" };
  const email = actor.email?.toLowerCase() || "";
  if (configuredEmails(env.PLATFORM_ADMIN_EMAILS).includes(email)) return { actor, role: "管理员" };
  if (email) {
    const assigned = await getDb().select().from(roleAssignments).where(eq(roleAssignments.email, email)).limit(1);
    if (assigned[0]) return { actor, role: assigned[0].role as PlatformRole };
  }
  if (configuredEmails(env.PLATFORM_APPROVER_EMAILS).includes(email)) return { actor, role: "审批人" };
  if (configuredEmails(env.PLATFORM_AUDITOR_EMAILS).includes(email)) return { actor, role: "审计员" };
  return { actor, role: "发起人" };
}

async function ensureAuthenticated(request: Request) {
  const identity = await roleFor(request);
  if (identity.role === "未登录") throw new Error("UNAUTHORIZED: 请先登录");
  return identity as { actor: Actor; role: PlatformRole };
}

export async function requireAdministrator(request: Request) {
  const identity = await ensureAuthenticated(request);
  if (identity.role !== "管理员") throw new Error("FORBIDDEN: 当前账号没有管理权限");
  return identity.actor;
}

export async function requireApprover(request: Request) {
  const identity = await ensureAuthenticated(request);
  if (!["管理员", "审批人"].includes(identity.role)) throw new Error("FORBIDDEN: 当前账号没有审批权限");
  return identity.actor;
}

export async function requireAuditor(request: Request) {
  const identity = await ensureAuthenticated(request);
  if (!["管理员", "审计员"].includes(identity.role)) throw new Error("FORBIDDEN: 当前账号没有审计权限");
  return identity.actor;
}

export function serverError(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : fallback;
  if (message.startsWith("UNAUTHORIZED:")) return jsonError(message.slice(13).trim(), 401);
  if (message.startsWith("FORBIDDEN:")) return jsonError(message.slice(10).trim(), 403);
  return jsonError(message, 500);
}

export function jsonError(message: string, status = 400) {
  return Response.json({ error: message }, { status });
}

export async function appendAudit(actor: Actor, action: string, objectId: string, result: string, detail?: string) {
  const db = getDb();
  // 使用 SQLite rowid 保证并发写入时也能按物理插入顺序取到真正的最后一条，维持哈希链连续。
  const previous = await db.select().from(auditEvents).orderBy(desc(sql`rowid`)).limit(1);
  const at = new Date().toISOString();
  const previousHash = previous[0]?.hash ?? null;
  // 载荷拼接与 hash 计算见 db/audit-chain.mjs —— 运维 CLI（reset-admin / rekey）写审计时
  // 必须用同一份实现，否则链会从那条开始断掉。（此前这段拼接只存在于这里。）
  const hash = await auditHash({ previousHash, at, actorId: actor.id, action, objectId, result, detail });
  await db.insert(auditEvents).values({ id: crypto.randomUUID(), at, actorId: actor.id, actorEmail: actor.email, actorDisplay: actor.display, action, objectId, result, detail, previousHash, hash });
  return hash;
}

// 人类可读的文件大小，用于「未命中原因」等面向使用者的提示
export function formatSize(bytes: number): string {
  const trim = (value: number, unit: string) => `${value.toFixed(value < 10 ? 1 : 0).replace(/\.0$/, "")} ${unit}`;
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return trim(bytes / 1024, "KB");
  if (bytes < 1024 * 1024 * 1024) return trim(bytes / 1024 / 1024, "MB");
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// 近似命中但被条件排除的规则，用于解释「为什么转人工」
export type RuleSkipDiagnostic = { ruleId: string; ruleName: string; reason: string };
export type RuleDecision = { id: string; name: string; action: string; approverEmails: string | null };
export type RuleEvaluation = { rule: RuleDecision; skipped: RuleSkipDiagnostic[]; fallbackReason: string | null };

export const FALLBACK_RULE: RuleDecision = { id: "R-FALLBACK", name: "未命中规则兜底", action: "转人工审批", approverEmails: null };

// 带诊断信息的规则判定：除返回命中规则外，还给出「后缀覆盖但被大小/部门条件排除」的规则清单，
// 便于提交页与申请详情直接展示未命中原因（避免使用者只看到「未命中规则兜底」而无从排查）。
// 动作严重度：多后缀（声明 ∪ 嗅探）判定冲突时取更严格者（内容防伪装的从严合并底线）
export const ACTION_SEVERITY: Record<string, number> = { "拒绝": 3, "转人工审批": 2, "自动通过": 1 };

// 单一后缀的判定本体
async function evaluateSingleExtension(extension: string, sizeBytes: number, department?: string | null): Promise<RuleEvaluation> {
  const db = getDb();
  const active = await db.select().from(rules).where(eq(rules.enabled, true)).orderBy(rules.priority);
  const skipped: RuleSkipDiagnostic[] = [];
  for (const rule of active) {
    const extensions = rule.extensions.split(",").map((value) => normalizeExtension(value)).filter(Boolean);
    // 后缀不覆盖的规则不属于「近似命中」，不写入诊断，避免噪音
    if (extensions.length && !extensions.includes(extension)) continue;
    if (rule.minSizeBytes !== null && sizeBytes < rule.minSizeBytes) {
      skipped.push({ ruleId: rule.id, ruleName: rule.name, reason: `文件大小 ${formatSize(sizeBytes)} 小于规则要求的最小 ${formatSize(rule.minSizeBytes)}` });
      continue;
    }
    if (rule.maxSizeBytes !== null && sizeBytes > rule.maxSizeBytes) {
      skipped.push({ ruleId: rule.id, ruleName: rule.name, reason: `文件大小 ${formatSize(sizeBytes)} 超过规则允许的最大 ${formatSize(rule.maxSizeBytes)}` });
      continue;
    }
    if (!scopeMatches(rule.scope, department)) {
      skipped.push({ ruleId: rule.id, ruleName: rule.name, reason: `发起人部门「${department || "未同步"}」不在规则适用范围（${rule.scope}）` });
      continue;
    }
    return { rule, skipped, fallbackReason: null };
  }
  const suffix = extension ? `.${extension}` : "无后缀文件";
  let fallbackReason: string;
  if (!active.length) fallbackReason = "当前没有启用中的审批规则，按兜底策略转人工审批";
  else if (skipped.length) fallbackReason = `${suffix} 命中 ${skipped.length} 条规则的后缀条件，但均被大小/部门条件排除：${skipped.map((item) => `${item.ruleName}（${item.reason}）`).join("；")}`;
  else fallbackReason = `没有启用中的规则覆盖 ${suffix} 后缀，按兜底策略转人工审批`;
  return { rule: FALLBACK_RULE, skipped, fallbackReason };
}

// 带诊断信息的规则判定。extension 支持传数组（内容防伪装：声明后缀 ∪ 嗅探后缀），
// 对每个后缀各跑一次判定并取最严格的动作（拒绝 > 转人工审批 > 自动通过），绝不取宽松者。
export async function evaluateFileDetailed(extension: string | string[], sizeBytes: number, department?: string | null): Promise<RuleEvaluation> {
  const candidates = Array.from(new Set((Array.isArray(extension) ? extension : [extension]).map((value) => normalizeExtension(value))));
  if (candidates.length <= 1) return evaluateSingleExtension(candidates[0] ?? "", sizeBytes, department);
  let best: { evaluation: RuleEvaluation; severity: number } | null = null;
  const skipped: RuleSkipDiagnostic[] = [];
  for (const candidate of candidates) {
    const evaluation = await evaluateSingleExtension(candidate, sizeBytes, department);
    skipped.push(...evaluation.skipped);
    const severity = ACTION_SEVERITY[evaluation.rule.action] ?? 0;
    if (!best || severity > best.severity) best = { evaluation, severity };
  }
  return { rule: best!.evaluation.rule, skipped, fallbackReason: best!.evaluation.fallbackReason };
}

export async function evaluateFile(extension: string, sizeBytes: number, department?: string | null): Promise<RuleDecision> {
  return (await evaluateFileDetailed(extension, sizeBytes, department)).rule;
}

function scopeMatches(scope: string, department?: string | null): boolean {
  const normalized = (value: string) => value.trim().toLowerCase();
  const targets = scope.split(",").map(normalized).filter(Boolean);
  if (!targets.length) return true;
  // UI 存储的 scope 枚举：ALL=全员；DEPARTMENT=按部门匹配（发起人有部门即命中）
  if (targets.includes("全员") || targets.includes("*") || targets.includes("all")) return true;
  if (targets.includes("department")) return Boolean(department);
  if (!department) return false;
  const departmentNormalized = normalized(department);
  return targets.some((target) => departmentNormalized.includes(target) || target.includes(departmentNormalized));
}

export function parseApproverEmails(value?: string | null): string[] {
  return (value || "").split(",").map((email) => email.trim().toLowerCase()).filter((email) => email.includes("@"));
}

// DB 中列表字段（extensions/approverEmails 等）以逗号拼接字符串存储，
// 但历史数据/调用方可能传入数组、JSON 数组或含中文顿号的字符串。统一规范化为 string[]。
export function parseListField(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value !== "string") return [];
  const text = value.trim();
  if (!text) return [];
  if (text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (Array.isArray(parsed)) return parsed.map((item) => String(item).trim()).filter(Boolean);
    } catch { /* 非 JSON，按分隔符兜底 */ }
  }
  return text.split(/[,，、;；]/).map((item) => item.trim()).filter(Boolean);
}

// 扩展名规范化：小写、去前导点（用户常输入 ".txt"，规则引擎按不带点的 extension 匹配）
export function normalizeExtension(value: string): string {
  return value.trim().toLowerCase().replace(/^\.+/, "");
}

export function canApprove(applicationApprovers: string | null, actorEmail: string | null, role: PlatformRole): boolean {
  // 管理员与审批人角色可处理所有待审批申请
  if (role === "管理员" || role === "审批人") return true;
  if (!actorEmail) return false;
  // 规则显式指定的审批人：即使平台角色只是发起人，也可审批被指派的申请
  const assigned = parseApproverEmails(applicationApprovers);
  return assigned.length > 0 && assigned.includes(actorEmail.toLowerCase());
}

// 文件存储唯一入口：本地文件系统实现（接口形态对齐 R2，便于将来换回对象存储）。
// 单例，避免每次下载都重建桶对象。
const globalRef = globalThis as unknown as { __transferPlatformBucket?: FileBucket };

export function storage(): FileBucket {
  if (!globalRef.__transferPlatformBucket) globalRef.__transferPlatformBucket = createFileBucket();
  return globalRef.__transferPlatformBucket;
}

// ---------- 站内送达闭环：状态机 ----------
// 0007 起为单平台文件收发：审批通过/规则自动通过后，按站内收件人生成送达记录，
// 收件人登录平台后通过 /api/files/{id}（会话鉴权）下载。不再有匿名外链与跨段网关。
export const APPLICATION_STATUS = {
  PENDING_APPROVAL: "PENDING_APPROVAL",
  APPROVED: "APPROVED",
  TRANSFERRING: "TRANSFERRING",
  TRANSFERRED: "TRANSFERRED",
  TRANSFER_FAILED: "TRANSFER_FAILED",
  REJECTED: "REJECTED",
  REJECTED_BY_RULE: "REJECTED_BY_RULE",
} as const;

export const APPLICATION_STATUS_LABEL: Record<string, string> = {
  PENDING_APPROVAL: "待审批",
  APPROVED: "已通过",
  TRANSFERRING: "送达中",
  TRANSFERRED: "已送达",
  TRANSFER_FAILED: "送达失败",
  REJECTED: "已驳回",
  REJECTED_BY_RULE: "已拒绝",
};

// 统一送达 pipeline：APPROVED → TRANSFERRING → 按收件人写入 download_deliveries → TRANSFERRED。
// 人工批准、规则自动通过、失败重试全部走同一条路径（可重入：已存在的送达记录不重复创建）。
export async function runDeliveryPipeline(application: typeof applications.$inferSelect, actor: Actor, options?: { trigger?: string }): Promise<{ status: string; message: string; recipientCount?: number }> {
  const db = getDb();
  if (!application.objectKey || !application.sha256) {
    await db.update(applications).set({ status: APPLICATION_STATUS.TRANSFER_FAILED, updatedAt: new Date().toISOString(), decisionReason: "发送单缺少隔离区文件，无法送达" }).where(eq(applications.id, application.id));
    await appendAudit(actor, "送达失败", application.id, "TRANSFER_FAILED", JSON.stringify({ reason: "缺少 objectKey/sha256" }));
    return { status: APPLICATION_STATUS.TRANSFER_FAILED, message: "发送单缺少隔离区文件，无法送达" };
  }

  await db.update(applications).set({ status: APPLICATION_STATUS.TRANSFERRING, updatedAt: new Date().toISOString() }).where(eq(applications.id, application.id));
  await appendAudit(actor, options?.trigger || "开始送达", application.id, "TRANSFERRING", JSON.stringify({ fileName: application.fileName, sizeBytes: application.sizeBytes }));

  const recipients = await db.select().from(applicationRecipients).where(eq(applicationRecipients.applicationId, application.id));
  if (!recipients.length) {
    const message = "发送单没有站内收件人，无法送达（新发送单至少需选择一位域账号收件人）";
    await db.update(applications).set({ status: APPLICATION_STATUS.TRANSFER_FAILED, updatedAt: new Date().toISOString(), decisionReason: message }).where(eq(applications.id, application.id));
    await appendAudit(actor, "送达失败", application.id, "TRANSFER_FAILED", JSON.stringify({ reason: "NO_RECIPIENTS" }));
    return { status: APPLICATION_STATUS.TRANSFER_FAILED, message };
  }

  const now = new Date().toISOString();
  for (const recipient of recipients) {
    await db.insert(downloadDeliveries).values({
      id: `DLV-${crypto.randomUUID().slice(0, 12).toUpperCase()}`,
      applicationId: application.id,
      recipientEmail: recipient.email,
      recipientName: recipient.name,
      fileName: application.fileName,
      enabled: true,
      downloadCount: 0,
      createdAt: now,
      firstDownloadedAt: null,
      lastDownloadedAt: null,
      revokedAt: null,
    }).onConflictDoNothing();
  }

  const message = `已向 ${recipients.length} 位收件人送达`;
  await db.update(applications).set({ status: APPLICATION_STATUS.TRANSFERRED, updatedAt: now, decisionReason: message }).where(eq(applications.id, application.id));
  await appendAudit(actor, "送达完成", application.id, "TRANSFERRED", JSON.stringify({ recipients: recipients.map((item) => item.email) }));

  // ⑥ 邮件通知：收件通知（先入队再后台发送，任何异常不影响送达结果）
  try {
    const queued = await notifyDelivered(
      { id: application.id, fileName: application.fileName, sizeBytes: application.sizeBytes, requesterName: application.requesterName, description: application.description },
      recipients.map((item) => ({ email: item.email, name: item.name })),
    );
    if (queued) dispatchMailOutbox();
  } catch { /* 通知失败不影响送达 */ }

  return { status: APPLICATION_STATUS.TRANSFERRED, message, recipientCount: recipients.length };
}

// 撤回送达：使指定发送单的全部未撤回送达记录失效（收件人立即无法再下载），并写入下载事件留痕。
// 站内闭环下撤回是纯本地操作（旧架构需要先调网关再改本地，该链路已随 0007 下线）。
export async function revokeDeliveries(applicationId: string, request: Request): Promise<{ revoked: number; revokedAt: string }> {
  const db = getDb();
  const now = new Date().toISOString();
  const deliveries = await db.select().from(downloadDeliveries).where(and(eq(downloadDeliveries.applicationId, applicationId), eq(downloadDeliveries.enabled, true)));
  for (const delivery of deliveries) {
    await db.update(downloadDeliveries).set({ enabled: false, revokedAt: now }).where(eq(downloadDeliveries.id, delivery.id));
    await db.insert(downloadEvents).values({
      id: crypto.randomUUID(),
      deliveryId: delivery.id,
      applicationId,
      event: "REVOKE",
      ip: request.headers.get("cf-connecting-ip") || null,
      userAgent: (request.headers.get("user-agent") || "").slice(0, 400) || null,
      result: "SUCCESS",
      reason: "REVOKED",
      createdAt: now,
    });
  }
  return { revoked: deliveries.length, revokedAt: now };
}

// 隔离区清理：已拒绝/已驳回文件保留 QUARANTINE_RETENTION_DAYS 天后自动删除并写审计（惰性清理，幂等）。
export async function cleanupExpiredQuarantine(): Promise<{ removed: number; skipped: number }> {
  const db = getDb();
  const retentionDays = Number(env.QUARANTINE_RETENTION_DAYS || 7);
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
  const rows = await db.select().from(applications).where(and(
    isNotNull(applications.objectKey),
    lt(applications.updatedAt, cutoff),
    sql`${applications.status} IN ('REJECTED','REJECTED_BY_RULE')`,
  )).limit(100);
  let removed = 0;
  for (const row of rows) {
    try {
      if (!row.objectKey) continue;
      await storage().delete(row.objectKey);
      await db.update(applications).set({
        objectKey: null,
        updatedAt: new Date().toISOString(),
        decisionReason: (row.decisionReason ? `${row.decisionReason}；` : "") + `隔离区保留 ${retentionDays} 天后已清理`,
      }).where(eq(applications.id, row.id));
      await appendAudit({ id: "SYSTEM", email: null, display: "系统清理任务" }, "隔离区清理", row.id, "DELETED", JSON.stringify({ fileName: row.fileName, objectKey: row.objectKey, retentionDays }));
      removed += 1;
    } catch {
      // 单个文件清理失败不影响其余文件
    }
  }
  return { removed, skipped: rows.length - removed };
}
