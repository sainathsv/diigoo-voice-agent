/**
 * Build a calls report as HTML and PDF.
 *   pnpm --filter @jenai/reports report -- --org zennara --days 45 --out ~/Desktop/report.pdf
 * PDF rendering uses the Chrome already on the machine; the web app will render
 * the same HTML when a client presses Download.
 */
import "@jenai/db/env";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { organizations, platformDb } from "@jenai/db";
import { callsSummary } from "./data";
import { callsReportHtml } from "./calls-report";

const arg = (n: string, fallback = "") => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? (process.argv[i + 1] ?? fallback) : fallback;
};

const CHROME = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].find((p) => existsSync(p));

const slug = arg("org", "zennara");
const days = Number(arg("days", "45"));
const out = arg("out", path.join(process.env.HOME ?? ".", "Desktop", `jenai-calls-report-${slug}.pdf`));

const [org] = await platformDb().select().from(organizations).where(eq(organizations.slug, slug));
if (!org) throw new Error(`No workspace with the slug ${slug}`);
const to = new Date();
const from = new Date(to.getTime() - days * 24 * 3600 * 1000);
const summary = await callsSummary(org.id, from, to);
const html = callsReportHtml(summary);

const dir = mkdtempSync(path.join(tmpdir(), "jenai-report-"));
const htmlPath = path.join(dir, "report.html");
writeFileSync(htmlPath, html);
console.log(`html: ${htmlPath}`);

if (!CHROME) {
  console.log("No Chrome found; open the HTML and print it to PDF.");
} else {
  execFileSync(CHROME, ["--headless", "--disable-gpu", "--no-pdf-header-footer", `--print-to-pdf=${out}`, `file://${htmlPath}`], { stdio: "pipe" });
  console.log(`pdf:  ${out}`);
}
if (process.argv.includes("--screenshot")) {
  const shot = out.replace(/\.pdf$/, ".png");
  execFileSync(CHROME!, ["--headless", "--disable-gpu", "--window-size=1240,1754", `--screenshot=${shot}`, `file://${htmlPath}`], { stdio: "pipe" });
  console.log(`png:  ${shot}`);
}
process.exit(0);
