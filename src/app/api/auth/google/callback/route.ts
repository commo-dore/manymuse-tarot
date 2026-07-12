import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  makeSession,
  OPERATOR_ALLOWLIST,
  OPERATOR_COOKIE,
} from "@/lib/auth";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const jar = await cookies();
  const savedState = jar.get("mm_oauth_state")?.value;

  const fail = (msg: string, status = 403) =>
    new NextResponse(
      `<meta charset="utf-8"><body style="font-family:system-ui;background:#131020;color:#e9e4f5;padding:4rem;text-align:center"><h2>Access denied</h2><p>${msg}</p><a style="color:#a78bfa" href="/operator/login">Back to sign-in</a></body>`,
      { status, headers: { "Content-Type": "text/html" } }
    );

  if (!code || !state || state !== savedState)
    return fail("Invalid sign-in attempt (state mismatch).", 400);

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: `${url.origin}/api/auth/google/callback`,
      grant_type: "authorization_code",
    }),
  });
  const token = await tokenRes.json();
  if (!token.id_token) return fail("Google sign-in failed.", 502);

  // id_token is received directly from Google over TLS — decoding the
  // payload without signature verification is safe in this exchange.
  const claims = JSON.parse(
    Buffer.from(token.id_token.split(".")[1], "base64url").toString("utf-8")
  );
  const email = (claims.email ?? "").toLowerCase();
  if (!claims.email_verified || !OPERATOR_ALLOWLIST.includes(email))
    return fail(`${email || "This account"} is not authorized for the operator panel.`);

  const res = NextResponse.redirect(`${url.origin}/operator`);
  res.cookies.set(OPERATOR_COOKIE, makeSession(email), {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    maxAge: 60 * 60 * 24 * 30,
    path: "/",
  });
  res.cookies.delete("mm_oauth_state");
  return res;
}
