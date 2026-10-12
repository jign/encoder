/*
 * Displacement + specular maps for a w x h rounded rectangle.
 *
 * Displacement: R/G encode the x/y shift (128 = none). Inside the bezel the shift points inward along the
 * rim normal, scaled by a Snell's-law profile of a convex squircle; the flat interior is neutral.
 * Specular: white with alpha = a thin lit band at the rim, light from the upper left.
 *
 * Neither map depends on strength, dispersion or specular (those are filter attributes), so only a
 * change of size, radius, bezel or DPR needs a rebuild. Only the rim ring is computed; the interior is
 * a flat fill, which keeps a 560x300 @2x palette to a few ms.
 */

export interface LensMaps {
  /** PNG data URI. */
  disp: string;
  spec: string;
}

/** Convex squircle height over the bezel, x: 0 (rim) -> 1 (flat). */
const height = (x: number) => Math.pow(1 - Math.pow(1 - x, 4), 0.25);
const slope = (x: number) => {
  const a = Math.max(0, x - 1e-3);
  const b = Math.min(1, x + 1e-3);
  return (height(b) - height(a)) / (b - a);
};

/** Single refraction, n_air = 1, n_glass = 1.5; lateral shift in glass-thickness units. */
function lateral(x: number): number {
  const th1 = Math.atan(Math.abs(slope(x)) * 0.9);
  const th2 = Math.asin(Math.sin(th1) / 1.5);
  const thickness = 0.35 + 0.65 * height(x);
  return Math.tan(th1 - th2) * thickness;
}

const N = 127;
const profile = (() => {
  const p = new Float32Array(N + 1);
  let max = 0;
  for (let i = 0; i <= N; i++) {
    p[i] = lateral(i / N);
    max = Math.max(max, p[i]);
  }
  for (let i = 0; i <= N; i++) p[i] /= max;
  return p;
})();
const profileAt = (x: number) => profile[Math.min(N, Math.max(0, Math.round(x * N)))];

const LIGHT_ANGLE = (-60 * Math.PI) / 180; // upper left
const LX = Math.sin(LIGHT_ANGLE);
const LY = -Math.cos(LIGHT_ANGLE);

export function buildLensMaps(w: number, h: number, radius: number, bezel: number, dpr: number): LensMaps {
  const W = Math.max(1, Math.round(w * dpr));
  const H = Math.max(1, Math.round(h * dpr));
  const mk = () => {
    const c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    return c;
  };
  const dc = mk();
  const sc = mk();
  const dctx = dc.getContext("2d");
  const sctx = sc.getContext("2d");
  if (!dctx || !sctx) throw new Error("2d canvas unavailable");
  const di = dctx.createImageData(W, H);
  const si = sctx.createImageData(W, H);
  const d32 = new Uint32Array(di.data.buffer);
  const s32 = new Uint32Array(si.data.buffer);
  d32.fill(0xff808080); // R=G=B=128, A=255 (little endian); specular stays transparent

  const hw = w / 2;
  const hh = h / 2;
  const r = Math.min(radius, hw, hh);
  const B = Math.min(bezel, Math.min(hw, hh));
  const band = Math.min(W, Math.ceil((B + 3) * dpr));

  const pixel = (x: number, y: number) => {
    const px = (x + 0.5) / dpr - hw;
    const py = (y + 0.5) / dpr - hh;
    // rounded-rect SDF (negative inside) and outward normal
    const qx = Math.abs(px) - (hw - r);
    const qy = Math.abs(py) - (hh - r);
    const d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
    const depth = -d;
    let nx: number;
    let ny: number;
    if (qx > 0 && qy > 0) {
      const l = Math.hypot(qx, qy) || 1;
      nx = qx / l;
      ny = qy / l;
    } else if (qx > qy) {
      nx = 1;
      ny = 0;
    } else {
      nx = 0;
      ny = 1;
    }
    if (px < 0) nx = -nx;
    if (py < 0) ny = -ny;

    const o = y * W + x;
    if (depth >= 0 && depth < B) {
      const m = profileAt(depth / B);
      const rr = Math.round(128 + -nx * m * 127);
      const gg = Math.round(128 + -ny * m * 127);
      d32[o] = 0xff000000 | (128 << 16) | (gg << 8) | rr;
    }
    if (depth >= -0.5 && depth < 2.5) {
      const lit = nx * LX + ny * LY;
      const lobe = Math.max(lit, 0) ** 2.2 + 0.35 * Math.max(-lit, 0) ** 2.2;
      const a = Math.min(1, lobe * Math.exp(-(((depth - 0.9) / 0.9) ** 2)));
      s32[o] = ((Math.round(a * 255) << 24) | 0x00ffffff) >>> 0;
    }
  };

  const ringRows = Math.min(H, Math.ceil((B + 3) * dpr));
  for (let y = 0; y < H; y++) {
    if (y < ringRows || y >= H - ringRows) {
      for (let x = 0; x < W; x++) pixel(x, y);
    } else {
      for (let x = 0; x < band; x++) pixel(x, y);
      for (let x = Math.max(band, W - band); x < W; x++) pixel(x, y);
    }
  }

  dctx.putImageData(di, 0, 0);
  sctx.putImageData(si, 0, 0);
  return { disp: dc.toDataURL("image/png"), spec: sc.toDataURL("image/png") };
}
