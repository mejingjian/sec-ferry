import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { applications } from "@/db/schema";
import { APPLICATION_STATUS, appendAudit, canApprove, jsonError, roleFor, runDeliveryPipeline, serverError } from "@/lib/server";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const body = await request.json() as { decision?: "approve" | "reject"; reason?: string };
    if (!body.decision || !["approve", "reject"].includes(body.decision)) return jsonError("审批动作无效");
    if (body.decision === "reject" && !body.reason?.trim()) return jsonError("驳回必须填写理由");
    const db = getDb();
    const current = await db.select().from(applications).where(eq(applications.id, id)).limit(1);
    if (!current[0]) return jsonError("申请不存在", 404);
    if (current[0].status !== APPLICATION_STATUS.PENDING_APPROVAL) return jsonError("该申请已处理，不能重复审批", 409);

    const identity = await roleFor(request);
    if (identity.role === "未登录" || !identity.actor) return jsonError("请先登录", 401);
    // 发起人回避：普通审批人/被指派人不能审批自己提交的发送单（职责分离）；管理员权限完全放开，不受此限
    const isSelf = current[0].requesterEmail && identity.actor.email
      && current[0].requesterEmail.toLowerCase() === identity.actor.email.toLowerCase();
    if (isSelf && identity.role !== "管理员") {
      return jsonError("不能审批自己提交的发送单，请由其他审批人或管理员处理", 403);
    }
    // 指定审批人校验：规则/管理员指派了审批人时，仅被指派审批人或管理员可处理；未指派时仅管理员兜底
    if (!canApprove(current[0].assignedApprovers, identity.actor.email, identity.role)) return jsonError("FORBIDDEN: 您不是该申请的指定审批人", 403);
    const actor = identity.actor;

    const now = new Date().toISOString();
    if (body.decision === "reject") {
      await db.update(applications).set({ status: APPLICATION_STATUS.REJECTED, decisionReason: body.reason!.trim(), approverId: actor.id, approverEmail: actor.email, updatedAt: now }).where(eq(applications.id, id));
      await appendAudit(actor, "审批驳回", id, APPLICATION_STATUS.REJECTED, JSON.stringify({ approver: actor.email || actor.display, reason: body.reason!.trim() }));
      return Response.json({ ...current[0], status: APPLICATION_STATUS.REJECTED, decisionReason: body.reason!.trim(), approverEmail: actor.email, updatedAt: now });
    }

    // 审批通过：先置 APPROVED 记录审批动作，再进入统一送达 pipeline（审批与送达是两个独立业务动作）
    await db.update(applications).set({ status: APPLICATION_STATUS.APPROVED, approverId: actor.id, approverEmail: actor.email, updatedAt: now }).where(eq(applications.id, id));
    await appendAudit(actor, "审批通过", id, APPLICATION_STATUS.APPROVED, JSON.stringify({ approver: actor.email || actor.display }));
    const pipeline = await runDeliveryPipeline(current[0], actor, { trigger: "审批通过后送达" });
    return Response.json({ ...current[0], status: pipeline.status, decisionReason: pipeline.message, approverEmail: actor.email, updatedAt: new Date().toISOString() });
  } catch (error) {
    return serverError(error, "审批失败");
  }
}
