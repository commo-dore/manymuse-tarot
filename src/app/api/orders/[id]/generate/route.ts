import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { isOperator } from "@/lib/auth";
import {
  buildBase,
  chainPrompt,
  revisionPrompt,
  persona,
  llm,
  llmStream,
  type ReadingInput,
} from "@/lib/reading";
import { OSHO_ZEN_CARDS } from "@/lib/cards";
import { loadGlobalInstructions } from "@/lib/persona-db";

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
  const personaNotes: string = body?.persona_notes ?? "";

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

  // Cards: slot order is meaningful; duplicates rejected (a real deck has
  // one of each card).
  const cards: string[] = Array.isArray(body?.cards)
    ? body.cards.filter(Boolean)
    : (order.cards as string[]) ?? [];
  if (cards.length < 1 || cards.length > 3)
    return NextResponse.json({ error: "Pick 1 to 3 cards first" }, { status: 400 });
  if (new Set(cards).size !== cards.length)
    return NextResponse.json(
      { error: "The same card can't be drawn twice — each card exists once in the deck." },
      { status: 400 }
    );
  const invalid = cards.find((c) => !VALID_CARDS.has(c));
  if (invalid)
    return NextResponse.json({ error: `Unknown card: ${invalid}` }, { status: 400 });

  const previousCards = ((order.cards as string[]) ?? []).join("|");
  await supabase
    .from("orders")
    .update({ cards, card_name: cards[0], persona_notes: personaNotes })
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

  const input: ReadingInput = {
    customerName: order.customers.display_name ?? order.customers.etsy_username,
    customerMessage: order.customer_message,
    cards,
    history,
    customerNotes: order.customers.notes || undefined,
    personaNotes,
  };

  const globalInstructions = await loadGlobalInstructions(supabase);

  let system: string;
  try {
    system = persona(personaNotes, globalInstructions);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
  const base = buildBase(input);

  const version = (latest?.version ?? 0) + 1;
  const save = async (finalText: string) => {
    await supabase.from("readings").insert({
      order_id: id,
      version,
      content: finalText,
      operator_comments: comments,
    });
    await supabase.from("orders").update({ status: "draft" }).eq("id", id);
  };

  // Regenerate = revise the existing layered draft (do NOT re-read the
  // cards). Only if the cards changed do we re-run the full chain.
  const sameCards = previousCards === cards.join("|");
  let finalPrompt: string;
  if (latest && sameCards) {
    finalPrompt = revisionPrompt(base, cards, comments, latest.content);
  } else {
    // Run all but the last card non-streamed, then stream the final layer.
    let current = "";
    try {
      for (let i = 0; i < cards.length - 1; i++) {
        const r = await llm(system, chainPrompt(base, cards, i, current));
        current = r.text;
      }
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 502 });
    }
    finalPrompt = chainPrompt(base, cards, cards.length - 1, current);
  }

  const result = llmStream({ system, prompt: finalPrompt, onFinish: save });
  return result.toTextStreamResponse();
}
