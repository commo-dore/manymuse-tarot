import { redirect, notFound } from "next/navigation";
import { db } from "@/lib/supabase";
import { isOperator } from "@/lib/auth";
import Workroom from "./workroom";

export const dynamic = "force-dynamic";

export default async function OrderPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  if (!(await isOperator())) redirect("/operator/login");
  const { id } = await params;

  const supabase = db();
  const { data: order } = await supabase
    .from("orders")
    .select("*, customers(*), readings(content, version, operator_comments, created_at)")
    .eq("id", id)
    .single();
  if (!order) notFound();

  const { data: pastOrders } = await supabase
    .from("orders")
    .select("id, customer_message, card_name, placed_at, status")
    .eq("customer_id", order.customer_id)
    .neq("id", id)
    .order("placed_at", { ascending: false });

  const readings = (order.readings ?? []).sort(
    (a: { version: number }, b: { version: number }) => b.version - a.version
  );

  return (
    <Workroom
      order={{
        id: order.id,
        status: order.status,
        placed_at: order.placed_at,
        card_name: order.card_name,
        customer_message: order.customer_message,
        order_ref: order.order_ref,
      }}
      customer={{
        etsy_username: order.customers.etsy_username,
        display_name: order.customers.display_name,
        notes: order.customers.notes,
      }}
      latestReading={readings[0] ?? null}
      versions={readings.length}
      pastOrders={pastOrders ?? []}
    />
  );
}
