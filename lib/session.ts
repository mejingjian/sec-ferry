import { env } from "cloudflare:workers";

export type SessionAuthMethod = "ldap" | "local" | "self-declared" | "sso";

export type SessionIdentity = { email: string | null; displayName: string; local?: boolean; authMethod?: SessionAuthMethod };

const COOKIE_NAME = "tp_session";
const TTL_SECONDS = 12 * 60 * 60;

function sessionSecret(): string {
  const configured = env.CONFIG_ENCRYPTION_KEY as string | undefined;
  return configured || "local-dev-session-secret-do-not-use-in-prod";
}

function encodeBase64Url(input: Uint8Array): string {
  let binary = "";
  for (const byte of input) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeBase64Url(input: string): Uint8Array {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const b64 = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function sign(payload: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(sessionSecret()), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function createSession(identity: SessionIdentity): Promise<string> {
  const payload = JSON.stringify({ ...identity, exp: Math.floor(Date.now() / 1000) + TTL_SECONDS });
  const encoded = encodeBase64Url(new TextEncoder().encode(payload));
  const signature = await sign(encoded);
  return `${encoded}.${signature}`;
}

export async function readSession(request: Request): Promise<SessionIdentity | null> {
  const cookie = request.headers.get("cookie") || "";
  const pair = cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE_NAME}=`));
  if (!pair) return null;
  const raw = pair.slice(COOKIE_NAME.length + 1);
  const dot = raw.lastIndexOf(".");
  if (dot <= 0) return null;
  const encoded = raw.slice(0, dot);
  const signature = raw.slice(dot + 1);
  if ((await sign(encoded)) !== signature) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(decodeBase64Url(encoded))) as { email?: string; displayName?: string; local?: boolean; authMethod?: SessionAuthMethod; exp?: number };
    if (typeof payload.exp !== "number" || payload.exp < Date.now() / 1000) return null;
    return {
      email: payload.email ?? null,
      displayName: String(payload.displayName || ""),
      local: payload.local === true,
      authMethod: payload.authMethod,
    };
  } catch {
    return null;
  }
}

export function sessionCookieHeader(value: string | null): string {
  if (value === null) return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
  return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${TTL_SECONDS}`;
}
