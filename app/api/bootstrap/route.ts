import { desc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { applications, applicationRecipients, auditEvents, downloadDeliveries, downloadEvents, ldapSyncRuns, ldapUsers, rules } from "@/db/schema";
import { jsonError, normalizeExtension, parseListField, roleFor } from "@/lib/server";
import { visibleApplications } from "@/lib/visibility";
export async function GET(request: Request) {
  try {
    const db = getDb();
    const identity = await roleFor(request);
    if (identity.role === "未登录" || !identity.actor) return jsonError("请先登录", 401);
    const canAudit = ["管理员", "审计员"].includes(identity.role);
    const actor = identity.actor;
    const myEmail = actor.email?.toLowerCase() || "";

    // 可见性口径统一由 lib/visibility.ts 提供，避免与 /api/applications 漂移。
    // 历史外发归档已随 0009 下线，这里只查站内发送单。
    const allApplications = await db.select().from(applications).orderBy(desc(applications.createdAt)).limit(200);
    // 「发给我的」口径：收件人即使只是发起人角色也能看到发给自己的发送单
    const myRecipientRows = myEmail
      ? await db.select().from(applicationRecipients).where(eq(applicationRecipients.email, myEmail))
      : [];
    const mine = new Set(myRecipientRows.map((item) => item.applicationId));
    // 收件箱不能因为「最近 200 条」窗口而漏件：把发给我但不在窗口内的发送单补进来
    const missingIds = Array.from(mine).filter((id) => !allApplications.some((row) => row.id === id));
    const receivedApplications = missingIds.length
      ? await db.select().from(applications).where(inArray(applications.id, missingIds))
      : [];
    const candidateRows = [...allApplications, ...receivedApplications].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    const applicationRows = visibleApplications(candidateRows, actor, identity.role, mine);

    // 送达与收件人明细只按「可见发送单」取：避免把他人发送单的收件人名单返回给普通用户
    const visibleIds = applicationRows.map((row) => row.id);
    const [auditRows, ruleRows, userRows, syncRows, deliveryRows, recipientRows, downloadEventRows] = await Promise.all([
      canAudit ? db.select().from(auditEvents).orderBy(desc(auditEvents.at)).limit(500) : Promise.resolve([]),
      db.select().from(rules).orderBy(rules.priority),
      db.select().from(ldapUsers).where(eq(ldapUsers.active, true)).orderBy(ldapUsers.name).limit(500),
      identity.role === "管理员" ? db.select().from(ldapSyncRuns).orderBy(desc(ldapSyncRuns.startedAt)).limit(20) : Promise.resolve([]),
      visibleIds.length ? db.select().from(downloadDeliveries).where(inArray(downloadDeliveries.applicationId, visibleIds)) : Promise.resolve([]),
      visibleIds.length ? db.select().from(applicationRecipients).where(inArray(applicationRecipients.applicationId, visibleIds)) : Promise.resolve([]),
      canAudit ? db.select().from(downloadEvents).orderBy(desc(downloadEvents.createdAt)).limit(500) : Promise.resolve([]),
    ]);

    // 送达记录：按发送单聚合（每个收件人一条）
    const recipientsByApplication = new Map<string, Array<typeof downloadDeliveries.$inferSelect>>();
    for (const delivery of deliveryRows) {
      const list = recipientsByApplication.get(delivery.applicationId) || [];
      list.push(delivery);
      recipientsByApplication.set(delivery.applicationId, list);
    }
    const shape = (row: typeof applications.$inferSelect) => {
      const deliveries = (recipientsByApplication.get(row.id) || []).map((delivery) => ({
        id: delivery.id,
        recipientEmail: delivery.recipientEmail,
        recipientName: delivery.recipientName,
        enabled: delivery.enabled,
        downloadCount: delivery.downloadCount,
        firstDownloadedAt: delivery.firstDownloadedAt,
        lastDownloadedAt: delivery.lastDownloadedAt,
        revokedAt: delivery.revokedAt,
      }));
      return {
        ...row,
        downloadUrl: null,
        deliveries,
        // 内容防伪装判定依据：供审批页/详情展示「后缀与内容不符」
        detectedKind: row.detectedKind,
        detectedExtensions: row.detectedExtensions,
        typeMismatch: row.typeMismatch,
      };
    };
    return Response.json({
      applications: applicationRows.map(shape),
      audit: auditRows,
      // extensions/approverEmails 在库内为逗号拼接字符串，统一转为数组返回，避免前端对字符串调用 .join 崩溃
      rules: ruleRows.map((row) => ({ ...row, extensions: parseListField(row.extensions).map(normalizeExtension), approverEmails: parseListField(row.approverEmails) })),
      ldapUsers: userRows.map((user) => ({ ...user, displayName: user.name })),
      syncRuns: syncRows,
      applicationRecipients: recipientRows,
      downloadEvents: downloadEventRows,
      currentUser: { displayName: identity.actor.display, email: identity.actor.email, role: identity.role },
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "无法读取平台数据", 500);
  }
}
