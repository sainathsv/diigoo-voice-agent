import { NextResponse, type NextRequest } from "next/server";
import { editionFrom, editionRoute } from "@jenai/authz";

/**
 * Content-Security-Policy with a fresh nonce per request (red-team finding,
 * 2026-09-19: the app shipped without a CSP). Next.js reads the nonce from the
 * request's CSP header and attaches it to its own scripts, so no inline script
 * without that nonce can run, even if an attacker gets markup onto a page.
 */
export function proxy(req: NextRequest) {
  // A police department's own server (JENAI_EDITION=police) serves its complaint portal only.
  const route = editionRoute(editionFrom(process.env.JENAI_EDITION), req.nextUrl.pathname);
  if (route === "not_found") return new NextResponse("Not found", { status: 404 });
  if (route !== "serve") return NextResponse.redirect(new URL(route.redirect, req.url));

  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64");
  const dev = process.env.NODE_ENV !== "production";
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "media-src 'self'",
    `connect-src 'self'${dev ? " ws: wss:" : ""}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(dev ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");

  const headers = new Headers(req.headers);
  headers.set("x-nonce", nonce);
  headers.set("content-security-policy", csp);
  const res = NextResponse.next({ request: { headers } });
  res.headers.set("content-security-policy", csp);
  if (!dev) res.headers.set("strict-transport-security", "max-age=63072000; includeSubDomains; preload");
  return res;
}

export const config = {
  matcher: [{ source: "/((?!_next/static|_next/image|favicon.ico).*)" }],
};
