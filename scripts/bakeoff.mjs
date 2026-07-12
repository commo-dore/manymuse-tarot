// Bake-off: latest Opus vs latest Sonnet on realistic customer readings.
// Runs the same chained-reading pipeline the app uses, measures tokens,
// and prices each model. Run locally: node scripts/bakeoff.mjs
import { generateText } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { readFileSync, writeFileSync } from "fs";

// load env from .env.local
for (const line of readFileSync(".env.local", "utf-8").split("\n")) {
  const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MODELS = [
  // $ per 1M tokens (input, output). Sonnet 5 intro pricing ($2/$10)
  // applies through 2026-08-31; standard is $3/$15.
  { id: "claude-opus-4-8", label: "Opus 4.8", in: 5, out: 25 },
  { id: "claude-sonnet-5", label: "Sonnet 5", in: 2, out: 10, note: "intro pricing; $3/$15 after 2026-08-31" },
];

const CUSTOMERS = [
  {
    name: "Brianna",
    cards: ["Clinging to the Past", "Letting Go"],
    message:
      "My ex broke up with me 4 months ago and I still check his socials every day. He has a new girlfriend now. I keep dreaming about him. Is he coming back or do I need to move on? Please be honest, I can take it.",
  },
  {
    name: "Marcus",
    cards: ["Stress", "The Creator", "Success"],
    message:
      "I've been at my corporate job 9 years and I hate it. I have a side business doing custom woodwork that's starting to make real money. My wife is scared about health insurance. Should I take the leap this year?",
  },
  {
    name: "Yuki",
    cards: ["Aloneness"],
    message:
      "I just moved to a new country for my husband's job. I don't speak the language well and I feel invisible. I used to be the social one. Who am I here?",
  },
  {
    name: "Deja",
    cards: ["Projections", "Trust"],
    message:
      "There's a guy at my gym, we talk every time we see each other and he remembers little things I say. But he hasn't asked me out. Am I imagining the connection? Should I make the first move?",
  },
  {
    name: "Tom",
    cards: ["The Burden", "Compromise", "Breakthrough"],
    message:
      "I'm the oldest son and my parents expect me to take over the family restaurant. My brother won't help. I got into a nursing program which is my real dream. If I go, the restaurant probably closes. How do I choose without destroying the family?",
  },
];

const system = Buffer.from(process.env.READER_PERSONA_B64, "base64").toString("utf-8");

function base(c) {
  return `Customer (Etsy): ${c.name}\n\nTheir message with the order:\n"""${c.message}"""\n\nPrevious history with this customer:\nNone — this is their first reading with us.\n\nThis is a ${c.cards.length}-card reading. The reader physically drew, in order: ${c.cards.map((x, i) => `${i + 1}. ${x}`).join(", ")} (Osho Zen Tarot).`;
}

function chainPrompt(b, cards, i, current) {
  const card = cards[i];
  if (i === 0)
    return `${b}\n\nWrite the reading for the FIRST card, ${card}.${cards.length > 1 ? " More cards follow and will build on this, so establish the situation and this card's insight without wrapping up — no final sign-off yet, but flowing prose." : " This is the only card, so make it a complete reading with a warm sign-off."}\nOutput only the reading text.`;
  const isLast = i === cards.length - 1;
  return `${b}\n\nThe reading so far:\n"""${current}"""\n\nNow layer in card ${i + 1}, ${card}. This card MODIFIES and deepens what the reading has established. Rewrite the full reading as one seamless piece.${isLast ? " This is the final card: conclude with a warm sign-off." : " More cards follow — do not wrap up yet."}\nOutput only the full rewritten reading text.`;
}

async function runReading(modelId, c) {
  let current = "";
  let inTok = 0, outTok = 0;
  const t0 = Date.now();
  for (let i = 0; i < c.cards.length; i++) {
    const { text, usage } = await generateText({
      model: anthropic(modelId),
      system,
      prompt: chainPrompt(base(c), c.cards, i, current),
      temperature: 0.9,
    });
    current = text.trim();
    inTok += usage.inputTokens ?? 0;
    outTok += usage.outputTokens ?? 0;
  }
  return { text: current, inTok, outTok, ms: Date.now() - t0 };
}

const results = [];
for (const model of MODELS) {
  for (const c of CUSTOMERS) {
    process.stderr.write(`${model.label} × ${c.name} (${c.cards.length} cards)…\n`);
    try {
      const r = await runReading(model.id, c);
      const cost = (r.inTok * model.in + r.outTok * model.out) / 1e6;
      results.push({ model: model.label, customer: c.name, ...r, cost });
    } catch (e) {
      results.push({ model: model.label, customer: c.name, error: String(e.message).slice(0, 200) });
    }
  }
}

writeFileSync("/tmp/bakeoff-results.json", JSON.stringify({ results, generatedAt: process.argv[2] ?? "" }, null, 2));
console.log(JSON.stringify(results.map(({ text, ...r }) => r), null, 2));
// full texts for qualitative review
writeFileSync(
  "/tmp/bakeoff-texts.md",
  results.map((r) => `## ${r.model} × ${r.customer}\n\n${r.text ?? r.error}\n`).join("\n---\n\n")
);
