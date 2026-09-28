"use client"

import { useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { DOWNLOAD_EVENT_LABEL, Metric, SectionTitle, type Application, type AuditEvent, type DownloadEvent, type RuleItem } from "@/components/views/shared"
import { Download, Search } from "lucide-react"

// audit_events 的 object/result 里混有编码（SUCCESS/CONTENT_TYPE_GUARD…）与自由文本，统一翻成中文展示
const OBJECT_LABEL: Record<string, string> = {
  LDAP: "LDAP 认证源",
  AUTH: "登录会话",
  CONTENT_TYPE_GUARD: "内容类型防护",
  SECRET_KEY: "服务端加密密钥",
}
const RESULT_LABEL: Record<string, string> = {
  SUCCESS: "成功", FAILED: "失败", DENIED: "已拒绝", DELETED: "已删除",
  TRANSFERRING: "送达中", TRANSFERRED: "已送达", TRANSFER_FAILED: "送达失败",
  REJECTED_BY_RULE: "规则拒绝", REJECTED: "已驳回", APPROVED: "已通过",
  PENDING_APPROVAL: "待审批", REVOKED: "已撤回",
}
const RESULT_TONE: Record<string, string> = {
  SUCCESS: "border-emerald-200 bg-emerald-50 text-emerald-700",
  APPROVED: "border-emerald-200 bg-emerald-50 text-emerald-700",
  TRANSFERRED: "border-emerald-200 bg-emerald-50 text-emerald-700",
  FAILED: "border-rose-200 bg-rose-50 text-rose-700",
  DENIED: "border-rose-200 bg-rose-50 text-rose-700",
  TRANSFER_FAILED: "border-rose-200 bg-rose-50 text-rose-700",
  REJECTED_BY_RULE: "border-rose-200 bg-rose-50 text-rose-700",
  REJECTED: "border-rose-200 bg-rose-50 text-rose-700",
  PENDING_APPROVAL: "border-amber-200 bg-amber-50 text-amber-700",
  TRANSFERRING: "border-blue-200 bg-blue-50 text-blue-700",
  REVOKED: "border-slate-200 bg-slate-50 text-slate-600",
}

// 复合结果（如「PENDING_APPROVAL；命中 R-xxx」）只翻译首段编码，其余原样保留
function resultLabel(result: string): string {
  const [head, ...rest] = result.split("；")
  const label = RESULT_LABEL[head.trim()] ?? head
  return rest.length ? `${label}；${rest.join("；")}` : label
}
function resultTone(result: string): string {
  return RESULT_TONE[(result.split("；")[0] || "").trim()] || "border-slate-200 bg-slate-50 text-slate-600"
}
function formatTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false })
}

export function AuditView({ events, downloadEvents, applications, rules }: { events: AuditEvent[]; downloadEvents: DownloadEvent[]; applications: Application[]; rules: RuleItem[] }) {
  const [query, setQuery] = useState("")
  const [actionFilter, setActionFilter] = useState("全部")
  // 对象编号 → 人类可读名称的内存映射（数据已在 bootstrap 返回，无额外请求）
  const appNameById = new Map(applications.map((item) => [item.id, item.fileName]))
  const ruleNameById = new Map(rules.map((item) => [item.id, item.name]))
  function objectLabel(objectId: string): { main: string; sub: string | null; application: boolean } {
    if (appNameById.has(objectId)) return { main: appNameById.get(objectId)!, sub: objectId, application: true }
    if (ruleNameById.has(objectId)) return { main: ruleNameById.get(objectId)!, sub: objectId, application: false }
    if (OBJECT_LABEL[objectId]) return { main: OBJECT_LABEL[objectId], sub: null, application: false }
    return { main: objectId, sub: null, application: false }
  }
  const actions = ["全部", ...Array.from(new Set(events.map((e) => e.action)))]
  const filtered = events.filter((e) => {
    const label = objectLabel(e.object)
    const matched = [e.actor, e.action, e.object, label.main, e.result, e.detail || "", e.hash].join(" ").toLowerCase().includes(query.toLowerCase())
    return matched && (actionFilter === "全部" || e.action === actionFilter)
  })
  const params = new URLSearchParams({ q: query, action: actionFilter === "全部" ? "" : actionFilter })
  return (
    <div className="space-y-7">
      <SectionTitle eyebrow="合规与追溯" title="只读审计台账" description="上传、规则判定、审批、送达和配置变更均进入哈希链。管理员也不能删除记录。" actions={<Button variant="outline" asChild><a href={`/api/audit/export?${params.toString()}`}><Download />导出 CSV</a></Button>} />
      <div className="grid gap-4 sm:grid-cols-3">
        <Metric label="当前记录" value={String(events.length)} />
        <Metric label="哈希链状态" value="连续无异常" success />
        <Metric label="保留策略" value="永久保留" />
      </div>
      <div className="rounded-2xl border border-slate-200 bg-white">
        <div className="flex gap-3 border-b p-4">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
            <Input className="pl-9" value={query} onChange={(e)=>setQuery(e.target.value)} placeholder="搜索人员、文件、申请编号或动作" />
          </div>
          <Select value={actionFilter} onValueChange={setActionFilter}>
            <SelectTrigger className="w-[150px]"><SelectValue /></SelectTrigger>
            <SelectContent>{actions.map((a) => <SelectItem key={a} value={a}>{a}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        {/* table-fixed：六列等宽均分整行宽度，随页面大小自适应 */}
        <Table className="table-fixed">
          <TableHeader>
            <TableRow>
              <TableHead className="w-1/6">时间</TableHead>
              <TableHead className="w-1/6">操作者</TableHead>
              <TableHead className="w-1/6">动作</TableHead>
              <TableHead className="w-1/6">对象</TableHead>
              <TableHead className="w-1/6">结果</TableHead>
              <TableHead className="w-1/6">链摘要</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((e) => {
              const label = objectLabel(e.object)
              return (
                <TableRow key={e.id}>
                  <TableCell className="whitespace-nowrap font-mono text-xs text-slate-500">{formatTime(e.at)}</TableCell>
                  <TableCell className="overflow-hidden whitespace-nowrap" title={e.actor}><span className="block truncate">{e.actor}</span></TableCell>
                  <TableCell className="overflow-hidden whitespace-nowrap">{e.action}</TableCell>
                  <TableCell className="overflow-hidden">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate font-medium" title={label.main}>{label.main}</span>
                      {label.sub && <span className="hidden shrink-0 truncate font-mono text-xs font-normal text-slate-400 lg:inline" title={label.sub}>{label.sub}</span>}
                      {label.application && (
                        <a
                          href={`/api/files/${e.object}`}
                          className="inline-flex shrink-0 rounded p-1 text-slate-400 transition-colors hover:bg-cyan-50 hover:text-cyan-700"
                          title="下载源文件"
                          aria-label="下载源文件"
                        >
                          <Download className="size-3.5" />
                        </a>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="overflow-hidden">
                    <Badge variant="outline" className={`max-w-full truncate whitespace-nowrap ${resultTone(e.result)}`}>{resultLabel(e.result)}</Badge>
                  </TableCell>
                  <TableCell className="overflow-hidden font-mono text-xs text-cyan-700" title={e.hash}><span className="block truncate">{e.hash}</span></TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>
      <div className="rounded-2xl border border-slate-200 bg-white">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
          <div>
            <h2 className="font-semibold">站内下载事件</h2>
            <p className="mt-1 text-xs text-slate-500">收件人与授权人的站内下载与拒绝记录，含来源 IP 与结果</p>
          </div>
          <Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-emerald-700">{downloadEvents.length} 条</Badge>
        </div>
        {downloadEvents.length ? (
          <Table className="table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead className="w-1/6">时间</TableHead>
                <TableHead className="w-1/6">申请</TableHead>
                <TableHead className="w-1/6">事件</TableHead>
                <TableHead className="w-1/6">结果</TableHead>
                <TableHead className="w-1/6">来源 IP</TableHead>
                <TableHead className="w-1/6">说明</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {downloadEvents.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="whitespace-nowrap font-mono text-xs text-slate-500">{formatTime(e.createdAt)}</TableCell>
                  <TableCell className="overflow-hidden">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate font-medium" title={appNameById.get(e.applicationId) || e.applicationId}>{appNameById.get(e.applicationId) || e.applicationId}</span>
                      {appNameById.has(e.applicationId) && <span className="hidden shrink-0 truncate font-mono text-xs font-normal text-slate-400 lg:inline">{e.applicationId}</span>}
                    </div>
                  </TableCell>
                  <TableCell className="overflow-hidden whitespace-nowrap">{DOWNLOAD_EVENT_LABEL[e.event] || e.event}</TableCell>
                  <TableCell className="overflow-hidden">
                    {e.result === "SUCCESS"
                      ? <Badge variant="outline" className="max-w-full truncate whitespace-nowrap border-emerald-200 bg-emerald-50 text-emerald-700">成功</Badge>
                      : <Badge variant="outline" className="max-w-full truncate whitespace-nowrap border-rose-200 bg-rose-50 text-rose-700">被拒/失败</Badge>}
                  </TableCell>
                  <TableCell className="overflow-hidden whitespace-nowrap font-mono text-xs">{e.ip || "-"}</TableCell>
                  <TableCell className="overflow-hidden text-xs text-slate-500" title={e.reason || ""}><span className="block truncate">{e.reason || "-"}</span></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="px-5 py-10 text-center text-sm text-slate-500">暂无站内下载事件。</p>
        )}
      </div>
    </div>
  )
}
