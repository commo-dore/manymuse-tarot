import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { isOperator } from "@/lib/auth";

export async function GET() {
  if (!(await isOperator()))
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data } = await db()
    .from("persona_adjustments")
    .select("*")
    .order("created_at", { ascending: false });
  return NextResponse.json({ adjustments: data ?? [] });
}

export async function POST(req: Request) {
  if (!(await isOperator()))
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const text = String(body?.text ?? "").trim();
  if (!text) return NextResponse.json({ error: "text required" }, { status: 400 });
  const supabase = db();
  if (body.id) {
    const { error } = await supabase
      .from("persona_adjustments")
      .update({ text, updated_at: new Date().toISOString() })
      .eq("id", body.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  } else {
    const { error } = await supabase.from("persona_adjustments").insert({ text });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  if (!(await isOperator()))
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await req.json().catch(() => ({}));
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const { error } = await db().from("persona_adjustments").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
