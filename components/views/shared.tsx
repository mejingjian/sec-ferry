"use client"

import { Badge } from "@/components/ui/badge"
import { BookOpenCheck, FileArchive, Gavel, Inbox, LayoutDashboard, Network, SlidersHorizontal, UploadCloud } from "lucide-react"

export type View = "dashboard" | "inbox" | "submit" | "applications" | "approvals" | "rules" | "audit" | "ldap"
// 与 lib/server.ts 的 APPLICATION_STATUS 保持一致的英文状态机枚举
export type Status = "PENDING_APPROVAL" | "APPROVED" | "TRANSFERRING" | "TRANSFERRED" | "TRANSFER_FAILED" | "REJECTED" | "REJECTED_BY_RULE"
// 送达记录：一个收件人一条（站内闭环，收件人登录后经 /api/files 下载）
export type DeliveryRecord = { id: string; recipientEmail?: string | null; recipientName?: string | null; enabled: boolean; downloadCount: number; firstDownloadedAt?: string | null; lastDownloadedAt?: string | null; revokedAt?: string | null }
// 发送单的完整收件人名单（来自 application_recipients，每人一条）
export type ApplicationRecipientItem = { email: string; name: string; department?: string | null }
export type Application = { id: string; fileName: string; size: string; sizeBytes: number; requester: string; requesterEmail?: string | null; department: string; recipient: string; recipients?: ApplicationRecipientItem[]; status: Status; rule: string; createdAt: string; reason?: string; approver?: string; detail?: string; sha256?: string | null; updatedAt?: string; deliveries?: DeliveryRecord[]; typeMismatch?: boolean; detectedKind?: string | null; extension?: string }
export type AuditEvent = { id: string; at: string; actor: string; action: string; object: string; result: string; hash: string; detail?: string }
export type RuleItem = { id: string; name: string; condition: string; action: string; scope: string; enabled: boolean; extensions?: string[]; minSizeBytes?: number; maxSizeBytes?: number; approverEmails?: string[]; priority?: number }
export type LdapUser = { email: string; displayName: string; department: string; title?: string; role?: string; active: boolean }
export type SyncRun = { id: string; status: string; summary: string; startedAt: string; completedAt?: string }
export type DownloadEvent = { id: string; deliveryId?: string | null; applicationId: string; event: string; ip?: string | null; userAgent?: string | null; result: string; reason?: string | null; createdAt: string }
export type ApplicationRecipient = { id: string; applicationId: string; email: string; name: string; department?: string | null; createdAt: string }
export type BootstrapData = {
  applications: ApplicationRaw[]
  audit: AuditEventRaw[]
  rules: RuleRaw[]
  ldapUsers?: LdapUser[]
  syncRuns?: SyncRun[]
  downloadEvents?: DownloadEvent[]
  applicationRecipients?: ApplicationRecipient[]
  currentUser?: { displayName: string; email: string | null; role: string }
}
export type ApplicationRaw = { id: string; fileName: string; sizeBytes: number; requesterName: string; requesterEmail?: string | null; department: string; recipientName: string; status: Status; ruleId: string; ruleName: string; createdAt: string; decisionReason?: string | null; detail?: string; approverDisplay?: string; approverEmail?: string | null; description?: string; sha256?: string | null; updatedAt?: string; extension?: string; deliveries?: DeliveryRecord[]; detectedKind?: string | null; detectedExtensions?: string | null; typeMismatch?: boolean | null }
export type AuditEventRaw = { id: string; at: string; actorDisplay: string; action: string; objectId: string; result: string; hash: string; detail?: string }
export type RuleRaw = { id: string; name: string; action: string; scope: string; enabled: boolean; extensions?: string[] | string | null; minSizeBytes?: number; maxSizeBytes?: number; approverEmails?: string[] | string | null; priority?: number }
export type ApiError = { error?: string }

// 规则大小区间的人类可读展示（与后端 formatSize 口径一致：小数位按数值大小自适应）
export function describeSize(bytes?: number): string {
  const trim = (value: number, unit: string) => `${value.toFixed(value < 10 ? 1 : 0).replace(/\.0$/, "")} ${unit}`
  if (!bytes) return "0 B"
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return trim(bytes / 1024, "KB")
  return trim(bytes / 1024 / 1024, "MB")
}

export const navItems = [
  { id: "dashboard" as View, label: "工作台", icon: LayoutDashboard },
  { id: "inbox" as View, label: "收件箱", icon: Inbox, badge: true },
  { id: "submit" as View, label: "文件发送", icon: UploadCloud },
  { id: "applications" as View, label: "发送记录", icon: FileArchive },
  { id: "approvals" as View, label: "待我审批", icon: Gavel, badge: true },
]
export const adminItems = [
  { id: "rules" as View, label: "审批规则", icon: SlidersHorizontal },
  { id: "audit" as View, label: "审计台账", icon: BookOpenCheck },
  { id: "ldap" as View, label: "LDAP 与权限", icon: Network },
]
export const STATUS_LABEL: Record<Status, string> = {
  PENDING_APPROVAL: "待审批", APPROVED: "已通过", TRANSFERRING: "送达中",
  TRANSFERRED: "已送达", TRANSFER_FAILED: "送达失败", REJECTED: "已驳回", REJECTED_BY_RULE: "已拒绝",
}
// 下载事件类型（站内闭环：下载与撤回均由平台本地写入）
export const DOWNLOAD_EVENT_LABEL: Record<string, string> = {
  DOWNLOAD_INTERNAL: "站内下载", DOWNLOAD: "下载", UPLOAD: "上传交付", REVOKE: "撤回送达", EXPIRE: "链接过期",
}
export const statusStyle: Record<Status, string> = {
  PENDING_APPROVAL: "border-amber-200 bg-amber-50 text-amber-700", TRANSFERRED: "border-emerald-200 bg-emerald-50 text-emerald-700",
  APPROVED: "border-cyan-200 bg-cyan-50 text-cyan-700", TRANSFERRING: "border-blue-200 bg-blue-50 text-blue-700",
  REJECTED_BY_RULE: "border-rose-200 bg-rose-50 text-rose-700", REJECTED: "border-orange-200 bg-orange-50 text-orange-700",
  TRANSFER_FAILED: "border-red-200 bg-red-50 text-red-700",
}
export const ruleActionStyle: Record<string, string> = {
  "拒绝": "border-rose-200 bg-rose-50 text-rose-700",
  "自动通过": "border-emerald-200 bg-emerald-50 text-emerald-700",
  "转人工审批": "border-amber-200 bg-amber-50 text-amber-700",
}

// ---------- 收件箱口径 ----------
// 收件人在收件箱里看到的状态：待送达（尚未通过审批）/ 未读 / 已下载 / 已撤回。
// 「已读」不单独建表：收件人只有下载这一个真实动作，因此以首/末次下载时间作为读取凭据，
// 与 download_deliveries 的留痕字段一一对应，避免多一份可能与交付状态漂移的读状态。
export type InboxState = "待送达" | "未读" | "已下载" | "已撤回"
export const inboxStateStyle: Record<InboxState, string> = {
  "待送达": "border-blue-200 bg-blue-50 text-blue-700",
  "未读": "border-amber-200 bg-amber-50 text-amber-700",
  "已下载": "border-emerald-200 bg-emerald-50 text-emerald-700",
  "已撤回": "border-slate-200 bg-slate-50 text-slate-500",
}
export function inboxState(delivery: DeliveryRecord | undefined, status: Status): InboxState {
  if (!delivery) return "待送达"
  if (!delivery.enabled || delivery.revokedAt) return "已撤回"
  if (delivery.firstDownloadedAt) return "已下载"
  return status === "TRANSFERRED" ? "未读" : "待送达"
}
// 收件人展示口径：优先用 application_recipients 完整名单，回退到送达记录与旧字段（归档记录只有 recipient）
export function recipientNames(item: Application): string[] {
  const fromRecipients = (item.recipients || []).map((recipient) => recipient.name || recipient.email).filter(Boolean)
  if (fromRecipients.length) return fromRecipients
  const fromDeliveries = (item.deliveries || []).map((delivery) => delivery.recipientName || delivery.recipientEmail || "").filter(Boolean)
  if (fromDeliveries.length) return fromDeliveries
  return item.recipient ? [item.recipient] : []
}
export function recipientSummary(item: Application, limit = 3): string {
  const names = recipientNames(item)
  if (!names.length) return "—"
  return names.length > limit ? `${names.slice(0, limit).join("、")} 等 ${names.length} 人` : names.join("、")
}

export function SectionTitle({ eyebrow, title, description, actions }: { eyebrow: string; title: string; description: string; actions?: React.ReactNode }) {
  return <div className="flex flex-col gap-4 border-b border-slate-200 pb-6 sm:flex-row sm:items-end sm:justify-between"><div><p className="mb-2 text-xs font-semibold uppercase tracking-[.14em] text-cyan-700">{eyebrow}</p><h1 className="text-2xl font-semibold tracking-tight text-slate-950 sm:text-[2rem]">{title}</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500">{description}</p></div>{actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}</div>
}
export function StatusBadge({ status }: { status: Status }) { return <Badge variant="outline" className={statusStyle[status]}>{STATUS_LABEL[status]}</Badge> }

export function Metric({ label,value,success=false }:{label:string;value:string;success?:boolean}) { return <div className="rounded-2xl border border-slate-200 bg-white p-5"><p className="text-sm text-slate-500">{label}</p><p className={`mt-2 text-xl font-semibold ${success?"text-emerald-700":""}`}>{value}</p></div> }
