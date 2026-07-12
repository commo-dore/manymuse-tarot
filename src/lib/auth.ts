import { cookies } from "next/headers";
import { createHmac } from "crypto";

const COOKIE = "mm_operator";

function sign(value: string) {
  const secret = process.env.OPERATOR_PASSWORD ?? "dev-secret";
  return createHmac("sha256", secret).update(value).digest("hex");
}

export function sessionToken() {
  return sign("operator-session");
}

export async function isOperator(): Promise<boolean> {
  const jar = await cookies();
  return jar.get(COOKIE)?.value === sessionToken();
}

export const OPERATOR_COOKIE = COOKIE;
