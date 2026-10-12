import { useId, useRef } from "react";
import type { CSSProperties } from "react";
import { resolveSurface } from "./engine";
import type { GlassSurface } from "./engine";
import { LensFilter } from "./LensFilter";
import type { LensParams } from "./lens";
import { useLensFilter } from "./useLensFilter";
import "./glass.css";

export interface GlassLayerProps {
  /**
   * "lens": refracts the backdrop at the rim (Chromium only). "frost": plain frosted glass.
   * "lens" falls back to "frost" wherever the engine can't refract.
   */
  surface?: GlassSurface;
  /** Per-instance overrides of the --lens-* tokens. */
  lens?: Partial<LensParams>;
  /**
   * Change this to make the lens re-read the --lens-* tokens and the border-radius and rebuild.
   * Only for tools that edit those live (the specimen page); apps don't need it.
   */
  rebuildKey?: string | number;
  className?: string;
}

/**
 * The glass material of a floating surface, as a background layer rather than as the surface itself.
 *
 *   <div class="my-panel">          // position: relative/absolute, border-radius, isolation: isolate
 *     <GlassLayer />                // first child: fills the panel, sits behind its content
 *     ...content, incl. .vp-frost elements...
 *   </div>
 *
 * Why a layer: an element with backdrop-filter is a "backdrop root", and a descendant with its own
 * backdrop-filter can only blur what that ancestor painted itself, never the page. So the lens must not
 * be an ancestor of anything that wants frost. Frosted elements are later siblings of the layer: their
 * backdrop is the page plus the lensed layer. The panel itself must not create a backdrop root
 * (no opacity < 1, filter, mask, clip-path, backdrop-filter, will-change of those). See study/07.
 *
 * The layer takes its size and border-radius from the panel (`border-radius: inherit`) and rebuilds the
 * lens when they change.
 */
export function GlassLayer({ surface = "lens", lens, rebuildKey, className }: GlassLayerProps) {
  const ref = useRef<HTMLDivElement>(null);
  const filterId = "vp-lens-" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const wantsLens = resolveSurface(surface) === "lens";
  const build = useLensFilter(ref, wantsLens, lens, rebuildKey);
  const refracting = wantsLens && build !== null;

  let style: CSSProperties | undefined;
  if (refracting) {
    const p = build.params;
    style = {
      backdropFilter: `blur(${p.frost}px) url(#${filterId}) saturate(${p.saturate}) brightness(${p.brightness})`,
    };
  }

  return (
    <div
      ref={ref}
      className={`vp-glass vp-glass--${refracting ? "lens" : "frost"}${className ? " " + className : ""}`}
      style={style}
      aria-hidden="true"
    >
      {refracting && <LensFilter id={filterId} build={build} />}
    </div>
  );
}
