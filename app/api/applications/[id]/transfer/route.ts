import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { applications } from "@/db/schema";
import { appendAudit, jsonError, requireApprover, runDeliveryPipeline, serverError } from "@/lib/server";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const actor = await requireApprover(request);
    const db = getDb();
    const rows = await db.select().from(applications).where(eq(applications.id, id)).limit(1);
    const item = rows[0];
    if (!item) return jsonError("发送单不存在", 404);
    if (!item.objectKey || !item.sha256) return jsonError("发送单缺少可送达文件", 409);
    if (!["APPROVED", "TRANSFER_FAILED"].includes(item.status)) return jsonError("当前状态不能执行送达", 409);
    const result = await runDeliveryPipeline(item, actor, { trigger: "重试送达" });
    if (result.status === "APPROVED") return jsonError(result.message, 503);
    const delivered = result.status === "TRANSFERRED";
    await appendAudit(actor, "执行送达", id, result.message);
    return Response.json({ status: result.status, message: result.message, recipientCount: result.recipientCount ?? null }, { status: delivered ? 200 : 502 });
  } catch (error) {
    return serverError(error, "执行送达失败");
  }
}
