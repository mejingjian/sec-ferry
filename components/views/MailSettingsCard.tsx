"use client"

// 邮件通知配置卡片（0010）：SMTP 服务器/端口/TLS/发件人/认证 + 测试发送 + 队列状态。
// 密码只写不读（页面回显 secretConfigured 布尔），加密口径与 LDAP 绑定密码一致。

import { useCallback, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { SectionTitle, type ApiError } from "@/components/views/shared"
import { MailCheck, Save, SendHorizonal } from "lucide-react"

type SmtpForm = { smtpHost: string; smtpPort: string; smtpSecure: boolean; smtpFrom: string; smtpUsername: string; secret: string; secretConfigured: boolean }
type Stats = { pending: number; sent: number; failed: number }

export function MailSettingsCard({ setNotice, setError }: { setNotice: (v: string) => void; setError: (v: string) => void }) {
  const [smtp, setSmtp] = useState<SmtpForm>({ smtpHost: "", smtpPort: "25", smtpSecure: false, smtpFrom: "", smtpUsername: "", secret: "", secretConfigured: false })
  const [stats, setStats] = useState<Stats | null>(null)
  const [testTo, setTestTo] = useState("")
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)

  const load = useCallback(async () => {
    const response = await fetch("/api/admin/mail-config", { cache: "no-store" })
    const data = await response.json() as ApiError & { smtp?: { smtpHost?: string; smtpPort?: number; smtpSecure?: boolean; smtpFrom?: string; smtpUsername?: string; secretConfigured?: boolean } | null; stats?: Stats }
    if (!response.ok) throw new Error(data.error || "读取邮件配置失败")
    return data
  }, [])

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const data = await load()
        if (!active) return
        if (data.smtp) setSmtp((prev) => ({ ...prev, ...data.smtp, smtpPort: String(data.smtp?.smtpPort ?? 25), secret: "" }))
        setStats(data.stats || null)
      } catch (nextError) {
        if (active) setError(nextError instanceof Error ? nextError.message : "读取邮件配置失败")
      }
    })()
    return () => { active = false }
  }, [load, setError])

  async function save() {
    if (!smtp.smtpHost.trim() || !smtp.smtpFrom.trim()) { setError("SMTP 服务器地址与发件人地址为必填项"); return }
    if (smtp.smtpUsername.trim() && !smtp.secret && !smtp.secretConfigured) { setError("填写了认证帐号时需要同时填写密码"); return }
    setSaving(true)
    try {
      const response = await fetch("/api/admin/mail-config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ smtpHost: smtp.smtpHost, smtpPort: Number(smtp.smtpPort) || (smtp.smtpSecure ? 465 : 25), smtpSecure: smtp.smtpSecure, smtpFrom: smtp.smtpFrom, smtpUsername: smtp.smtpUsername, secret: smtp.secret || undefined }) })
      const data = await response.json() as ApiError
      if (!response.ok) throw new Error(data.error || "保存失败")
      const data2 = await load()
      if (data2.smtp) setSmtp((prev) => ({ ...prev, ...data2.smtp, smtpPort: String(data2.smtp?.smtpPort ?? 25), secret: "" }))
      setStats(data2.stats || null)
      setNotice("邮件通知配置已保存（密码加密存储）")
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "保存邮件配置失败")
    } finally { setSaving(false) }
  }

  async function sendTest() {
    setTesting(true)
    try {
      const response = await fetch("/api/admin/mail-config", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ to: testTo.trim() || undefined }) })
      const data = await response.json() as ApiError & { to?: string; elapsedMs?: number; backlogDispatched?: number }
      if (!response.ok) throw new Error(data.error || "测试邮件发送失败")
      const data2 = await load()
      setStats(data2.stats || null)
      setNotice(`测试邮件已发送至 ${data.to}（${data.elapsedMs}ms）${data.backlogDispatched ? `，并补发了 ${data.backlogDispatched} 封积压通知` : ""}`)
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "测试邮件发送失败")
    } finally { setTesting(false) }
  }

  return <div className="rounded-2xl border border-slate-200 bg-white p-5"><SectionTitle eyebrow="邮件通知" title="内网 SMTP 发信" description="审批待办与文件送达时自动发信通知（内网邮件 = 域账号邮箱）。发送失败不阻断业务流程，通知先入队并自动重试；未配置时通知仅入队暂存。" actions={<Button onClick={() => void sendTest()} disabled={testing || !smtp.smtpHost}><SendHorizonal />{testing ? "发送中" : "发送测试邮件"}</Button>} />
    <div className="mt-5 grid gap-3 xl:grid-cols-2">
      <div><label className="text-xs font-medium text-slate-600">SMTP 服务器 <span className="text-rose-500">*</span></label><Input className="mt-1" placeholder="例如 192.168.1.10 或 smtp.corp.local" value={smtp.smtpHost} onChange={(e) => setSmtp({ ...smtp, smtpHost: e.target.value })} /></div>
      <div className="flex items-end gap-4"><div className="w-32"><label className="text-xs font-medium text-slate-600">端口</label><Input className="mt-1" type="number" min="1" max="65535" value={smtp.smtpPort} onChange={(e) => setSmtp({ ...smtp, smtpPort: e.target.value })} /></div><label className="flex h-10 items-center gap-2 text-sm text-slate-700"><input type="checkbox" className="h-4 w-4 accent-cyan-600" checked={smtp.smtpSecure} onChange={(e) => setSmtp({ ...smtp, smtpSecure: e.target.checked, smtpPort: e.target.checked ? "465" : "25" })} />隐式 TLS(465)</label></div>
      <div><label className="text-xs font-medium text-slate-600">发件人地址 <span className="text-rose-500">*</span></label><Input className="mt-1" placeholder="transfer-platform@corp.local" value={smtp.smtpFrom} onChange={(e) => setSmtp({ ...smtp, smtpFrom: e.target.value })} /></div>
      <div><label className="text-xs font-medium text-slate-600">认证帐号（中继免认证可留空）</label><Input className="mt-1" placeholder="SMTP 帐号" value={smtp.smtpUsername} onChange={(e) => setSmtp({ ...smtp, smtpUsername: e.target.value })} /></div>
      <div><label className="text-xs font-medium text-slate-600">认证密码 {smtp.secretConfigured ? <span className="text-emerald-600">（已配置，留空保持不变）</span> : ""}</label><Input className="mt-1" type="password" autoComplete="off" value={smtp.secret} onChange={(e) => setSmtp({ ...smtp, secret: e.target.value })} /></div>
      <div><label className="text-xs font-medium text-slate-600">测试收件地址（留空发给发件人自己）</label><Input className="mt-1" placeholder="someone@corp.local" value={testTo} onChange={(e) => setTestTo(e.target.value)} /></div>
    </div>
    <div className="mt-4 flex flex-wrap items-center gap-4">
      <Button onClick={() => void save()} disabled={saving}><Save />{saving ? "保存中" : "保存配置"}</Button>
      {stats ? <span className="flex items-center gap-2 text-sm text-slate-600"><MailCheck className="h-4 w-4" />通知队列：待发 {stats.pending} · 已发 {stats.sent} · 失败 {stats.failed}</span> : null}
    </div>
    <div className="mt-4 rounded-xl border border-cyan-200 bg-cyan-50 p-4 text-sm leading-6 text-cyan-900"><b>说明：</b>平台通过内置 SMTP 客户端直连内网邮件中继（明文端口自动尝试 STARTTLS 升级，465 为隐式 TLS）。审批待办通知发给规则指派审批人（未指派时发给「审批人」角色名单），收件通知发给各站内收件人。内网中继若使用自签名证书，可在服务端环境变量设置 SMTP_TLS_REJECT_UNAUTHORIZED=0 关闭证书校验。</div>
  </div>
}
