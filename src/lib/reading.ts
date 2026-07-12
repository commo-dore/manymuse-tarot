import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";

type History = {
  message: string;
  cards: string[];
  reading: string | null;
  date: string;
}[];

function persona(): string {
  // The reader persona is deliberately NOT in the codebase (public repo).
  // It lives in the READER_PERSONA_B64 env var (base64 of the system prompt).
  const b64 = process.env.READER_PERSONA_B64;
  if (!b64) {
    throw new Error(
      "READER_PERSONA_B64 is not set — refusing to generate an un-personalized reading."
    );
  }
  return Buffer.from(b64, "base64").toString("utf-8");
}

async function llm(system: string, prompt: string): Promise<string> {
  const { text } = await generateText({
    model: anthropic("claude-sonnet-5"),
    system,
    prompt,
    temperature: 0.9,
  });
  return text.trim();
}

export async function generateReading(opts: {
  customerName: string;
  customerMessage: string;
  cards: string[]; // 1-3 cards, slot order is meaningful
  operatorComments?: string;
  previousDraft?: string;
  history: History;
  customerNotes?: string;
}): Promise<{ final: string; chain: string[] }> {
  const {
    customerName,
    customerMessage,
    cards,
    operatorComments,
    previousDraft,
    history,
    customerNotes,
  } = opts;
  if (!cards.length || cards.length > 3)
    throw new Error("Pick between 1 and 3 cards.");

  const system = persona();

  const historyBlock = history.length
    ? history
        .map(
          (h) =>
            `On ${h.date}, they asked: "${h.message}" — cards drawn: ${h.cards.join(", ") || "?"}.\nReading given (excerpt): ${(h.reading ?? "").slice(0, 600)}`
        )
        .join("\n\n")
    : "None — this is their first reading with us.";

  const base = `Customer (Etsy): ${customerName}
${customerNotes ? `Private notes about this customer: ${customerNotes}\n` : ""}
Their message with the order:
"""${customerMessage}"""

Previous history with this customer:
${historyBlock}

This is a ${cards.length}-card reading. The reader physically drew, in order: ${cards.map((c, i) => `${i + 1}. ${c}`).join(", ")} (Osho Zen Tarot).`;

  // Regeneration: revise the existing layered draft per the reader's
  // comments instead of re-running the chain from scratch.
  if (previousDraft) {
    const revised = await llm(
      system,
      `${base}

A draft reading exists. The reader reviewed it and wants changes. Rewrite it applying these instructions faithfully while keeping the layered card structure (${cards.join(" → ")}) intact:
READER'S INSTRUCTIONS: ${operatorComments || "(none given — vary the draft substantially)"}

DRAFT TO REVISE:
"""${previousDraft}"""

Output only the revised reading text.`
    );
    return { final: revised, chain: [revised] };
  }

  // Sequential chain: each card's call layers onto the reading so far.
  // Fidelity to slot order takes priority over latency.
  const chain: string[] = [];
  let current = "";
  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    let prompt: string;
    if (i === 0) {
      prompt = `${base}

Write the reading for the FIRST card, ${card}.${cards.length > 1 ? ` More cards follow and will build on this, so establish the situation and this card's insight without wrapping up the whole reading — no final sign-off yet, but it must still read as flowing prose, not an outline.` : " This is the only card, so make it a complete reading with a warm sign-off."}
Output only the reading text.`;
    } else {
      const isLast = i === cards.length - 1;
      prompt = `${base}

The reading so far (covers card${i > 1 ? "s" : ""} ${cards.slice(0, i).join(", ")}):
"""${current}"""

Now layer in card ${i + 1}, ${card}. This card MODIFIES and deepens what the reading has established — let it shift the direction, confirm, complicate, or resolve what came before, referring naturally back to the earlier card${i > 1 ? "s" : ""}. Rewrite the full reading as one seamless piece incorporating everything so far plus this card.${isLast ? " This is the final card: bring the reading to its conclusion with a warm sign-off." : " More cards follow — do not wrap up or sign off yet."}
Output only the full rewritten reading text.`;
    }
    current = await llm(system, prompt);
    chain.push(current);
  }

  return { final: current, chain };
}
