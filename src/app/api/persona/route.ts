import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { isOperator } from "@/lib/auth";

export async function GET() {
  if (!(await isOperator()))
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data } = await db()
    .from("persona_settings")
    .select("instructions, updated_at")
    .eq("id", 1)
    .maybeSingle();
  return NextResponse.json({
    instructions: data?.instructions ?? "",
    updated_at: data?.updated_at ?? null,
  });
}

export async function POST(req: Request) {
  if (!(await isOperator()))
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const instructions = String(body?.instructions ?? "");
  const { error } = await db()
    .from("persona_settings")
    .upsert({ id: 1, instructions, updated_at: new Date().toISOString() });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
