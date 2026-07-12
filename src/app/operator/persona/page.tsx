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
  approved: boolean;
  created_at: string;
};

const SONNET = "claude-sonnet-5";
const OPUS = "claude-opus-4-8";
const LABEL: Record<string, string> = { [SONNET]: "Sonnet 5", [OPUS]: "Opus 4.8" };

type Pane = { text: string; streaming: boolean; error?: string };
type TestState = {
  panes: Record<string, Pane>; // keyed by model
  pending: string[]; // adjustment prompts since last approve
  adjustInput: string;
};

export default function PersonaStudio() {
  const [instructions, setInstructions] = useState("");
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [tests, setTests] = useState<TestCase[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [state, setState] = useState<Record<string, TestState>>({});
  const [busyTest, setBusyTest] = useState("");
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<Partial<TestCase> | null>(null);
  const [prefilling, setPrefilling] = useState(false);
  const [approveMsg, setApproveMsg] = useState("");

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

  async function savePersona(text?: string) {
    const body = { instructions: text ?? instructions };
    const res = await fetch("/api/persona", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      setDirty(false);
      setSavedAt(new Date().toISOString());
    } else setError((await res.json()).error);
  }

  function patchState(id: string, fn: (s: TestState) => TestState) {
    setState((all) => {
      const cur = all[id] ?? { panes: {}, pending: [], adjustInput: "" };
      return { ...all, [id]: fn(cur) };
    });
  }

  async function streamModel(
    test: TestCase,
    model: string,
    adjustments?: string,
    previousOutput?: string
  ) {
    patchState(test.id, (s) => ({
      ...s,
      panes: { ...s.panes, [model]: { text: "", streaming: true } },
    }));
    try {
      const res = await fetch("/api/persona/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          test_id: test.id,
          model,
          instructions,
          adjustments,
          previous_output: previousOutput,
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
        const snapshot = acc;
        patchState(test.id, (s) => ({
          ...s,
          panes: { ...s.panes, [model]: { text: snapshot, streaming: true } },
        }));
      }
      patchState(test.id, (s) => ({
        ...s,
        panes: { ...s.panes, [model]: { text: acc, streaming: false } },
      }));
    } catch (e) {
      patchState(test.id, (s) => ({
        ...s,
        panes: {
          ...s.panes,
          [model]: { text: "", streaming: false, error: (e as Error).message },
        },
      }));
    }
  }

  // Fresh run — both models side by side, in parallel.
  async function runBoth(test: TestCase) {
    setError("");
    setApproveMsg("");
    setBusyTest(test.id);
    patchState(test.id, (s) => ({ ...s, pending: [], adjustInput: "" }));
    await Promise.all([streamModel(test, SONNET), streamModel(test, OPUS)]);
    setBusyTest("");
    load();
  }

  // Adjustment pass — revises each model's own current output.
  async function regenerateWithAdjustment(test: TestCase) {
    const st = state[test.id];
    const adj = st?.adjustInput.trim();
    if (!adj) {
      setError("Type an adjustment first.");
      return;
    }
    setError("");
    setApproveMsg("");
    setBusyTest(test.id);
    patchState(test.id, (s) => ({
      ...s,
      pending: [...s.pending, adj],
      adjustInput: "",
    }));
    await Promise.all(
      [SONNET, OPUS].map((m) =>
        streamModel(test, m, adj, st?.panes[m]?.text || undefined)
      )
    );
    setBusyTest("");
    load();
  }

  // Approving a pane folds the adjustment prompts into the persona.
  async function approve(test: TestCase, model: string) {
    const pending = state[test.id]?.pending ?? [];
    const res = await fetch("/api/persona/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ test_id: test.id, model, adjustments: pending }),
    });
    const json = await res.json();
    if (!res.ok) {
      setError(json.error);
      return;
    }
    if (json.instructions !== undefined) {
      setInstructions(json.instructions);
      setDirty(false);
      setSavedAt(new Date().toISOString());
    }
    patchState(test.id, (s) => ({ ...s, pending: [] }));
    setApproveMsg(
      pending.length
        ? `Approved ${LABEL[model]} — ${pending.length} adjustment prompt${pending.length > 1 ? "s" : ""} added to the persona above.`
        : `Approved ${LABEL[model]} (no adjustments to add).`
    );
    load();
  }

  // New test case: preload all fields with a generated realistic case.
  async function openNewTest() {
    setEditing({ name: "…", customer_name: "…", message: "Generating…", cards: [] });
    await prefill();
  }
  async function prefill() {
    setPrefilling(true);
    try {
      const res = await fetch("/api/persona/tests/generate", { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error);
      setEditing((e) => ({ ...(e ?? {}), ...json, id: e?.id }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPrefilling(false);
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

  const latestRun = (testId: string, model: string) =>
    runs.find((r) => r.test_id === testId && r.model === model);

  return (
    <main className="mx-auto max-w-6xl px-6 py-12">
      <Link href="/operator" className="text-sm text-violet-300/80 hover:text-violet-200">
        ← Back to queue
      </Link>
      <h1 className="mt-4 font-[family-name:var(--font-serif)] text-3xl">
        Persona studio
      </h1>
      <p className="mt-2 text-sm text-white/50">
        Standing instructions below apply to every production reading. Test
        runs use exactly what&apos;s in the box right now. Approving a reading
        folds the adjustment prompts that shaped it back into the persona.
      </p>

      <section className="mt-6">
        <textarea
          value={instructions}
          onChange={(e) => {
            setInstructions(e.target.value);
            setDirty(true);
          }}
          rows={7}
          className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 outline-none focus:border-violet-400/60 placeholder:text-white/25 font-mono text-sm"
          placeholder={"Approved adjustments accumulate here automatically — or write your own."}
        />
        <div className="mt-2 flex items-center gap-3">
          <button
            onClick={() => savePersona()}
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
        {approveMsg && <p className="mt-2 text-emerald-300 text-sm">{approveMsg}</p>}
        {error && <p className="mt-2 text-rose-300 text-sm">{error}</p>}
      </section>

      <section className="mt-10">
        <div className="flex items-center justify-between">
          <h2 className="font-[family-name:var(--font-serif)] text-2xl">
            Test cases
          </h2>
          <button
            onClick={openNewTest}
            className="rounded-lg border border-violet-400/50 px-3 py-2 text-sm hover:bg-violet-400/10"
          >
            + New test case
          </button>
        </div>

        <div className="mt-4 space-y-5">
          {tests.map((t) => {
            const st = state[t.id];
            const hasOutput =
              st && (st.panes[SONNET]?.text || st.panes[OPUS]?.text);
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
                      onClick={() => runBoth(t)}
                      disabled={busyTest !== ""}
                      className="rounded-lg bg-violet-500 hover:bg-violet-400 disabled:opacity-40 px-3 py-1.5 font-medium text-white"
                    >
                      {busyTest === t.id ? "Reading…" : "▶ Run (both models)"}
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

                {hasOutput && (
                  <div className="mt-4 flex gap-2">
                    <input
                      value={st?.adjustInput ?? ""}
                      onChange={(e) =>
                        patchState(t.id, (s) => ({
                          ...s,
                          adjustInput: e.target.value,
                        }))
                      }
                      onKeyDown={(e) => {
                        if (e.key === "Enter") regenerateWithAdjustment(t);
                      }}
                      placeholder="Adjustment for both readings, e.g. 'less mystical language, more practical next steps'…"
                      className="flex-1 rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm outline-none focus:border-violet-400/60 placeholder:text-white/25"
                    />
                    <button
                      onClick={() => regenerateWithAdjustment(t)}
                      disabled={busyTest !== ""}
                      className="rounded-xl border border-violet-400/50 px-4 py-2.5 text-sm font-medium hover:bg-violet-400/10 disabled:opacity-40 whitespace-nowrap"
                    >
                      Regenerate reading
                    </button>
                  </div>
                )}
                {(st?.pending.length ?? 0) > 0 && (
                  <p className="mt-2 text-xs text-amber-300/80">
                    Pending adjustments (added to persona on approve):{" "}
                    {st!.pending.map((a) => `“${a}”`).join(" · ")}
                  </p>
                )}

                {(hasOutput || busyTest === t.id) && (
                  <div className="mt-4 grid gap-4 md:grid-cols-2">
                    {[SONNET, OPUS].map((m) => {
                      const pane = st?.panes[m];
                      const persisted = latestRun(t.id, m);
                      const text = pane?.text || (!pane ? persisted?.output : "");
                      return (
                        <div
                          key={m}
                          className="rounded-xl border border-violet-400/20 bg-violet-400/[0.05] p-4"
                        >
                          <div className="flex items-center justify-between">
                            <span className="text-xs uppercase tracking-widest text-violet-300/70">
                              {LABEL[m]}
                              {pane?.streaming ? " — writing…" : ""}
                            </span>
                            {!pane?.streaming && text && (
                              <button
                                onClick={() => approve(t, m)}
                                className="text-xs rounded-lg bg-emerald-500 hover:bg-emerald-400 px-3 py-1 font-medium text-white"
                              >
                                ✓ Approve
                              </button>
                            )}
                          </div>
                          {pane?.error && (
                            <p className="mt-2 text-rose-300 text-sm">{pane.error}</p>
                          )}
                          <p className="mt-2 whitespace-pre-wrap leading-relaxed font-[family-name:var(--font-serif)] text-[0.95rem]">
                            {text || (pane?.streaming ? "…" : "")}
                          </p>
                        </div>
                      );
                    })}
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
            <div className="flex items-center justify-between">
              <h3 className="font-[family-name:var(--font-serif)] text-xl">
                {editing.id ? "Edit test case" : "New test case"}
              </h3>
              <button
                onClick={prefill}
                disabled={prefilling}
                className="rounded-lg border border-violet-400/50 px-3 py-1.5 text-sm hover:bg-violet-400/10 disabled:opacity-50"
              >
                {prefilling ? "Generating…" : "⟳ Regenerate all fields"}
              </button>
            </div>
            <div className="mt-4 space-y-3">
              <input
                value={editing.name ?? ""}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                placeholder="Test name"
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
                rows={5}
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
