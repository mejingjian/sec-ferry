import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { applications, applicationRecipients, downloadDeliveries, downloadEvents } from "@/db/schema";
import { APPLICATION_STATUS, appendAudit, canApprove, jsonError, roleFor, storage } from "@/lib/server";

async function recordInternalDownload(application: { id: string }, result: "SUCCESS" | "DENIED", reason: string | null, request: Request) {
  await getDb().insert(downloadEvents).values({
    id: crypto.randomUUID(),
    deliveryId: null,
    applicationId: application.id,
    event: "DOWNLOAD_INTERNAL",
    ip: request.headers.get("cf-connecting-ip") || null,
    userAgent: (request.headers.get("user-agent") || "").slice(0, 400) || null,
    result,
    reason,
    createdAt: new Date().toISOString(),
  });
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const db = getDb();
    const rows = await db.select().from(applications).where(eq(applications.id, id)).limit(1);
    const application = rows[0];
    if (!application) return jsonError("文件不存在", 404);
    // 下载权限：发起人本人、收件人、管理员、审计员、指定审批人
    const identity = await roleFor(request);
    if (identity.role === "未登录" || !identity.actor) return jsonError("请先登录", 401);
    const actor = identity.actor;
    const objectKey = application.objectKey;
    if (!objectKey) return jsonError("文件不存在", 404);
    const actorEmail = actor.email?.toLowerCase() || "";
    const isOwner = actor.id === application.requesterId;
    const isElevated = ["管理员", "审计员"].includes(identity.role);
    const isAssigned = canApprove(application.assignedApprovers, actor.email, identity.role);
    const deliveryRows = actorEmail !== ""
      ? await db.select().from(downloadDeliveries).where(and(eq(downloadDeliveries.applicationId, id), eq(downloadDeliveries.recipientEmail, actorEmail))).limit(1)
      : [];
    const delivery = deliveryRows[0];
    // 「被指定的收件人」与「已生成送达记录的收件人」是两种状态：审批通过前只有前者。
    // 判因要区分二者，否则本单收件人会被误报成「无权下载」，掩盖真实原因。
    const designated = actorEmail !== "" && (await db.select({ id: applicationRecipients.id }).from(applicationRecipients)
      .where(and(eq(applicationRecipients.applicationId, id), eq(applicationRecipients.email, actorEmail))).limit(1)).length > 0;
    const isRecipient = Boolean(delivery) || designated;
    // 收件人下载必须同时满足：发送单已送达 + 自己的送达记录仍有效（未撤回）。
    // 待审批/已驳回的单子收件人不能提前拿到文件，撤回后也必须立即失效。
    const recipientCanDownload = Boolean(delivery) && application.status === APPLICATION_STATUS.TRANSFERRED && delivery.enabled && !delivery.revokedAt;
    if (!isOwner && !recipientCanDownload && !isElevated && !isAssigned) {
      const reason = isRecipient ? (delivery && (delivery.revokedAt || !delivery.enabled) ? "DELIVERY_REVOKED" : "NOT_DELIVERED") : "FORBIDDEN";
      await appendAudit(actor, "内部下载", id, "DENIED", JSON.stringify({ fileName: application.fileName, applicationId: id, reason }));
      await recordInternalDownload(application, "DENIED", reason, request);
      return jsonError(
        reason === "DELIVERY_REVOKED" ? "FORBIDDEN: 该文件已被发送方撤回，无法下载" : reason === "NOT_DELIVERED" ? "FORBIDDEN: 该文件尚未送达（等待审批通过）" : "FORBIDDEN: 无权下载该文件",
        403,
      );
    }
    const object = await storage().get(objectKey);
    if (!object) {
      await appendAudit(actor, "内部下载", id, "DENIED", JSON.stringify({ fileName: application.fileName, applicationId: id, reason: "FILE_NOT_FOUND" }));
      await recordInternalDownload(application, "DENIED", "FILE_NOT_FOUND", request);
      return jsonError("存储中的文件不存在", 404);
    }
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(application.fileName)}`);
    headers.set("x-content-type-options", "nosniff");
    await appendAudit(actor, "内部下载", id, "SUCCESS", JSON.stringify({ fileName: application.fileName, applicationId: id, reason: "SUCCESS", byRecipient: recipientCanDownload }));
    await recordInternalDownload(application, "SUCCESS", null, request);
    // 收件人下载时更新其送达记录的下载留痕（download_count / 首末次下载时间）
    if (recipientCanDownload) {
      const now = new Date().toISOString();
      await db.update(downloadDeliveries).set({
        downloadCount: sql`${downloadDeliveries.downloadCount} + 1`,
        firstDownloadedAt: sql`COALESCE(${downloadDeliveries.firstDownloadedAt}, ${now})`,
        lastDownloadedAt: now,
      }).where(and(eq(downloadDeliveries.applicationId, id), eq(downloadDeliveries.recipientEmail, actorEmail)));
    }
    return new Response(object.body, { headers });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "文件下载失败", error instanceof Error && error.message.startsWith("FORBIDDEN:") ? 403 : 500);
  }
}
