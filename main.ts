import { App, Plugin, PluginSettingTab, Setting, WorkspaceLeaf } from "obsidian";
import { confirmAction } from "./utils/ConfirmModal";
import { DataStore } from "./data/DataStore";
import { CalendarView, CALENDAR_VIEW_TYPE } from "./views/CalendarView";
import { WorkoutView, WORKOUT_VIEW_TYPE } from "./views/WorkoutView";
import { StatsView, STATS_VIEW_TYPE } from "./views/StatsView";
import { todayStr } from "./utils/calendar";

export default class GymTrackerPlugin extends Plugin {
    store!: DataStore;

    async onload(): Promise<void> {
        this.store = new DataStore(this);
        await this.store.load();

        // Register custom calendar view
        this.registerView(
            CALENDAR_VIEW_TYPE,
            (leaf: WorkspaceLeaf) => {
                const view = new CalendarView(
                    leaf,
                    this.store,
                    (date: string) => { void this.openWorkoutView(date); },
                    () => { void this.openWorkoutView(todayStr()); },
                    () => { void this.activateStatsView(); }
                );
                return view;
            }
        );

        this.registerView(
            STATS_VIEW_TYPE,
            (leaf: WorkspaceLeaf) => new StatsView(leaf, this.store, () => { void this.activateCalendarView(); })
        );

        // Register workout view
        this.registerView(
            WORKOUT_VIEW_TYPE,
            (leaf: WorkspaceLeaf) => new WorkoutView(leaf, this.store)
        );

        // Ribbon icon
        this.addRibbonIcon("dumbbell", "Open Gym Calendar", () => {
            void this.activateCalendarView();
        });

        // Commands
        this.addCommand({
            id: "open-gym-calendar",
            name: "Open gym calendar",
            callback: () => { void this.activateCalendarView(); },
        });

        this.addCommand({
            id: "open-gym-statistics",
            name: "Open gym statistics",
            callback: () => { void this.activateStatsView(); },
        });

        this.addCommand({
            id: "start-workout",
            name: "Start today's workout",
            callback: () => { void this.openWorkoutView(todayStr()); },
        });

        // Settings tab
        this.addSettingTab(new GymTrackerSettingTab(this.app, this));
    }

    onunload(): void {
        // Obsidian handles view cleanup
    }

    // ── View management ──

    async activateCalendarView(): Promise<void> {
        const { workspace } = this.app;

        let leaf = workspace.getLeavesOfType(CALENDAR_VIEW_TYPE)[0];
        if (!leaf) {
            const mainLeaf = workspace.getLeaf(false);
            if (mainLeaf) {
                await mainLeaf.setViewState({
                    type: CALENDAR_VIEW_TYPE,
                    active: true,
                });
                leaf = mainLeaf;
            }
        }

        if (leaf) {
            await workspace.revealLeaf(leaf);
            const view = leaf.view as CalendarView;
            view.refresh();
        }
    }

    async activateStatsView(): Promise<void> {
        const { workspace } = this.app;
        // Reuse the current tab so Calendar and Statistics link back and forth
        const leaf = workspace.getLeavesOfType(STATS_VIEW_TYPE)[0] ?? workspace.getLeaf(false);
        await leaf.setViewState({ type: STATS_VIEW_TYPE, active: true });
        await workspace.revealLeaf(leaf);
        (leaf.view as StatsView).refresh();
    }

    // ── Workout view ──

    async openWorkoutView(date: string): Promise<void> {
        const { workspace } = this.app;

        let leaf = workspace.getLeavesOfType(WORKOUT_VIEW_TYPE)[0];
        if (!leaf) {
            leaf = workspace.getLeaf(true);
        }
        await leaf.setViewState({
            type: WORKOUT_VIEW_TYPE,
            state: { date },
            active: true,
        });
        await workspace.revealLeaf(leaf);
    }
}

// ═══════════════════════════════════════════════════
// Settings Tab
// ═══════════════════════════════════════════════════

class GymTrackerSettingTab extends PluginSettingTab {
    plugin: GymTrackerPlugin;

    constructor(app: App, plugin: GymTrackerPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    refreshTab(): void {
        this.display();
    }

    // Render plugin settings using the imperative API.
    // This keeps the settings UI compatible with the plugin's supported Obsidian versions.
    display(): void {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.addClass("gym-settings");

        const settings = this.plugin.store.getSettings();

        // Week start day
        new Setting(containerEl)
            .setName("Week starts on")
            .setDesc("Calendar week start day")
            .addDropdown(dropdown => {
                dropdown
                    .addOption('monday', 'Monday')
                    .addOption('sunday', 'Sunday')
                    .setValue(settings.weekStartDay)
                    .onChange(async (value: string) => {
                        settings.weekStartDay = value as 'monday' | 'sunday';
                        await this.plugin.store.saveSettings(settings);
                    });
            });

        // Weight unit
        new Setting(containerEl)
            .setName("Weight unit")
            .setDesc("Switching automatically converts all existing weight data")
            .addDropdown(dropdown => {
                dropdown
                    .addOption('kg', 'Kilograms (kg)')
                    .addOption('lbs', 'Pounds (lbs)')
                    .setValue(settings.weightUnit)
                    .onChange(async (value: string) => {
                        settings.weightUnit = value as 'kg' | 'lbs';
                        await this.plugin.store.saveSettings(settings);
                        this.refreshTab();
                    });
            });

        // Body weight
        new Setting(containerEl)
            .setName("Body weight")
            .setDesc("Added to bodyweight exercises in the statistics (0 = ignore)")
            .addText(text => {
                text
                    .setValue(settings.bodyWeight ? String(settings.bodyWeight) : '')
                    .setPlaceholder('0')
                    .onChange(async (value: string) => {
                        const n = parseFloat(value.replace(',', '.'));
                        settings.bodyWeight = Number.isFinite(n) && n > 0 ? n : 0;
                        await this.plugin.store.saveSettings(settings);
                    });
            });

        // Folder name
        new Setting(containerEl)
            .setName("Vault folder")
            .setDesc("Folder in your vault. Prefix with . to hide from file explorer (e.g. .gym-tracker)")
            .addText(text => {
                text
                    .setValue(settings.vaultFolder)
                    .setPlaceholder('.gym-tracker')
                    .onChange(async (value: string) => {
                        settings.vaultFolder = value || '.gym-tracker';
                        await this.plugin.store.saveSettings(settings);
                    });
            });

        // File name
        new Setting(containerEl)
            .setName("File name")
            .setDesc("File name without extension. e.g. data")
            .addText(text => {
                text
                    .setValue(settings.vaultFileName)
                    .setPlaceholder('data')
                    .onChange(async (value: string) => {
                        settings.vaultFileName = value || 'data';
                        await this.plugin.store.saveSettings(settings);
                    });
            });

        // Show in graph
        new Setting(containerEl)
            .setName("Show in graph")
            .setDesc("Stores as .md with frontmatter so file appears in graph view")
            .addToggle(toggle => {
                toggle
                    .setValue(settings.showInGraph)
                    .onChange(async (value: boolean) => {
                        settings.showInGraph = value;
                        await this.plugin.store.saveSettings(settings);
                    });
            });

        // Clear all data
        new Setting(containerEl)
            .setName("Clear all data")
            .setDesc("Delete all templates and workout sessions. This cannot be undone.")
            .addButton(btn => {
                btn.setButtonText("Clear All Data");
                const destBtn = btn as unknown as { setDestructive?: () => void, setWarning: () => void };
                if (typeof destBtn.setDestructive === "function") {
                    destBtn.setDestructive();
                } else {
                    destBtn.setWarning();
                }
                btn.onClick(async () => {
                    if (await confirmAction(this.app, "Delete ALL templates and workout data? This cannot be undone.")) {
                        await this.plugin.store.clearAllData();
                        this.refreshTab();
                    }
                });
            });
    }
}
