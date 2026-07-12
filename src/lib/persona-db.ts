import type { SupabaseClient } from "@supabase/supabase-js";

// Effective standing instructions = free-text base + all approved
// adjustment prompts (managed in the persona studio's adjustments tab).
export async function loadGlobalInstructions(
  supabase: SupabaseClient,
  draftBase?: string
): Promise<string> {
  const [{ data: settings }, { data: adjustments }] = await Promise.all([
    supabase.from("persona_settings").select("instructions").eq("id", 1).maybeSingle(),
    supabase
      .from("persona_adjustments")
      .select("text")
      .order("created_at", { ascending: true }),
  ]);
  const base = draftBase !== undefined ? draftBase : (settings?.instructions ?? "");
  const bullets = (adjustments ?? []).map((a) => `- ${a.text}`).join("\n");
  return [base.trim(), bullets].filter(Boolean).join("\n");
}
