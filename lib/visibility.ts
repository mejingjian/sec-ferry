import { parseApproverEmails, type PlatformRole } from "@/lib/server";

// 申请可见性的唯一实现：/api/applications 与 /api/bootstrap 共用，
// 避免两处各写一套过滤逻辑导致口径漂移（历史上审批人「待我审批」为空的根因）。
export function canSeeAllApplications(role: PlatformRole | "未登录"): boolean {
  return role === "管理员" || role === "审批人" || role === "审计员";
}

type ApplicationVisibilityFields = { id: string; requesterId: string; assignedApprovers: string | null };

// receivedApplicationIds：当前用户作为站内收件人（application_recipients.email）命中的发送单集合。
// 口径：管理员/审批人/审计员见全部；发起人见「本人提交 + 被规则指定为审批人 + 发给我的」。
export function visibleApplications<T extends ApplicationVisibilityFields>(
  rows: T[],
  actor: { id: string; email: string | null },
  role: PlatformRole | "未登录",
  receivedApplicationIds?: Set<string>,
): T[] {
  if (canSeeAllApplications(role)) return rows;
  const email = actor.email?.toLowerCase() || "";
  return rows.filter((row) =>
    row.requesterId === actor.id
    || receivedApplicationIds?.has(row.id)
    || (email !== "" && parseApproverEmails(row.assignedApprovers).includes(email)),
  );
}
