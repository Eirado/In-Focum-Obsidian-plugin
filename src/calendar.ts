// Calendar math on date-only ISO strings (YYYY-MM-DD), in UTC so a daylight-saving
// change never shifts a day into the wrong column.

export type Iso = string;

const DAY = 86_400_000;
const toTime = (iso: Iso) => Date.parse(`${iso}T00:00:00Z`);
const toIso = (time: number): Iso => new Date(time).toISOString().slice(0, 10);

export const isIso = (text: string) => /^\d{4}-\d{2}-\d{2}$/.test(text) && toIso(toTime(text)) === text;
export const addDays = (iso: Iso, days: number): Iso => toIso(toTime(iso) + days * DAY);

/** Monday is 0, Sunday 6. */
export const weekday = (iso: Iso) => (new Date(toTime(iso)).getUTCDay() + 6) % 7;
export const mondayOf = (iso: Iso): Iso => addDays(iso, -weekday(iso));

/** Today on this Mac's clock, the day the daily notes use. */
export function today(): Iso {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** The Mondays of the last `count` weeks; the last one is this week. */
export function weeksUntil(day: Iso, count: number): Iso[] {
  const last = mondayOf(day);
  return Array.from({ length: count }, (_, i) => addDays(last, (i - count + 1) * 7));
}

const monthName = new Intl.DateTimeFormat(undefined, { month: "short", timeZone: "UTC" });
const longDate = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const shortDate = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", timeZone: "UTC" });

export const formatLong = (iso: Iso) => longDate.format(new Date(toTime(iso)));
export const formatShort = (iso: Iso) => shortDate.format(new Date(toTime(iso)));

/** A label at each week holding the 1st of a month (one that has begun), unless it would crowd the previous label. */
export function monthLabels(mondays: Iso[], until: Iso): { column: number; text: string }[] {
  const labels: { column: number; text: string }[] = [];
  mondays.forEach((monday, column) => {
    const first = Array.from({ length: 7 }, (_, d) => addDays(monday, d)).find((iso) => iso.endsWith("-01") && iso <= until);
    const opening = column === 0 && Number(monday.slice(8, 10)) <= 7;
    if (!first && !opening) return;
    const anchor = first ?? monday;
    if (labels.length > 0 && column - labels[labels.length - 1].column < 3) return;
    labels.push({ column, text: monthName.format(new Date(toTime(anchor))) });
  });
  return labels;
}
