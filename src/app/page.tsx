"use client";

import { useState } from "react";

export default function IntakePage() {
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const [returning, setReturning] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    setState("busy");
    const fd = new FormData(e.currentTarget);
    const res = await fetch("/api/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        etsy_username: fd.get("etsy_username"),
        name: fd.get("name"),
        order_ref: fd.get("order_ref"),
        message: fd.get("message"),
      }),
    });
    const json = await res.json();
    if (!res.ok) {
      setError(json.error ?? "Something went wrong.");
      setState("idle");
      return;
    }
    setReturning(json.returning);
    setState("done");
  }

  return (
    <main className="mx-auto w-full max-w-xl px-6 py-16">
      <p className="text-sm tracking-[0.3em] uppercase text-violet-300/70">
        ManyMuse Tarot
      </p>
      <h1 className="mt-3 font-[family-name:var(--font-serif)] text-4xl">
        Your reading begins here
      </h1>
      <p className="mt-4 text-violet-100/70 leading-relaxed">
        Thank you for your order. Tell Mira what&apos;s on your heart — the more
        you share, the more personal your reading. She will pull your card by
        hand from her Osho Zen deck at her table, and you&apos;ll receive your
        reading through Etsy messages.
      </p>

      {state === "done" ? (
        <div className="mt-10 rounded-2xl border border-violet-400/30 bg-violet-400/10 p-6">
          <h2 className="font-[family-name:var(--font-serif)] text-2xl">
            {returning ? "Welcome back 🌙" : "Received 🌙"}
          </h2>
          <p className="mt-2 text-violet-100/80">
            {returning
              ? "Mira remembers your last reading and will build on it. "
              : ""}
            Your message is with Mira now. Your reading will arrive in your
            Etsy messages shortly.
          </p>
        </div>
      ) : (
        <form onSubmit={submit} className="mt-10 space-y-5">
          <Field label="Etsy username *" name="etsy_username" required />
          <Field label="First name (how Mira should address you)" name="name" />
          <Field label="Etsy order number" name="order_ref" />
          <div>
            <label className="block text-sm text-violet-200/80 mb-1.5">
              Your message to Mira *
            </label>
            <textarea
              name="message"
              required
              rows={7}
              placeholder="What's your situation, and what do you want the cards to speak to?"
              className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 outline-none focus:border-violet-400/60 placeholder:text-white/25"
            />
          </div>
          {error && <p className="text-rose-300 text-sm">{error}</p>}
          <button
            disabled={state === "busy"}
            className="w-full rounded-xl bg-violet-500 hover:bg-violet-400 disabled:opacity-50 py-3.5 font-medium text-white transition"
          >
            {state === "busy" ? "Sending…" : "Send to Mira"}
          </button>
        </form>
      )}
    </main>
  );
}

function Field({
  label,
  name,
  required,
}: {
  label: string;
  name: string;
  required?: boolean;
}) {
  return (
    <div>
      <label className="block text-sm text-violet-200/80 mb-1.5">{label}</label>
      <input
        name={name}
        required={required}
        className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 outline-none focus:border-violet-400/60"
      />
    </div>
  );
}
