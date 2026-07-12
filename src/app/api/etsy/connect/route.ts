import { NextResponse } from "next/server";
import { randomBytes, createHash } from "crypto";
import { isOperator } from "@/lib/auth";
import { etsyConfigured, etsyEnv } from "@/lib/etsy";

// Etsy OAuth 2.0 (authorization code + PKCE).
export async function GET(req: Request) {
  if (!(await isOperator()))
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!etsyConfigured())
    return NextResponse.json(
      { error: "Set the Etsy credentials (env vars) first." },
      { status: 503 }
    );

  const origin = new URL(req.url).origin;
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("hex");

  const params = new URLSearchParams({
    response_type: "code",
    client_id: etsyEnv().apiKey,
    redirect_uri: `${origin}/api/etsy/callback`,
    scope: "transactions_r",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  const res = NextResponse.redirect(`https://www.etsy.com/oauth/connect?${params}`);
  res.cookies.set("mm_etsy_pkce", `${state}.${verifier}`, {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    maxAge: 600,
    path: "/",
  });
  return res;
}
