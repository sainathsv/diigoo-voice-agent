/**
 * Editions: what one installation of JENAI offers. The full product runs at app.jenai.in.
 *
 * The police edition (JENAI_EDITION=police) is the complaint portal alone, for a police
 * department's own server: calls with their recordings and transcripts, complaints
 * (Analytics and Cases, with WhatsApp through OpenWA on the same server) with case
 * sheets and the Excel export, and the officers who see them.
 * Sales modules, billing, integrations, the public API and the JENAI console are not
 * part of it, so that server does not serve them at all.
 */
export type Edition = "full" | "police";

export function editionFrom(value: string | undefined): Edition {
  return value === "police" ? "police" : "full";
}

/** Workspace pages of the police edition (after /w/<workspace>), in menu order. Analytics is its front page. */
export const POLICE_PAGES = ["/analytics", "/cases", "/calls", "/whatsapp", "/team", "/roles", "/branches", "/activity"] as const;

/** Workspace downloads the police edition keeps: recording playback, proof files and the Excel export. */
const POLICE_DOWNLOADS = ["calls", "cases", "complaints"];

/**
 * What a request gets in this edition: served, not found, or sent elsewhere. Workspace
 * pages and downloads are an allow list, so anything added later stays off a police
 * server until it is listed here.
 */
export function editionRoute(edition: Edition, pathname: string): "serve" | "not_found" | { redirect: string } {
  if (edition === "full") return "serve";
  if (/^\/(console|api\/v1)(\/|$)/.test(pathname)) return "not_found";
  if (pathname.startsWith("/api/w/")) {
    const api = /^\/api\/w\/[^/]+\/([^/]+)/.exec(pathname);
    return api && POLICE_DOWNLOADS.includes(api[1]!) ? "serve" : "not_found";
  }
  const w = /^\/w\/([^/]+)\/?([^/]*)/.exec(pathname);
  if (!w) return "serve";
  if (!w[2]) return { redirect: `/w/${w[1]}/analytics` };
  return (POLICE_PAGES as readonly string[]).includes(`/${w[2]}`) ? "serve" : "not_found";
}
