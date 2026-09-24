"use client"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { ApplicationTable } from "@/components/views/ApplicationTable"
import { SectionTitle, type Application, type View } from "@/components/views/shared"
import { Filter, Plus, Search } from "lucide-react"

export function ApplicationsView({ items, all, query, setQuery, statusFilter, setStatusFilter, onView, onTransfer, onRevoke, busy }: { items: Application[]; all: Application[]; query: string; setQuery: (v:string)=>void; statusFilter: string; setStatusFilter: (v:string)=>void; onView:(v:View)=>void; onTransfer:(item:Application)=>Promise<void>; onRevoke:(item:Application)=>Promise<void>; busy:boolean }) {
  const statuses = ["全部", ...Array.from(new Set(all.map((i) => i.status)))]
  return <div className="space-y-7"><SectionTitle eyebrow="全流程追踪" title="发送记录" description="查看文件从上传、规则判定、审批到送达收件人的全部状态。" actions={<Button onClick={() => onView("submit")}><Plus />新建发送单</Button>} /><div className="rounded-xl border border-cyan-200 bg-cyan-50 p-4 text-sm text-cyan-900"><b>送达方式：</b>自动通过或审批通过后立即送达站内收件人；收件人登录平台即可下载，全程审计留痕，发送方可随时撤回。</div><div className="rounded-2xl border border-slate-200 bg-white"><div className="flex flex-col gap-3 border-b border-slate-100 p-4 sm:flex-row"><div className="relative flex-1"><Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" /><Input className="pl-9" value={query} onChange={(e)=>setQuery(e.target.value)} placeholder="搜索单号、文件、人员或收件人" /></div><Select value={statusFilter} onValueChange={setStatusFilter}><SelectTrigger className="w-[150px]"><SelectValue /></SelectTrigger><SelectContent>{statuses.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent></Select><Button variant="outline"><Filter />筛选</Button></div><ApplicationTable items={items} onTransfer={onTransfer} onRevoke={onRevoke} busy={busy} /></div></div>
}
