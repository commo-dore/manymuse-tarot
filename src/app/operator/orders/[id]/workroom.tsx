"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { OSHO_ZEN_CARDS } from "@/lib/cards";

type Reading = { content: string; version: number } | null;

export default function Workroom({
  order,
  customer,
  latestReading,
  versions,
  pastOrders,
}: {
  order: {
    id: string;
    status: string;
    placed_at: string;
    card_name: string | null;
    customer_message: string;
    order_ref: string | null;
  };
  customer: {
    etsy_username: string;
    display_name: string | null;
    notes: string | null;
  };
  latestReading: Reading;
  versions: number;
  pastOrders: {
    id: string;
    customer_message: string;
    card_name: string | null;
    placed_at: string;
    status: string;
  }[];
}) {
  const router = useRouter();
  const [card, setCard] = useState(order.card_name ?? "");
  const [comments, setComments] = useState("");
  const [busy, setBusy] = useState<"" | "generate" | "approve">("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);

  const holdUntil = new Date(order.placed_at).getTime() + 30 * 60 * 1000;
  const holdRemaining = Math.max(0, holdUntil - now);
  const finalized = order.status === "approved" || order.status === "sent";

  const suits = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const c of OSHO_ZEN_CARDS) {
      map.set(c.suit, [...(map.get(c.suit) ?? []), c.name]);
    }
    return [...map.entries()];
  }, []);

  async function call(path: string, body?: object) {
    setError("");
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error ?? "Request failed");
    return json;
  }

  async function generate() {
    if (!card) {
      setError("Pick the card you drew first.");
      return;
    }
    setBusy("generate");
    try {
      await call(`/api/orders/${order.id}/generate`, {
        card_name: card,
        comments,
      });
      setComments("");
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function approve() {
    setBusy("approve");
    try {
      await call(`/api/orders/${order.id}/approve`);
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function copyReading() {
    if (!latestReading) return;
    await navigator.clipboard.writeText(latestReading.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <Link href="/operator" className="text-sm text-violet-300/80 hover:text-violet-200">
        ← Back to queue
      </Link>

      <div className="mt-4 flex items-start justify-between gap-4">
        <div>
          <h1 className="font-[family-name:var(--font-serif)] text-3xl">
            {customer.display_name || customer.etsy_username}
          </h1>
          <p className="text-sm text-white/50">
            @{customer.etsy_username}
            {order.order_ref ? ` · Order ${order.order_ref}` : ""} ·{" "}
            {new Date(order.placed_at).toLocaleString()}
          </p>
        </div>
        <span className="rounded-full bg-violet-400/15 text-violet-300 text-xs px-3 py-1 whitespace-nowrap">
          {order.status}
        </span>
      </div>

      {pastOrders.length > 0 && (
        <div className="mt-6 rounded-2xl border border-amber-400/25 bg-amber-400/[0.06] p-4">
          <p className="text-amber-300 text-sm font-medium">
            Returning customer — {pastOrders.length} previous order
            {pastOrders.length > 1 ? "s" : ""} (history is woven into the reading automatically)
          </p>
          <ul className="mt-2 space-y-1 text-sm text-white/60">
            {pastOrders.slice(0, 3).map((p) => (
              <li key={p.id}>
                {new Date(p.placed_at).toLocaleDateString()} — {p.card_name ?? "no card"} — “
                {p.customer_message.slice(0, 90)}
                {p.customer_message.length > 90 ? "…" : ""}”
              </li>
            ))}
          </ul>
        </div>
      )}

      <section className="mt-6 rounded-2xl border border-white/10 bg-white/[0.04] p-5">
        <h2 className="text-sm uppercase tracking-widest text-white/40">
          Customer&apos;s message
        </h2>
        <p className="mt-2 whitespace-pre-wrap leading-relaxed">
          {order.customer_message}
        </p>
      </section>

      <section className="mt-6">
        <label className="block text-sm text-white/60 mb-1.5">
          Card you drew (Osho Zen)
        </label>
        <select
          value={card}
          disabled={finalized}
          onChange={(e) => setCard(e.target.value)}
          className="w-full rounded-xl border border-white/10 bg-[#1b1730] px-4 py-3 outline-none focus:border-violet-400/60 disabled:opacity-60"
        >
          <option value="">— pick the card —</option>
          {suits.map(([suit, names]) => (
            <optgroup key={suit} label={suit}>
              {names.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </section>

      {latestReading && (
        <section className="mt-6 rounded-2xl border border-violet-400/25 bg-violet-400/[0.06] p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-sm uppercase tracking-widest text-violet-300/70">
              Reading — draft v{latestReading.version}
              {versions > 1 ? ` (${versions} versions)` : ""}
            </h2>
            <button
              onClick={copyReading}
              className="text-xs rounded-lg border border-white/15 px-3 py-1.5 hover:bg-white/10"
            >
              {copied ? "Copied ✓" : "Copy for Etsy message"}
            </button>
          </div>
          <p className="mt-3 whitespace-pre-wrap leading-relaxed font-[family-name:var(--font-serif)] text-lg">
            {latestReading.content}
          </p>
        </section>
      )}

      {!finalized && (
        <section className="mt-6 space-y-3">
          <textarea
            value={comments}
            onChange={(e) => setComments(e.target.value)}
            rows={3}
            placeholder="Adjustments for the next version (tone, focus, things to add or remove)…"
            className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 outline-none focus:border-violet-400/60 placeholder:text-white/25"
          />
          {error && <p className="text-rose-300 text-sm">{error}</p>}
          <div className="flex gap-3">
            <button
              onClick={generate}
              disabled={busy !== ""}
              className="flex-1 rounded-xl border border-violet-400/50 py-3 font-medium hover:bg-violet-400/10 disabled:opacity-50"
            >
              {busy === "generate"
                ? "Writing…"
                : latestReading
                  ? "Regenerate"
                  : "Generate reading"}
            </button>
            <button
              onClick={approve}
              disabled={busy !== "" || !latestReading || holdRemaining > 0}
              title={
                holdRemaining > 0
                  ? "Readings send no sooner than 30 min after the order"
                  : undefined
              }
              className="flex-1 rounded-xl bg-emerald-500 hover:bg-emerald-400 py-3 font-medium text-white disabled:opacity-40"
            >
              {holdRemaining > 0
                ? `Approve in ${Math.ceil(holdRemaining / 60000)} min`
                : busy === "approve"
                  ? "Approving…"
                  : "Approve & release"}
            </button>
          </div>
        </section>
      )}

      {finalized && latestReading && (
        <section className="mt-6 flex gap-3">
          <button
            onClick={copyReading}
            className="flex-1 rounded-xl bg-violet-500 hover:bg-violet-400 py-3 font-medium text-white"
          >
            {copied ? "Copied ✓" : "Copy reading for Etsy message"}
          </button>
          <a
            href={`/api/orders/${order.id}/download`}
            className="flex-1 rounded-xl border border-white/20 py-3 font-medium text-center hover:bg-white/10"
          >
            Download .txt (digital file)
          </a>
        </section>
      )}
    </main>
  );
}
