import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { db } from "@/lib/supabase";
import { etsyEnv } from "@/lib/etsy";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const jar = await cookies();
  const [savedState, verifier] = (jar.get("mm_etsy_pkce")?.value ?? "").split(".");

  if (!code || !state || state !== savedState || !verifier)
    return NextResponse.json({ error: "Invalid Etsy OAuth state" }, { status: 400 });

  const res = await fetch("https://api.etsy.com/v3/public/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: etsyEnv().apiKey,
      redirect_uri: `${url.origin}/api/etsy/callback`,
      code,
      code_verifier: verifier,
    }),
  });
  const json = await res.json();
  if (!json.access_token)
    return NextResponse.json(
      { error: "Etsy token exchange failed", detail: json },
      { status: 502 }
    );

  // Discover the shop ID for the connected account (v3 /users/me carries
  // shop_id), so the operator never has to enter it manually.
  let shopId: string | null = null;
  try {
    const meRes = await fetch("https://api.etsy.com/v3/application/users/me", {
      headers: {
        "x-api-key": etsyEnv().apiKey,
        Authorization: `Bearer ${json.access_token}`,
      },
    });
    const me = await meRes.json();
    if (me?.shop_id) shopId = String(me.shop_id);
  } catch {
    // non-fatal — pull will ask to reconnect if missing
  }

  await db()
    .from("etsy_tokens")
    .upsert({
      id: 1,
      access_token: json.access_token,
      refresh_token: json.refresh_token,
      expires_at: new Date(Date.now() + (json.expires_in ?? 3600) * 1000).toISOString(),
      updated_at: new Date().toISOString(),
      shop_id: shopId,
    });

  const out = NextResponse.redirect(`${url.origin}/operator/settings?etsy=connected`);
  out.cookies.delete("mm_etsy_pkce");
  return out;
}
