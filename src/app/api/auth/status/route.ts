import { NextResponse } from "next/server";
import { oauthConfigured } from "@/lib/auth";

export async function GET() {
  return NextResponse.json({ oauth: oauthConfigured() });
}
