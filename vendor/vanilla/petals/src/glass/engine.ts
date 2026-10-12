/*
 * Engine detection for the lens.
 *
 * `@supports (backdrop-filter: url(#x))` is true in WebKit/Gecko too, but they don't render SVG filters
 * in backdrop-filter (WebKit bug 245510), so feature queries can't be used. Gate on engine instead.
 * See study/06-glass.md.
 */

let chromium: boolean | undefined;

function isChromium(): boolean {
  if (chromium !== undefined) return chromium;
  if (typeof navigator === "undefined") return (chromium = false);
  const brands = (navigator as Navigator & { userAgentData?: { brands?: readonly { brand: string }[] } })
    .userAgentData?.brands;
  chromium =
    !!brands?.some((b) => /Chromium/.test(b.brand)) || /\b(Chrome|Edg)\//.test(navigator.userAgent);
  return chromium;
}

/**
 * Can this webview refract the backdrop? True on Chromium (WebView2, Chrome, Edge) unless the user
 * asks for less transparency. A host can force the frosted look with `<html data-vp-glass="frost">`.
 */
export function supportsLens(): boolean {
  if (typeof document === "undefined" || !isChromium()) return false;
  if (document.documentElement.dataset.vpGlass === "frost") return false;
  return !matchMedia("(prefers-reduced-transparency: reduce)").matches;
}

export type GlassSurface = "lens" | "frost";

/** What the host asked for, resolved against what the engine can do. */
export function resolveSurface(wanted: GlassSurface): GlassSurface {
  return wanted === "lens" && supportsLens() ? "lens" : "frost";
}
