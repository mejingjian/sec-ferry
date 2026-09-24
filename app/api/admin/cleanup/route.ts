import { cleanupExpiredQuarantine, requireAdministrator, serverError } from "@/lib/server";

// 管理员手动触发：隔离区到期清理（幂等，可重复调用）
export async function POST(request: Request) {
  try {
    await requireAdministrator(request);
    const { removed, skipped } = await cleanupExpiredQuarantine();
    return Response.json({ ok: true, quarantineRemoved: removed, quarantineSkipped: skipped });
  } catch (error) {
    return serverError(error, "清理失败");
  }
}
