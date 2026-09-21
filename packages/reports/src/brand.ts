/**
 * JENAI report look: the Copper Craft brand from jenai.in (Space Grotesk,
 * ivory and copper, the dark pill wordmark), laid out as cards and tiles.
 * Charts are hand-drawn SVG so a PDF renders the same everywhere, with no
 * chart library and nothing fetched at print time.
 */

export const C = {
  ivory: "#FBF7F1",
  ivory2: "#F4EEE5",
  paper: "#FFFFFF",
  ink: "#211C1A",
  inkSoft: "#5F5854",
  grey: "#7C7671",
  line: "rgba(33,28,26,.12)",
  copper: "#C96A3C",
  copperSoft: "#E7A277",
  copperDeep: "#A9542C",
  ok: "#2F7D4F",
  bad: "#B42318",
  pill1: "#26262E",
  pill2: "#33333C",
} as const;

/** The wordmark, exact brand geometry, static for print. */
export function logo(height = 26): string {
  const width = Math.round(height * (548 / 120));
  return `<svg width="${width}" height="${height}" viewBox="46 70 548 120" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="jenai">
    <defs><linearGradient id="pill" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${C.pill1}"/><stop offset="1" stop-color="${C.pill2}"/></linearGradient></defs>
    <rect x="60" y="86" width="520" height="92" rx="46" fill="url(#pill)"/>
    <text x="118" y="150" font-family="'Space Grotesk',Arial,sans-serif" font-size="62" font-weight="700" fill="#FFFFFF" letter-spacing="1">jen<tspan fill="#D97D54">ai</tspan></text>
    <circle cx="410" cy="104" r="9" fill="#D97D54"/>
    <g transform="translate(496,132)">
      <rect x="0" y="-8" width="7" height="16" rx="3.5" fill="#4A4A52"/>
      <rect x="12" y="-14" width="7" height="28" rx="3.5" fill="#6B6B74"/>
      <rect x="24" y="-6" width="7" height="12" rx="3.5" fill="#4A4A52"/>
    </g>
  </svg>`;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Upright bars with a value above each, for calls a day. */
export function barChart(rows: Array<{ label: string; value: number; highlight?: boolean }>, opts: { height?: number; width?: number } = {}): string {
  const w = opts.width ?? 660;
  const h = opts.height ?? 150;
  const max = Math.max(1, ...rows.map((r) => r.value));
  const gap = 8;
  const bw = Math.max(6, (w - gap * (rows.length - 1)) / Math.max(rows.length, 1));
  const bars = rows
    .map((r, i) => {
      const bh = Math.round((r.value / max) * (h - 34));
      const x = i * (bw + gap);
      const y = h - 18 - bh;
      const fill = r.highlight ? C.copper : C.copperSoft;
      return `<rect x="${x}" y="${y}" width="${bw}" height="${Math.max(bh, 2)}" rx="4" fill="${fill}"/>
        <text x="${x + bw / 2}" y="${y - 4}" text-anchor="middle" font-size="8.5" fill="${C.inkSoft}">${r.value}</text>
        <text x="${x + bw / 2}" y="${h - 5}" text-anchor="middle" font-size="7.6" fill="${C.grey}">${esc(r.label)}</text>`;
    })
    .join("");
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" xmlns="http://www.w3.org/2000/svg">${bars}</svg>`;
}

/** Ring with a number in the middle. */
export function donut(slices: Array<{ label: string; value: number; color: string }>, centre: { value: string; caption: string }, size = 168): string {
  const total = slices.reduce((a, s) => a + s.value, 0) || 1;
  const r = size / 2 - 14;
  const c = size / 2;
  const circumference = 2 * Math.PI * r;
  let offset = 0;
  const arcs = slices
    .map((s) => {
      const len = (s.value / total) * circumference;
      const seg = `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${s.color}" stroke-width="22"
        stroke-dasharray="${len} ${circumference - len}" stroke-dashoffset="${-offset}" transform="rotate(-90 ${c} ${c})"/>`;
      offset += len;
      return seg;
    })
    .join("");
  return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
    <circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${C.ivory2}" stroke-width="22"/>
    ${arcs}
    <text x="${c}" y="${c - 1}" text-anchor="middle" font-size="26" font-weight="700" fill="${C.ink}">${esc(centre.value)}</text>
    <text x="${c}" y="${c + 15}" text-anchor="middle" font-size="9" fill="${C.grey}">${esc(centre.caption)}</text>
  </svg>`;
}

/** The rounded progress rows from the reference layout. */
export function progressRows(rows: Array<{ label: string; value: number; suffix?: string }>): string {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return `<div class="prog">${rows
    .map(
      (r) => `<div class="prog-row">
        <div class="prog-track"><div class="prog-fill" style="width:${Math.max(6, Math.round((r.value / max) * 100))}%"></div><span class="prog-label">${esc(r.label)}</span></div>
        <div class="prog-val">${r.value}${esc(r.suffix ?? "")}</div>
      </div>`,
    )
    .join("")}</div>`;
}

/** A ranked list with the change against the period before, as in the reference. */
export function rankedList(rows: Array<{ label: string; value: string; delta?: number | null }>): string {
  return `<ul class="ranked">${rows
    .map((r) => {
      const d = r.delta;
      const arrow = d === null || d === undefined ? `<span class="flat">no earlier period</span>` : d > 0 ? `<span class="up">▲ ${Math.abs(d)}%</span>` : d < 0 ? `<span class="down">▼ ${Math.abs(d)}%</span>` : `<span class="flat">no change</span>`;
      return `<li><span class="rk-label">${esc(r.label)}</span><span class="rk-val">${esc(r.value)}</span>${arrow}</li>`;
    })
    .join("")}</ul>`;
}

/** Page shell: fonts, tokens, cards, and the tile grid. */
export function css(): string {
  return `
  @page { size: A4; margin: 11mm; }
  * { box-sizing: border-box; }
  body { margin: 0; background: ${C.ivory}; color: ${C.ink};
    font-family: 'Space Grotesk', -apple-system, 'Helvetica Neue', Arial, sans-serif; font-size: 9.6px; line-height: 1.5;
    -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .page { position: relative; page-break-after: always; padding-bottom: 6mm; }
  .page:last-child { page-break-after: auto; }
  .glow { position: fixed; width: 320px; height: 320px; border-radius: 999px; filter: blur(46px); opacity: .5; z-index: -1; }
  .glow-a { background: rgba(201,106,60,.16); top: -90px; right: -80px; }
  .glow-b { background: rgba(231,162,119,.14); bottom: -110px; left: -90px; }
  h1 { font-size: 26px; font-weight: 700; letter-spacing: -.035em; line-height: 1.05; margin: 0; text-transform: lowercase; }
  h2 { font-size: 13px; font-weight: 700; letter-spacing: -.02em; margin: 0 0 8px; }
  h3 { font-size: 10px; font-weight: 700; margin: 0 0 6px; }
  p { margin: 0 0 8px; color: ${C.inkSoft}; }
  .masthead { display: flex; align-items: flex-end; justify-content: space-between; border-bottom: 2px solid ${C.ink}; padding-bottom: 9px; margin-bottom: 14px; }
  .masthead .who { font-size: 7.6px; letter-spacing: .12em; text-transform: uppercase; color: ${C.grey}; margin-top: 5px; }
  .masthead .right { text-align: right; }
  .kicker { display: inline-block; font-size: 7.6px; font-weight: 700; letter-spacing: .14em; text-transform: uppercase;
    color: ${C.copper}; background: rgba(201,106,60,.10); border: 1px solid rgba(201,106,60,.24); border-radius: 999px; padding: 3px 9px; }
  .card { background: ${C.paper}; border: 1px solid ${C.line}; border-radius: 16px; padding: 13px 15px; }
  .card.dark { background: ${C.ink}; color: ${C.ivory}; border-color: ${C.ink}; }
  .card.dark p, .card.dark .tile-label { color: rgba(251,247,241,.72); }
  .grid { display: grid; gap: 9px; }
  .g4 { grid-template-columns: repeat(4, 1fr); }
  .g3 { grid-template-columns: repeat(3, 1fr); }
  .g2 { grid-template-columns: repeat(2, 1fr); }
  .split { grid-template-columns: 1.35fr 1fr; }
  .tile-label { font-size: 7.8px; letter-spacing: .1em; text-transform: uppercase; color: ${C.grey}; }
  .tile-value { font-size: 27px; font-weight: 700; letter-spacing: -.03em; line-height: 1.05; margin-top: 3px; font-variant-numeric: tabular-nums; }
  .tile-note { font-size: 8.2px; color: ${C.grey}; margin-top: 2px; }
  .up { color: ${C.ok}; font-weight: 700; }
  .down { color: ${C.bad}; font-weight: 700; }
  .flat { color: ${C.grey}; }
  table { width: 100%; border-collapse: collapse; font-size: 9px; }
  th { text-align: left; background: ${C.ink}; color: ${C.ivory}; font-weight: 600; padding: 5px 8px; }
  th:first-child { border-radius: 6px 0 0 6px; } th:last-child { border-radius: 0 6px 6px 0; }
  td { padding: 5px 8px; border-bottom: 1px solid ${C.line}; font-variant-numeric: tabular-nums; }
  .ranked { list-style: none; margin: 0; padding: 0; }
  .ranked li { display: flex; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px solid ${C.line}; }
  .ranked li:last-child { border-bottom: 0; }
  .rk-label { flex: 1; font-weight: 600; }
  .rk-val { font-variant-numeric: tabular-nums; color: ${C.inkSoft}; }
  .prog { display: grid; gap: 7px; }
  .prog-row { display: flex; align-items: center; gap: 10px; }
  .prog-track { position: relative; flex: 1; height: 21px; background: ${C.ivory2}; border-radius: 999px; overflow: hidden; }
  .prog-fill { position: absolute; inset: 0 auto 0 0; background: ${C.copperSoft}; border-radius: 999px; }
  .prog-label { position: relative; display: block; padding: 3px 11px; font-size: 8.6px; font-weight: 700; color: ${C.ink}; }
  .prog-val { min-width: 34px; text-align: right; font-weight: 700; font-variant-numeric: tabular-nums; }
  .legend { display: flex; flex-wrap: wrap; gap: 10px; font-size: 8.4px; color: ${C.inkSoft}; margin-top: 8px; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 999px; margin-right: 4px; vertical-align: -1px; }
  .note { background: ${C.ivory2}; border-radius: 10px; padding: 10px 12px; font-size: 8.8px; color: ${C.inkSoft}; }
  .warn { background: #FFF4EE; border: 1px solid ${C.copperSoft}; border-radius: 10px; padding: 10px 12px; font-size: 8.8px; }
  .foot { display: flex; justify-content: space-between; font-size: 7.4px; color: ${C.grey}; border-top: 1px solid ${C.line}; padding-top: 6px; margin-top: 12px; }
  `;
}
