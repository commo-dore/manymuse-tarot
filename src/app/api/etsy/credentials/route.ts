import { NextResponse } from "next/server";
import { isOperator } from "@/lib/auth";
import { etsyConfigured } from "@/lib/etsy";

// Saves Etsy credentials as Vercel *environment variables* (never to the
// repo or database), then triggers a redeploy so they take effect.
// Requires VERCEL_API_TOKEN + VERCEL_PROJECT_ID (+ VERCEL_TEAM_ID) in env.

const FIELDS: Record<string, string> = {
  api_key: "ETSY_API_KEY",
  shared_secret: "ETSY_SHARED_SECRET",
  shop_id: "ETSY_SHOP_ID",
};

export async function GET() {
  if (!(await isOperator()))
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({
    configured: etsyConfigured(),
    can_save: !!(process.env.VERCEL_API_TOKEN && process.env.VERCEL_PROJECT_ID),
  });
}

export async function POST(req: Request) {
  if (!(await isOperator()))
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const token = process.env.VERCEL_API_TOKEN;
  const projectId = process.env.VERCEL_PROJECT_ID;
  const teamId = process.env.VERCEL_TEAM_ID;
  if (!token || !projectId)
    return NextResponse.json(
      {
        error:
          "Server is missing VERCEL_API_TOKEN/VERCEL_PROJECT_ID — add the Etsy env vars via the Vercel dashboard instead.",
      },
      { status: 503 }
    );

  const body = await req.json().catch(() => ({}));
  const url = `https://api.vercel.com/v10/projects/${projectId}/env?upsert=true${teamId ? `&teamId=${teamId}` : ""}`;
  const saved: string[] = [];

  for (const [field, envName] of Object.entries(FIELDS)) {
    const value = (body?.[field] ?? "").trim();
    if (!value) continue;
    const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          key: envName,
          value,
          type: "encrypted",
          target: ["production", "preview"],
        }),
      });
    if (res.ok) saved.push(envName);
    else {
      const err = await res.json().catch(() => ({}));
      return NextResponse.json(
        { error: `Failed saving ${envName}: ${err?.error?.message ?? res.status}` },
        { status: 502 }
      );
    }
  }

  return NextResponse.json({
    ok: true,
    saved,
    note: "Env vars saved. They apply on the next deployment — redeploy to activate, then use Connect Etsy.",
  });
}
