"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { FileKey2, KeyRound, Loader2, LogIn, ShieldCheck, UserRound } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

export default function LoginPage() {
  const router = useRouter()
  const [account, setAccount] = useState("")
  const [password, setPassword] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  async function login(payload: { account?: string; password?: string; displayName?: string; local?: boolean }) {
    setBusy(true)
    setError("")
    try {
      const response = await fetch("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) })
      const data = await response.json() as { error?: string }
      if (!response.ok) throw new Error(data.error || "登录失败")
      router.replace("/")
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "登录失败")
    } finally {
      setBusy(false)
    }
  }

  function submitCredentials(event: React.FormEvent) {
    event.preventDefault()
    if (!account.trim()) { setError("请输入域账号或企业邮箱"); return }
    if (!password) { setError("请输入域密码"); return }
    void login({ account: account.trim(), password })
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#f4f7fa] px-4">
      <div className="w-full max-w-md">
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_18px_50px_rgba(8,27,45,.10)]">
          <div className="bg-[#081b2d] px-8 py-7">
            <div className="flex items-center gap-3">
              <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-cyan-400 text-[#082033]"><FileKey2 className="size-5" /></div>
              <div>
                <h1 className="text-lg font-semibold text-white">安全文件收发平台</h1>
                <p className="text-xs text-slate-400">Secure File Transfer · 域账号登录</p>
              </div>
            </div>
          </div>
          <div className="space-y-6 px-8 py-7">
            <form className="space-y-4" onSubmit={submitCredentials}>
              <div className="space-y-1.5">
                <Label htmlFor="login-account">域账号</Label>
                <div className="relative">
                  <UserRound className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
                  <Input id="login-account" autoComplete="username" placeholder="域账号或 name@corp.example.com" className="pl-9" value={account} onChange={(e) => setAccount(e.target.value)} />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="login-password">域密码</Label>
                <div className="relative">
                  <KeyRound className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
                  <Input id="login-password" type="password" autoComplete="current-password" placeholder="与登录域内电脑相同的密码" className="pl-9" value={password} onChange={(e) => setPassword(e.target.value)} />
                </div>
                <p className="text-xs leading-5 text-slate-400">密码由域控制器（LDAP）直接校验，平台不保存密码；连续输错会临时锁定账号。</p>
              </div>
              <Button type="submit" className="w-full" disabled={busy || !account.trim() || !password}>
                {busy ? <Loader2 className="size-4 animate-spin" /> : <LogIn className="size-4" />}登录
              </Button>
            </form>
            <div className="flex items-center gap-3">
              <div className="h-px flex-1 bg-slate-200" />
              <span className="text-xs text-slate-400">或</span>
              <div className="h-px flex-1 bg-slate-200" />
            </div>
            <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-4">
              <p className="text-sm font-medium text-slate-600">本地管理员（初始化 / 联调）</p>
              <p className="mt-1 text-xs leading-5 text-slate-500">仅在尚未配置平台管理员名单时可用 —— 供首次进入配置 LDAP 认证源与联调使用。配置 <code className="rounded bg-slate-200 px-1">PLATFORM_ADMIN_EMAILS</code> 后该入口自动失效。</p>
              <Button type="button" variant="outline" className="mt-3 w-full" disabled={busy} onClick={() => void login({ local: true })}>
                <ShieldCheck className="size-4" />以本地管理员身份进入
              </Button>
            </div>
            {error && <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}
          </div>
        </div>
        <p className="mt-6 text-center text-xs leading-5 text-slate-400">域账号统一登录 · 会话由服务端签名维护，12 小时有效</p>
      </div>
    </div>
  )
}
