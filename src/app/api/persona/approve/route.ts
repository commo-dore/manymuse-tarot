import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { isOperator } from "@/lib/auth";

// Approving one of the two side-by-side readings:
// - stores each adjustment prompt as a row in persona_adjustments (the
//   editable "database view" tab), so future readings use them
// - marks the newest run of that test+model approved
// - marks the test case done
export async function POST(req: Request) {
  if (!(await isOperator()))
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const adjustments: string[] = Array.isArray(body?.adjustments)
    ? body.adjustments.map((a: string) => String(a).trim()).filter(Boolean)
    : [];
  const testId: string = body?.test_id ?? "";
  const model: string = body?.model ?? "";
  if (!testId || !model)
    return NextResponse.json({ error: "test_id and model required" }, { status: 400 });

  const supabase = db();

  const { data: run } = await supabase
    .from("persona_test_runs")
    .select("id")
    .eq("test_id", testId)
    .eq("model", model)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (run)
    await supabase.from("persona_test_runs").update({ approved: true }).eq("id", run.id);

  await supabase.from("persona_tests").update({ done: true }).eq("id", testId);

  let appended = 0;
  if (adjustments.length) {
    const { data: existing } = await supabase
      .from("persona_adjustments")
      .select("text");
    const seen = new Set((existing ?? []).map((r) => r.text));
    const fresh = adjustments.filter((a) => !seen.has(a));
    if (fresh.length) {
      const { error } = await supabase
        .from("persona_adjustments")
        .insert(fresh.map((text) => ({ text })));
      if (error)
        return NextResponse.json({ error: error.message }, { status: 500 });
      appended = fresh.length;
    }
  }

  return NextResponse.json({ ok: true, appended, done: true });
}
