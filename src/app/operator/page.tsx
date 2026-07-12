import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/lib/supabase";
import { isOperator } from "@/lib/auth";

export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<string, string> = {
  new: "Needs card",
  draft: "Draft ready",
  approved: "Approved",
  sent: "Sent",
};

export default async function Dashboard() {
  if (!(await isOperator())) redirect("/operator/login");

  const supabase = db();
  const { data: orders } = await supabase
    .from("orders")
    .select("id, customer_id, status, placed_at, cards, card_name, source, customer_message, customers(etsy_username, display_name)")
    .order("placed_at", { ascending: false })
    .limit(100);

  const { data: allCustomerIds } = await supabase
    .from("orders")
    .select("customer_id");
  const counts = new Map<string, number>();
  for (const row of allCustomerIds ?? [])
    counts.set(row.customer_id, (counts.get(row.customer_id) ?? 0) + 1);

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <div className="flex items-center justify-between">
        <h1 className="font-[family-name:var(--font-serif)] text-3xl">
          Reading queue
        </h1>
        <Link href="/operator/settings" className="text-sm text-violet-300/80 hover:text-violet-200">
          Etsy settings →
        </Link>
      </div>
      <div className="mt-8 space-y-3">
        {(orders ?? []).map((o) => {
          const customer = o.customers as unknown as {
            etsy_username: string;
            display_name: string | null;
          };
          const holdUntil = new Date(o.placed_at).getTime() + 30 * 60 * 1000;
          const held = Date.now() < holdUntil && o.status !== "sent";
          return (
            <Link
              key={o.id}
              href={`/operator/orders/${o.id}`}
              className="block rounded-2xl border border-white/10 bg-white/[0.04] hover:bg-white/[0.08] p-5 transition"
            >
              <div className="flex items-center justify-between gap-4">
                <div>
                  <span className="font-medium">
                    {customer?.display_name || customer?.etsy_username}
                  </span>
                  <span className="ml-2 text-sm text-white/50">
                    @{customer?.etsy_username}
                  </span>
                  {(counts.get(o.customer_id) ?? 0) > 1 && (
                    <span className="ml-2 rounded-full bg-amber-400/15 text-amber-300 text-xs px-2 py-0.5">
                      returning
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2 text-xs">
                  {o.source === "etsy" && (
                    <span className="rounded-full bg-teal-400/15 text-teal-300 px-2 py-0.5">
                      etsy
                    </span>
                  )}
                  {held && (
                    <span className="rounded-full bg-sky-400/15 text-sky-300 px-2 py-0.5">
                      30-min hold
                    </span>
                  )}
                  <span className="rounded-full bg-violet-400/15 text-violet-300 px-2 py-0.5">
                    {STATUS_LABEL[o.status] ?? o.status}
                  </span>
                </div>
              </div>
              <p className="mt-2 text-sm text-white/60 line-clamp-2">
                {o.customer_message}
              </p>
              <p className="mt-2 text-xs text-white/40">
                {new Date(o.placed_at).toLocaleString()} ·{" "}
                {(o.cards as string[])?.length ? `Cards: ${(o.cards as string[]).join(" → ")}` : o.card_name ? `Card: ${o.card_name}` : "No cards yet"}
              </p>
            </Link>
          );
        })}
        {!orders?.length && (
          <p className="text-white/50">No orders yet.</p>
        )}
      </div>
    </main>
  );
}
