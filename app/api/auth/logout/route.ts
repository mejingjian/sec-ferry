import { sessionCookieHeader } from "@/lib/session";

export async function POST() {
  return Response.json({ ok: true }, { headers: { "set-cookie": sessionCookieHeader(null) } });
}
