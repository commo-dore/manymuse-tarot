import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { isOperator } from "@/lib/auth";

// Approving one of the two side-by-side readings folds the adjustment
// prompts that produced it into the standing persona instructions, so the
// training compounds across sessions.
export async function POST(req: Request) {
  if (!(await isOperator()))
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const adjustments: string[] = Array.isArray(body?.adjustments)
    ? body.adjustments.map((a: string) => String(a).trim()).filter(Boolean)
    : [];
  const testId: string = body?.test_id ?? "";
  const model: string = body?.model ?? "";

  const supabase = db();

  // Mark the newest run of this test+model as approved (best effort).
  if (testId && model) {
    const { data: run } = await supabase
      .from("persona_test_runs")
      .select("id")
      .eq("test_id", testId)
      .eq("model", model)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (run)
      await supabase
        .from("persona_test_runs")
        .update({ approved: true })
        .eq("id", run.id);
  }

  if (!adjustments.length) {
    return NextResponse.json({ ok: true, appended: 0 });
  }

  const { data: settings } = await supabase
    .from("persona_settings")
    .select("instructions")
    .eq("id", 1)
    .maybeSingle();
  const current = settings?.instructions ?? "";
  const additions = adjustments
    .filter((a) => !current.includes(a))
    .map((a) => `- ${a}`)
    .join("\n");
  const next = additions ? (current ? `${current}\n${additions}` : additions) : current;

  const { error } = await supabase
    .from("persona_settings")
    .upsert({ id: 1, instructions: next, updated_at: new Date().toISOString() });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, appended: adjustments.length, instructions: next });
}
