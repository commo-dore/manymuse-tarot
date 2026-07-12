import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { isOperator } from "@/lib/auth";
import { generateReading } from "@/lib/reading";
import { OSHO_ZEN_CARDS } from "@/lib/cards";

export const maxDuration = 300;

const VALID_CARDS = new Set(OSHO_ZEN_CARDS.map((c) => c.name));

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!(await isOperator()))
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const comments: string = body?.comments ?? "";

  const supabase = db();
  const { data: order } = await supabase
    .from("orders")
    .select("*, customers(*)")
    .eq("id", id)
    .single();
  if (!order)
    return NextResponse.json({ error: "Order not found" }, { status: 404 });
  if (order.status === "approved" || order.status === "sent")
    return NextResponse.json({ error: "Order already approved" }, { status: 400 });

  // Cards: slot order is meaningful and preserved as given.
  const cards: string[] = Array.isArray(body?.cards)
    ? body.cards.filter(Boolean)
    : (order.cards as string[]) ?? [];
  if (cards.length < 1 || cards.length > 3)
    return NextResponse.json({ error: "Pick 1 to 3 cards first" }, { status: 400 });
  const invalid = cards.find((c) => !VALID_CARDS.has(c));
  if (invalid)
    return NextResponse.json({ error: `Unknown card: ${invalid}` }, { status: 400 });
  await supabase
    .from("orders")
    .update({ cards, card_name: cards[0] })
    .eq("id", id);

  const { data: drafts } = await supabase
    .from("readings")
    .select("version, content")
    .eq("order_id", id)
    .order("version", { ascending: false })
    .limit(1);
  const latest = drafts?.[0];

  const { data: pastOrders } = await supabase
    .from("orders")
    .select("id, customer_message, cards, card_name, placed_at, readings(content, version)")
    .eq("customer_id", order.customer_id)
    .neq("id", id)
    .order("placed_at", { ascending: false })
    .limit(3);

  const history = (pastOrders ?? []).map((o) => {
    const readings = (o.readings ?? []) as { content: string; version: number }[];
    const last = readings.sort((a, b) => b.version - a.version)[0];
    const pastCards =
      ((o.cards as string[]) ?? []).length > 0
        ? (o.cards as string[])
        : o.card_name
          ? [o.card_name]
          : [];
    return {
      message: o.customer_message,
      cards: pastCards,
      reading: last?.content ?? null,
      date: new Date(o.placed_at).toDateString(),
    };
  });

  const { final, chain } = await generateReading({
    customerName: order.customers.display_name ?? order.customers.etsy_username,
    customerMessage: order.customer_message,
    cards,
    operatorComments: comments,
    previousDraft: latest?.content,
    history,
    customerNotes: order.customers.notes || undefined,
  });

  const version = (latest?.version ?? 0) + 1;
  const { error } = await supabase.from("readings").insert({
    order_id: id,
    version,
    content: final,
    operator_comments: comments,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  await supabase.from("orders").update({ status: "draft" }).eq("id", id);

  return NextResponse.json({ ok: true, content: final, version, chain });
}
