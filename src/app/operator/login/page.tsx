"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const [error, setError] = useState("");
  const [oauthReady, setOauthReady] = useState<boolean | null>(null);
  const router = useRouter();

  useEffect(() => {
    fetch("/api/auth/status")
      .then((r) => r.json())
      .then((j) => setOauthReady(j.oauth))
      .catch(() => setOauthReady(false));
  }, []);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: fd.get("password") }),
    });
    if (res.ok) router.push("/operator");
    else setError((await res.json()).error ?? "Sign-in failed");
  }

  return (
    <main className="mx-auto max-w-sm px-6 py-24">
      <h1 className="font-[family-name:var(--font-serif)] text-3xl">
        Operator sign-in
      </h1>

      {oauthReady && (
        <a
          href="/api/auth/google"
          className="mt-8 block w-full rounded-xl bg-white text-[#1a1a1a] py-3 text-center font-medium hover:bg-white/90"
        >
          Continue with Google
        </a>
      )}

      {oauthReady === false && (
        <form onSubmit={submit} className="mt-8 space-y-4">
          <p className="text-xs text-white/40">
            Google sign-in isn&apos;t configured yet — using the shared
            password until then.
          </p>
          <input
            type="password"
            name="password"
            placeholder="Password"
            className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 outline-none focus:border-violet-400/60"
          />
          <button className="w-full rounded-xl bg-violet-500 hover:bg-violet-400 py-3 font-medium text-white">
            Enter
          </button>
        </form>
      )}

      {error && <p className="mt-4 text-rose-300 text-sm">{error}</p>}
    </main>
  );
}
