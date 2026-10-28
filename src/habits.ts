// Habit rules, live from the daily notes. A habit is planned on a day that has a daily note when
// the template held it that day, or when its line is in the note. Planned and not ticked is not
// done: a deleted line, an unchecked one, or [-]. Today's unticked habits are still open.

import { addDays, isIso, type Iso } from "./calendar";

export type Status = "done" | "cancelled" | "open";
export type DayState = "done" | "missed" | "pending" | "off";
type Window = [Iso, Iso | null];

export interface HabitDef {
  name: string;
  key: string;
  match: string[];
  category?: string;
  windows?: Window[];
  auto?: boolean;
}

export interface HabitsConfig {
  /** The daily note template's path; empty when habits are not planned by a template. */
  template: string;
  habitTag: string;
  habits: HabitDef[];
}

/** The template's habits over time, recorded whenever they change. */
export interface TemplateLog {
  snapshots: { date: Iso; habits: string[] }[];
}

export interface HabitSummary {
  def: HabitDef;
  active: boolean;
  rank: number;
  planned: number;
  done: number;
  streak: number;
  best: number;
  rate30?: number;
  rate?: number;
  lastPlanned?: Iso;
}

export interface HabitModel {
  today: Iso;
  habits: HabitSummary[];
  /** Whether a day has a daily note. */
  noted: (date: Iso) => boolean;
  state: (key: string, date: Iso) => DayState;
}

/** A daily note's date from its name: `27-10-2026` or `2026-10-27`, or an iCloud copy such as `27-10-2026 2`. */
export function dailyDate(basename: string): Iso | undefined {
  const dmy = /^(\d{2})-(\d{2})-(\d{4})(?: \d+)?$/.exec(basename);
  const ymd = /^(\d{4})-(\d{2})-(\d{2})(?: \d+)?$/.exec(basename);
  const iso = dmy ? `${dmy[3]}-${dmy[2]}-${dmy[1]}` : ymd ? `${ymd[1]}-${ymd[2]}-${ymd[3]}` : "";
  return isIso(iso) ? iso : undefined;
}

export function parseConfig(text: string): HabitsConfig {
  const block = /```json\n([\s\S]*?)\n```/.exec(text);
  if (!block) throw new Error("the habits note needs a ```json block");
  const raw = JSON.parse(block[1]) as Partial<HabitsConfig>;
  return {
    template: raw.template ?? "",
    habitTag: raw.habitTag ?? "habit",
    habits: (raw.habits ?? []).map((h) => ({ ...h, match: h.match.map((m) => m.toLowerCase()) })),
  };
}

const TAG = /(?:^|[^\w/&])#([\p{L}\p{N}_/-]+)/gu;

/** The words of a task: no inline fields, link brackets, tags or done dates. */
function plain(text: string): string {
  return text
    .replace(/\[[\w-]+::[^\]]*\]/g, " ")
    .replace(/\([\w-]+::[^)]*\)/g, " ")
    .replace(/✅\s*\d{4}-\d{2}-\d{2}/g, " ")
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(TAG, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const normalize = (text: string) => plain(text).toLowerCase();
const statusOf = (mark: string): Status => (mark === "x" || mark === "X" ? "done" : mark === "-" ? "cancelled" : "open");
const better = (a: Status | undefined, b: Status): Status =>
  a === "done" || b === "done" ? "done" : a === "cancelled" || b === "cancelled" ? "cancelled" : "open";

/** Top-level task lines outside frontmatter, callouts and code: where the daily habits live. */
function topTasks(text: string): { status: Status; text: string; tags: string[] }[] {
  const out: { status: Status; text: string; tags: string[] }[] = [];
  let fence = false;
  for (const line of text.replace(/^---\n[\s\S]*?\n---\n?/, "").split("\n")) {
    if (/^\s*```/.test(line)) fence = !fence;
    if (fence || line.startsWith(">")) continue;
    const task = /^(?:[-*+]|\d+[.)])\s+\[(.)\]\s+(.*)$/.exec(line);
    if (task) out.push({ status: statusOf(task[1]), text: task[2], tags: [...task[2].matchAll(TAG)].map((m) => m[1].toLowerCase()) });
  }
  return out;
}

function habitOf(text: string, habits: HabitDef[]): HabitDef | undefined {
  const words = normalize(text);
  return habits.find((h) => h.match.some((p) => (p.endsWith("*") ? words.startsWith(p.slice(0, -1)) : words === p)));
}

const slug = (name: string) =>
  normalize(name)
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 30) || "habit";

/** The template's habits in order: its top-level tasks with the habit tag. Unknown ones join the config. */
export function templateHabits(text: string, config: HabitsConfig): string[] {
  const keys: string[] = [];
  for (const task of topTasks(text)) {
    if (!task.tags.includes(config.habitTag.toLowerCase())) continue;
    let habit = habitOf(task.text, config.habits);
    if (!habit) {
      let key = slug(task.text);
      while (config.habits.some((h) => h.key === key)) key = `${key}_2`;
      habit = { name: plain(task.text), key, match: [normalize(task.text)], auto: true };
      config.habits.push(habit);
    }
    if (!keys.includes(habit.key)) keys.push(habit.key);
  }
  return keys;
}

/** Records the template's habits when they changed since the last snapshot. */
export function trackTemplate(log: TemplateLog, keys: string[], today: Iso): boolean {
  const last = log.snapshots[log.snapshots.length - 1];
  if (last && last.habits.length === keys.length && last.habits.every((k) => keys.includes(k))) return false;
  const snapshot = { date: today, habits: [...keys].sort() };
  if (last?.date === today) log.snapshots[log.snapshots.length - 1] = snapshot;
  else log.snapshots.push(snapshot);
  return true;
}

/** Whether the template held a habit on a day: the log from its first snapshot, the config's windows before. */
function inTemplate(habit: HabitDef, date: Iso, log: TemplateLog): boolean {
  const first = log.snapshots[0];
  if (first && date >= first.date) {
    let held = false;
    for (const snapshot of log.snapshots) if (snapshot.date <= date) held = snapshot.habits.includes(habit.key);
    return held;
  }
  return (habit.windows ?? []).some(([from, to]) => date >= from && (to === null || date <= to));
}

/** Each habit's status in one note. */
export function noteHabits(text: string, habits: HabitDef[]): Map<string, Status> {
  const statuses = new Map<string, Status>();
  for (const task of topTasks(text)) {
    const habit = habitOf(task.text, habits);
    if (habit) statuses.set(habit.key, better(statuses.get(habit.key), task.status));
  }
  return statuses;
}

/** Merges a note's statuses into its day: copies of a daily note count as one day. */
export function mergeInto(days: Map<Iso, Map<string, Status>>, date: Iso, statuses: Map<string, Status>): void {
  const day = days.get(date) ?? new Map<string, Status>();
  for (const [key, status] of statuses) day.set(key, better(day.get(key), status));
  days.set(date, day);
}

export function buildModel(days: Map<Iso, Map<string, Status>>, config: HabitsConfig, log: TemplateLog, templateKeys: string[], today: Iso): HabitModel {
  const states = new Map<string, Map<Iso, DayState>>();
  const dates = [...days.keys()].filter((d) => d <= today).sort();
  for (const habit of config.habits) {
    const byDate = new Map<Iso, DayState>();
    for (const date of dates) {
      const status = days.get(date)!.get(habit.key);
      if (status === "done") byDate.set(date, "done");
      else if (status !== undefined || inTemplate(habit, date, log)) byDate.set(date, date === today ? "pending" : "missed");
    }
    states.set(habit.key, byDate);
  }

  const summaries = config.habits.map((def): HabitSummary => {
    const byDate = states.get(def.key)!;
    const decided = [...byDate].filter(([, s]) => s !== "pending");
    const doneDates = decided.filter(([, s]) => s === "done").map(([d]) => d);
    const rateFrom = (from: Iso) => {
      const recent = decided.filter(([d]) => d >= from);
      return recent.length > 0 ? Math.round((recent.filter(([, s]) => s === "done").length / recent.length) * 100) : undefined;
    };
    let streak = 0;
    for (let d = byDate.get(today) === "done" ? today : addDays(today, -1); byDate.get(d) === "done"; d = addDays(d, -1)) streak++;
    let best = 0;
    let run = 0;
    const planned = [...byDate.keys()].sort();
    for (let d = planned[0] ?? today; d <= today; d = addDays(d, 1)) {
      run = byDate.get(d) === "done" ? run + 1 : 0;
      best = Math.max(best, run);
    }
    return {
      def,
      active: inTemplate(def, today, log),
      rank: 0,
      planned: decided.length,
      done: doneDates.length,
      streak,
      best,
      rate30: rateFrom(addDays(today, -29)),
      rate: decided.length > 0 ? Math.round((doneDates.length / decided.length) * 100) : undefined,
      lastPlanned: planned[planned.length - 1],
    };
  });

  // Template order first, as in the daily note; then past habits, most recent first.
  const past = summaries.filter((s) => !s.active).sort((a, b) => (b.lastPlanned ?? "").localeCompare(a.lastPlanned ?? ""));
  for (const s of summaries) s.rank = s.active ? Math.max(0, templateKeys.indexOf(s.def.key)) : 100 + past.indexOf(s);

  return {
    today,
    habits: summaries.filter((s) => s.planned > 0 || s.active || byDateHasPending(states.get(s.def.key)!)).sort((a, b) => a.rank - b.rank),
    noted: (date) => days.has(date),
    state: (key, date) => states.get(key)?.get(date) ?? "off",
  };
}

const byDateHasPending = (byDate: Map<Iso, DayState>) => [...byDate.values()].includes("pending");
