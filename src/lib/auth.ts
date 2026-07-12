import { cookies } from "next/headers";
import { createHmac, timingSafeEqual } from "crypto";

const COOKIE = "mm_operator";

// Operator access:
// - Google OAuth (allowlisted emails) when GOOGLE_CLIENT_ID/SECRET are set.
// - Shared-password fallback ONLY while OAuth is not configured, so the
//   panel can't be locked out before credentials arrive. Once OAuth env
//   vars exist, the password path is disabled entirely.
export const OPERATOR_ALLOWLIST = (
  process.env.OPERATOR_ALLOWLIST ??
  "n.aldarij@gmail.com,merlijn@commo-dore.com"
)
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

export function oauthConfigured(): boolean {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

function secret(): string {
  return (
    process.env.SESSION_SECRET ?? process.env.OPERATOR_PASSWORD ?? "dev-secret"
  );
}

function sign(value: string): string {
  return createHmac("sha256", secret()).update(value).digest("hex");
}

export function makeSession(email: string): string {
  const payload = Buffer.from(email.toLowerCase()).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function verifySession(token: string | undefined): string | null {
  if (!token) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = sign(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const email = Buffer.from(payload, "base64url").toString("utf-8");
  if (email === "password-operator") return !oauthConfigured() ? email : null;
  return OPERATOR_ALLOWLIST.includes(email) ? email : null;
}

export async function isOperator(): Promise<boolean> {
  const jar = await cookies();
  return verifySession(jar.get(COOKIE)?.value) !== null;
}

export const OPERATOR_COOKIE = COOKIE;
