import { and, desc, eq, like, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { auditEvents } from "@/db/schema";
import { requireAuditor, serverError } from "@/lib/server";

function csv(value: unknown) { return `"${String(value ?? "").replaceAll('"', '""')}"`; }

export async function GET(request: Request) {
  try {
    await requireAuditor(request);
    const url = new URL(request.url);
    const action = url.searchParams.get("action")?.trim();
    const actor = url.searchParams.get("actor")?.trim();
    const objectId = url.searchParams.get("object")?.trim();
    const result = url.searchParams.get("result")?.trim();
    const keyword = url.searchParams.get("keyword")?.trim() || url.searchParams.get("q")?.trim();
    const limit = Math.min(10000, Math.max(1, Number(url.searchParams.get("limit")) || 5000));

    const conditions = [];
    if (action) conditions.push(eq(auditEvents.action, action));
    if (actor) conditions.push(like(auditEvents.actorDisplay, `%${actor}%`));
    if (objectId) conditions.push(like(auditEvents.objectId, `%${objectId}%`));
    if (result) conditions.push(like(auditEvents.result, `%${result}%`));
    if (keyword) conditions.push(or(like(auditEvents.detail, `%${keyword}%`), like(auditEvents.result, `%${keyword}%`), like(auditEvents.objectId, `%${keyword}%`)));

    const events = conditions.length
      ? await getDb().select().from(auditEvents).where(and(...conditions)).orderBy(desc(sql`rowid`)).limit(limit)
      : await getDb().select().from(auditEvents).orderBy(desc(sql`rowid`)).limit(limit);

    const lines = [
      ["时间", "操作者", "动作", "对象", "结果", "详情", "前序哈希", "当前哈希"].map(csv).join(","),
      ...events.map((event) => [event.at, event.actorDisplay, event.action, event.objectId, event.result, event.detail ?? "", event.previousHash ?? "", event.hash].map(csv).join(",")),
    ];
    return new Response(`\uFEFF${lines.join("\r\n")}`, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="audit-${new Date().toISOString().slice(0, 10)}.csv"` } });
  } catch (error) {
    return serverError(error, "审计导出失败");
  }
}
