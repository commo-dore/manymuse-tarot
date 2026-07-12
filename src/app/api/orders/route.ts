import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const etsy_username = (body?.etsy_username ?? "").trim().toLowerCase();
  const message = (body?.message ?? "").trim();
  const order_ref = (body?.order_ref ?? "").trim();
  if (!etsy_username || !message) {
    return NextResponse.json(
      { error: "Etsy username and your message are required." },
      { status: 400 }
    );
  }
  if (message.length > 1024) {
    return NextResponse.json(
      { error: "Your message is limited to 1024 characters." },
      { status: 400 }
    );
  }

  const supabase = db();
  const { data: customer, error: cErr } = await supabase
    .from("customers")
    .upsert(
      { etsy_username, display_name: body?.name?.trim() || etsy_username },
      { onConflict: "etsy_username" }
    )
    .select()
    .single();
  if (cErr || !customer)
    return NextResponse.json({ error: cErr?.message }, { status: 500 });

  const { data: order, error: oErr } = await supabase
    .from("orders")
    .insert({
      customer_id: customer.id,
      order_ref,
      customer_message: message,
    })
    .select()
    .single();
  if (oErr)
    return NextResponse.json({ error: oErr.message }, { status: 500 });

  const { count } = await supabase
    .from("orders")
    .select("id", { count: "exact", head: true })
    .eq("customer_id", customer.id);

  return NextResponse.json({ ok: true, order_id: order.id, returning: (count ?? 1) > 1 });
}
