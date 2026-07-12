import { NextResponse } from "next/server";
import { makeSession, oauthConfigured, OPERATOR_COOKIE } from "@/lib/auth";

// Shared-password fallback — active ONLY until Google OAuth credentials
// are configured, then this endpoint refuses.
export async function POST(req: Request) {
  if (oauthConfigured()) {
    return NextResponse.json(
      { error: "Password sign-in is disabled — use Google sign-in." },
      { status: 403 }
    );
  }
  const { password } = await req.json().catch(() => ({}));
  if (!password || password !== process.env.OPERATOR_PASSWORD) {
    return NextResponse.json({ error: "Wrong password" }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(OPERATOR_COOKIE, makeSession("password-operator"), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 30,
    path: "/",
  });
  return res;
}
