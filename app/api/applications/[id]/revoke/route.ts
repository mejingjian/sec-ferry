import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { applications, applicationRecipients, downloadDeliveries } from "@/db/schema";
import { APPLICATION_STATUS, appendAudit, canApprove, jsonError, roleFor, revokeDeliveries, serverError } from "@/lib/server";

// POST /api/applications/{id}/revoke
// 撤回送达：使全部未撤回的送达记录失效（收件人立即无法再下载），并写下载事件与审计。
// 撤回是独立的业务动作，不改变发送单的审批状态（TRANSFERRED 保留）。
// 权限：发送方本人（「发送方可随时撤回」）、管理员/审批人，以及被规则指派的审批人；
// 审计员只读，不参与撤回。
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const identity = await roleFor(request);
    if (identity.role === "未登录" || !identity.actor) return jsonError("请先登录", 401);
    const actor = identity.actor;
    const db = getDb();
    const rows = await db.select().from(applications).where(eq(applications.id, id)).limit(1);
    const application = rows[0];
    if (!application) return jsonError("发送单不存在", 404);

    const isOwner = actor.id === application.requesterId;
    const isManager = identity.role === "管理员" || identity.role === "审批人";
    const isAssigned = canApprove(application.assignedApprovers, actor.email, identity.role);
    if (!isOwner && !isManager && !isAssigned) return jsonError("FORBIDDEN: 只有发送方或审批人可以撤回送达", 403);
    if (application.status !== APPLICATION_STATUS.TRANSFERRED) return jsonError("仅已送达的发送单可以撤回", 409);

    const active = await db.select().from(downloadDeliveries).where(eq(downloadDeliveries.applicationId, id));
    if (!active.some((delivery) => delivery.enabled && !delivery.revokedAt)) return jsonError("该发送单没有可撤回的送达记录", 409);

    const { revoked, revokedAt } = await revokeDeliveries(id, request);
    await appendAudit(actor, "撤回送达", id, "REVOKED", JSON.stringify({
      recipients: (await db.select().from(applicationRecipients).where(eq(applicationRecipients.applicationId, id))).map((item) => item.email),
      revoked,
      revokedAt,
      revokedBy: actor.email || actor.display,
    }));
    return Response.json({ ok: true, revoked, revokedAt });
  } catch (error) {
    return serverError(error, "撤回送达失败");
  }
}
