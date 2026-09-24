import { getDb } from "@/db";
import { rules } from "@/db/schema";
import { appendAudit, jsonError, normalizeExtension, parseApproverEmails, parseListField, requireAdministrator, serverError } from "@/lib/server";

// 规则行出库统一转数组，保证 API 契约一致（前端类型声明即 string[]）
function serializeRule(row: typeof rules.$inferSelect) {
  return { ...row, extensions: parseListField(row.extensions).map(normalizeExtension), approverEmails: parseListField(row.approverEmails) };
}

export async function GET(request: Request) {
  try {
    await requireAdministrator(request);
    const rows = await getDb().select().from(rules).orderBy(rules.priority);
    return Response.json(rows.map(serializeRule));
  } catch (error) {
    return serverError(error, "读取规则失败");
  }
}

export async function POST(request: Request) {
  try {
    const actor = await requireAdministrator(request);
    const body = await request.json() as {
      name?: string; extensions?: string; minSizeBytes?: number | null; maxSizeBytes?: number | null;
      action?: string; scope?: string; approverEmails?: string; priority?: number; enabled?: boolean;
    };
    const name = body.name?.trim();
    if (!name) throw new Error("规则名称不能为空");
    const rawExtensions = Array.isArray(body.extensions) ? body.extensions.join(",") : (body.extensions || "");
    const extensions = rawExtensions.split(",").map((value) => normalizeExtension(value)).filter(Boolean);
    if (!extensions.length) throw new Error("至少填写一个文件扩展名");
    if (!["拒绝", "自动通过", "转人工审批"].includes(body.action || "")) throw new Error("动作必须是：拒绝 / 自动通过 / 转人工审批");
    const scope = body.scope?.trim() || "全员";
    const approverEmails = parseApproverEmails(typeof body.approverEmails === "string" ? body.approverEmails : "").join(",") || null;
    const minSizeBytes = body.minSizeBytes == null ? null : Math.max(0, Number(body.minSizeBytes));
    const maxSizeBytes = body.maxSizeBytes == null ? null : Math.max(0, Number(body.maxSizeBytes));
    if (minSizeBytes !== null && maxSizeBytes !== null && minSizeBytes > maxSizeBytes) throw new Error("最小大小不能大于最大大小");
    const db = getDb();
    const maxRow = await db.select().from(rules).orderBy(rules.priority).limit(1);
    const nextPriority = maxRow.length ? maxRow[maxRow.length - 1].priority + 1 : 1;
    const now = new Date().toISOString();
    const row = {
      id: `R-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      priority: Number.isFinite(Number(body.priority)) ? Math.max(1, Math.floor(Number(body.priority))) : nextPriority,
      name,
      extensions: extensions.join(","),
      minSizeBytes,
      maxSizeBytes,
      action: body.action!,
      scope,
      approverEmails,
      enabled: body.enabled !== false,
      createdAt: now,
      updatedAt: now,
    };
    await db.insert(rules).values(row);
    await appendAudit(actor, "新增规则", row.id, "成功", JSON.stringify({ name, extensions: extensions.join(","), action: row.action, scope, priority: row.priority }));
    // 返回与 GET 一致的数组契约
    return Response.json(serializeRule(row));
  } catch (error) {
    return serverError(error, "新增规则失败");
  }
}

export async function OPTIONS() {
  return jsonError("Method Not Allowed", 405);
}
