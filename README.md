# In Focum

Heatmaps for Obsidian Bases: focus sessions against a daily goal, and a map for every habit.

## Views

The plugin adds two view types to Bases.

- **Focus heatmap**: one cell per day, filled toward a daily goal of sessions (the goal and above are full color), with tiles for today, this week, the goal streak, days at goal and sessions. Its rows are day notes with a sessions property (`focus_done` by default), a minutes property (`focus_minutes`) and the day's daily note (`focus_day`), as written by On Focus; any day notes with such properties work. Options: color, goal, weeks, the three properties, and compact (one line and the map, for daily notes).
- **Habit heatmaps**: a map per habit, read live from the task lines of your daily notes. Its rows are daily notes named `DD-MM-YYYY` or `YYYY-MM-DD`. Options: color and weeks.

Hover a day for its numbers; click it to open that day's note. Days not done stay dark.

A base with both views:

```yaml
filters:
  or:
    - file.inFolder("Focus/Days")
    - file.inFolder("Daily")
views:
  - type: in-focum-focus
    name: Focus
    filters:
      and:
        - file.inFolder("Focus/Days")
    goal: 10
  - type: in-focum-habits
    name: Habits
    filters:
      and:
        - file.inFolder("Daily")
```

Embed a view in a note with `![[Tracker.base#Focus]]`. A note with `cssclasses: in-focum-dashboard` hides its properties and gets wider.

## Habits

A habit is a top-level task line in a daily note. Tick it when done. A habit the template planned for a day counts as not done when its line is missing, unticked or cancelled (`[-]`); today's unticked habits stay open.

The habit list is a note in your vault (Settings → In Focum → Habits note, `Habits.md` by default) with a `json` block:

```json
{
  "template": "Templates/Daily.md",
  "habitTag": "habit",
  "habits": [
    { "name": "Read", "key": "read", "match": ["read 30 min", "read*"] },
    { "name": "Exercise", "key": "exercise", "match": ["exercise"], "windows": [["2026-01-01", null]] }
  ]
}
```

- `template`: the daily note template. Its tasks tagged with `habitTag` are the habits planned each day, and the plugin records when they change. Without a template, a habit is planned on the days its line is in the note.
- `match`: the texts that mean the habit, in lowercase, without tags or links. A `*` at the end matches the start of the text.
- `windows`: when the template held the habit before the plugin began recording it; `null` means it still does.
- A template task that matches no habit is added on its own.

## Build

```sh
npm install
npm run check                          # type-check
node build.mjs                         # into dist/: main.js, styles.css, manifest.json
node build.mjs --vault /path/to/vault  # install or update it in a vault
```

Then turn on In Focum in Settings → Community plugins. The colors are Flexoki ramps from `src/colors.json`, each validated for the light and dark themes.
