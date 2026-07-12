import { db } from "@/lib/supabase";
import { isOperator } from "@/lib/auth";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!(await isOperator()))
    return new Response("Unauthorized", { status: 401 });

  const { id } = await params;
  const supabase = db();
  const { data: order } = await supabase
    .from("orders")
    .select("order_ref, status, customers(etsy_username), readings(content, version)")
    .eq("id", id)
    .single();
  if (!order) return new Response("Not found", { status: 404 });
  if (order.status !== "approved" && order.status !== "sent")
    return new Response("Reading not approved yet", { status: 400 });

  const readings = (order.readings ?? []) as { content: string; version: number }[];
  const latest = readings.sort((a, b) => b.version - a.version)[0];
  if (!latest) return new Response("No reading", { status: 404 });

  await supabase
    .from("orders")
    .update({ status: "sent", sent_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "approved");

  const customer = order.customers as unknown as { etsy_username: string };
  const filename = `reading-${customer.etsy_username}${order.order_ref ? "-" + order.order_ref : ""}.txt`;
  return new Response(latest.content, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
