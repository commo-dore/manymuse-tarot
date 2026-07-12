import { NextResponse } from "next/server";
import { sessionToken, OPERATOR_COOKIE } from "@/lib/auth";

export async function POST(req: Request) {
  const { password } = await req.json().catch(() => ({}));
  if (!password || password !== process.env.OPERATOR_PASSWORD) {
    return NextResponse.json({ error: "Wrong password" }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(OPERATOR_COOKIE, sessionToken(), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 30,
    path: "/",
  });
  return res;
}
