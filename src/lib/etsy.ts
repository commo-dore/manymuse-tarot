// Etsy API v3 integration. Static credentials (keystring, shared secret,
// shop id) live in environment variables — never in the repo or DB.
// OAuth tokens rotate on every refresh, so they live in the etsy_tokens
// table (single row, service-role access only).
import { db } from "@/lib/supabase";

export function etsyConfigured(): boolean {
  // Shop ID is auto-discovered at OAuth connect time, so only the
  // keystring is required up front.
  return !!process.env.ETSY_API_KEY;
}

export function etsyEnv() {
  return {
    apiKey: process.env.ETSY_API_KEY ?? "",
    sharedSecret: process.env.ETSY_SHARED_SECRET ?? "",
    shopId: process.env.ETSY_SHOP_ID ?? "",
  };
}

export async function getAccessToken(): Promise<string | null> {
  const supabase = db();
  const { data: row } = await supabase
    .from("etsy_tokens")
    .select("*")
    .eq("id", 1)
    .single();
  if (!row?.refresh_token) return null;

  const fresh =
    row.access_token &&
    row.expires_at &&
    new Date(row.expires_at).getTime() - Date.now() > 60_000;
  if (fresh) return row.access_token;

  const res = await fetch("https://api.etsy.com/v3/public/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: etsyEnv().apiKey,
      refresh_token: row.refresh_token,
    }),
  });
  const json = await res.json();
  if (!json.access_token) return null;
  await supabase
    .from("etsy_tokens")
    .update({
      access_token: json.access_token,
      refresh_token: json.refresh_token ?? row.refresh_token,
      expires_at: new Date(Date.now() + (json.expires_in ?? 3600) * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", 1);
  return json.access_token;
}

export type EtsyReceipt = {
  receipt_id: number;
  buyer_user_id: number;
  name: string;
  message_from_buyer: string | null;
  created_timestamp: number;
};

export async function fetchOpenReceipts(): Promise<EtsyReceipt[]> {
  const token = await getAccessToken();
  if (!token) throw new Error("Etsy is not connected — complete OAuth first.");
  const { apiKey } = etsyEnv();
  let shopId = etsyEnv().shopId;
  if (!shopId) {
    const { data: row } = await db()
      .from("etsy_tokens")
      .select("shop_id")
      .eq("id", 1)
      .maybeSingle();
    shopId = row?.shop_id ?? "";
  }
  if (!shopId)
    throw new Error("No Etsy shop ID — reconnect Etsy so it can be discovered.");
  const res = await fetch(
    `https://api.etsy.com/v3/application/shops/${shopId}/receipts?was_shipped=false&limit=50`,
    { headers: { "x-api-key": apiKey, Authorization: `Bearer ${token}` } }
  );
  if (!res.ok)
    throw new Error(`Etsy receipts fetch failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return (json.results ?? []) as EtsyReceipt[];
}
