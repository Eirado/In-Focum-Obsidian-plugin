// The calendar grid shared by every map: one column per week (Monday on top), a cell per
// day, month labels above, a tooltip and keyboard navigation. Views decide what a day means.

import { type App, type HoverParent, Keymap } from "obsidian";
import { addDays, type Iso, monthLabels } from "./calendar";

export const HOVER_SOURCE = "in-focum";

export interface Cell {
  /** CSS class of the cell: l0…l4 for amounts, done / missed / off / pending for habits. */
  tone: string;
  /** The tooltip's first line, the value: "13 sessions", "Done". */
  value: string;
  /** The tooltip's second line: the date and context. */
  detail: string;
  /** The note a click opens (a linkpath, resolved like a wikilink). */
  link?: string;
}

export interface GridSpec {
  mondays: Iso[];
  today: Iso;
  cell: (date: Iso) => Cell;
  label: string;
  months?: boolean;
  weekdays?: boolean;
}

const WEEKDAY_LABELS = ["Mon", "", "Wed", "", "Fri", "", ""];

/** Cell size and how many weeks fit in a width; fewer weeks rather than unreadable cells. */
export function fit(width: number, weeks: number, labelWidth: number, min: number, max: number) {
  const available = Math.max(0, width - labelWidth);
  const gapFor = (cell: number) => (cell >= 13 ? 3 : 2);
  let cell = Math.min(max, Math.floor((available - (weeks - 1) * 3) / weeks));
  let shown = weeks;
  if (cell < min) {
    cell = min;
    shown = Math.max(4, Math.floor((available + gapFor(min)) / (min + gapFor(min))));
  }
  return { cell, gap: gapFor(cell), shown: Math.min(shown, weeks) };
}

export function renderMonths(parent: HTMLElement, mondays: Iso[], today: Iso): HTMLElement {
  const row = parent.createDiv({ cls: "gh-months", attr: { "aria-hidden": "true" } });
  const labels = monthLabels(mondays, today);
  labels.forEach((label, i) => {
    const span = row.createSpan({ text: label.text });
    const next = labels[i + 1]?.column ?? mondays.length;
    span.style.gridColumn = `${label.column + 1} / ${next + 1}`;
  });
  return row;
}

export function renderGrid(parent: HTMLElement, spec: GridSpec, host: MapHost): HTMLElement {
  const map = parent.createDiv({ cls: "gh-map" });
  if (spec.months) renderMonths(map, spec.mondays, spec.today).addClass("gh-map-months");
  if (spec.weekdays) {
    const days = map.createDiv({ cls: "gh-weekdays", attr: { "aria-hidden": "true" } });
    for (const label of WEEKDAY_LABELS) days.createSpan({ text: label });
  } else map.addClass("no-weekdays");
  // Named by hidden text, not aria-label: Obsidian turns every aria-label into a hover tooltip.
  const name = map.createSpan({ cls: "gh-sr", text: spec.label, attr: { id: host.idFor("label") } });
  const grid = map.createDiv({ cls: "gh-grid", attr: { role: "grid", tabindex: "0", "aria-labelledby": name.id } });
  for (const monday of spec.mondays) {
    for (let d = 0; d < 7; d++) {
      const date = addDays(monday, d);
      const el = grid.createDiv({ cls: "gh-cell" });
      if (date > spec.today) {
        el.addClass("is-future");
        el.setAttr("aria-hidden", "true");
        continue;
      }
      const cell = spec.cell(date);
      el.addClass(cell.tone);
      if (date === spec.today) el.addClass("is-today");
      el.setAttrs({ role: "gridcell", id: host.idFor(date) });
      host.bind(el, date, cell);
    }
  }
  return map;
}

/**
 * Pointer, keyboard and tooltip handling for every grid inside one view root, by delegation:
 * a few listeners per view instead of several per cell.
 */
export class MapHost {
  private readonly cells = new WeakMap<HTMLElement, { date: Iso; cell: Cell }>();
  private readonly tip: HTMLElement;
  private readonly tipValue: HTMLElement;
  private readonly tipDetail: HTMLElement;
  private readonly prefix = `gh-${Math.random().toString(36).slice(2, 8)}`;
  private serial = 0;

  constructor(
    private readonly app: App,
    private readonly root: HTMLElement,
    private readonly hoverParent: HoverParent,
  ) {
    this.tip = root.createDiv({ cls: "gh-tip", attr: { "aria-hidden": "true" } });
    this.tipValue = this.tip.createDiv({ cls: "gh-tip-value" });
    this.tipDetail = this.tip.createDiv({ cls: "gh-tip-detail" });
    root.addEventListener("pointerover", (e) => this.onPointerOver(e));
    root.addEventListener("pointerleave", () => this.hide());
    root.addEventListener("click", (e) => this.onClick(e));
    root.addEventListener("keydown", (e) => this.onKey(e));
    root.addEventListener("focusin", (e) => this.onFocus(e));
    root.addEventListener("focusout", () => this.hide());
  }

  /** Call before re-rendering: keeps the tooltip element, drops the rest. */
  reset(): void {
    this.hide();
    this.serial++;
  }

  idFor(date: Iso): string {
    return `${this.prefix}-${this.serial}-${Math.random().toString(36).slice(2, 6)}-${date}`;
  }

  bind(el: HTMLElement, date: Iso, cell: Cell): void {
    this.cells.set(el, { date, cell });
  }

  private cellOf(target: EventTarget | null): HTMLElement | null {
    const el = (target as HTMLElement | null)?.closest?.(".gh-cell") as HTMLElement | null;
    return el && this.cells.has(el) ? el : null;
  }

  private onPointerOver(e: PointerEvent): void {
    const el = this.cellOf(e.target);
    if (!el) return this.hide();
    this.show(el);
    const { cell } = this.cells.get(el)!;
    if (cell.link)
      this.app.workspace.trigger("hover-link", {
        event: e,
        source: HOVER_SOURCE,
        hoverParent: this.hoverParent,
        targetEl: el,
        linktext: cell.link,
        sourcePath: "",
      });
  }

  private onClick(e: MouseEvent): void {
    const el = this.cellOf(e.target);
    if (el) this.open(el, e);
  }

  private open(el: HTMLElement, e: MouseEvent | KeyboardEvent): void {
    const { cell } = this.cells.get(el)!;
    if (cell.link) void this.app.workspace.openLinkText(cell.link, "", Keymap.isModEvent(e));
  }

  private onFocus(e: FocusEvent): void {
    const grid = (e.target as HTMLElement).closest(".gh-grid") as HTMLElement | null;
    if (!grid) return;
    const active = this.active(grid) ?? this.lastCell(grid);
    if (active) this.activate(grid, active);
  }

  private onKey(e: KeyboardEvent): void {
    const grid = (e.target as HTMLElement).closest(".gh-grid") as HTMLElement | null;
    if (!grid) return;
    const cells = Array.from(grid.children) as HTMLElement[];
    const current = this.active(grid) ?? this.lastCell(grid);
    if (!current) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      this.open(current, e);
      return;
    }
    const steps: Record<string, number> = { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -7, ArrowRight: 7 };
    let index = cells.indexOf(current);
    if (e.key === "Home") index = 0;
    else if (e.key === "End") index = cells.indexOf(this.lastCell(grid)!);
    else if (e.key in steps) {
      const step = steps[e.key];
      const row = index % 7;
      if ((step === -1 && row === 0) || (step === 1 && row === 6)) return;
      index += step;
    } else return;
    e.preventDefault();
    const next = cells[index];
    if (next && this.cells.has(next)) this.activate(grid, next);
  }

  private active(grid: HTMLElement): HTMLElement | null {
    return grid.querySelector(".gh-cell.is-active");
  }

  private lastCell(grid: HTMLElement): HTMLElement | null {
    const cells = Array.from(grid.querySelectorAll(".gh-cell:not(.is-future)")) as HTMLElement[];
    return cells[cells.length - 1] ?? null;
  }

  private activate(grid: HTMLElement, el: HTMLElement): void {
    const previous = this.active(grid);
    previous?.removeClass("is-active");
    previous?.removeAttribute("aria-label");
    const { cell } = this.cells.get(el)!;
    el.setAttr("aria-label", `${cell.value}, ${cell.detail}`);
    el.addClass("is-active");
    grid.setAttr("aria-activedescendant", el.id);
    this.show(el);
  }

  private show(el: HTMLElement): void {
    const { cell } = this.cells.get(el)!;
    this.tipValue.setText(cell.value);
    this.tipDetail.setText(cell.detail);
    this.tip.addClass("is-visible");
    const box = this.root.getBoundingClientRect();
    const target = el.getBoundingClientRect();
    const half = this.tip.offsetWidth / 2;
    const center = target.left - box.left + target.width / 2;
    const left = Math.min(Math.max(center, half + 2), box.width - half - 2);
    const below = target.top - box.top < this.tip.offsetHeight + 12;
    this.tip.toggleClass("is-below", below);
    this.tip.style.left = `${left}px`;
    this.tip.style.top = `${below ? target.bottom - box.top : target.top - box.top}px`;
  }

  private hide(): void {
    this.tip.removeClass("is-visible");
  }
}
