import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { integrationSettings, roleAssignments } from "@/db/schema";
import { appendAudit, requireAdministrator, serverError } from "@/lib/server";

async function encrypt(secret: string) {
  if (!env.CONFIG_ENCRYPTION_KEY) throw new Error("尚未配置服务端加密密钥");
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(env.CONFIG_ENCRYPTION_KEY));
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(secret));
  return `${Array.from(iv).map((v) => v.toString(16).padStart(2,"0")).join("")}.${Array.from(new Uint8Array(encrypted)).map((v) => v.toString(16).padStart(2,"0")).join("")}`;
}

export async function GET(request: Request) {
  try {
    await requireAdministrator(request);
    const db = getDb();
    const [settings, roles] = await Promise.all([db.select().from(integrationSettings).where(eq(integrationSettings.id,"ldap")).limit(1), db.select().from(roleAssignments).orderBy(roleAssignments.role, roleAssignments.email)]);
    const item = settings[0];
    return Response.json({ ldap: item ? {
      ldapName: item.ldapName || "",
      ldapHost: item.ldapHost || "",
      ldapPort: item.ldapPort || (item.ldapLdaps ? 636 : 389),
      ldapLdaps: Boolean(item.ldapLdaps),
      baseDn: item.baseDn || "",
      bindDn: item.bindDn || "",
      ldapFilter: item.ldapFilter || "",
      syncIntervalMinutes: item.syncIntervalMinutes,
      secretConfigured: Boolean(item.encryptedSecret),
      ldapGatewayUrl: item.ldapGatewayUrl || "",
      contentTypeGuard: item.contentTypeGuard || "normal",
    } : null, roles });
  } catch (error) { return serverError(error,"读取配置失败"); }
}

export async function PUT(request: Request) {
  try {
    const actor = await requireAdministrator(request);
    // Redmine 风格认证源：名称/主机/端口/LDAPS/帐号/密码/Base DN；ldapGatewayUrl 为旧版网关回退
    const body = await request.json() as { ldapName?:string; ldapHost?:string; ldapPort?:number; ldapLdaps?:boolean; baseDn?:string; bindDn?:string; secret?:string; syncIntervalMinutes?:number; ldapGatewayUrl?:string; ldapFilter?:string; contentTypeGuard?:string };
    const db = getDb(); const now = new Date().toISOString();
    // 内容防伪装开关：normal=不一致拒绝+未知转人工（默认）；strict=不一致与未知一律拒绝；off=仅记录不影响判定
    const guardInput = (body.contentTypeGuard || "").trim().toLowerCase();
    if (guardInput && !["normal","strict","off"].includes(guardInput)) throw new Error("内容类型防护档位仅支持 normal / strict / off");
    // 只更新防护档位（不带任何 LDAP 字段）的局部请求：不动认证源配置
    const guardOnly = body.ldapHost === undefined && body.ldapGatewayUrl === undefined && body.baseDn === undefined && body.bindDn === undefined
      && body.secret === undefined && body.ldapName === undefined && body.ldapPort === undefined && body.ldapLdaps === undefined
      && body.syncIntervalMinutes === undefined && body.ldapFilter === undefined;
    if (guardOnly) {
      if (!guardInput) throw new Error("缺少要更新的配置项");
      const current = await db.select().from(integrationSettings).where(eq(integrationSettings.id,"ldap")).limit(1);
      if (!current[0]) throw new Error("请先完成 LDAP 认证源配置，再调整内容类型防护档位");
      await db.update(integrationSettings).set({ contentTypeGuard: guardInput, updatedAt: now }).where(eq(integrationSettings.id,"ldap"));
      if (guardInput !== (current[0].contentTypeGuard || "normal")) {
        await appendAudit(actor,"更新内容类型防护档位","CONTENT_TYPE_GUARD","SUCCESS",JSON.stringify({ from: current[0].contentTypeGuard || "normal", to: guardInput }));
      }
      return Response.json({ok:true,contentTypeGuard:guardInput});
    }
    const host = body.ldapHost?.trim() || "";
    const gatewayUrl = body.ldapGatewayUrl?.trim() || "";
    if (!host && !gatewayUrl) throw new Error("请填写 LDAP 主机（或旧版网关地址）");
    if (host && !body.baseDn?.trim()) throw new Error("Base DN 不能为空");
    if (host && !body.bindDn?.trim()) throw new Error("帐号（绑定 DN）不能为空");
    if (gatewayUrl && !/^https?:\/\//i.test(gatewayUrl)) throw new Error("网关地址需要 http:// 或 https:// 开头");
    if (!host && !gatewayUrl) throw new Error("Base DN 和绑定账号不能为空");
    const ldapFilter = body.ldapFilter?.trim() || "";
    if (ldapFilter && (!ldapFilter.startsWith("(") || !ldapFilter.endsWith(")"))) throw new Error("搜索过滤器需要以 ( 开始、以 ) 结束，例如 (objectClass=user)");
    const ldaps = Boolean(body.ldapLdaps);
    const port = Math.min(Math.max(Number(body.ldapPort) || (ldaps ? 636 : 389), 1), 65535);
    const current = await db.select().from(integrationSettings).where(eq(integrationSettings.id,"ldap")).limit(1);
    const encryptedSecret = body.secret ? await encrypt(body.secret) : current[0]?.encryptedSecret || null;
    const contentTypeGuard = (["normal","strict","off"].includes(guardInput) ? guardInput : current[0]?.contentTypeGuard || "normal") as string;
    const row={id:"ldap",ldapName:body.ldapName?.trim()||"Corporate_LDAP",ldapHost:host,ldapPort:port,ldapLdaps:ldaps,ldapFilter:ldapFilter||null,ldapGatewayUrl:gatewayUrl||null,baseDn:body.baseDn?.trim()||"",bindDn:body.bindDn?.trim()||"",encryptedSecret,syncIntervalMinutes:Math.max(5,Number(body.syncIntervalMinutes)||30),contentTypeGuard,updatedAt:now};
    await db.insert(integrationSettings).values(row).onConflictDoUpdate({target:integrationSettings.id,set:row});
    await appendAudit(actor,"更新 LDAP 配置","LDAP",host?`直连 ${ldaps?"ldaps":"ldap"}://${host}:${port}`:`网关 ${row.ldapGatewayUrl}；密钥${encryptedSecret?"已配置":"未配置"}`);
    if (guardInput && guardInput !== current[0]?.contentTypeGuard) {
      await appendAudit(actor,"更新内容类型防护档位","CONTENT_TYPE_GUARD","SUCCESS",JSON.stringify({ from: current[0]?.contentTypeGuard || "normal", to: guardInput }));
    }
    return Response.json({ok:true,secretConfigured:Boolean(encryptedSecret),contentTypeGuard});
  } catch (error) { return serverError(error,"保存 LDAP 配置失败"); }
}
