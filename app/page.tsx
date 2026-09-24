"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Sidebar, SidebarContent, SidebarFooter, SidebarHeader, SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"
import { Textarea } from "@/components/ui/textarea"
import { ApplicationsView } from "@/components/views/ApplicationsView"
import { ApprovalsView } from "@/components/views/ApprovalsView"
import { AuditView } from "@/components/views/AuditView"
import { Dashboard } from "@/components/views/Dashboard"
import { InboxView, type InboxRow } from "@/components/views/InboxView"
import { LdapView } from "@/components/views/LdapView"
import { NavGroup } from "@/components/views/NavGroup"
import { RulesView } from "@/components/views/RulesView"
import { SubmitView } from "@/components/views/SubmitView"
import { STATUS_LABEL, adminItems, describeSize, inboxState, navItems, type ApiError, type Application, type ApplicationRaw, type ApplicationRecipientItem, type AuditEvent, type BootstrapData, type DownloadEvent, type LdapUser, type RuleItem, type Status, type SyncRun, type View } from "@/components/views/shared"
import { Bell, Check, FileKey2, ShieldCheck, X } from "lucide-react"

export default function Home() {
  const router = useRouter()
  const [view, setView] = useState<View>("dashboard")
  const [applications, setApplications] = useState<Application[]>([])
  const [audit, setAudit] = useState<AuditEvent[]>([])
  const [query, setQuery] = useState("")
  const [statusFilter, setStatusFilter] = useState("全部")
  const [decisionTarget, setDecisionTarget] = useState<Application | null>(null)
  const [decision, setDecision] = useState<"approve" | "reject">("approve")
  const [decisionReason, setDecisionReason] = useState("")
  const [notice, setNotice] = useState("")
  const [role, setRole] = useState("")
  const [currentUser, setCurrentUser] = useState({ displayName: "", email: "", role: "" })
  const [rules, setRules] = useState<RuleItem[]>([])
  const [ldapUsers, setLdapUsers] = useState<LdapUser[]>([])
  const [syncRuns, setSyncRuns] = useState<SyncRun[]>([])
  const [downloadEvents, setDownloadEvents] = useState<DownloadEvent[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const pending = applications.filter((item) => item.status === "PENDING_APPROVAL")
  // 收件箱：「发给我的」发送单 + 我在该单上的送达记录（未送达时记录为空，状态显示待送达）
  const myEmail = currentUser.email.toLowerCase()
  const inboxRows: InboxRow[] = myEmail
    ? applications.flatMap((application) => {
      const delivery = (application.deliveries || []).find((item) => (item.recipientEmail || "").toLowerCase() === myEmail)
      const addressed = Boolean(delivery) || (application.recipients || []).some((recipient) => recipient.email.toLowerCase() === myEmail)
      return addressed ? [{ application, delivery, state: inboxState(delivery, application.status) }] : []
    })
    : []
  const unreadCount = inboxRows.filter((row) => row.state === "未读").length
  const filtered = applications.filter((item) => {
    const matched = [item.id, item.fileName, item.requester, item.recipient, STATUS_LABEL[item.status], item.status, item.rule].join(" ").toLowerCase().includes(query.toLowerCase())
    return matched && (statusFilter === "全部" || item.status === statusFilter)
  })
  function mapApplication(item: ApplicationRaw, recipientsByApp: Map<string, ApplicationRecipientItem[]>): Application {
    const sizeMb = item.sizeBytes / 1024 / 1024
    return { id: item.id, fileName: item.fileName, size: sizeMb >= 1 ? `${sizeMb.toFixed(1)} MB` : `${Math.max(1, Math.round(item.sizeBytes / 1024))} KB`, sizeBytes: item.sizeBytes, requester: item.requesterName, requesterEmail: item.requesterEmail, department: item.department, recipient: item.recipientName, recipients: recipientsByApp.get(item.id) || [], status: item.status, rule: `${item.ruleId} ${item.ruleName}`, createdAt: new Date(item.createdAt).toLocaleString("zh-CN"), reason: item.decisionReason || item.detail || undefined, approver: item.approverDisplay || item.approverEmail || undefined, detail: item.description, sha256: item.sha256 ?? null, updatedAt: item.updatedAt, deliveries: item.deliveries ?? [], typeMismatch: item.typeMismatch === true, detectedKind: item.detectedKind, extension: item.extension }
  }
  // 防御性规范化：后端偶发返回逗号拼接字符串而非数组时，避免对字符串调用 .join 崩溃
  function toList(value: unknown): string[] {
    if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean)
    if (typeof value === "string" && value.trim()) return value.split(/[,，、;；]/).map((item) => item.trim()).filter(Boolean)
    return []
  }
  async function refresh() {
    try {
      const response = await fetch("/api/bootstrap", { cache: "no-store" });
      const data = await response.json() as BootstrapData & ApiError;
      if (response.status === 401) { router.replace("/login"); return }
      if (!response.ok) throw new Error(data.error || "数据加载失败");
      // 身份先行：即使后续某个映射出错，角色/菜单也不至于消失
      if (data.currentUser?.role) { setRole(data.currentUser.role); setCurrentUser({ displayName: data.currentUser.displayName, email: data.currentUser.email || "", role: data.currentUser.role }) }
      // 收件人名单先按发送单聚合：前端所有「收件人」展示（列表/审批页/收件箱）共用这一份数据
      const recipientsByApp = new Map<string, ApplicationRecipientItem[]>();
      for (const recipient of data.applicationRecipients || []) {
        const list = recipientsByApp.get(recipient.applicationId) || [];
        list.push({ email: recipient.email, name: recipient.name, department: recipient.department });
        recipientsByApp.set(recipient.applicationId, list);
      }
      setApplications((data.applications || []).map((item) => mapApplication(item, recipientsByApp)));
      setAudit((data.audit || []).map((item) => ({ id: item.id, at: new Date(item.at).toLocaleString("zh-CN"), actor: item.actorDisplay, action: item.action, object: item.objectId, result: item.result, hash: `${item.hash.slice(0, 6)}…${item.hash.slice(-6)}`, detail: item.detail })));
      setRules((data.rules || []).map((item) => { const extensions = toList(item.extensions); const approverEmails = toList(item.approverEmails); return { id: item.id, name: item.name, action: item.action, scope: item.scope === "ALL" ? "全员" : item.scope === "DEPARTMENT" ? "部门匹配" : item.scope, enabled: item.enabled, extensions, minSizeBytes: item.minSizeBytes, maxSizeBytes: item.maxSizeBytes, approverEmails, priority: item.priority, condition: `后缀 ∈ ${extensions.length ? extensions.join(", ") : "任意"}${item.minSizeBytes ? `，大小 ≥ ${describeSize(item.minSizeBytes)}` : ""}${item.maxSizeBytes ? `，大小 ≤ ${describeSize(item.maxSizeBytes)}` : ""}${approverEmails.length ? `，审批人 ${approverEmails.join(", ")}` : ""}` } }));
      if (data.ldapUsers) setLdapUsers(data.ldapUsers)
      if (data.syncRuns) setSyncRuns(data.syncRuns)
      setDownloadEvents(data.downloadEvents || []);
      setError("");
    } catch (nextError) { setError(nextError instanceof Error ? nextError.message : "数据加载失败"); }
  }
  useEffect(() => {
    void (async () => {
      try {
        const me = await fetch("/api/auth/me", { cache: "no-store" });
        if (me.status === 401) { router.replace("/login"); return }
        await refresh();
      } catch { router.replace("/login") }
    })()
  // 引导加载：仅在挂载时执行一次；refresh/router 为组件内稳定引用，无需重复触发
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  async function resolveDecision() {
    if (!decisionTarget || (decision === "reject" && !decisionReason.trim())) return
    setBusy(true)
    try {
      const response = await fetch(`/api/applications/${decisionTarget.id}/decision`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision, reason: decisionReason }) });
      const data = await response.json() as ApiError; if (!response.ok) throw new Error(data.error || "审批失败");
      await refresh(); setNotice(`${decisionTarget.id} 已${decision === "approve" ? "通过并送达收件人" : "驳回"}`); setDecisionTarget(null); setDecisionReason("")
    } catch (nextError) { setError(nextError instanceof Error ? nextError.message : "审批失败") } finally { setBusy(false) }
  }
  async function executeTransfer(item: Application) {
    setBusy(true)
    try {
      const response = await fetch(`/api/applications/${item.id}/transfer`, { method: "POST" })
      const data = await response.json() as { message?: string; error?: string }
      if (!response.ok) throw new Error(data.error || data.message || "外传执行失败")
      await refresh()
      setNotice(`${item.id} 已送达收件人`)
    } catch (nextError) { setError(nextError instanceof Error ? nextError.message : "外传执行失败") } finally { setBusy(false) }
  }
  async function logout() {
    try { await fetch("/api/auth/logout", { method: "POST" }) } finally { router.replace("/login") }
  }
  async function revokeDelivery(item: Application) {
    if (!window.confirm(`确认撤回 ${item.id} 送达的文件？撤回后所有收件人将立即无法下载，操作会写入审计台账。`)) return
    setBusy(true)
    try {
      const response = await fetch(`/api/applications/${item.id}/revoke`, { method: "POST" })
      const data = await response.json() as ApiError & { revoked?: number }
      if (!response.ok) throw new Error(data.error || "撤回失败")
      await refresh()
      setNotice(`${item.id} 已撤回（${data.revoked ?? 0} 条送达记录失效）`)
    } catch (nextError) { setError(nextError instanceof Error ? nextError.message : "撤回失败") } finally { setBusy(false) }
  }
  return <SidebarProvider>
    <Sidebar collapsible="icon" className="border-r-0 bg-[#081b2d] text-slate-200">
      <SidebarHeader className="border-b border-white/10 px-4 py-5"><div className="flex items-center gap-3 overflow-hidden"><div className="grid size-9 shrink-0 place-items-center rounded-xl bg-cyan-400 text-[#082033]"><FileKey2 className="size-5" /></div><div className="min-w-0 group-data-[collapsible=icon]:hidden"><p className="truncate text-[15px] font-semibold text-white">安全外传平台</p><p className="truncate text-xs text-slate-400">Secure Transfer Control</p></div></div></SidebarHeader>
      <SidebarContent className="bg-[#081b2d]">
        <NavGroup label="业务工作区" items={navItems} view={view} setView={setView} badges={{ approvals: pending.length, inbox: unreadCount }} />
        {["管理员", "审计员"].includes(role) && <NavGroup label="安全与管理" items={adminItems.filter((item) => item.id === "audit" ? ["管理员", "审计员"].includes(role) : role === "管理员")} view={view} setView={setView} badges={{}} />}
      </SidebarContent>
      <SidebarFooter className="border-t border-white/10 bg-[#081b2d] p-3"><div className="flex items-center gap-3 rounded-lg px-2 py-2"><div className="grid size-8 shrink-0 place-items-center rounded-full bg-slate-700 text-xs font-semibold text-white">{(currentUser.displayName || "?").slice(0, 1)}</div><div className="min-w-0 flex-1 group-data-[collapsible=icon]:hidden"><p className="truncate text-sm font-medium text-white">{currentUser.displayName || "未登录"}</p><p className="truncate text-xs text-slate-400">{currentUser.email || (role ? role : "请先登录")}</p></div></div></SidebarFooter>
    </Sidebar>
    <SidebarInset className="min-w-0 bg-[#f4f7fa]">
      <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-slate-200 bg-white/95 px-4 backdrop-blur sm:px-7"><SidebarTrigger className="text-slate-500" /><div className="h-5 w-px bg-slate-200" /><div className="flex min-w-0 flex-1 items-center gap-2 text-sm text-slate-500"><ShieldCheck className="size-4 text-cyan-700" /><span className="hidden sm:inline">内网文件统一收发 · 全程审计留痕</span></div><Button variant="ghost" size="icon" aria-label="通知" className="relative text-slate-500"><Bell /><span className="absolute right-2 top-2 size-1.5 rounded-full bg-rose-500" /></Button>{role && <Badge variant="outline" className="hidden border-cyan-200 bg-cyan-50 text-cyan-700 sm:inline-flex">{role}</Badge>}<Button variant="outline" size="sm" className="text-slate-500" onClick={() => void logout()}>退出登录</Button></header>
      {notice && <div className="mx-4 mt-4 flex items-center justify-between rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 sm:mx-7"><span className="flex items-center gap-2"><Check className="size-4" />{notice}</span><button onClick={() => setNotice("")} aria-label="关闭提示"><X className="size-4" /></button></div>}
      {error && <div className="mx-4 mt-4 flex items-center justify-between rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800 sm:mx-7"><span>{error}</span><button onClick={() => setError("")} aria-label="关闭错误"><X className="size-4" /></button></div>}
      <div className="mx-auto w-full max-w-[1480px] p-4 sm:p-7">
        {view === "dashboard" && <Dashboard applications={applications} pending={pending} audit={audit} onView={setView} />}
        {view === "inbox" && <InboxView rows={inboxRows} onView={setView} busy={busy} />}
        {view === "submit" && <SubmitView users={ldapUsers} setError={setError} busy={busy} onSubmit={async ({ file, recipientEmails, description }) => { setBusy(true); try { const search = new URLSearchParams({ fileName: file.name, recipients: recipientEmails.join(","), description }); const response = await fetch(`/api/applications?${search.toString()}`, { method: "POST", headers: { "content-type": file.type || "application/octet-stream" }, body: file }); const data = await response.json() as ApiError & { id?: string; status?: Status }; if (!response.ok) throw new Error(data.error || "提交失败"); await refresh(); setNotice(`${data.id} 已提交，规则判定为“${data.status ? STATUS_LABEL[data.status] : "未知"}”`); setView("applications") } catch (nextError) { setError(nextError instanceof Error ? nextError.message : "提交失败") } finally { setBusy(false) } }} />}
        {view === "applications" && <ApplicationsView items={filtered} all={applications} query={query} setQuery={setQuery} statusFilter={statusFilter} setStatusFilter={setStatusFilter} onView={setView} onTransfer={executeTransfer} onRevoke={revokeDelivery} busy={busy} />}
        {view === "approvals" && <ApprovalsView items={pending} currentUser={currentUser} onDecision={(item, next) => { setDecisionTarget(item); setDecision(next) }} />}
        {view === "rules" && <RulesView items={rules} refresh={refresh} setNotice={setNotice} setError={setError} role={role} />}
        {view === "audit" && <AuditView events={audit} downloadEvents={downloadEvents} applications={applications} rules={rules} />}
        {view === "ldap" && <LdapView setNotice={setNotice} setError={setError} refresh={refresh} ldapUsers={ldapUsers} syncRuns={syncRuns} />}
      </div>
    </SidebarInset>
    <Dialog open={Boolean(decisionTarget)} onOpenChange={(open) => !open && setDecisionTarget(null)}><DialogContent><DialogHeader><DialogTitle>{decision === "approve" ? "确认通过申请" : "驳回申请"}</DialogTitle><DialogDescription>{decisionTarget?.id} · {decisionTarget?.fileName}</DialogDescription></DialogHeader><div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm leading-6 text-slate-600">{decision === "approve" ? "通过后将立即送达全部站内收件人，收件人登录平台即可下载，全程审计留痕。" : "驳回后发起人可以修改后重新提交，历史记录将保留。"}</div><Textarea value={decisionReason} onChange={(e) => setDecisionReason(e.target.value)} placeholder={decision === "approve" ? "审批意见（可选）" : "请输入驳回理由（必填）"} /><DialogFooter><Button variant="outline" onClick={() => setDecisionTarget(null)}>取消</Button><Button variant={decision === "approve" ? "default" : "destructive"} disabled={busy || (decision === "reject" && !decisionReason.trim())} onClick={resolveDecision}>{busy ? "处理中" : decision === "approve" ? "确认通过" : "确认驳回"}</Button></DialogFooter></DialogContent></Dialog>
  </SidebarProvider>
}
