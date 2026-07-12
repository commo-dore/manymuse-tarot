// Osho Zen Tarot — 79 cards
export const OSHO_ZEN_CARDS: { name: string; suit: string }[] = [
  // Major Arcana
  ...[
    "The Fool", "Existence", "Inner Voice", "Creativity", "The Rebel",
    "No-Thingness", "The Lovers", "Awareness", "Courage", "Aloneness",
    "Change", "Breakthrough", "New Vision", "Transformation", "Integration",
    "Conditioning", "Thunderbolt", "Silence", "Past Lives", "Innocence",
    "Beyond Illusion", "Completion", "The Master",
  ].map((name) => ({ name, suit: "Major Arcana" })),
  // Fire (action)
  ...[
    "The Source", "Possibilities", "Experiencing", "Participation", "Totality",
    "Success", "Stress", "Traveling", "Exhaustion", "Suppression",
    "Playfulness", "Intensity", "Sharing", "The Creator",
  ].map((name) => ({ name, suit: "Fire" })),
  // Water (emotions)
  ...[
    "Going with the Flow", "Friendliness", "Celebration", "Turning In",
    "Clinging to the Past", "The Dream", "Projections", "Letting Go",
    "Laziness", "Harmony", "Understanding", "Trust", "Receptivity", "Healing",
  ].map((name) => ({ name, suit: "Water" })),
  // Clouds (mind)
  ...[
    "Consciousness", "Schizophrenia", "Ice-olation", "Postponement",
    "Comparison", "The Burden", "Politics", "Guilt", "Sorrow", "Rebirth",
    "Mind", "Fighting", "Morality", "Control",
  ].map((name) => ({ name, suit: "Clouds" })),
  // Rainbows (physical)
  ...[
    "Maturity", "Moment to Moment", "Guidance", "The Miser", "The Outsider",
    "Compromise", "Patience", "Ordinariness", "Ripeness", "We Are the World",
    "Adventure", "Slowing Down", "Flowering", "Abundance",
  ].map((name) => ({ name, suit: "Rainbows" })),
];
