"use client"

import { SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarMenu, SidebarMenuBadge, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar"
import { navItems, type View } from "@/components/views/shared"

// badges：按视图 id 传入角标数字（待我审批、收件箱未读），无角标的视图不显示
export function NavGroup({ label, items, view, setView, badges }: { label: string; items: typeof navItems; view: View; setView: (v: View) => void; badges: Partial<Record<View, number>> }) {
  return <SidebarGroup><SidebarGroupLabel className="text-slate-500">{label}</SidebarGroupLabel><SidebarGroupContent><SidebarMenu>{items.map((item) => { const count = "badge" in item && item.badge ? badges[item.id] || 0 : 0; return <SidebarMenuItem key={item.id}><SidebarMenuButton isActive={view === item.id} tooltip={item.label} onClick={() => setView(item.id)} className="h-10 text-slate-300 hover:bg-white/8 hover:text-white data-[active=true]:bg-cyan-400/15 data-[active=true]:text-cyan-300"><item.icon /><span>{item.label}</span></SidebarMenuButton>{count > 0 ? <SidebarMenuBadge className="bg-amber-400 text-[#082033]">{count}</SidebarMenuBadge> : null}</SidebarMenuItem> })}</SidebarMenu></SidebarGroupContent></SidebarGroup>
}
