import type { Metadata } from "next"
import "./globals.css"

export const metadata: Metadata = {
  title: "安全外传平台",
  description: "规则驱动、审批有据、全程留痕的内网文件外传审批平台。",
  other: { "codex-preview": "development" },
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body className="antialiased">{children}</body></html>
}
