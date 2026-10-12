import { Fragment } from "react";
import type { LensBuild } from "./useLensFilter";

const only = (c: "r" | "g" | "b") =>
  `${c === "r" ? 1 : 0} 0 0 0 0  0 ${c === "g" ? 1 : 0} 0 0 0  0 0 ${c === "b" ? 1 : 0} 0 0  0 0 0 1 0`;

/**
 * The SVG filter behind `backdrop-filter: url(#id)`. Render it anywhere in the document (not
 * display:none, Chromium drops such filters); <GlassLayer> renders its own.
 *
 * Dispersion is three displacement passes at scales s(1+k), s, s(1-k), keeping one channel from each.
 * color-interpolation-filters must be sRGB or the 128-neutral map is read in linear light.
 */
export function LensFilter({ id, build }: { id: string; build: LensBuild }) {
  const { w, h, params: p, maps } = build;
  const s = p.strength;
  const k = p.dispersion;
  return (
    <svg
      width={0}
      height={0}
      style={{ position: "absolute" }}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <filter
          id={id}
          x={0}
          y={0}
          width={w}
          height={h}
          filterUnits="userSpaceOnUse"
          primitiveUnits="userSpaceOnUse"
          colorInterpolationFilters="sRGB"
        >
          <feImage href={maps.disp} x={0} y={0} width={w} height={h} preserveAspectRatio="none" result="dmap" />
          {k > 0.005 ? (
            <>
              {(
                [
                  ["r", s * (1 + k)],
                  ["g", s],
                  ["b", s * (1 - k)],
                ] as const
              ).map(([c, scale]) => (
                <Fragment key={c}>
                  <feDisplacementMap
                    in="SourceGraphic"
                    in2="dmap"
                    scale={scale.toFixed(2)}
                    xChannelSelector="R"
                    yChannelSelector="G"
                    result={`${c}d`}
                  />
                  <feColorMatrix in={`${c}d`} type="matrix" values={only(c)} result={c} />
                </Fragment>
              ))}
              <feComposite in="r" in2="g" operator="arithmetic" k1={0} k2={1} k3={1} k4={0} result="rg" />
              <feComposite in="rg" in2="b" operator="arithmetic" k1={0} k2={1} k3={1} k4={0} result="lens" />
            </>
          ) : (
            <feDisplacementMap
              in="SourceGraphic"
              in2="dmap"
              scale={s.toFixed(2)}
              xChannelSelector="R"
              yChannelSelector="G"
              result="lens"
            />
          )}
          <feImage href={maps.spec} x={0} y={0} width={w} height={h} preserveAspectRatio="none" result="smap" />
          <feColorMatrix
            in="smap"
            type="matrix"
            values={`1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 ${p.specular.toFixed(2)} 0`}
            result="smap2"
          />
          <feBlend in="smap2" in2="lens" mode="normal" />
        </filter>
      </defs>
    </svg>
  );
}
