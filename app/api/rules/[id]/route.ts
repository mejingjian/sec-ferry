import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { rules } from "@/db/schema";
import { appendAudit, jsonError, normalizeExtension, parseListField, requireAdministrator, serverError } from "@/lib/server";

// 规则行出库统一转数组，保证 API 契约一致（前端类型声明即 string[]）
function serializeRule(row: typeof rules.$inferSelect) {
  return { ...row, extensions: parseListField(row.extensions).map(normalizeExtension), approverEmails: parseListField(row.approverEmails) };
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const actor = await requireAdministrator(request);
    const body = await request.json() as { enabled?: boolean };
    if (typeof body.enabled !== "boolean") return jsonError("规则状态无效");
    const db = getDb();
    const current = await db.select().from(rules).where(eq(rules.id, id)).limit(1);
    if (!current[0]) return jsonError("规则不存在", 404);
    await db.update(rules).set({ enabled: body.enabled, updatedAt: new Date().toISOString() }).where(eq(rules.id, id));
    await appendAudit(actor, "变更审批规则", id, body.enabled ? "已启用" : "已停用");
    return Response.json(serializeRule({ ...current[0], enabled: body.enabled }));
  } catch (error) {
    return serverError(error, "规则更新失败");
  }
}

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const actor = await requireAdministrator(request);
    const body = await request.json() as {
      name?: string; extensions?: string; minSizeBytes?: number | null; maxSizeBytes?: number | null;
      action?: string; scope?: string; approverEmails?: string; priority?: number; enabled?: boolean;
    };
    const db = getDb();
    const current = await db.select().from(rules).where(eq(rules.id, id)).limit(1);
    if (!current[0]) return jsonError("规则不存在", 404);
    const name = body.name?.trim();
    if (!name) throw new Error("规则名称不能为空");
    const rawExtensions = Array.isArray(body.extensions) ? body.extensions.join(",") : (body.extensions || "");
    const extensions = rawExtensions.split(",").map((value) => normalizeExtension(value)).filter(Boolean);
    if (!extensions.length) throw new Error("至少填写一个文件扩展名");
    if (!["拒绝", "自动通过", "转人工审批"].includes(body.action || "")) throw new Error("动作必须是：拒绝 / 自动通过 / 转人工审批");
    const minSizeBytes = body.minSizeBytes == null ? null : Math.max(0, Number(body.minSizeBytes));
    const maxSizeBytes = body.maxSizeBytes == null ? null : Math.max(0, Number(body.maxSizeBytes));
    if (minSizeBytes !== null && maxSizeBytes !== null && minSizeBytes > maxSizeBytes) throw new Error("最小大小不能大于最大大小");
    const rawApproverEmails = Array.isArray(body.approverEmails) ? body.approverEmails.join(",") : (body.approverEmails || "");
    const approverEmails = rawApproverEmails.split(",").map((email) => email.trim().toLowerCase()).filter(Boolean).join(",") || null;
    const updated = {
      name,
      extensions: extensions.join(","),
      minSizeBytes,
      maxSizeBytes,
      action: body.action!,
      scope: body.scope?.trim() || "全员",
      approverEmails,
      priority: Number.isFinite(Number(body.priority)) ? Math.max(1, Math.floor(Number(body.priority))) : current[0].priority,
      enabled: body.enabled !== undefined ? body.enabled : current[0].enabled,
      updatedAt: new Date().toISOString(),
    };
    await db.update(rules).set(updated).where(eq(rules.id, id));
    await appendAudit(actor, "编辑审批规则", id, "成功", JSON.stringify({ before: { name: current[0].name, action: current[0].action, scope: current[0].scope, extensions: current[0].extensions }, after: { name: updated.name, action: updated.action, scope: updated.scope, extensions: updated.extensions } }));
    return Response.json(serializeRule({ ...current[0], ...updated }));
  } catch (error) {
    return serverError(error, "规则编辑失败");
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const actor = await requireAdministrator(request);
    const db = getDb();
    const current = await db.select().from(rules).where(eq(rules.id, id)).limit(1);
    if (!current[0]) return jsonError("规则不存在", 404);
    await db.delete(rules).where(eq(rules.id, id));
    await appendAudit(actor, "删除审批规则", id, "成功", JSON.stringify({ name: current[0].name, action: current[0].action, scope: current[0].scope }));
    return Response.json({ ok: true });
  } catch (error) {
    return serverError(error, "规则删除失败");
  }
}
