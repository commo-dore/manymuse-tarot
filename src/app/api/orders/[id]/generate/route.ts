import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { isOperator } from "@/lib/auth";
import { generateReading } from "@/lib/reading";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!(await isOperator()))
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const cardName: string | undefined = body?.card_name;
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

  const card = cardName ?? order.card_name;
  if (!card)
    return NextResponse.json({ error: "Pick a card first" }, { status: 400 });
  if (card !== order.card_name)
    await supabase.from("orders").update({ card_name: card }).eq("id", id);

  // latest draft (for regeneration)
  const { data: drafts } = await supabase
    .from("readings")
    .select("version, content")
    .eq("order_id", id)
    .order("version", { ascending: false })
    .limit(1);
  const latest = drafts?.[0];

  // repeat-customer history: previous orders + their latest readings
  const { data: pastOrders } = await supabase
    .from("orders")
    .select("id, customer_message, card_name, placed_at, readings(content, version)")
    .eq("customer_id", order.customer_id)
    .neq("id", id)
    .order("placed_at", { ascending: false })
    .limit(3);

  const history = (pastOrders ?? []).map((o) => {
    const readings = (o.readings ?? []) as { content: string; version: number }[];
    const last = readings.sort((a, b) => b.version - a.version)[0];
    return {
      message: o.customer_message,
      card: o.card_name,
      reading: last?.content ?? null,
      date: new Date(o.placed_at).toDateString(),
    };
  });

  const content = await generateReading({
    customerName: order.customers.display_name ?? order.customers.etsy_username,
    customerMessage: order.customer_message,
    cardName: card,
    operatorComments: comments,
    previousDraft: latest?.content,
    history,
    customerNotes: order.customers.notes || undefined,
  });

  const version = (latest?.version ?? 0) + 1;
  const { error } = await supabase.from("readings").insert({
    order_id: id,
    version,
    content,
    operator_comments: comments,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  await supabase.from("orders").update({ status: "draft" }).eq("id", id);

  return NextResponse.json({ ok: true, content, version });
}
