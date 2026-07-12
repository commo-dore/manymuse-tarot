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
  done: boolean;
  created_at: string;
};
type Run = {
  id: string;
  test_id: string;
  model: string;
  output: string;
  approved: boolean;
  created_at: string;
};
type Adjustment = { id: string; text: string; created_at: string; updated_at: string };

const SONNET = "claude-sonnet-5";
const OPUS = "claude-opus-4-8";
const LABEL: Record<string, string> = { [SONNET]: "Sonnet 5", [OPUS]: "Opus 4.8" };

type Pane = { text: string; streaming: boolean; error?: string };
type TestState = {
  panes: Record<string, Pane>;
  pending: string[];
  adjustInput: string;
  confirmation?: string;
};

function dt(s: string) {
  return new Date(s).toLocaleString(undefined, {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function PersonaStudio() {
  const [tab, setTab] = useState<"tests" | "adjustments">("tests");
  const [instructions, setInstructions] = useState("");
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [tests, setTests] = useState<TestCase[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [adjustments, setAdjustments] = useState<Adjustment[]>([]);
  const [state, setState] = useState<Record<string, TestState>>({});
  const [expanded, setExpanded] = useState<string>("");
  const [busyTest, setBusyTest] = useState("");
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<Partial<TestCase> | null>(null);
  const [prefilling, setPrefilling] = useState(false);
  const [editingAdj, setEditingAdj] = useState<{ id: string; text: string } | null>(null);

  async function load() {
    const [p, t, a] = await Promise.all([
      fetch("/api/persona").then((r) => r.json()),
      fetch("/api/persona/tests").then((r) => r.json()),
      fetch("/api/persona/adjustments").then((r) => r.json()),
    ]);
    setInstructions(p.instructions ?? "");
    setSavedAt(p.updated_at);
    setTests(t.tests ?? []);
    setRuns(t.runs ?? []);
    setAdjustments(a.adjustments ?? []);
  }
  useEffect(() => {
    load();
  }, []);

  function patchState(id: string, fn: (s: TestState) => TestState) {
    setState((all) => {
      const cur = all[id] ?? { panes: {}, pending: [], adjustInput: "" };
      return { ...all, [id]: fn(cur) };
    });
  }

  async function streamModel(
    test: TestCase,
    model: string,
    adj?: string,
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
          adjustments: adj,
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

  async function runBoth(test: TestCase) {
    setError("");
    setBusyTest(test.id);
    patchState(test.id, (s) => ({
      ...s,
      pending: [],
      adjustInput: "",
      confirmation: undefined,
    }));
    await Promise.all([streamModel(test, SONNET), streamModel(test, OPUS)]);
    setBusyTest("");
    load();
  }

  async function regenerateWithAdjustment(test: TestCase) {
    const st = state[test.id];
    const adj = st?.adjustInput.trim();
    if (!adj) {
      setError("Type an adjustment first.");
      return;
    }
    setError("");
    setBusyTest(test.id);
    patchState(test.id, (s) => ({
      ...s,
      pending: [...s.pending, adj],
      adjustInput: "",
      confirmation: undefined,
    }));
    const prev = (m: string) =>
      st?.panes[m]?.text || latestRun(test.id, m)?.output || undefined;
    await Promise.all(
      [SONNET, OPUS].map((m) => streamModel(test, m, adj, prev(m)))
    );
    setBusyTest("");
    load();
  }

  async function approve(test: TestCase, model: string) {
    const pending = state[test.id]?.pending ?? [];
    const res = await fetch("/api/persona/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ test_id: test.id, model, adjustments: pending }),
    });
    const json = await res.json();
    if (!res.ok) {
      setError(json.error ?? "Approve failed");
      return;
    }
    patchState(test.id, (s) => ({
      ...s,
      pending: [],
      confirmation: `✓ ${LABEL[model]} reading approved — test marked done${
        json.appended
          ? `, ${json.appended} adjustment prompt${json.appended > 1 ? "s" : ""} added to the persona`
          : ""
      }.`,
    }));
    await load();
    // collapse after a beat so the confirmation is visible
    setTimeout(() => setExpanded(""), 1800);
  }

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

  async function saveAdjustment() {
    if (!editingAdj) return;
    const res = await fetch("/api/persona/adjustments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(editingAdj.id ? editingAdj : { text: editingAdj.text }),
    });
    if (!res.ok) setError((await res.json()).error);
    else {
      setEditingAdj(null);
      load();
    }
  }

  async function removeAdjustment(id: string) {
    await fetch("/api/persona/adjustments", {
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
      <div className="mt-4 flex items-center justify-between">
        <h1 className="font-[family-name:var(--font-serif)] text-3xl">
          Persona studio
        </h1>
        <div className="inline-flex rounded-full border border-white/15 p-0.5 text-sm">
          {(["tests", "adjustments"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`rounded-full px-4 py-1.5 transition ${
                tab === t ? "bg-violet-500 text-white" : "text-white/60 hover:text-white"
              }`}
            >
              {t === "tests" ? "Test cases" : `Persona adjustments (${adjustments.length})`}
            </button>
          ))}
        </div>
      </div>
      {error && <p className="mt-3 text-rose-300 text-sm">{error}</p>}

      {tab === "tests" && (
        <>
          <section className="mt-6">
            <div className="flex items-center justify-between">
              <h2 className="font-[family-name:var(--font-serif)] text-2xl">
                Test cases <span className="text-white/30 text-base">newest first</span>
              </h2>
              <button
                onClick={openNewTest}
                className="rounded-lg border border-violet-400/50 px-3 py-2 text-sm hover:bg-violet-400/10"
              >
                + New test case
              </button>
            </div>

            <div className="mt-4 space-y-3">
              {tests.map((t) => {
                const st = state[t.id];
                const isOpen = expanded === t.id;
                return (
                  <div
                    key={t.id}
                    className={`rounded-2xl border p-5 ${
                      t.done
                        ? "border-emerald-400/25 bg-emerald-400/[0.04]"
                        : "border-white/10 bg-white/[0.04]"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => setExpanded(isOpen ? "" : t.id)}
                      className="w-full text-left"
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <h3 className="font-medium">
                            {t.name}
                            {t.done && (
                              <span className="ml-2 rounded-full bg-emerald-400/15 text-emerald-300 text-xs px-2 py-0.5">
                                done ✓
                              </span>
                            )}
                          </h3>
                          <p className="text-xs text-white/40 mt-0.5">
                            {dt(t.created_at)} · {t.customer_name} · {t.cards.join(" → ")}
                          </p>
                        </div>
                        <span className="text-white/30 text-sm">{isOpen ? "▲" : "▼"}</span>
                      </div>
                      <p className="mt-2 text-sm text-white/60 line-clamp-2">
                        “{t.message}”
                      </p>
                    </button>

                    {isOpen && (
                      <div className="mt-4">
                        <div className="flex gap-2 text-xs">
                          <button
                            onClick={() => runBoth(t)}
                            disabled={busyTest !== ""}
                            className="rounded-lg bg-violet-500 hover:bg-violet-400 disabled:opacity-40 px-3 py-1.5 font-medium text-white"
                          >
                            {busyTest === t.id ? "Reading…" : "▶ Run fresh (both models)"}
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

                        <div className="mt-3 flex gap-2">
                          <input
                            value={st?.adjustInput ?? ""}
                            onChange={(e) =>
                              patchState(t.id, (s) => ({ ...s, adjustInput: e.target.value }))
                            }
                            onKeyDown={(e) => {
                              if (e.key === "Enter") regenerateWithAdjustment(t);
                            }}
                            placeholder="Adjustment for both readings…"
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
                        {(st?.pending.length ?? 0) > 0 && (
                          <p className="mt-2 text-xs text-amber-300/80">
                            Pending adjustments (saved to persona on approve):{" "}
                            {st!.pending.map((a) => `“${a}”`).join(" · ")}
                          </p>
                        )}
                        {st?.confirmation && (
                          <p className="mt-2 text-sm text-emerald-300">{st.confirmation}</p>
                        )}

                        <div className="mt-4 grid gap-4 md:grid-cols-2">
                          {[SONNET, OPUS].map((m) => {
                            const pane = st?.panes[m];
                            const persisted = latestRun(t.id, m);
                            // live pane wins; otherwise show the last saved run
                            const text = pane ? pane.text : persisted?.output ?? "";
                            const fromHistory = !pane && !!persisted;
                            return (
                              <div
                                key={m}
                                className="rounded-xl border border-violet-400/20 bg-violet-400/[0.05] p-4"
                              >
                                <div className="flex items-center justify-between">
                                  <span className="text-xs uppercase tracking-widest text-violet-300/70">
                                    {LABEL[m]}
                                    {pane?.streaming
                                      ? " — writing…"
                                      : fromHistory
                                        ? ` — saved ${dt(persisted!.created_at)}${persisted!.approved ? " · approved ✓" : ""}`
                                        : ""}
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
                                  {text || (pane?.streaming ? "…" : "No reading yet — hit Run.")}
                                </p>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
              {!tests.length && <p className="text-white/50">No test cases yet.</p>}
            </div>
          </section>

          <section className="mt-10 border-t border-white/10 pt-8">
            <h2 className="font-[family-name:var(--font-serif)] text-xl">
              Base persona notes (free text)
            </h2>
            <p className="mt-1 text-xs text-white/40">
              Applied to every reading, together with the adjustments in the other
              tab. Test runs use this box as typed — no save needed.
            </p>
            <textarea
              value={instructions}
              onChange={(e) => {
                setInstructions(e.target.value);
                setDirty(true);
              }}
              rows={5}
              className="mt-3 w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 outline-none focus:border-violet-400/60 font-mono text-sm"
            />
            <div className="mt-2 flex items-center gap-3">
              <button
                onClick={async () => {
                  const res = await fetch("/api/persona", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ instructions }),
                  });
                  if (res.ok) {
                    setDirty(false);
                    setSavedAt(new Date().toISOString());
                  }
                }}
                disabled={!dirty}
                className="rounded-xl bg-violet-500 hover:bg-violet-400 disabled:opacity-40 px-5 py-2.5 font-medium text-white"
              >
                {dirty ? "Save" : "Saved ✓"}
              </button>
              {savedAt && (
                <span className="text-xs text-white/40">
                  last saved {new Date(savedAt).toLocaleString()}
                </span>
              )}
            </div>
          </section>
        </>
      )}

      {tab === "adjustments" && (
        <section className="mt-6">
          <div className="flex items-center justify-between">
            <p className="text-sm text-white/50">
              Every prompt approved from a test case lands here. Edits and
              deletions apply immediately — the next test run or customer
              reading uses this exact list.
            </p>
            <button
              onClick={() => setEditingAdj({ id: "", text: "" })}
              className="rounded-lg border border-violet-400/50 px-3 py-2 text-sm hover:bg-violet-400/10 whitespace-nowrap"
            >
              + Add manually
            </button>
          </div>
          <div className="mt-4 overflow-x-auto rounded-2xl border border-white/10">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/10 text-left text-xs uppercase tracking-widest text-white/40">
                  <th className="px-4 py-3">Adjustment prompt</th>
                  <th className="px-4 py-3 whitespace-nowrap">Added</th>
                  <th className="px-4 py-3 whitespace-nowrap">Updated</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {adjustments.map((a) => (
                  <tr key={a.id} className="border-b border-white/5 last:border-0">
                    <td className="px-4 py-3">
                      {editingAdj?.id === a.id ? (
                        <input
                          value={editingAdj.text}
                          onChange={(e) =>
                            setEditingAdj({ id: a.id, text: e.target.value })
                          }
                          onKeyDown={(e) => {
                            if (e.key === "Enter") saveAdjustment();
                          }}
                          autoFocus
                          className="w-full rounded-lg border border-violet-400/50 bg-white/5 px-3 py-1.5 outline-none"
                        />
                      ) : (
                        a.text
                      )}
                    </td>
                    <td className="px-4 py-3 text-white/40 whitespace-nowrap">
                      {dt(a.created_at)}
                    </td>
                    <td className="px-4 py-3 text-white/40 whitespace-nowrap">
                      {a.updated_at !== a.created_at ? dt(a.updated_at) : "—"}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-right">
                      {editingAdj?.id === a.id ? (
                        <>
                          <button
                            onClick={saveAdjustment}
                            className="rounded-lg bg-violet-500 hover:bg-violet-400 px-3 py-1 text-xs font-medium text-white"
                          >
                            Save
                          </button>
                          <button
                            onClick={() => setEditingAdj(null)}
                            className="ml-2 rounded-lg border border-white/15 px-3 py-1 text-xs hover:bg-white/10"
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            onClick={() => setEditingAdj({ id: a.id, text: a.text })}
                            className="rounded-lg border border-white/15 px-3 py-1 text-xs hover:bg-white/10"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => removeAdjustment(a.id)}
                            className="ml-2 rounded-lg border border-rose-400/30 text-rose-300 px-3 py-1 text-xs hover:bg-rose-400/10"
                          >
                            Delete
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
                {editingAdj && !editingAdj.id && (
                  <tr>
                    <td className="px-4 py-3" colSpan={3}>
                      <input
                        value={editingAdj.text}
                        onChange={(e) => setEditingAdj({ id: "", text: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") saveAdjustment();
                        }}
                        autoFocus
                        placeholder="New adjustment prompt…"
                        className="w-full rounded-lg border border-violet-400/50 bg-white/5 px-3 py-1.5 outline-none"
                      />
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      <button
                        onClick={saveAdjustment}
                        className="rounded-lg bg-violet-500 hover:bg-violet-400 px-3 py-1 text-xs font-medium text-white"
                      >
                        Save
                      </button>
                      <button
                        onClick={() => setEditingAdj(null)}
                        className="ml-2 rounded-lg border border-white/15 px-3 py-1 text-xs hover:bg-white/10"
                      >
                        Cancel
                      </button>
                    </td>
                  </tr>
                )}
                {!adjustments.length && !editingAdj && (
                  <tr>
                    <td className="px-4 py-6 text-white/40" colSpan={4}>
                      No adjustments yet — approve a test-case reading to add its
                      adjustment prompts here.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

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
              <div>
                <textarea
                  value={editing.message ?? ""}
                  onChange={(e) =>
                    setEditing({ ...editing, message: e.target.value })
                  }
                  rows={5}
                  maxLength={1024}
                  placeholder="The customer's message (max 1024 characters)"
                  className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 outline-none focus:border-violet-400/60"
                />
                <p className="text-right text-xs text-white/30">
                  {(editing.message ?? "").length}/1024
                </p>
              </div>
              <div>
                <label className="block text-xs text-white/50 mb-1">
                  Cards (1–3, in order — drawn at random, unrelated to the message)
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
