/** Lens parameters. Defaults live in tokens.css (--lens-*); these are the fallbacks if a token is missing. */
export interface LensParams {
  /** px: depth of the refracting band measured from the rim. */
  bezel: number;
  /** px: maximum shift at the very rim. */
  strength: number;
  /** 0..1: red/blue split as a fraction of `strength`. 1 is the maximum. */
  dispersion: number;
  /** 0..1: opacity of the thin specular line. */
  specular: number;
  /** px: blur applied before refraction. */
  frost: number;
  saturate: number;
  brightness: number;
}

export const LENS_DEFAULTS: LensParams = {
  bezel: 27,
  strength: 20,
  dispersion: 1,
  specular: 0.36,
  frost: 2,
  saturate: 1.25,
  brightness: 1.04,
};

/** Read `--lens-*` tokens from the element's computed style (they inherit from :root or a theme). */
export function readLensTokens(el: Element): LensParams {
  const cs = getComputedStyle(el);
  const num = (name: string, fallback: number) => {
    const v = parseFloat(cs.getPropertyValue(name));
    return Number.isFinite(v) ? v : fallback;
  };
  return {
    bezel: num("--lens-bezel", LENS_DEFAULTS.bezel),
    strength: num("--lens-strength", LENS_DEFAULTS.strength),
    dispersion: num("--lens-dispersion", LENS_DEFAULTS.dispersion),
    specular: num("--lens-specular", LENS_DEFAULTS.specular),
    frost: num("--lens-frost", LENS_DEFAULTS.frost),
    saturate: num("--lens-saturate", LENS_DEFAULTS.saturate),
    brightness: num("--lens-brightness", LENS_DEFAULTS.brightness),
  };
}
