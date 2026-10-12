import { useLayoutEffect, useState } from "react";
import type { RefObject } from "react";
import { flushSync } from "react-dom";
import { LENS_DEFAULTS, readLensTokens } from "./lens";
import type { LensParams } from "./lens";
import { buildLensMaps } from "./maps";
import type { LensMaps } from "./maps";

/** Everything <LensFilter> needs to render the SVG filter for one element. */
export interface LensBuild {
  w: number;
  h: number;
  radius: number;
  params: LensParams;
  maps: LensMaps;
}

/** A resize that follows another within this window is debounced instead of rebuilt at once. */
const LEADING_GAP_MS = 150;
const TRAILING_MS = 120;

/**
 * Measures `ref` and keeps a lens filter spec in step with its size, border-radius and the `--lens-*` tokens.
 *
 * - First build runs in a layout effect, so the first paint already has the lens.
 * - Later size changes rebuild at once when the element has been still (typing in a palette changes its
 *   height; a stale map would show for a frame), and debounce when changes come in a stream (window drag).
 * - Moving the element costs nothing: the filter lives in element-local coordinates.
 *
 * Token and radius changes are not observable, so a tool that edits them live (the specimen page) passes a
 * `rebuildKey` that changes with them; apps leave it out.
 *
 * Layout size (offsetWidth/Height) is used on purpose: open animations that scale the element must not
 * bake the scale into the map.
 */
export function useLensFilter(
  ref: RefObject<HTMLElement | null>,
  enabled: boolean,
  overrides?: Partial<LensParams>,
  rebuildKey?: string | number,
): LensBuild | null {
  const [build, setBuild] = useState<LensBuild | null>(null);
  const overridesKey = JSON.stringify(overrides ?? {});

  useLayoutEffect(() => {
    const el = ref.current;
    if (!enabled || !el) {
      setBuild(null);
      return;
    }
    const over: Partial<LensParams> = JSON.parse(overridesKey);
    let timer = 0;
    let lastRun = 0;
    let lastW = 0;
    let lastH = 0;
    let cacheKey = "";
    let cached: LensMaps | null = null;

    const run = (sync: boolean) => {
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      if (!w || !h) return;
      const params: LensParams = { ...LENS_DEFAULTS, ...readLensTokens(el), ...over };
      const radius = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const key = `${w}|${h}|${radius}|${params.bezel}|${dpr}`;
      if (key !== cacheKey || !cached) {
        cached = buildLensMaps(w, h, radius, params.bezel, dpr);
        cacheKey = key;
      }
      lastW = w;
      lastH = h;
      lastRun = performance.now();
      const next: LensBuild = { w, h, radius, params, maps: cached };
      if (sync) flushSync(() => setBuild(next));
      else setBuild(next);
    };

    run(false);

    const ro = new ResizeObserver(() => {
      if (el.offsetWidth === lastW && el.offsetHeight === lastH) return;
      window.clearTimeout(timer);
      if (performance.now() - lastRun > LEADING_GAP_MS) run(true);
      else timer = window.setTimeout(() => run(false), TRAILING_MS);
    });
    ro.observe(el);

    return () => {
      window.clearTimeout(timer);
      ro.disconnect();
    };
  }, [ref, enabled, overridesKey, rebuildKey]);

  return enabled ? build : null;
}
