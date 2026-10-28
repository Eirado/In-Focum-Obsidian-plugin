// Two Bases views. Focus: sessions per day against a daily goal, from On Focus's day notes.
// Habits: one map per habit, from the daily notes themselves. Bases picks the notes; these draw.

import {
  type BasesAllOptions,
  type BasesEntry,
  type BasesPropertyId,
  BasesView,
  type HoverPopover,
  NullValue,
  type QueryController,
  type TFile,
} from "obsidian";
import { addDays, formatLong, formatShort, isIso, type Iso, mondayOf, today, weeksUntil } from "./calendar";
import { dailyDate, type DayState, type HabitModel } from "./habits";
import { type Cell, fit, MapHost, renderGrid, renderMonths } from "./heatmap";
import type InFocum from "./main";

export const FOCUS_VIEW = "in-focum-focus";
export const HABITS_VIEW = "in-focum-habits";

/** Flexoki's accents; the colors behind each are in styles.css, validated for both themes. */
export const COLORS: Record<string, string> = {
  blue: "Blue",
  cyan: "Cyan",
  green: "Green",
  yellow: "Yellow",
  orange: "Orange",
  red: "Red",
  purple: "Purple",
  magenta: "Magenta",
};

const count = new Intl.NumberFormat();
const plural = (n: number, one: string, many: string) => `${count.format(n)} ${n === 1 ? one : many}`;

function numberOf(entry: BasesEntry, property: BasesPropertyId): number | undefined {
  const value = entry.getValue(property);
  if (!value || value instanceof NullValue) return undefined;
  const n = Number(value.toString());
  return Number.isFinite(n) ? n : undefined;
}

function textOf(entry: BasesEntry, property: BasesPropertyId): string | undefined {
  const value = entry.getValue(property);
  return !value || value instanceof NullValue ? undefined : value.toString();
}

/** Shared plumbing: a root that fits its weeks to the width and re-renders when that changes. */
abstract class MapView extends BasesView {
  hoverPopover: HoverPopover | null = null;
  protected readonly root: HTMLElement;
  protected readonly content: HTMLElement;
  private host?: MapHost;
  private shape = "";

  protected constructor(controller: QueryController, parentEl: HTMLElement, kind: string) {
    super(controller);
    this.root = parentEl.createDiv({ cls: ["gh-root", `gh-${kind}`] });
    this.content = this.root.createDiv({ cls: "gh-content" });
    // One layout per frame: the observer fires again when a render changes the height.
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => this.layout(false));
    });
    observer.observe(this.root);
    this.register(() => observer.disconnect());
  }

  onDataUpdated(): void {
    this.layout(true);
  }

  protected abstract defaultColor: string;
  /** Cell size and weeks for a width; `key` names anything else that needs a new render. */
  protected abstract measure(width: number): { cell: number; gap: number; shown: number; key?: string };
  protected abstract render(weeks: number, host: MapHost): void;

  protected option(key: string, fallback: number, min: number, max: number): number {
    const value = Number(this.config.get(key));
    return Number.isFinite(value) && value >= min ? Math.min(Math.round(value), max) : fallback;
  }

  /** The daily note of a day when it exists, else the day's own note: never an unresolved link. */
  protected linkFor(entry: BasesEntry | undefined): string | undefined {
    if (!entry) return undefined;
    const day = textOf(entry, this.config.getAsPropertyId("day") ?? "note.focus_day");
    const daily = day ? this.app.metadataCache.getFirstLinkpathDest(day, "") : null;
    return daily?.path ?? entry.file.path;
  }

  protected layout(force: boolean): void {
    const width = this.root.clientWidth;
    if (width === 0 || !this.data) return;
    const color = String(this.config.get("color") ?? this.defaultColor);
    for (const name of Object.keys(COLORS)) this.root.toggleClass(`gh-color-${name}`, name === (color in COLORS ? color : this.defaultColor));
    const { cell, gap, shown, key } = this.measure(width);
    this.root.style.setProperty("--gh-cell", `${cell}px`);
    this.root.style.setProperty("--gh-gap", `${gap}px`);
    this.root.style.setProperty("--gh-radius", `${cell >= 13 ? 3 : 2}px`);
    const shape = `${shown}|${key ?? ""}`;
    if (!force && shape === this.shape) return;
    this.shape = shape;
    this.host ??= new MapHost(this.app, this.root, this);
    this.host.reset();
    this.content.empty();
    this.render(shown, this.host);
  }
}

function tiles(parent: HTMLElement, items: { label: string; value: string; note?: string; good?: boolean }[]): void {
  const row = parent.createDiv({ cls: "gh-kpis" });
  for (const item of items) {
    const tile = row.createDiv({ cls: "gh-kpi" });
    tile.createDiv({ cls: "gh-kpi-label", text: item.label });
    tile.createDiv({ cls: "gh-kpi-value", text: item.value });
    if (item.note) tile.createDiv({ cls: ["gh-kpi-note", item.good ? "is-good" : ""].filter(Boolean), text: item.note });
  }
}

function legend(parent: HTMLElement, title: string, items: { tone: string; text: string }[]): void {
  const row = parent.createDiv({ cls: "gh-legend" });
  row.createSpan({ cls: "gh-legend-title", text: title });
  for (const item of items) {
    const entry = row.createSpan({ cls: "gh-legend-item" });
    entry.createSpan({ cls: ["gh-cell", "gh-swatch", item.tone] });
    entry.createSpan({ text: item.text });
  }
}

export class FocusView extends MapView {
  readonly type = FOCUS_VIEW;
  protected defaultColor = "blue";

  constructor(controller: QueryController, parentEl: HTMLElement) {
    super(controller, parentEl, "focus");
  }

  private compact(): boolean {
    return this.config.get("compact") === true;
  }

  protected measure(width: number) {
    const compact = this.compact();
    this.root.toggleClass("gh-compact", compact);
    return compact
      ? fit(width - 8, this.option("weeks", 26, 8, 53), 0, 8, 12)
      : fit(width - 8, this.option("weeks", 53, 8, 53), 34, 9, 18);
  }

  /**
   * The day the map ends on: the date of the daily note it is embedded in (a past note shows
   * that day as it was), else today. Bases has no API for the embedding note; its pane has.
   */
  private anchor(): Iso {
    const now = today();
    let found: Iso | undefined;
    this.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view as { file?: TFile | null; containerEl?: HTMLElement };
      if (found || !view.file || !view.containerEl?.contains(this.root)) return;
      const dmy = /^(\d{2})-(\d{2})-(\d{4})/.exec(view.file.basename);
      const ymd = /^(\d{4})-(\d{2})-(\d{2})/.exec(view.file.basename);
      const iso = dmy ? `${dmy[3]}-${dmy[2]}-${dmy[1]}` : ymd ? `${ymd[1]}-${ymd[2]}-${ymd[3]}` : "";
      if (isIso(iso)) found = iso;
    });
    return found && found < now ? found : now;
  }

  protected render(weeks: number, host: MapHost): void {
    const goal = this.option("goal", 10, 1, 50);
    const compact = this.compact();
    const now = this.anchor();
    const sessionsOf = this.config.getAsPropertyId("sessions") ?? "note.focus_done";
    const minutesOf = this.config.getAsPropertyId("minutes") ?? "note.focus_minutes";

    const days = new Map<Iso, { sessions: number; minutes?: number; entry: BasesEntry }>();
    for (const entry of this.data.data) {
      const date = entry.file.basename;
      const sessions = isIso(date) ? numberOf(entry, sessionsOf) : undefined;
      if (sessions !== undefined) days.set(date, { sessions, minutes: numberOf(entry, minutesOf), entry });
    }
    const sessionsOn = (date: Iso) => days.get(date)?.sessions ?? 0;
    const mondays = weeksUntil(now, weeks);
    const from = mondays[0];

    // Bins: 1–39% of the goal, 40–69%, 70–99%, the goal and more (the full color).
    const level = (n: number) => (n <= 0 ? 0 : n >= goal ? 4 : n / goal >= 0.7 ? 3 : n / goal >= 0.4 ? 2 : 1);
    const edges = [1, Math.ceil(goal * 0.4), Math.ceil(goal * 0.7), goal];

    let total = 0;
    let goalDays = 0;
    let best: { date: Iso; sessions: number } | undefined;
    for (const [date, day] of days) {
      if (date < from || date > now) continue;
      total += day.sessions;
      if (day.sessions >= goal) goalDays++;
      if (!best || day.sessions >= best.sessions) best = { date, sessions: day.sessions };
    }
    let week = 0;
    for (let d = mondayOf(now); d <= now; d = addDays(d, 1)) week += sessionsOn(d);
    let streak = 0;
    for (let d = sessionsOn(now) >= goal ? now : addDays(now, -1); sessionsOn(d) >= goal; d = addDays(d, -1)) streak++;
    let longest = 0;
    let run = 0;
    const first = [...days.keys()].sort()[0] ?? now;
    for (let d = first; d <= now; d = addDays(d, 1)) {
      run = sessionsOn(d) >= goal ? run + 1 : 0;
      longest = Math.max(longest, run);
    }

    const dayCount = sessionsOn(now);
    const span = weeks >= 52 ? "in the last year" : `in ${weeks} weeks`;
    if (compact) {
      // The daily note already shows the day's sessions and focus time; this adds the run of days.
      const line = this.content.createDiv({ cls: "gh-line" });
      const text = line.createDiv({ cls: "gh-line-text" });
      text.createSpan({ cls: "gh-line-value", text: count.format(streak) });
      text.createSpan({ text: `-day goal streak · best ${longest} · ` });
      text.createSpan({ cls: "gh-line-value", text: count.format(goalDays) });
      text.createSpan({ text: ` days at ${goal}+ ${span}` });
      const scale = line.createDiv({ cls: "gh-scale", attr: { "aria-hidden": "true" } });
      scale.createSpan({ text: "0" });
      for (const tone of ["l0", "l1", "l2", "l3", "l4"]) scale.createSpan({ cls: ["gh-cell", "gh-swatch", tone] });
      scale.createSpan({ text: `${goal}+` });
    } else
      tiles(this.content, [
        { label: "Today", value: count.format(dayCount), note: dayCount >= goal ? `of ${goal} · goal met` : `of ${goal}`, good: dayCount >= goal },
        { label: "This week", value: count.format(week), note: "sessions" },
        { label: "Goal streak", value: count.format(streak), note: `${streak === 1 ? "day" : "days"} · best ${longest}` },
        { label: "Days at goal", value: count.format(goalDays), note: span },
        { label: "Sessions", value: count.format(total), note: best ? `best ${best.sessions}, ${best.date === now ? "today" : formatShort(best.date)}` : span },
      ]);

    renderGrid(
      this.content,
      {
        mondays,
        today: now,
        months: true,
        weekdays: !compact,
        label: `Focus sessions per day, ${span} until ${formatLong(now)}. ${plural(total, "session", "sessions")}, ${plural(goalDays, "day", "days")} at the goal of ${goal}.`,
        cell: (date): Cell => {
          const day = days.get(date);
          const n = day?.sessions ?? 0;
          const minutes = day?.minutes ? ` · ${Math.floor(day.minutes / 60)}h ${day.minutes % 60}m` : "";
          return {
            tone: `l${level(n)}`,
            value: n > 0 ? plural(n, "session", "sessions") : "No sessions",
            detail: `${formatLong(date)}${minutes}${n >= goal ? " · goal met" : ""}`,
            link: this.linkFor(day?.entry),
          };
        },
      },
      host,
    );
    if (compact) return;

    const range = (lo: number, hi: number) => (hi <= lo ? `${lo}` : `${lo}–${hi}`);
    const bins = [
      { tone: "l0", text: "0" },
      ...[1, 2, 3]
        .filter((i) => edges[i] > edges[i - 1])
        .map((i) => ({ tone: `l${i}`, text: range(edges[i - 1], edges[i] - 1) })),
      { tone: "l4", text: `${goal}+ goal` },
    ];
    legend(this.content, "Sessions a day", bins);
  }
}

const STATES: Record<DayState, string> = {
  done: "Done",
  missed: "Not done",
  pending: "Still open today",
  off: "Not planned",
};

export class HabitsView extends MapView {
  readonly type = HABITS_VIEW;
  protected defaultColor = "green";
  private readonly plugin: InFocum;
  private model?: HabitModel;
  private problem?: string;
  private loading = 0;
  private columns = 1;

  constructor(controller: QueryController, parentEl: HTMLElement, plugin: InFocum) {
    super(controller, parentEl, "habits");
    this.plugin = plugin;
  }

  onload(): void {
    this.register(this.plugin.onHabitsChanged(() => this.onDataUpdated()));
  }

  /** The daily notes changed: read their habits (only the changed ones), then draw. */
  onDataUpdated(): void {
    const files: TFile[] = this.data?.data.map((entry) => entry.file) ?? [];
    const run = ++this.loading;
    this.plugin.habitModel(files).then(
      (model) => {
        if (run !== this.loading) return;
        [this.model, this.problem] = [model, undefined];
        this.layout(true);
      },
      (error: unknown) => {
        if (run !== this.loading) return;
        this.problem = error instanceof Error ? error.message : String(error);
        this.layout(true);
      },
    );
  }

  protected measure(width: number) {
    const label = width < 560 ? 0 : 180;
    const weeks = this.option("weeks", 26, 8, 53);
    const block = (cell: number) => label + weeks * (cell + (cell >= 13 ? 3 : 2));
    this.columns = width - 8 >= 2 * block(13) + 48 ? 2 : 1;
    this.root.toggleClass("is-narrow", label === 0);
    const each = (width - 8 - (this.columns - 1) * 48) / this.columns;
    return { ...fit(each, weeks, label, 8, 15), key: `${this.columns}` };
  }

  protected render(weeks: number, host: MapHost): void {
    const model = this.model;
    if (this.problem || !model) {
      this.content.createDiv({ cls: "gh-footnote", text: this.problem ? `Habit maps: ${this.problem}` : "Reading your daily notes…" });
      return;
    }
    const now = model.today;
    const mondays = weeksUntil(now, weeks);
    const from = mondays[0];
    // A click opens the day's daily note itself, not an iCloud copy of it.
    const notes = new Map<Iso, string>();
    for (const entry of this.data.data) {
      const date = dailyDate(entry.file.basename);
      if (date && (!notes.has(date) || entry.file.basename.length === 10)) notes.set(date, entry.file.path);
    }

    const shown = model.habits.filter((h) => {
      for (let d = from; d <= now; d = addDays(d, 1)) if (model.state(h.def.key, d) !== "off") return true;
      return false;
    });
    const quiet = model.habits.filter((h) => !shown.includes(h)).map((h) => h.def.name);

    const planned = shown.filter((h) => model.state(h.def.key, now) !== "off");
    const done = planned.filter((h) => model.state(h.def.key, now) === "done").length;
    const left = planned.filter((h) => model.state(h.def.key, now) === "pending").map((h) => h.def.name);
    const head = this.content.createDiv({ cls: "gh-habits-head" });
    const summary = head.createDiv({ cls: "gh-summary" });
    if (planned.length > 0) {
      summary.createSpan({ cls: "gh-summary-value", text: `${done} of ${planned.length}` });
      summary.createSpan({ text: left.length > 0 ? ` done today · left: ${left.join(", ")}` : " done today" });
    } else summary.createSpan({ text: "No habits planned today" });
    legend(head, "", [
      { tone: "done", text: STATES.done },
      { tone: "missed", text: STATES.missed },
      { tone: "off", text: STATES.off },
      { tone: "pending", text: STATES.pending },
    ]);

    const rows = this.content.createDiv({ cls: "gh-rows" });
    rows.style.setProperty("--gh-columns", String(this.columns));
    for (let c = 0; c < this.columns; c++) {
      const axis = rows.createDiv({ cls: "gh-habit gh-axis-block" });
      axis.createDiv({ cls: "gh-axis-spacer" });
      renderMonths(axis, mondays, now);
    }
    const section = (title: string) => rows.createDiv({ cls: "gh-section", text: title });
    const row = (h: (typeof shown)[number]) => {
      const block = rows.createDiv({ cls: "gh-habit" });
      const label = block.createDiv({ cls: ["gh-label", h.active ? "" : "is-past"].filter(Boolean) });
      label.createDiv({ cls: "gh-label-name", text: h.def.name });
      // A past habit's last 30 days hold a day or two at most: its overall rate says more.
      const meta = h.active
        ? [`Streak ${h.streak} · best ${h.best}`, h.rate30 === undefined ? "" : `${h.rate30}% of the last 30 days`]
        : [`${h.rate ?? 0}% overall · best streak ${h.best}`, h.lastPlanned ? `Last planned ${formatShort(h.lastPlanned)}` : ""];
      for (const line of meta.filter(Boolean)) label.createDiv({ cls: "gh-label-meta", text: line });
      renderGrid(
        block,
        {
          mondays,
          today: now,
          label: `${h.def.name}, ${weeks} weeks`,
          cell: (date): Cell => {
            const state = model.state(h.def.key, date);
            return { tone: state, value: STATES[state], detail: `${h.def.name} · ${formatLong(date)}`, link: notes.get(date) };
          },
        },
        host,
      );
    };

    const active = shown.filter((h) => h.active);
    const past = shown.filter((h) => !h.active);
    if (active.length > 0 && past.length > 0) section("Active");
    active.forEach(row);
    if (past.length > 0) section("Past habits");
    past.forEach(row);
    if (quiet.length > 0)
      this.content.createDiv({ cls: "gh-footnote", text: `Nothing in these ${weeks} weeks: ${quiet.join(", ")}. Widen the weeks in the view settings to see them.` });
  }
}

export const focusOptions = (): BasesAllOptions[] => [
  { type: "dropdown", key: "color", displayName: "Color", default: "blue", options: COLORS },
  { type: "slider", key: "goal", displayName: "Daily goal (sessions)", default: 10, min: 1, max: 20, step: 1 },
  { type: "slider", key: "weeks", displayName: "Weeks shown", default: 53, min: 8, max: 53, step: 1 },
  { type: "property", key: "sessions", displayName: "Sessions", default: "note.focus_done" },
  { type: "property", key: "minutes", displayName: "Focus minutes", default: "note.focus_minutes" },
  { type: "property", key: "day", displayName: "Daily note name", default: "note.focus_day" },
  { type: "toggle", key: "compact", displayName: "Compact, for daily notes", default: false },
];

export const habitsOptions = (): BasesAllOptions[] => [
  { type: "dropdown", key: "color", displayName: "Color", default: "green", options: COLORS },
  { type: "slider", key: "weeks", displayName: "Weeks shown", default: 26, min: 8, max: 53, step: 1 },
];
