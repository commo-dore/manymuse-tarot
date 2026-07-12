import { NextResponse } from "next/server";
import { isOperator } from "@/lib/auth";
import { llm, READING_MODEL } from "@/lib/reading";
import { OSHO_ZEN_CARDS } from "@/lib/cards";

export const maxDuration = 60;

const THEMES = [
  "an ex who went silent / no-contact confusion",
  "a career or money crossroads",
  "a family conflict or obligation",
  "loneliness, relocation, or identity loss",
  "a new romance that feels uncertain",
  "a friendship betrayal",
  "fertility, pregnancy, or body worries",
  "a creative dream they're scared to pursue",
  "grief after losing someone",
  "twin flame / soulmate obsession",
  "workplace drama with a specific coworker",
  "deciding whether to move abroad",
];

// Invent a realistic test case: customer name, personal message, cards.
export async function POST() {
  if (!(await isOperator()))
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const theme = THEMES[Math.floor(Math.random() * THEMES.length)];
  const nCards = 1 + Math.floor(Math.random() * 3);
  const deck = OSHO_ZEN_CARDS.map((c) => c.name);

  const prompt = `Invent ONE realistic Etsy tarot-reading customer for testing. Theme: ${theme}.

The message must read like a real person typed it into an Etsy order note: specific details (names, timeframes, small concrete facts), imperfect punctuation is fine, 40-120 words, emotionally real, first person. Not generic.

Also pick ${nCards} card${nCards > 1 ? "s" : ""} a reader might have physically drawn, chosen ONLY from this Osho Zen deck list (exact spelling): ${deck.join(", ")}.

Reply with ONLY this JSON, nothing else:
{"name": "<short test-case label, e.g. 'Ghosted after 2 years'>", "customer_name": "<first name>", "message": "<the customer's message>", "cards": [${Array.from({ length: nCards }, (_, i) => `"<card ${i + 1}>"`).join(", ")}]}`;

  try {
    const { text } = await llm(
      "You generate realistic test data. Output strictly valid JSON only.",
      prompt,
      READING_MODEL
    );
    const json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    const valid = new Set(deck);
    const cards: string[] = [
      ...new Set((json.cards ?? []).filter((c: string) => valid.has(c))),
    ] as string[];
    // top up with random cards if the model picked invalid/duplicate ones
    while (cards.length < nCards) {
      const c = deck[Math.floor(Math.random() * deck.length)];
      if (!cards.includes(c)) cards.push(c);
    }
    return NextResponse.json({
      name: String(json.name ?? "Test case"),
      customer_name: String(json.customer_name ?? "Alex"),
      message: String(json.message ?? ""),
      cards: cards.slice(0, nCards),
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
