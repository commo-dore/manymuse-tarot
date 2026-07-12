"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

export default function SettingsPage() {
  const [status, setStatus] = useState<{ configured: boolean; can_save: boolean } | null>(null);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [syncMsg, setSyncMsg] = useState("");

  useEffect(() => {
    fetch("/api/etsy/credentials")
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => {});
    if (new URLSearchParams(window.location.search).get("etsy") === "connected")
      setMsg("Etsy account connected ✓ — you can now pull orders.");
  }, []);

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErr("");
    setMsg("");
    const fd = new FormData(e.currentTarget);
    const res = await fetch("/api/etsy/credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: fd.get("api_key"),
        shared_secret: fd.get("shared_secret"),
        shop_id: fd.get("shop_id"),
      }),
    });
    const json = await res.json();
    if (!res.ok) setErr(json.error);
    else setMsg(`Saved to env vars: ${json.saved.join(", ")}. ${json.note}`);
  }

  async function pull() {
    setSyncMsg("Pulling…");
    const res = await fetch("/api/etsy/sync", { method: "POST" });
    const json = await res.json();
    setSyncMsg(
      res.ok
        ? `Fetched ${json.fetched} open Etsy orders, imported ${json.imported} new.`
        : `Pull failed: ${json.error}`
    );
  }

  return (
    <main className="mx-auto max-w-xl px-6 py-12">
      <Link href="/operator" className="text-sm text-violet-300/80 hover:text-violet-200">
        ← Back to queue
      </Link>
      <h1 className="mt-4 font-[family-name:var(--font-serif)] text-3xl">
        Etsy connection
      </h1>
      <p className="mt-2 text-sm text-white/50">
        Credentials from the Etsy developer account (personal app). They are
        stored as environment variables only — never in the repo or database.
        Callback URL to register in the Etsy app:{" "}
        <code className="text-violet-300">
          {typeof window !== "undefined" ? window.location.origin : ""}/api/etsy/callback
        </code>
      </p>

      <form onSubmit={save} className="mt-8 space-y-4">
        <Field label="API key (keystring)" name="api_key" />
        <Field label="Shared secret" name="shared_secret" />
        <Field label="Shop ID" name="shop_id" />
        <button className="w-full rounded-xl bg-violet-500 hover:bg-violet-400 py-3 font-medium text-white">
          Save credentials to env vars
        </button>
      </form>
      {msg && <p className="mt-4 text-emerald-300 text-sm">{msg}</p>}
      {err && <p className="mt-4 text-rose-300 text-sm">{err}</p>}

      <div className="mt-10 space-y-3 border-t border-white/10 pt-8">
        <a
          href="/api/etsy/connect"
          className="block w-full rounded-xl border border-violet-400/50 py-3 text-center font-medium hover:bg-violet-400/10"
        >
          Connect Etsy account (OAuth)
        </a>
        <button
          onClick={pull}
          className="w-full rounded-xl border border-white/20 py-3 font-medium hover:bg-white/10"
        >
          Pull open Etsy orders now
        </button>
        {syncMsg && <p className="text-sm text-white/60">{syncMsg}</p>}
        {status && !status.configured && (
          <p className="text-xs text-amber-300/80">
            Etsy env vars are not set yet — orders can still be entered
            manually from the intake form.
          </p>
        )}
      </div>
    </main>
  );
}

function Field({ label, name }: { label: string; name: string }) {
  return (
    <div>
      <label className="block text-sm text-white/60 mb-1.5">{label}</label>
      <input
        name={name}
        autoComplete="off"
        className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 outline-none focus:border-violet-400/60"
      />
    </div>
  );
}
