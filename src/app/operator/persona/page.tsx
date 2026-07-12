"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { OSHO_ZEN_CARDS } from "@/lib/cards";

type TestCase = {
  id: string;
  name: string;
  customer_name: string;
  message: string;
  cards: string[];
};
type Run = {
  id: string;
  test_id: string;
  model: string;
  output: string;
  created_at: string;
};

const MODELS = [
  { id: "claude-sonnet-5", label: "Sonnet 5 (production)" },
  { id: "claude-opus-4-8", label: "Opus 4.8" },
];

export default function PersonaStudio() {
  const [instructions, setInstructions] = useState("");
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [tests, setTests] = useState<TestCase[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [live, setLive] = useState<Record<string, string>>({});
  const [running, setRunning] = useState<string>("");
  const [model, setModel] = useState(MODELS[0].id);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<Partial<TestCase> | null>(null);
  const [showHistory, setShowHistory] = useState<string>("");

  async function load() {
    const [p, t] = await Promise.all([
      fetch("/api/persona").then((r) => r.json()),
      fetch("/api/persona/tests").then((r) => r.json()),
    ]);
    setInstructions(p.instructions ?? "");
    setSavedAt(p.updated_at);
    setTests(t.tests ?? []);
    setRuns(t.runs ?? []);
  }
  useEffect(() => {
    load();
  }, []);

  async function save() {
    const res = await fetch("/api/persona", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instructions }),
    });
    if (res.ok) {
      setDirty(false);
      setSavedAt(new Date().toISOString());
    } else setError((await res.json()).error);
  }

  async function run(test: TestCase) {
    setError("");
    setRunning(test.id);
    setLive((l) => ({ ...l, [test.id]: "" }));
    try {
      const res = await fetch("/api/persona/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          test_id: test.id,
          model,
          instructions, // current draft applies immediately, saved or not
        }),
      });
      if (!res.ok || !res.body)
        throw new Error((await res.json()).error ?? "Run failed");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let acc = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        acc += decoder.decode(value, { stream: true });
        setLive((l) => ({ ...l, [test.id]: acc }));
      }
      // refresh run history (run was persisted server-side)
      const t = await fetch("/api/persona/tests").then((r) => r.json());
      setRuns(t.runs ?? []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning("");
    }
  }

  async function saveTest() {
    if (!editing) return;
    const res = await fetch("/api/persona/tests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: editing.id,
        name: editing.name,
        customer_name: editing.customer_name,
        message: editing.message,
        cards: editing.cards ?? [],
      }),
    });
    if (!res.ok) setError((await res.json()).error);
    else {
      setEditing(null);
      load();
    }
  }

  async function removeTest(id: string) {
    await fetch("/api/persona/tests", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    load();
  }

  const runsFor = (id: string) =>
    runs.filter((r) => r.test_id === id);

  return (
    <main className="mx-auto max-w-4xl px-6 py-12">
      <Link href="/operator" className="text-sm text-violet-300/80 hover:text-violet-200">
        ← Back to queue
      </Link>
      <h1 className="mt-4 font-[family-name:var(--font-serif)] text-3xl">
        Persona studio
      </h1>
      <p className="mt-2 text-sm text-white/50">
        Train Mira&apos;s voice here. Instructions below are layered on top of
        the base persona for <strong>every</strong> reading. Test runs use
        exactly what&apos;s in the box right now — you don&apos;t need to save
        first to see the effect.
      </p>

      <section className="mt-6">
        <textarea
          value={instructions}
          onChange={(e) => {
            setInstructions(e.target.value);
            setDirty(true);
          }}
          rows={7}
          placeholder={
            "e.g.\n- Never open two readings the same way\n- Keep readings under 400 words unless it's a 3-card spread\n- Reference the candle/crystals at most once per reading"
          }
          className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 outline-none focus:border-violet-400/60 placeholder:text-white/25 font-mono text-sm"
        />
        <div className="mt-2 flex items-center gap-3">
          <button
            onClick={save}
            disabled={!dirty}
            className="rounded-xl bg-violet-500 hover:bg-violet-400 disabled:opacity-40 px-5 py-2.5 font-medium text-white"
          >
            {dirty ? "Save — applies to all future readings" : "Saved ✓"}
          </button>
          {savedAt && (
            <span className="text-xs text-white/40">
              last saved {new Date(savedAt).toLocaleString()}
            </span>
          )}
        </div>
      </section>

      <section className="mt-10">
        <div className="flex items-center justify-between">
          <h2 className="font-[family-name:var(--font-serif)] text-2xl">
            Test cases
          </h2>
          <div className="flex items-center gap-3">
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="rounded-lg border border-white/10 bg-[#1b1730] px-3 py-2 text-sm outline-none"
            >
              {MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
            <button
              onClick={() =>
                setEditing({ name: "", customer_name: "", message: "", cards: [] })
              }
              className="rounded-lg border border-violet-400/50 px-3 py-2 text-sm hover:bg-violet-400/10"
            >
              + New test case
            </button>
          </div>
        </div>
        {error && <p className="mt-3 text-rose-300 text-sm">{error}</p>}

        <div className="mt-4 space-y-4">
          {tests.map((t) => {
            const history = runsFor(t.id);
            const liveOut = live[t.id];
            return (
              <div
                key={t.id}
                className="rounded-2xl border border-white/10 bg-white/[0.04] p-5"
              >
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h3 className="font-medium">{t.name}</h3>
                    <p className="text-xs text-white/40 mt-0.5">
                      {t.customer_name} · {t.cards.join(" → ")}
                    </p>
                  </div>
                  <div className="flex gap-2 text-xs whitespace-nowrap">
                    <button
                      onClick={() => run(t)}
                      disabled={running !== ""}
                      className="rounded-lg bg-violet-500 hover:bg-violet-400 disabled:opacity-40 px-3 py-1.5 font-medium text-white"
                    >
                      {running === t.id ? "Reading…" : "▶ Run"}
                    </button>
                    <button
                      onClick={() => setEditing(t)}
                      className="rounded-lg border border-white/15 px-3 py-1.5 hover:bg-white/10"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => removeTest(t.id)}
                      className="rounded-lg border border-rose-400/30 text-rose-300 px-3 py-1.5 hover:bg-rose-400/10"
                    >
                      Delete
                    </button>
                  </div>
                </div>
                <p className="mt-2 text-sm text-white/60 line-clamp-2">
                  “{t.message}”
                </p>

                {(liveOut !== undefined || history.length > 0) && (
                  <div className="mt-4 rounded-xl border border-violet-400/20 bg-violet-400/[0.05] p-4">
                    <div className="flex items-center justify-between text-xs text-violet-300/70">
                      <span>
                        {running === t.id
                          ? liveOut
                            ? "Writing…"
                            : "Reading earlier cards…"
                          : liveOut !== undefined
                            ? `Latest run (${model.includes("opus") ? "Opus 4.8" : "Sonnet 5"})`
                            : `Latest run (${history[0]?.model.includes("opus") ? "Opus 4.8" : "Sonnet 5"} · ${new Date(history[0]?.created_at).toLocaleString()})`}
                      </span>
                      {history.length > 1 && (
                        <button
                          onClick={() =>
                            setShowHistory(showHistory === t.id ? "" : t.id)
                          }
                          className="underline underline-offset-2"
                        >
                          {showHistory === t.id
                            ? "hide previous runs"
                            : `compare with ${history.length - (liveOut !== undefined ? 0 : 1)} previous run(s)`}
                        </button>
                      )}
                    </div>
                    <p className="mt-2 whitespace-pre-wrap leading-relaxed font-[family-name:var(--font-serif)]">
                      {liveOut !== undefined ? liveOut || "…" : history[0]?.output}
                    </p>
                    {showHistory === t.id &&
                      history
                        .slice(liveOut !== undefined ? 0 : 1, 4)
                        .map((r) => (
                          <div
                            key={r.id}
                            className="mt-3 border-t border-white/10 pt-3"
                          >
                            <p className="text-xs text-white/40">
                              {r.model.includes("opus") ? "Opus 4.8" : "Sonnet 5"} ·{" "}
                              {new Date(r.created_at).toLocaleString()}
                            </p>
                            <p className="mt-1 whitespace-pre-wrap leading-relaxed font-[family-name:var(--font-serif)] text-white/70">
                              {r.output}
                            </p>
                          </div>
                        ))}
                  </div>
                )}
              </div>
            );
          })}
          {!tests.length && <p className="text-white/50">No test cases yet.</p>}
        </div>
      </section>

      {editing && (
        <div className="fixed inset-0 z-20 bg-black/60 flex items-center justify-center p-6">
          <div className="w-full max-w-lg rounded-2xl border border-white/10 bg-[#1b1730] p-6 max-h-[90vh] overflow-y-auto">
            <h3 className="font-[family-name:var(--font-serif)] text-xl">
              {editing.id ? "Edit test case" : "New test case"}
            </h3>
            <div className="mt-4 space-y-3">
              <input
                value={editing.name ?? ""}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                placeholder="Test name (e.g. Angry repeat customer)"
                className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 outline-none focus:border-violet-400/60"
              />
              <input
                value={editing.customer_name ?? ""}
                onChange={(e) =>
                  setEditing({ ...editing, customer_name: e.target.value })
                }
                placeholder="Customer first name"
                className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 outline-none focus:border-violet-400/60"
              />
              <textarea
                value={editing.message ?? ""}
                onChange={(e) =>
                  setEditing({ ...editing, message: e.target.value })
                }
                rows={4}
                placeholder="The customer's message"
                className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 outline-none focus:border-violet-400/60"
              />
              <div>
                <label className="block text-xs text-white/50 mb-1">
                  Cards (1–3, in order)
                </label>
                {[0, 1, 2].map((i) => (
                  <select
                    key={i}
                    value={editing.cards?.[i] ?? ""}
                    onChange={(e) => {
                      const cards = [...(editing.cards ?? [])];
                      if (e.target.value) cards[i] = e.target.value;
                      else cards.splice(i);
                      setEditing({ ...editing, cards: cards.filter(Boolean) });
                    }}
                    className="w-full mb-2 rounded-xl border border-white/10 bg-[#131020] px-4 py-2.5 outline-none"
                  >
                    <option value="">
                      {i === 0 ? "— card 1 —" : `— card ${i + 1} (optional) —`}
                    </option>
                    {OSHO_ZEN_CARDS.filter(
                      (c) =>
                        !(editing.cards ?? []).includes(c.name) ||
                        editing.cards?.[i] === c.name
                    ).map((c) => (
                      <option key={c.name} value={c.name}>
                        {c.name} ({c.suit})
                      </option>
                    ))}
                  </select>
                ))}
              </div>
            </div>
            <div className="mt-5 flex gap-3">
              <button
                onClick={saveTest}
                className="flex-1 rounded-xl bg-violet-500 hover:bg-violet-400 py-2.5 font-medium text-white"
              >
                Save test case
              </button>
              <button
                onClick={() => setEditing(null)}
                className="flex-1 rounded-xl border border-white/20 py-2.5 hover:bg-white/10"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
