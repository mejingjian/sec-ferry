// 内容类型防伪装的策略层（normal/strict/off），提交接口与预判接口共用，保证口径一致。
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { integrationSettings } from "@/db/schema";
import { isTypeMismatch, type SniffResult } from "@/lib/file-type";

export type ContentTypeGuard = "normal" | "strict" | "off";

export async function getContentTypeGuard(): Promise<ContentTypeGuard> {
  try {
    const row = (await getDb().select().from(integrationSettings).where(eq(integrationSettings.id, "ldap")).limit(1))[0];
    const value = (row?.contentTypeGuard || "normal").trim().toLowerCase();
    return value === "strict" || value === "off" ? (value as ContentTypeGuard) : "normal";
  } catch {
    return "normal";
  }
}

export type GuardOutcome =
  | { verdict: "reject"; reason: string; message: string }
  | { verdict: "manual"; reason: string; message: string }
  | { verdict: "pass"; extensions: string[] };

/**
 * 按策略处置嗅探结果：
 * - off：仅记录，不影响判定（回退开关）
 * - normal（用户定稿）：声明与内容不一致 → **拒绝**（提示格式不正确）；未知类型 → 强制转人工
 * - strict：不一致与未知类型一律拒绝
 * - 一致且已知 → 参与匹配的后缀集合 = 声明后缀 ∪ 嗅探候选后缀（由规则引擎从严合并）
 */
export function applyContentGuard(guard: ContentTypeGuard, declaredExtension: string, sniff: SniffResult): GuardOutcome {
  if (guard === "off") return { verdict: "pass", extensions: [declaredExtension] };
  const declared = declaredExtension.trim().toLowerCase().replace(/^\.+/, "");
  const mismatch = isTypeMismatch(declared, sniff);
  if (mismatch) {
    const actual = sniff.kinds.join("/") || "未知类型";
    return {
      verdict: "reject",
      reason: "CONTENT_TYPE_MISMATCH",
      message: `文件格式不正确：声明后缀 .${declared || "（无）"} 与实际内容类型（${actual}）不符，已拒绝。请勿通过修改文件后缀绕过审批。`,
    };
  }
  if (!sniff.kinds.length) {
    if (guard === "strict") {
      return {
        verdict: "reject",
        reason: "CONTENT_TYPE_UNKNOWN",
        message: "文件格式不正确：无法识别文件实际内容类型（未知类型），已拒绝。",
      };
    }
    return { verdict: "manual", reason: "CONTENT_TYPE_UNKNOWN", message: "命中内容安全兜底：无法识别文件实际内容类型（未知类型），转人工审批" };
  }
  return { verdict: "pass", extensions: Array.from(new Set([declared, ...sniff.extensions]).values()) };
}
