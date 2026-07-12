import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { isOperator } from "@/lib/auth";

const HOLD_MS = 30 * 60 * 1000; // 30 minutes after order placed

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!(await isOperator()))
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const supabase = db();
  const { data: order } = await supabase
    .from("orders")
    .select("id, status, placed_at")
    .eq("id", id)
    .single();
  if (!order)
    return NextResponse.json({ error: "Order not found" }, { status: 404 });
  if (order.status !== "draft")
    return NextResponse.json(
      { error: "Generate a reading before approving." },
      { status: 400 }
    );

  const readyAt = new Date(order.placed_at).getTime() + HOLD_MS;
  const waitMs = readyAt - Date.now();
  if (waitMs > 0) {
    return NextResponse.json(
      {
        error: `Too early — readings send no sooner than 30 minutes after the order. Ready in ${Math.ceil(waitMs / 60000)} min.`,
        ready_at: new Date(readyAt).toISOString(),
      },
      { status: 425 }
    );
  }

  await supabase
    .from("orders")
    .update({ status: "approved", approved_at: new Date().toISOString() })
    .eq("id", id);

  return NextResponse.json({ ok: true });
}
