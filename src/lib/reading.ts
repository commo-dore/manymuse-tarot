import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";

type History = {
  message: string;
  card: string | null;
  reading: string | null;
  date: string;
}[];

export async function generateReading(opts: {
  customerName: string;
  customerMessage: string;
  cardName: string;
  operatorComments?: string;
  previousDraft?: string;
  history: History;
  customerNotes?: string;
}) {
  const {
    customerName,
    customerMessage,
    cardName,
    operatorComments,
    previousDraft,
    history,
    customerNotes,
  } = opts;

  const historyBlock = history.length
    ? history
        .map(
          (h) =>
            `On ${h.date}, they asked: "${h.message}" — card drawn: ${h.card ?? "?"}.\nReading given (excerpt): ${(h.reading ?? "").slice(0, 600)}`
        )
        .join("\n\n")
    : "None — this is their first reading with us.";

  // The reader persona is deliberately NOT in the codebase (public repo).
  // It lives in the READER_PERSONA_B64 env var (base64 of the system prompt).
  const personaB64 = process.env.READER_PERSONA_B64;
  if (!personaB64) {
    throw new Error(
      "READER_PERSONA_B64 is not set — refusing to generate an un-personalized reading."
    );
  }
  const system = Buffer.from(personaB64, "base64").toString("utf-8");

  const user = `Customer (Etsy): ${customerName}
${customerNotes ? `Private notes about this customer: ${customerNotes}\n` : ""}
Their message with the order:
"""${customerMessage}"""

Card physically drawn by the reader: ${cardName} (Osho Zen Tarot)

Previous history with this customer:
${historyBlock}
${
  previousDraft
    ? `\nA previous draft exists. The reader reviewed it and wants changes. Rewrite the reading applying these instructions faithfully:\nREADER'S INSTRUCTIONS: ${operatorComments || "(none given — vary the draft substantially)"}\n\nPREVIOUS DRAFT:\n"""${previousDraft}"""`
    : ""
}

Write the reading now. Output only the message text itself.`;

  const { text } = await generateText({
    model: anthropic("claude-sonnet-5"),
    system,
    prompt: user,
    temperature: 0.9,
  });
  return text.trim();
}
