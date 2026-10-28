import { type App, Plugin, PluginSettingTab, Setting, type TAbstractFile, TFile } from "obsidian";
import { type Iso, today } from "./calendar";
import { HOVER_SOURCE } from "./heatmap";
import {
  buildModel,
  dailyDate,
  type HabitModel,
  mergeInto,
  noteHabits,
  parseConfig,
  type Status,
  type TemplateLog,
  templateHabits,
  trackTemplate,
} from "./habits";
import { FOCUS_VIEW, FocusView, focusOptions, HABITS_VIEW, HabitsView, habitsOptions } from "./views";

export interface Settings {
  /** The habit list: names, the texts that mean them, when the template held them. */
  habitsNote: string;
}

const DEFAULT_SETTINGS: Settings = { habitsNote: "Habits.md" };

/** What data.json holds: the settings, and the template's habits over time. */
interface Saved extends Partial<Settings> {
  templateLog?: TemplateLog;
}

export default class InFocum extends Plugin {
  settings: Settings = { ...DEFAULT_SETTINGS };
  private log: TemplateLog = { snapshots: [] };
  /** Each daily note's habit statuses, kept until the note or the habit list changes. */
  private readonly parsed = new Map<string, { mtime: number; statuses: Map<string, Status> }>();
  private configStamp = 0;
  /** The template the habits note names; empty until it is read. */
  private template = "";
  private readonly listeners = new Set<() => void>();

  async onload(): Promise<void> {
    const saved = (await this.loadData()) as Saved | null;
    this.settings = { habitsNote: saved?.habitsNote || DEFAULT_SETTINGS.habitsNote };
    this.log = saved?.templateLog ?? { snapshots: [] };
    this.registerHoverLinkSource(HOVER_SOURCE, { display: "In Focum", defaultMod: true });
    this.registerBasesView(FOCUS_VIEW, {
      name: "Focus heatmap",
      icon: "flame",
      factory: (controller, containerEl) => new FocusView(controller, containerEl),
      options: focusOptions,
    });
    this.registerBasesView(HABITS_VIEW, {
      name: "Habit heatmaps",
      icon: "calendar-check",
      factory: (controller, containerEl) => new HabitsView(controller, containerEl, this),
      options: habitsOptions,
    });
    this.addSettingTab(new InFocumSettingTab(this.app, this));
    // Neither the habit list nor the template is a row of the base: redraw the habit maps when one changes.
    this.registerEvent(this.app.vault.on("modify", (file) => this.onModify(file)));
    // Record template changes even on days the habit maps are not opened.
    this.app.workspace.onLayoutReady(() => void this.habitModel([]).catch(() => undefined));
  }

  /** Habit views subscribe here; the returned function unsubscribes. */
  onHabitsChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Saves a settings change and redraws the habit maps. */
  async changeSettings(change: Partial<Settings>): Promise<void> {
    this.settings = { ...this.settings, ...change };
    this.parsed.clear();
    this.configStamp = 0;
    await this.save();
    this.notify();
  }

  private save(): Promise<void> {
    const saved: Saved = { ...this.settings, templateLog: this.log };
    return this.saveData(saved);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private onModify(file: TAbstractFile): void {
    if (file.path !== this.settings.habitsNote && (this.template === "" || file.path !== this.template)) return;
    // Record a template change the day it happens, even with no habit map open; then redraw the open ones.
    void this.habitModel([])
      .catch(() => undefined)
      .then(() => this.notify());
  }

  /** The habits of the given daily notes; also records the template's habits when they changed. */
  async habitModel(files: TFile[]): Promise<HabitModel> {
    const note = this.app.vault.getAbstractFileByPath(this.settings.habitsNote);
    if (!(note instanceof TFile)) throw new Error(`Habits note not found: ${this.settings.habitsNote}. Set it in Settings → In Focum.`);
    if (note.stat.mtime !== this.configStamp) {
      this.parsed.clear();
      this.configStamp = note.stat.mtime;
    }
    const config = parseConfig(await this.app.vault.cachedRead(note));
    this.template = config.template;
    const now = today();
    let keys: string[] = [];
    if (config.template !== "") {
      const template = this.app.vault.getAbstractFileByPath(config.template);
      if (!(template instanceof TFile)) throw new Error(`Template not found: ${config.template}`);
      keys = templateHabits(await this.app.vault.cachedRead(template), config);
      if (trackTemplate(this.log, keys, now)) await this.save();
    }

    const days = new Map<Iso, Map<string, Status>>();
    for (const file of files) {
      const date = dailyDate(file.basename);
      if (!date) continue;
      let entry = this.parsed.get(file.path);
      if (!entry || entry.mtime !== file.stat.mtime) {
        entry = { mtime: file.stat.mtime, statuses: noteHabits(await this.app.vault.cachedRead(file), config.habits) };
        this.parsed.set(file.path, entry);
      }
      mergeInto(days, date, entry.statuses);
    }
    return buildModel(days, config, this.log, keys, now);
  }
}

class InFocumSettingTab extends PluginSettingTab {
  private readonly plugin: InFocum;

  constructor(app: App, plugin: InFocum) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    this.containerEl.empty();
    new Setting(this.containerEl)
      .setName("Habits note")
      .setDesc("The note with your habit list, from the vault's root: a ```json block with template, habitTag and habits.")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.habitsNote)
          .setValue(this.plugin.settings.habitsNote)
          .onChange((value) => void this.plugin.changeSettings({ habitsNote: value.trim() || DEFAULT_SETTINGS.habitsNote })),
      );
  }
}
