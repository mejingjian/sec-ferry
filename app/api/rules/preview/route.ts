import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { ldapUsers } from "@/db/schema";
import { evaluateFileDetailed, jsonError, roleFor, serverError } from "@/lib/server";
import { isTypeMismatch, sniffFileType } from "@/lib/file-type";
import { applyContentGuard, getContentTypeGuard } from "@/lib/content-guard";

// 规则预判：给「发送文件」页面的实时预判面板使用。
// 直接复用提交时同一套规则引擎与内容防伪装策略（同一签名表、同一档位开关），
// 避免前端预判与真实判定不一致。firstBytes = 文件首部字节的 hex（≤512 字节，由前端 slice 计算）。
export async function POST(request: Request) {
  try {
    const identity = await roleFor(request);
    if (identity.role === "未登录" || !identity.actor) return jsonError("请先登录", 401);
    const body = await request.json() as { fileName?: string; sizeBytes?: number; firstBytes?: string };
    const fileName = (body.fileName || "").trim();
    if (!fileName) return jsonError("缺少文件名");
    const sizeBytes = Math.max(0, Number(body.sizeBytes) || 0);
    const extension = fileName.includes(".") ? fileName.split(".").pop()!.toLowerCase() : "";
    const email = identity.actor.email?.toLowerCase();
    const profile = email ? (await getDb().select().from(ldapUsers).where(eq(ldapUsers.email, email)).limit(1))[0] : undefined;
    const department = profile?.department || "待 LDAP 同步";

    // 内容防伪装：与提交接口同一处置逻辑（normal=不一致拒绝+未知转人工；strict=一律拒绝；off=不影响判定）
    const headHex = (body.firstBytes || "").replace(/[^0-9a-fA-F]/g, "");
    const head = new Uint8Array(headHex.length / 2);
    for (let index = 0; index < head.length; index += 1) head[index] = parseInt(headHex.slice(index * 2, index * 2 + 2), 16);
    const sniff = sniffFileType(head);
    const guard = await getContentTypeGuard();
    const guardOutcome = applyContentGuard(guard, extension, sniff);
    if (guardOutcome.verdict === "reject") {
      return Response.json({
        extension, sizeBytes, department, guard,
        detectedKind: sniff.kinds.join(",") || "unknown",
        detectedExtensions: sniff.extensions,
        typeMismatch: isTypeMismatch(extension, sniff),
        verdict: "reject",
        rejectReason: guardOutcome.message,
        action: "拒绝",
        ruleId: "CONTENT-GUARD",
        ruleName: "内容类型防护",
        matched: false,
      });
    }

    const matchedExtensions = guardOutcome.verdict === "pass" ? guardOutcome.extensions : [extension];
    const evaluation = await evaluateFileDetailed(matchedExtensions, sizeBytes, department);
    const matched = evaluation.rule;
    const forcedManual = guardOutcome.verdict === "manual" && matched.action !== "拒绝";
    const action = forcedManual ? "转人工审批" : matched.action;
    const fallbackReason = forcedManual ? guardOutcome.message : evaluation.fallbackReason;
    return Response.json({
      ruleId: matched.id,
      ruleName: matched.name,
      action,
      extension,
      sizeBytes,
      department,
      guard,
      detectedKind: sniff.kinds.join(",") || "unknown",
      detectedExtensions: sniff.extensions,
      typeMismatch: isTypeMismatch(extension, sniff),
      verdict: guardOutcome.verdict,
      matched: matched.id !== "R-FALLBACK",
      skipped: evaluation.skipped,
      fallbackReason,
    });
  } catch (error) {
    return serverError(error, "规则预判失败");
  }
}
