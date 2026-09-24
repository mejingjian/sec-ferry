// 登录失败计数与锁定：防域账号在线爆破。
//
// 计数落在 D1（而不是内存）是硬要求：workerd 实例会随负载/发布重建，内存计数等于没有防护。
// 标识（identifier）= 小写的域账号或邮箱，与来源 IP 一并留痕，便于事后审计「谁在扫账号」。
//
// 阈值默认 5 次 / 锁 15 分钟，可用环境变量覆盖：
//   LOGIN_MAX_FAILURES=5   LOGIN_LOCK_MINUTES=15

import { env } from "cloudflare:workers";
import { desc, eq, isNotNull } from "drizzle-orm";
import { getDb } from "@/db";
import { loginAttempts } from "@/db/schema";

const DEFAULT_MAX_FAILURES = 5;
const DEFAULT_LOCK_MINUTES = 15;

function positiveNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loginPolicy() {
  return {
    maxFailures: Math.floor(positiveNumber(env.LOGIN_MAX_FAILURES, DEFAULT_MAX_FAILURES)),
    lockMs: positiveNumber(env.LOGIN_LOCK_MINUTES, DEFAULT_LOCK_MINUTES) * 60_000,
  };
}

export function normalizeIdentifier(value: string): string {
  return value.trim().toLowerCase();
}

export type LoginLockState = { locked: boolean; remainingMinutes: number; failureCount: number };

export async function loginLockState(identifier: string): Promise<LoginLockState> {
  const rows = await getDb().select().from(loginAttempts).where(eq(loginAttempts.identifier, identifier)).limit(1);
  const row = rows[0];
  if (!row) return { locked: false, remainingMinutes: 0, failureCount: 0 };
  if (!row.lockedUntil) return { locked: false, remainingMinutes: 0, failureCount: row.failureCount };
  const until = new Date(row.lockedUntil).getTime();
  if (until <= Date.now()) return { locked: false, remainingMinutes: 0, failureCount: 0 };
  return { locked: true, remainingMinutes: Math.max(1, Math.ceil((until - Date.now()) / 60_000)), failureCount: row.failureCount };
}

export type LoginFailureState = { failureCount: number; lockedUntil: string | null; remainingAttempts: number };

export async function registerLoginFailure(identifier: string, ip: string | null): Promise<LoginFailureState> {
  const { maxFailures, lockMs } = loginPolicy();
  const db = getDb();
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const rows = await db.select().from(loginAttempts).where(eq(loginAttempts.identifier, identifier)).limit(1);
  const previous = rows[0];
  // 只在「上一次失败仍在窗口内」时累加；否则从头计数（避免把很久以前的失败也算进来，
  // 例如昨天错 4 次、今天第 1 次就被锁）。
  //
  // ⚠️ 这里不能用「lockedUntil 为空 ⇒ 视为已过期」来判断 —— 未锁定过的行 lockedUntil 本来就是空，
  //    那样会让每次失败都把计数重置为 1，锁定永远不会触发（本轮回归确实抓到了这个 bug）。
  const lastFailureMs = previous?.lastFailureAt ? new Date(previous.lastFailureAt).getTime() : null;
  const continuous = lastFailureMs !== null && now - lastFailureMs <= lockMs;
  const failureCount = (continuous ? previous?.failureCount ?? 0 : 0) + 1;
  const willLock = failureCount >= maxFailures;
  const lockedUntil = willLock ? new Date(now + lockMs).toISOString() : null;
  const values = {
    identifier,
    lastIp: ip,
    // 锁定瞬间把计数清零：锁到期后从干净状态重新计数
    failureCount: willLock ? 0 : failureCount,
    firstFailureAt: continuous ? previous?.firstFailureAt ?? nowIso : nowIso,
    lastFailureAt: nowIso,
    lockedUntil,
    updatedAt: nowIso,
  };
  await db.insert(loginAttempts).values(values).onConflictDoUpdate({ target: loginAttempts.identifier, set: values });
  return { failureCount, lockedUntil, remainingAttempts: Math.max(0, maxFailures - failureCount) };
}

export async function clearLoginFailures(identifier: string): Promise<void> {
  await getDb().delete(loginAttempts).where(eq(loginAttempts.identifier, identifier));
}

/** 当前处于锁定状态的标识（管理员排查用） */
export async function listLockedIdentifiers(limit = 50) {
  const rows = await getDb().select().from(loginAttempts).where(isNotNull(loginAttempts.lockedUntil)).orderBy(desc(loginAttempts.updatedAt)).limit(limit);
  return rows.filter((row) => row.lockedUntil && new Date(row.lockedUntil).getTime() > Date.now());
}
