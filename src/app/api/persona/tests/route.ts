import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { isOperator } from "@/lib/auth";
import { OSHO_ZEN_CARDS } from "@/lib/cards";

const VALID_CARDS = new Set(OSHO_ZEN_CARDS.map((c) => c.name));

export async function GET() {
  if (!(await isOperator()))
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const supabase = db();
  const { data: tests } = await supabase
    .from("persona_tests")
    .select("*")
    .order("created_at", { ascending: true });
  const { data: runs } = await supabase
    .from("persona_test_runs")
    .select("id, test_id, model, output, created_at")
    .order("created_at", { ascending: false })
    .limit(100);
  return NextResponse.json({ tests: tests ?? [], runs: runs ?? [] });
}

export async function POST(req: Request) {
  if (!(await isOperator()))
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const cards: string[] = Array.isArray(body?.cards) ? body.cards.filter(Boolean) : [];
  if (!body?.name || !body?.message || cards.length < 1 || cards.length > 3)
    return NextResponse.json(
      { error: "Name, message and 1-3 cards are required." },
      { status: 400 }
    );
  if (new Set(cards).size !== cards.length || cards.some((c) => !VALID_CARDS.has(c)))
    return NextResponse.json({ error: "Cards must be unique, valid Osho Zen cards." }, { status: 400 });

  const supabase = db();
  const row = {
    name: body.name,
    customer_name: body.customer_name || "Customer",
    message: body.message,
    cards,
  };
  if (body.id) {
    const { error } = await supabase.from("persona_tests").update(row).eq("id", body.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, id: body.id });
  }
  const { data, error } = await supabase
    .from("persona_tests")
    .insert(row)
    .select("id")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, id: data.id });
}

export async function DELETE(req: Request) {
  if (!(await isOperator()))
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await req.json().catch(() => ({}));
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const { error } = await db().from("persona_tests").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
