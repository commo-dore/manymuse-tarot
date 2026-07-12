import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { isOperator } from "@/lib/auth";
import { fetchOpenReceipts } from "@/lib/etsy";

// Pull open Etsy receipts into the operator queue. Etsy-pulled orders and
// manual orders are identical from the workflow's perspective — same
// table, same statuses — Etsy ones just carry extra metadata.
export async function POST() {
  if (!(await isOperator()))
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let receipts;
  try {
    receipts = await fetchOpenReceipts();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }

  const supabase = db();
  let imported = 0;
  for (const r of receipts) {
    const username = `etsy-${r.buyer_user_id}`;
    const { data: existing } = await supabase
      .from("orders")
      .select("id")
      .eq("etsy_receipt_id", String(r.receipt_id))
      .maybeSingle();
    if (existing) continue;

    const { data: customer } = await supabase
      .from("customers")
      .upsert(
        { etsy_username: username, display_name: r.name || username },
        { onConflict: "etsy_username" }
      )
      .select()
      .single();
    if (!customer) continue;

    const { error } = await supabase.from("orders").insert({
      customer_id: customer.id,
      order_ref: String(r.receipt_id),
      customer_message:
        r.message_from_buyer?.trim() ||
        "(no message from buyer — ask via Etsy or read on the order intent)",
      source: "etsy",
      etsy_receipt_id: String(r.receipt_id),
      etsy_buyer_username: r.name || username,
      placed_at: new Date(r.created_timestamp * 1000).toISOString(),
    });
    if (!error) imported++;
  }

  return NextResponse.json({ ok: true, fetched: receipts.length, imported });
}
