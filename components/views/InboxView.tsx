"use client"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { SectionTitle, inboxStateStyle, type Application, type DeliveryRecord, type InboxState, type View } from "@/components/views/shared"
import { ArrowRight, CheckCheck, Download, Inbox as InboxIcon, MailOpen } from "lucide-react"

// 收件箱一行 = 一张发给我的发送单 + 我在该单上的送达记录（未送达时为空）
export type InboxRow = { application: Application; delivery?: DeliveryRecord; state: InboxState }

function shortTime(value?: string | null): string {
  return value ? new Date(value).toLocaleString("zh-CN") : "—"
}

export function InboxView({ rows, onView, busy = false }: { rows: InboxRow[]; onView: (v: View) => void; busy?: boolean }) {
  const unread = rows.filter((row) => row.state === "未读")
  const downloaded = rows.filter((row) => row.state === "已下载")
  const revoked = rows.filter((row) => row.state === "已撤回")
  const metrics = [
    { label: "未读", value: unread.length, hint: "已送达但尚未下载", icon: MailOpen, style: "text-amber-700 bg-amber-50" },
    { label: "已下载", value: downloaded.length, hint: "下载行为已留痕审计", icon: CheckCheck, style: "text-emerald-700 bg-emerald-50" },
    { label: "已撤回 / 待送达", value: revoked.length + rows.filter((row) => row.state === "待送达").length, hint: "撤回后立即失效", icon: InboxIcon, style: "text-slate-600 bg-slate-100" },
  ]
  return (
    <div className="space-y-7">
      <SectionTitle
        eyebrow="文件接收"
        title="收件箱"
        description="发送方审批通过后文件立即送达这里。下载全程留痕审计；发送方撤回后文件立即失效，无法再下载。"
        actions={<Button variant="outline" onClick={() => onView("applications")}>查看发送记录<ArrowRight /></Button>}
      />
      <div className="grid gap-4 sm:grid-cols-3">
        {metrics.map((metric) => (
          <div key={metric.label} className="rounded-2xl border border-slate-200 bg-white p-5">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-sm text-slate-500">{metric.label}</p>
                <p className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">{metric.value}</p>
              </div>
              <div className={`grid size-10 place-items-center rounded-xl ${metric.style}`}><metric.icon className="size-5" /></div>
            </div>
            <p className="mt-4 text-xs text-slate-500">{metric.hint}</p>
          </div>
        ))}
      </div>
      <div className="rounded-2xl border border-slate-200 bg-white">
        {rows.length === 0
          ? <div className="py-20 text-center"><InboxIcon className="mx-auto size-10 text-slate-300" /><h2 className="mt-4 font-semibold">收件箱为空</h2><p className="mt-1 text-sm text-slate-500">还没有人给你发送文件，或对应发送单已被撤回。</p></div>
          : <Table>
            <TableHeader>
              <TableRow>
                <TableHead>文件</TableHead>
                <TableHead>发送人</TableHead>
                <TableHead>发送说明</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>下载时间</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map(({ application, delivery, state }) => {
                const downloadable = state === "未读" || state === "已下载"
                return (
                  <TableRow key={application.id}>
                    <TableCell>
                      <p className="font-medium text-slate-900">{application.fileName}</p>
                      <p className="mt-1 text-xs text-slate-500">{application.id} · {application.size}</p>
                    </TableCell>
                    <TableCell>
                      <p>{application.requester}</p>
                      <p className="mt-1 text-xs text-slate-500">{application.department}</p>
                    </TableCell>
                    <TableCell className="max-w-[260px] truncate text-slate-600" title={application.detail}>{application.detail || "—"}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className={inboxStateStyle[state]}>{state}</Badge>
                      {state === "已下载" && <p className="mt-1 text-[11px] text-slate-500">共下载 {delivery?.downloadCount || 0} 次</p>}
                      {state === "待送达" && <p className="mt-1 text-[11px] text-slate-500">等待审批通过</p>}
                    </TableCell>
                    <TableCell className="text-slate-500">{shortTime(delivery?.lastDownloadedAt)}</TableCell>
                    <TableCell className="text-right">
                      {downloadable
                        ? <Button asChild size="sm" variant={state === "未读" ? "default" : "outline"} disabled={busy}>
                          <a href={`/api/files/${application.id}`}><Download />{state === "未读" ? "下载" : "重新下载"}</a>
                        </Button>
                        : <span className="text-xs text-slate-400">{state === "已撤回" ? "发送方已撤回" : "审批通过后可下载"}</span>}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>}
      </div>
    </div>
  )
}
