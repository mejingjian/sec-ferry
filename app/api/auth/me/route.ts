import { jsonError, roleFor } from "@/lib/server";
import { readSession } from "@/lib/session";

export async function GET(request: Request) {
  try {
    const hasOaiIdentity = Boolean(request.headers.get("oai-authenticated-user-id") || request.headers.get("oai-authenticated-user-email"));
    const session = await readSession(request);
    if (!hasOaiIdentity && !session) return Response.json({ error: "未登录" }, { status: 401 });
    const identity = await roleFor(request);
    if (identity.role === "未登录" || !identity.actor) return Response.json({ error: "未登录" }, { status: 401 });
    return Response.json({ displayName: identity.actor.display, email: identity.actor.email, role: identity.role });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "读取当前用户失败", 500);
  }
}
