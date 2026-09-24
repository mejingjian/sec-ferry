import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { roleAssignments } from "@/db/schema";
import { appendAudit, requireAdministrator, serverError } from "@/lib/server";

export async function POST(request: Request) {
  try {
    const actor=await requireAdministrator(request); const body=await request.json() as {email?:string;displayName?:string;role?:string};
    const email=body.email?.trim().toLowerCase(); if(!email||!email.includes("@"))throw new Error("请输入有效邮箱"); if(!["管理员","审批人","审计员","发起人"].includes(body.role||""))throw new Error("角色无效");
    const now=new Date().toISOString(); const row={email,displayName:body.displayName?.trim()||email,role:body.role!,createdAt:now,updatedAt:now};
    await getDb().insert(roleAssignments).values(row).onConflictDoUpdate({target:roleAssignments.email,set:{displayName:row.displayName,role:row.role,updatedAt:now}}); await appendAudit(actor,"配置平台角色",email,row.role); return Response.json(row);
  } catch(error){return serverError(error,"保存角色失败")}
}
export async function DELETE(request:Request){try{const actor=await requireAdministrator(request);const email=new URL(request.url).searchParams.get("email")?.toLowerCase();if(!email)throw new Error("缺少邮箱");await getDb().delete(roleAssignments).where(eq(roleAssignments.email,email));await appendAudit(actor,"删除角色配置",email,"已删除");return Response.json({ok:true})}catch(error){return serverError(error,"删除角色失败")}}
