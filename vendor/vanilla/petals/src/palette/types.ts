import type { ReactNode } from "react";
import type { GlassSurface } from "../glass/engine";
import type { MatchRanges } from "./fuzzy";

/** One selectable row: a command, a file, a folder… The palette doesn't care which. */
export interface PaletteItem<T = unknown> {
  id: string;
  label: string;
  /** Second line in comfortable density; grey suffix in compact. */
  description?: string;
  /** Extra words that match the query but aren't shown. */
  keywords?: readonly string[];
  /** Grey suffix (compact) or group heading (comfortable). */
  category?: string;
  /** Leading glyph, ~14px. Shown in comfortable density. */
  icon?: ReactNode;
  /** Display-ready chords, e.g. ["Ctrl+O"]. Shown as plain grey mono text. */
  shortcut?: readonly string[];
  /** Shown dimmed; skipped by the keyboard and never selected. */
  disabled?: boolean;
  data?: T;
}

export interface PaletteSelectEvent {
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  source: "keyboard" | "pointer";
}

export type PaletteCloseReason = "escape" | "outside";

/** Returns null to hide the item. Ranges index into the label. */
export type PaletteFilter<T> = (
  item: PaletteItem<T>,
  query: string,
) => { score: number; ranges?: MatchRanges } | null;

/**
 * compact: QP style. Dense one-line rows, category as a grey suffix, no icons.
 * comfortable: Whitebloom style. Icons, two-line rows, group headings, optional header.
 */
export type PaletteDensity = "compact" | "comfortable";

export interface PaletteProps<T = unknown> {
  open: boolean;
  onClose(reason: PaletteCloseReason): void;

  items: readonly PaletteItem<T>[];
  /** The host decides whether to close; the palette never closes itself on select. */
  onSelect(item: PaletteItem<T>, event: PaletteSelectEvent): void;

  query: string;
  onQueryChange(query: string): void;
  /** Default: fuzzy on label, then keywords and description. `false` keeps the host's order. */
  filter?: PaletteFilter<T> | false;

  density?: PaletteDensity;
  /** Title and explanation above the list (comfortable density). */
  header?: { title: string; description?: string };
  /** Default: "suffix" in compact, "heading" in comfortable. */
  categoryDisplay?: "suffix" | "heading" | "none";
  placeholder?: string;
  emptyState?: ReactNode;
  /** Visible rows before scrolling. */
  maxRows?: number;
  /**
   * "lens": the panel refracts what is behind it at the rim; a feathered white wash covers the content
   * area so text stays legible. Chromium only; elsewhere it silently becomes "frost".
   * "frost": the plain frosted glass. Default "frost"; the lens is opt-in until tuned on the specimen page.
   */
  surface?: GlassSurface;
  /** Change to make the lens re-read the --lens-* tokens and the panel radius. For tuning tools only. */
  rebuildKey?: string | number;
}
