import { NextResponse, type NextRequest } from "next/server";
import { verifySession } from "@/lib/auth";

export const config = {
  matcher: ["/operator/:path*"],
};

// Every /operator page (queue, orders, persona studio, settings) requires a
// valid operator session; unauthenticated visits land on the login page.
export default function proxy(req: NextRequest) {
  const path = req.nextUrl.pathname;
  if (path === "/operator/login") return NextResponse.next();

  const token = req.cookies.get("mm_operator")?.value;
  if (verifySession(token)) return NextResponse.next();

  const login = req.nextUrl.clone();
  login.pathname = "/operator/login";
  login.search = "";
  return NextResponse.redirect(login);
}
