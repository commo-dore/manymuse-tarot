"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const [error, setError] = useState("");
  const router = useRouter();

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: fd.get("password") }),
    });
    if (res.ok) router.push("/operator");
    else setError("Wrong password");
  }

  return (
    <main className="mx-auto max-w-sm px-6 py-24">
      <h1 className="font-[family-name:var(--font-serif)] text-3xl">
        Operator sign-in
      </h1>
      <form onSubmit={submit} className="mt-8 space-y-4">
        <input
          type="password"
          name="password"
          placeholder="Password"
          className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 outline-none focus:border-violet-400/60"
        />
        {error && <p className="text-rose-300 text-sm">{error}</p>}
        <button className="w-full rounded-xl bg-violet-500 hover:bg-violet-400 py-3 font-medium text-white">
          Enter
        </button>
      </form>
    </main>
  );
}
