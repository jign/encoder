import { Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, MouseEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import { GlassLayer } from "../glass/GlassLayer";
import { resolveSurface } from "../glass/engine";
import { fuzzyMatch } from "./fuzzy";
import type { MatchRanges } from "./fuzzy";
import type { PaletteFilter, PaletteItem, PaletteProps } from "./types";
import "./palette.css";

interface Row<T> {
  item: PaletteItem<T>;
  ranges?: MatchRanges;
}

/** Label matches beat keyword matches, which beat description matches. */
function defaultFilter<T>(item: PaletteItem<T>, query: string): ReturnType<PaletteFilter<T>> {
  const label = fuzzyMatch(query, item.label);
  if (label) return label;
  let best: number | null = null;
  for (const k of item.keywords ?? []) {
    const m = fuzzyMatch(query, k);
    if (m && (best === null || m.score > best)) best = m.score;
  }
  if (best !== null) return { score: best - 2 };
  const desc = item.description ? fuzzyMatch(query, item.description) : null;
  return desc ? { score: desc.score - 4 } : null;
}

function rowsFor<T>(
  items: readonly PaletteItem<T>[],
  query: string,
  filter: PaletteFilter<T> | false,
  grouped: boolean,
): Row<T>[] {
  let rows: Row<T>[];
  if (!query.trim() || filter === false) {
    rows = items.map((item) => ({ item }));
  } else {
    const scored: (Row<T> & { score: number })[] = [];
    for (const item of items) {
      const m = filter(item, query);
      if (m) scored.push({ item, ranges: m.ranges, score: m.score });
    }
    rows = scored.sort((a, b) => b.score - a.score);
  }
  if (!grouped) return rows;
  // Group by category in order of first appearance, so the keyboard order is the visual order.
  const groups = new Map<string, Row<T>[]>();
  for (const row of rows) {
    const key = row.item.category ?? "";
    let group = groups.get(key);
    if (!group) groups.set(key, (group = []));
    group.push(row);
  }
  return [...groups.values()].flat();
}

function highlight(text: string, ranges: MatchRanges | undefined): ReactNode {
  if (!ranges?.length) return text;
  const out: ReactNode[] = [];
  let at = 0;
  for (const [start, end] of ranges) {
    if (start > at) out.push(text.slice(at, start));
    out.push(
      <mark key={start} className="vp-palette__hit">
        {text.slice(start, end)}
      </mark>,
    );
    at = end;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

/** Next enabled index from `from` moving by `step`: wraps by one row when `wrap`, else jumps and clamps. */
function nextEnabled<T>(rows: Row<T>[], from: number, step: number, wrap: boolean): number {
  const n = rows.length;
  const enabled = (i: number) => !rows[i].item.disabled;
  if (wrap) {
    const dir = step < 0 ? -1 : 1;
    let i = from < 0 ? (dir > 0 ? -1 : n) : from;
    for (let k = 0; k < n; k++) {
      i = (((i + dir) % n) + n) % n;
      if (enabled(i)) return i;
    }
    return -1;
  }
  const target = Math.min(n - 1, Math.max(0, from + step));
  const dir = step < 0 ? -1 : 1;
  for (let i = target; i >= 0 && i < n; i += dir) if (enabled(i)) return i;
  for (let i = target; i >= 0 && i < n; i -= dir) if (enabled(i)) return i;
  return -1;
}

export function Palette<T = unknown>(props: PaletteProps<T>) {
  if (!props.open) return null;
  return createPortal(<PalettePanel {...props} />, document.body);
}

function PalettePanel<T>({
  onClose,
  items,
  onSelect,
  query,
  onQueryChange,
  filter = defaultFilter,
  density = "compact",
  header,
  categoryDisplay = density === "compact" ? "suffix" : "heading",
  placeholder = "Type a command",
  emptyState = "No matches",
  maxRows = density === "compact" ? 12 : 8,
  surface = "frost",
  rebuildKey,
}: PaletteProps<T>) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const grouped = categoryDisplay === "heading";

  const rows = useMemo(() => rowsFor(items, query, filter, grouped), [items, query, filter, grouped]);
  const [active, setActive] = useState(-1);

  // Focus the input on open and give focus back on close.
  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    // Never scroll for focus, either way: the element getting focus back can be a whole document (an
    // editor's content), and focusing it plainly scrolls its page to the top.
    input.current?.focus({ preventScroll: true });
    return () => {
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    setActive(nextEnabled(rows, -1, 1, true));
  }, [rows]);

  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const select = (index: number, e: { shiftKey: boolean; ctrlKey: boolean; altKey: boolean }, source: "keyboard" | "pointer") => {
    const row = rows[index];
    if (!row || row.item.disabled) return;
    onSelect(row.item, { shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, altKey: e.altKey, source });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    const key = e.key;
    const move = (step: number, wrap: boolean) => {
      e.preventDefault();
      setActive((i) => nextEnabled(rows, i, step, wrap));
    };
    if (key === "ArrowDown") move(1, true);
    else if (key === "ArrowUp") move(-1, true);
    else if (key === "PageDown") move(maxRows, false);
    else if (key === "PageUp") move(-maxRows, false);
    else if (key === "Enter") {
      e.preventDefault();
      select(active, e, "keyboard");
    } else if (key === "Escape") {
      e.preventDefault();
      onClose("escape");
    } else if (key === "Tab") {
      e.preventDefault(); // focus stays in the palette
    }
  };

  // Clicks anywhere in the panel keep the caret in the input, except on the input itself.
  const keepFocus = (e: MouseEvent) => {
    if (e.target !== input.current) e.preventDefault();
  };

  const listId = `${id}-list`;
  const optionId = (i: number) => `${id}-opt-${i}`;
  const comfortable = density === "comfortable";
  const lens = resolveSurface(surface) === "lens";

  return (
    <div
      className="vp-palette-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose("outside");
      }}
    >
      <div
        className={`vp-palette vp-palette--${density} vp-palette--${lens ? "lens" : "frost"}`}
        role="dialog"
        aria-label={header?.title ?? placeholder}
        onMouseDown={keepFocus}
        style={{ "--vp-palette-rows": maxRows } as CSSProperties}
      >
        <GlassLayer surface={lens ? "lens" : "frost"} rebuildKey={rebuildKey} />
        {lens && <div className="vp-palette__wash" />}
        <input
          ref={input}
          className="vp-palette__input"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={active >= 0 ? optionId(active) : undefined}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {header && (
          <div className="vp-palette__header">
            <div className="vp-palette__header-title">{header.title}</div>
            {header.description && <div className="vp-palette__header-description">{header.description}</div>}
          </div>
        )}
        <div className="vp-palette__list" id={listId} role="listbox" ref={list}>
          {rows.length === 0 && <div className="vp-palette__empty">{emptyState}</div>}
          {rows.map((row, i) => {
            const { item } = row;
            const heading = grouped && item.category && item.category !== rows[i - 1]?.item.category;
            const className =
              "vp-palette__row" +
              (i === active ? " is-active" : "") +
              (item.disabled ? " is-disabled" : "") +
              (comfortable && item.description ? " has-description" : "");
            return (
              <Fragment key={item.id}>
                {heading && <div className="vp-palette__heading">{item.category}</div>}
                <div
                  id={optionId(i)}
                  className={className}
                  role="option"
                  aria-selected={i === active}
                  aria-disabled={item.disabled || undefined}
                  data-index={i}
                  onMouseMove={() => {
                    if (i !== active && !item.disabled) setActive(i);
                  }}
                  onClick={(e) => select(i, e, "pointer")}
                >
                  {comfortable && item.icon && <span className="vp-palette__icon">{item.icon}</span>}
                  <span className="vp-palette__text">
                    <span className="vp-palette__label">{highlight(item.label, row.ranges)}</span>
                    {item.description && <span className="vp-palette__description">{item.description}</span>}
                  </span>
                  {categoryDisplay === "suffix" && item.category && (
                    <span className="vp-palette__category">{item.category}</span>
                  )}
                  {item.shortcut?.length ? (
                    <span className="vp-palette__shortcut">{item.shortcut.join("  ")}</span>
                  ) : null}
                </div>
              </Fragment>
            );
          })}
        </div>
      </div>
    </div>
  );
}
