// 审计事件的哈希链计算（纯 ESM）：应用与运维 CLI 共用的**唯一**一份实现。
//
// 为什么必须共享：审计日志的价值建立在「链没断」上 —— 每条事件的 hash = SHA-256(上一条 hash | 时间 |
// 操作者 | 动作 | 对象 | 结果 | 明细)。只要有一处用不同的拼接顺序或不同的空值处理写进去，
// 整条链的校验就会从那一条开始全部失败，而审计日志一旦失去可信性就无法补救。
// 运维侧（reset-admin / rekey 这类需要直连 SQLite 的应急操作）同样要留痕，
// 因此把「怎么算这条 hash」收敛到本文件，任何一侧都不要再手写拼接。

/** 链首的前置 hash 占位符（第一条事件没有上一条） */
export const AUDIT_GENESIS = "GENESIS";

/**
 * 参与 hash 的原始载荷。
 * ⚠️ 字段的**顺序与分隔符**是既有数据的兼容契约，改动会让历史事件的 hash 全部对不上。
 * @param {{ previousHash?: string | null, at: string, actorId: string, action: string, objectId: string, result: string, detail?: string | null }} event
 * @returns {string}
 */
export function auditPayload(event) {
  return [
    event.previousHash ?? AUDIT_GENESIS,
    event.at,
    event.actorId,
    event.action,
    event.objectId,
    event.result,
    event.detail ?? "",
  ].join("|");
}

/**
 * 计算某条审计事件的 hash。
 * @param {{ previousHash?: string | null, at: string, actorId: string, action: string, objectId: string, result: string, detail?: string | null }} event
 * @returns {Promise<string>} 64 位十六进制
 */
export async function auditHash(event) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(auditPayload(event)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
