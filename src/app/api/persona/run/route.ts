import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { isOperator } from "@/lib/auth";
import {
  buildBase,
  chainPrompt,
  revisionPrompt,
  persona,
  llm,
  llmStream,
  READING_MODEL,
} from "@/lib/reading";

export const maxDuration = 300;

const ALLOWED_MODELS = new Set(["claude-sonnet-5", "claude-opus-4-8"]);

// Run one persona test case with the CURRENT (possibly unsaved) studio
// instructions. Two modes:
// - fresh: full card chain
// - adjust: `adjustments` + `previous_output` present → revise that output
// Streams the reading; persists the run with its adjustments.
export async function POST(req: Request) {
  if (!(await isOperator()))
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const testId: string = body?.test_id;
  const model: string = ALLOWED_MODELS.has(body?.model) ? body.model : READING_MODEL;
  const adjustments: string = (body?.adjustments ?? "").trim();
  const previousOutput: string = body?.previous_output ?? "";
  if (!testId)
    return NextResponse.json({ error: "test_id required" }, { status: 400 });

  const supabase = db();
  const { data: test } = await supabase
    .from("persona_tests")
    .select("*")
    .eq("id", testId)
    .single();
  if (!test)
    return NextResponse.json({ error: "Test case not found" }, { status: 404 });

  let instructions: string;
  if (typeof body?.instructions === "string") {
    instructions = body.instructions;
  } else {
    const { data: settings } = await supabase
      .from("persona_settings")
      .select("instructions")
      .eq("id", 1)
      .maybeSingle();
    instructions = settings?.instructions ?? "";
  }

  let system: string;
  try {
    system = persona(undefined, instructions);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }

  const cards = (test.cards as string[]) ?? [];
  const base = buildBase({
    customerName: test.customer_name,
    customerMessage: test.message,
    cards,
    history: [],
  });

  let finalPrompt: string;
  if (adjustments && previousOutput) {
    finalPrompt = revisionPrompt(base, cards, adjustments, previousOutput);
  } else {
    let current = "";
    try {
      for (let i = 0; i < cards.length - 1; i++) {
        const r = await llm(system, chainPrompt(base, cards, i, current), model);
        current = r.text;
      }
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 502 });
    }
    finalPrompt = chainPrompt(base, cards, cards.length - 1, current);
  }

  const result = llmStream({
    system,
    prompt: finalPrompt,
    model,
    onFinish: async (finalText) => {
      await supabase.from("persona_test_runs").insert({
        test_id: testId,
        model,
        persona_snapshot: instructions,
        output: finalText,
        adjustments,
      });
    },
  });
  return result.toTextStreamResponse();
}
