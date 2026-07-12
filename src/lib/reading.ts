import { generateText, streamText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";

export const READING_MODEL = "claude-sonnet-5";

export type History = {
  message: string;
  cards: string[];
  reading: string | null;
  date: string;
}[];

export type ReadingInput = {
  customerName: string;
  customerMessage: string;
  cards: string[]; // 1-3 unique cards; slot order is meaningful
  history: History;
  customerNotes?: string;
  personaNotes?: string; // per-reading voice/instruction adjustments
};

export function persona(personaNotes?: string, globalInstructions?: string): string {
  // The reader persona is deliberately NOT in the codebase (public repo).
  // It lives in the READER_PERSONA_B64 env var (base64 of the system prompt).
  const b64 = process.env.READER_PERSONA_B64;
  if (!b64) {
    throw new Error(
      "READER_PERSONA_B64 is not set — refusing to generate an un-personalized reading."
    );
  }
  let system = Buffer.from(b64, "base64").toString("utf-8");
  if (globalInstructions?.trim()) {
    system += `\n\nStanding instructions from the reader (trained in the persona studio — always apply):\n${globalInstructions.trim()}`;
  }
  if (personaNotes?.trim()) {
    system += `\n\nThe reader has given these additional voice/tone instructions for THIS reading — they take priority over the defaults above where they conflict:\n${personaNotes.trim()}`;
  }
  return system;
}

export function buildBase(opts: ReadingInput): string {
  const historyBlock = opts.history.length
    ? opts.history
        .map(
          (h) =>
            `On ${h.date}, they asked: "${h.message}" — cards drawn: ${h.cards.join(", ") || "?"}.\nReading given (excerpt): ${(h.reading ?? "").slice(0, 600)}`
        )
        .join("\n\n")
    : "None — this is their first reading with us.";

  return `Customer (Etsy): ${opts.customerName}
${opts.customerNotes ? `Private notes about this customer: ${opts.customerNotes}\n` : ""}
Their message with the order:
"""${opts.customerMessage}"""

Previous history with this customer:
${historyBlock}

This is a ${opts.cards.length}-card reading. The reader physically drew, in order: ${opts.cards.map((c, i) => `${i + 1}. ${c}`).join(", ")} (Osho Zen Tarot).`;
}

// Prompt for card i of the sequential chain. Each card's call layers onto
// the reading so far; only the final card concludes and signs off.
export function chainPrompt(
  base: string,
  cards: string[],
  i: number,
  current: string
): string {
  const card = cards[i];
  if (i === 0) {
    return `${base}

Write the reading for the FIRST card, ${card}.${
      cards.length > 1
        ? ` More cards follow and will build on this, so establish the situation and this card's insight without wrapping up the whole reading — no final sign-off yet, but it must still read as flowing prose, not an outline.`
        : " This is the only card, so make it a complete reading with a warm sign-off."
    }
Output only the reading text.`;
  }
  const isLast = i === cards.length - 1;
  return `${base}

The reading so far (covers card${i > 1 ? "s" : ""} ${cards.slice(0, i).join(", ")}):
"""${current}"""

Now layer in card ${i + 1}, ${card}. This card MODIFIES and deepens what the reading has established — let it shift the direction, confirm, complicate, or resolve what came before, referring naturally back to the earlier card${i > 1 ? "s" : ""}. Rewrite the full reading as one seamless piece incorporating everything so far plus this card.${
    isLast
      ? " This is the final card: bring the reading to its conclusion with a warm sign-off."
      : " More cards follow — do not wrap up or sign off yet."
  }
Output only the full rewritten reading text.`;
}

// Regeneration builds on the existing layered draft — it does NOT re-read
// the cards from scratch.
export function revisionPrompt(
  base: string,
  cards: string[],
  comments: string,
  draft: string
): string {
  return `${base}

A draft reading exists. The reader reviewed it and wants changes. Rewrite it applying these instructions faithfully while keeping the layered card structure (${cards.join(" → ")}) intact:
READER'S INSTRUCTIONS: ${comments || "(none given — vary the draft substantially)"}

DRAFT TO REVISE:
"""${draft}"""

Output only the revised reading text.`;
}

export async function llm(
  system: string,
  prompt: string,
  model: string = READING_MODEL
): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  const { text, usage } = await generateText({
    model: anthropic(model),
    system,
    prompt,
    temperature: 0.9,
  });
  return {
    text: text.trim(),
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
  };
}

// Streaming variant for the final call of a chain (or a revision) so the
// operator watches the reading appear as it's written.
export function llmStream(opts: {
  system: string;
  prompt: string;
  model?: string;
  onFinish: (finalText: string) => Promise<void>;
}) {
  return streamText({
    model: anthropic(opts.model ?? READING_MODEL),
    system: opts.system,
    prompt: opts.prompt,
    temperature: 0.9,
    onFinish: async ({ text }) => {
      await opts.onFinish(text.trim());
    },
  });
}
