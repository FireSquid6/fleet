/**
 * A terminal cell is `FONT_SIZE * LINE_HEIGHT` tall — taller than the font glyph
 * that fills it — so painting block/box glyphs as *text* leaves a seam of empty
 * pixels between rows: solid block art grows horizontal gaps and vertical box
 * lines break into dashes. Drawing them from geometry keyed to the cell bounds
 * instead keeps the art contiguous at any line height, font, or zoom level.
 *
 * Returns `true` when `code` was handled (caller skips text rendering), `false`
 * otherwise (caller falls back to `fillText`).
 */
export function drawCellGlyph(
  ctx: CanvasRenderingContext2D,
  code: number,
  x: number,
  y: number,
  cw: number,
  ch: number,
  dpr: number,
): boolean {
  if (code >= 0x2580 && code <= 0x259f) return drawBlock(ctx, code, x, y, cw, ch, dpr);
  if (code >= 0x2500 && code <= 0x257f) return drawBox(ctx, code, x, y, cw, ch, dpr);
  return false;
}

function drawBlock(
  ctx: CanvasRenderingContext2D,
  code: number,
  x: number,
  y: number,
  cw: number,
  ch: number,
  dpr: number,
): boolean {
  const snap = (v: number) => Math.round(v * dpr) / dpr;
  const right = x + cw;
  const bottom = y + ch;
  const midX = snap(x + cw / 2);
  const midY = snap(y + ch / 2);
  const fill = (x0: number, y0: number, x1: number, y1: number) =>
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
  const lowerEighth = (n: number) => fill(x, snap(bottom - (ch * n) / 8), right, bottom);
  const leftEighth = (n: number) => fill(x, y, snap(x + (cw * n) / 8), bottom);
  const shade = (alpha: number) => {
    const prev = ctx.globalAlpha;
    ctx.globalAlpha = prev * alpha;
    fill(x, y, right, bottom);
    ctx.globalAlpha = prev;
  };

  switch (code) {
    case 0x2588: fill(x, y, right, bottom); return true; // █ full block
    case 0x2580: fill(x, y, right, midY); return true; // ▀ upper half
    case 0x2584: fill(x, midY, right, bottom); return true; // ▄ lower half
    case 0x258c: fill(x, y, midX, bottom); return true; // ▌ left half
    case 0x2590: fill(midX, y, right, bottom); return true; // ▐ right half
    case 0x2594: fill(x, y, right, snap(y + ch / 8)); return true; // ▔ upper eighth
    case 0x2595: fill(snap(right - cw / 8), y, right, bottom); return true; // ▕ right eighth
    case 0x2581: lowerEighth(1); return true; // ▁
    case 0x2582: lowerEighth(2); return true; // ▂
    case 0x2583: lowerEighth(3); return true; // ▃
    case 0x2585: lowerEighth(5); return true; // ▅
    case 0x2586: lowerEighth(6); return true; // ▆
    case 0x2587: lowerEighth(7); return true; // ▇
    case 0x2589: leftEighth(7); return true; // ▉
    case 0x258a: leftEighth(6); return true; // ▊
    case 0x258b: leftEighth(5); return true; // ▋
    case 0x258d: leftEighth(3); return true; // ▍
    case 0x258e: leftEighth(2); return true; // ▎
    case 0x258f: leftEighth(1); return true; // ▏
    case 0x2591: shade(0.25); return true; // ░ light shade
    case 0x2592: shade(0.5); return true; // ▒ medium shade
    case 0x2593: shade(0.75); return true; // ▓ dark shade
    default:
      break;
  }

  // Quadrants (U+2596–U+259F): fill any subset of the four cell corners.
  const ul = () => fill(x, y, midX, midY);
  const ur = () => fill(midX, y, right, midY);
  const ll = () => fill(x, midY, midX, bottom);
  const lr = () => fill(midX, midY, right, bottom);
  switch (code) {
    case 0x2596: ll(); return true; // ▖
    case 0x2597: lr(); return true; // ▗
    case 0x2598: ul(); return true; // ▘
    case 0x2599: ul(); ll(); lr(); return true; // ▙
    case 0x259a: ul(); lr(); return true; // ▚
    case 0x259b: ul(); ur(); ll(); return true; // ▛
    case 0x259c: ul(); ur(); lr(); return true; // ▜
    case 0x259d: ur(); return true; // ▝
    case 0x259e: ur(); ll(); return true; // ▞
    case 0x259f: ur(); ll(); lr(); return true; // ▟
    default:
      return false;
  }
}

/**
 * Per-glyph arm weights for the "junction" box-drawing characters, indexed by
 * code point: `[up, down, left, right]` where 0 = none, 1 = light, 2 = heavy,
 * 3 = double. Dashes (drawn as broken lines), rounded corners, and diagonals are
 * handled separately below and are absent from this table.
 */
const BOX_ARMS: Record<number, [number, number, number, number]> = {
  0x2500: [0, 0, 1, 1], 0x2501: [0, 0, 2, 2], 0x2502: [1, 1, 0, 0], 0x2503: [2, 2, 0, 0],
  0x250c: [0, 1, 0, 1], 0x250d: [0, 1, 0, 2], 0x250e: [0, 2, 0, 1], 0x250f: [0, 2, 0, 2],
  0x2510: [0, 1, 1, 0], 0x2511: [0, 1, 2, 0], 0x2512: [0, 2, 1, 0], 0x2513: [0, 2, 2, 0],
  0x2514: [1, 0, 0, 1], 0x2515: [1, 0, 0, 2], 0x2516: [2, 0, 0, 1], 0x2517: [2, 0, 0, 2],
  0x2518: [1, 0, 1, 0], 0x2519: [1, 0, 2, 0], 0x251a: [2, 0, 1, 0], 0x251b: [2, 0, 2, 0],
  0x251c: [1, 1, 0, 1], 0x251d: [1, 1, 0, 2], 0x251e: [2, 1, 0, 1], 0x251f: [1, 2, 0, 1],
  0x2520: [2, 2, 0, 1], 0x2521: [2, 1, 0, 2], 0x2522: [1, 2, 0, 2], 0x2523: [2, 2, 0, 2],
  0x2524: [1, 1, 1, 0], 0x2525: [1, 1, 2, 0], 0x2526: [2, 1, 1, 0], 0x2527: [1, 2, 1, 0],
  0x2528: [2, 2, 1, 0], 0x2529: [2, 1, 2, 0], 0x252a: [1, 2, 2, 0], 0x252b: [2, 2, 2, 0],
  0x252c: [0, 1, 1, 1], 0x252d: [0, 1, 2, 1], 0x252e: [0, 1, 1, 2], 0x252f: [0, 1, 2, 2],
  0x2530: [0, 2, 1, 1], 0x2531: [0, 2, 2, 1], 0x2532: [0, 2, 1, 2], 0x2533: [0, 2, 2, 2],
  0x2534: [1, 0, 1, 1], 0x2535: [1, 0, 2, 1], 0x2536: [1, 0, 1, 2], 0x2537: [1, 0, 2, 2],
  0x2538: [2, 0, 1, 1], 0x2539: [2, 0, 2, 1], 0x253a: [2, 0, 1, 2], 0x253b: [2, 0, 2, 2],
  0x253c: [1, 1, 1, 1], 0x253d: [1, 1, 2, 1], 0x253e: [1, 1, 1, 2], 0x253f: [1, 1, 2, 2],
  0x2540: [2, 1, 1, 1], 0x2541: [1, 2, 1, 1], 0x2542: [2, 2, 1, 1], 0x2543: [2, 1, 2, 1],
  0x2544: [2, 1, 1, 2], 0x2545: [1, 2, 2, 1], 0x2546: [1, 2, 1, 2], 0x2547: [2, 1, 2, 2],
  0x2548: [1, 2, 2, 2], 0x2549: [2, 2, 2, 1], 0x254a: [2, 2, 1, 2], 0x254b: [2, 2, 2, 2],
  0x2550: [0, 0, 3, 3], 0x2551: [3, 3, 0, 0], 0x2552: [0, 1, 0, 3], 0x2553: [0, 3, 0, 1],
  0x2554: [0, 3, 0, 3], 0x2555: [0, 1, 3, 0], 0x2556: [0, 3, 1, 0], 0x2557: [0, 3, 3, 0],
  0x2558: [1, 0, 0, 3], 0x2559: [3, 0, 0, 1], 0x255a: [3, 0, 0, 3], 0x255b: [1, 0, 3, 0],
  0x255c: [3, 0, 1, 0], 0x255d: [3, 0, 3, 0], 0x255e: [1, 1, 0, 3], 0x255f: [3, 3, 0, 1],
  0x2560: [3, 3, 0, 3], 0x2561: [1, 1, 3, 0], 0x2562: [3, 3, 1, 0], 0x2563: [3, 3, 3, 0],
  0x2564: [0, 1, 3, 3], 0x2565: [0, 3, 1, 1], 0x2566: [0, 3, 3, 3], 0x2567: [1, 0, 3, 3],
  0x2568: [3, 0, 1, 1], 0x2569: [3, 0, 3, 3], 0x256a: [1, 1, 3, 3], 0x256b: [3, 3, 1, 1],
  0x256c: [3, 3, 3, 3],
  0x2574: [0, 0, 1, 0], 0x2575: [1, 0, 0, 0], 0x2576: [0, 0, 0, 1], 0x2577: [0, 1, 0, 0],
  0x2578: [0, 0, 2, 0], 0x2579: [2, 0, 0, 0], 0x257a: [0, 0, 0, 2], 0x257b: [0, 2, 0, 0],
  0x257c: [0, 0, 1, 2], 0x257d: [1, 2, 0, 0], 0x257e: [0, 0, 2, 1], 0x257f: [2, 1, 0, 0],
};

/** Dashed lines: `[dash count, vertical?, weight]`. */
const BOX_DASH: Record<number, [number, boolean, number]> = {
  0x2504: [3, false, 1], 0x2505: [3, false, 2], 0x2506: [3, true, 1], 0x2507: [3, true, 2],
  0x2508: [4, false, 1], 0x2509: [4, false, 2], 0x250a: [4, true, 1], 0x250b: [4, true, 2],
  0x254c: [2, false, 1], 0x254d: [2, false, 2], 0x254e: [2, true, 1], 0x254f: [2, true, 2],
};

function drawBox(
  ctx: CanvasRenderingContext2D,
  code: number,
  x: number,
  y: number,
  cw: number,
  ch: number,
  dpr: number,
): boolean {
  const snap = (v: number) => Math.round(v * dpr) / dpr;
  // Line weights scale with the cell so they stay proportional under zoom, and
  // are rounded to a whole device pixel (min 1) so lines render crisp.
  const px = (w: number) => Math.max(1, Math.round(w * dpr)) / dpr;
  const light = px(ch / 14);
  const heavy = px(ch / 7);
  const cx = snap(x + cw / 2);
  const cy = snap(y + ch / 2);
  const right = x + cw;
  const bottom = y + ch;
  // Half the gap between the two rails of a double line.
  const dsep = Math.max(light, px(ch / 9));

  // A vertical bar centred on `hc`; a horizontal bar centred on `vc`.
  const vbar = (hc: number, y0: number, y1: number, t: number) =>
    ctx.fillRect(snap(hc - t / 2), y0, t, y1 - y0);
  const hbar = (vc: number, x0: number, x1: number, t: number) =>
    ctx.fillRect(x0, snap(vc - t / 2), x1 - x0, t);

  const dash = BOX_DASH[code];
  if (dash) {
    const [count, vertical, weight] = dash;
    const t = weight === 2 ? heavy : light;
    // `count` dashes separated by equal gaps: 2n-1 equal units, odd ones inked.
    const span = vertical ? ch : cw;
    const unit = span / (count * 2 - 1);
    for (let i = 0; i < count; i++) {
      const a = i * 2 * unit;
      if (vertical) vbar(cx, snap(y + a), snap(y + a + unit), t);
      else hbar(cy, snap(x + a), snap(x + a + unit), t);
    }
    return true;
  }

  if (code >= 0x256d && code <= 0x2573) {
    ctx.strokeStyle = ctx.fillStyle as string;
    ctx.lineWidth = light;
    ctx.beginPath();
    const r = Math.min(cw, ch) / 2;
    switch (code) {
      case 0x256d: // ╭ down + right
        ctx.moveTo(cx, bottom); ctx.lineTo(cx, cy + r);
        ctx.quadraticCurveTo(cx, cy, cx + r, cy); ctx.lineTo(right, cy); break;
      case 0x256e: // ╮ down + left
        ctx.moveTo(cx, bottom); ctx.lineTo(cx, cy + r);
        ctx.quadraticCurveTo(cx, cy, cx - r, cy); ctx.lineTo(x, cy); break;
      case 0x256f: // ╯ up + left
        ctx.moveTo(cx, y); ctx.lineTo(cx, cy - r);
        ctx.quadraticCurveTo(cx, cy, cx - r, cy); ctx.lineTo(x, cy); break;
      case 0x2570: // ╰ up + right
        ctx.moveTo(cx, y); ctx.lineTo(cx, cy - r);
        ctx.quadraticCurveTo(cx, cy, cx + r, cy); ctx.lineTo(right, cy); break;
      case 0x2571: // ╱
        ctx.moveTo(x, bottom); ctx.lineTo(right, y); break;
      case 0x2572: // ╲
        ctx.moveTo(x, y); ctx.lineTo(right, bottom); break;
      case 0x2573: // ╳
        ctx.moveTo(x, bottom); ctx.lineTo(right, y);
        ctx.moveTo(x, y); ctx.lineTo(right, bottom); break;
    }
    ctx.stroke();
    return true;
  }

  const arms = BOX_ARMS[code];
  if (!arms) return false;
  const [u, d, l, r] = arms;

  // Single (light/heavy) arms run from their edge through the centre, overshooting
  // by half a stroke so perpendicular arms fuse into a solid junction.
  const armT = (w: number) => (w === 2 ? heavy : light);
  if (u === 1 || u === 2) vbar(cx, y, snap(cy + armT(u) / 2), armT(u));
  if (d === 1 || d === 2) vbar(cx, snap(cy - armT(d) / 2), bottom, armT(d));
  if (l === 1 || l === 2) hbar(cy, x, snap(cx + armT(l) / 2), armT(l));
  if (r === 1 || r === 2) hbar(cy, snap(cx - armT(r) / 2), right, armT(r));

  // Double arms are drawn as two parallel light rails. A rail spans to the far
  // side (passing straight through) when the opposite arm continues, or stops at
  // the central square otherwise; a "cap" segment then closes the square on any
  // side with no arm, turning dangling rails into corners. Junctions that mix
  // double with single arms are approximate but readable — exact double joinery
  // would need per-glyph geometry.
  if (u === 3 || d === 3 || l === 3 || r === 3) {
    if (u === 3 || d === 3) {
      const top = u ? y : snap(cy - dsep);
      const bot = d ? bottom : snap(cy + dsep);
      vbar(cx - dsep, top, bot, light);
      vbar(cx + dsep, top, bot, light);
    }
    if (l === 3 || r === 3) {
      const lft = l ? x : snap(cx - dsep);
      const rgt = r ? right : snap(cx + dsep);
      hbar(cy - dsep, lft, rgt, light);
      hbar(cy + dsep, lft, rgt, light);
    }
    if ((u === 3 || d === 3) && !u) hbar(cy - dsep, snap(cx - dsep), snap(cx + dsep), light);
    if ((u === 3 || d === 3) && !d) hbar(cy + dsep, snap(cx - dsep), snap(cx + dsep), light);
    if ((l === 3 || r === 3) && !l) vbar(cx - dsep, snap(cy - dsep), snap(cy + dsep), light);
    if ((l === 3 || r === 3) && !r) vbar(cx + dsep, snap(cy - dsep), snap(cy + dsep), light);
  }

  return true;
}
