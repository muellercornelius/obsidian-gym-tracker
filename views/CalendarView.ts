import { ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import { DataStore } from "../data/DataStore";
import {
    getMonthGrid,
    monthName,
    prevMonth,
    nextMonth,
    todayStr,
} from "../utils/calendar";
import { CalendarDay, WorkoutSession } from "../types";

export const CALENDAR_VIEW_TYPE = "gym-tracker-calendar";

export class CalendarView extends ItemView {
    private store: DataStore;
    private onDateClick: (date: string) => void;
    private onStartWorkout: () => void;
    private onOpenStats: () => void;
    private currentYear: number;
    private currentMonth: number;

    constructor(
        leaf: WorkspaceLeaf,
        store: DataStore,
        onDateClick: (date: string) => void,
        onStartWorkout: () => void,
        onOpenStats: () => void
    ) {
        super(leaf);
        this.store = store;
        this.onDateClick = onDateClick;
        this.onStartWorkout = onStartWorkout;
        this.onOpenStats = onOpenStats;

        const today = new Date();
        this.currentYear = today.getFullYear();
        this.currentMonth = today.getMonth();
    }

    getViewType(): string {
        return CALENDAR_VIEW_TYPE;
    }

    getDisplayText(): string {
        return "Gym Calendar";
    }

    getIcon(): string {
        return "dumbbell";
    }

    async onOpen(): Promise<void> {
        this.render();
    }

    refresh(): void {
        this.render();
    }

    private render(): void {
        const container = this.contentEl;
        container.empty();
        container.addClass("gym-calendar-container");

        const settings = this.store.getSettings();
        const data = this.store.getData();
        const grid = getMonthGrid(
            this.currentYear,
            this.currentMonth,
            data.sessions,
            settings.weekStartDay
        );
        const monthSessions = grid
            .filter(day => day.isCurrentMonth && day.session)
            .map(day => day.session as WorkoutSession);

        const inner = container.createDiv("gym-cal-inner");

        this.renderHeader(inner);
        this.renderSummary(inner, monthSessions);
        this.renderGrid(inner, grid, settings.weekStartDay);
        this.renderWorkoutList(inner, monthSessions);
        this.renderActions(inner);
    }

    // ── Header: month title + navigation ──

    private renderHeader(parent: HTMLElement): void {
        const header = parent.createDiv("gym-cal-header");

        const titleBox = header.createDiv("gym-cal-header-text");
        titleBox.createDiv({ text: "Gym Tracker", cls: "gym-cal-kicker" });
        titleBox.createEl("h1", {
            text: monthName(this.currentYear, this.currentMonth),
            cls: "gym-cal-title",
        });

        const nav = header.createDiv("gym-cal-nav");

        const now = new Date();
        const isCurrent = now.getFullYear() === this.currentYear && now.getMonth() === this.currentMonth;
        if (!isCurrent) {
            const todayBtn = nav.createEl("button", { text: "Today", cls: "gym-cal-today" });
            todayBtn.onclick = () => {
                this.currentYear = now.getFullYear();
                this.currentMonth = now.getMonth();
                this.render();
            };
        }

        const prevBtn = nav.createEl("button", { cls: "gym-cal-nav-btn", attr: { "aria-label": "Previous month" } });
        setIcon(prevBtn, "chevron-left");
        prevBtn.onclick = () => {
            const p = prevMonth(this.currentYear, this.currentMonth);
            this.currentYear = p.year;
            this.currentMonth = p.month;
            this.render();
        };

        const nextBtn = nav.createEl("button", { cls: "gym-cal-nav-btn", attr: { "aria-label": "Next month" } });
        setIcon(nextBtn, "chevron-right");
        nextBtn.onclick = () => {
            const n = nextMonth(this.currentYear, this.currentMonth);
            this.currentYear = n.year;
            this.currentMonth = n.month;
            this.render();
        };
    }

    // ── Month summary ──

    private renderSummary(parent: HTMLElement, sessions: WorkoutSession[]): void {
        let sets = 0;
        let volume = 0;
        for (const session of sessions) {
            const stats = this.sessionStats(session);
            sets += stats.doneSets;
            volume += stats.volume;
        }
        const unit = this.store.getSettings().weightUnit === "lbs" ? "lbs" : "kg";

        const card = parent.createDiv("gym-cal-summary");
        this.addSummaryStat(card, String(sessions.length), sessions.length === 1 ? "Workout" : "Workouts");
        this.addSummaryStat(card, String(sets), "Sets");
        this.addSummaryStat(card, `${Math.round(volume).toLocaleString()} ${unit}`, "Volume");
    }

    private addSummaryStat(parent: HTMLElement, value: string, label: string): void {
        const stat = parent.createDiv("gym-cal-stat");
        stat.createDiv({ text: value, cls: "gym-cal-stat-value" });
        stat.createDiv({ text: label, cls: "gym-cal-stat-label" });
    }

    // ── Month grid ──

    private renderGrid(parent: HTMLElement, grid: CalendarDay[], weekStartDay: "monday" | "sunday"): void {
        const dowRow = parent.createDiv("gym-cal-dow");
        const dayNames = weekStartDay === "sunday"
            ? ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
            : ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
        for (const name of dayNames) {
            dowRow.createSpan({ text: name, cls: "gym-cal-dow-cell" });
        }

        // The month's trailing row(s) of the next month add nothing: drop a fully foreign last week
        const rows = grid.slice(35).every(day => !day.isCurrentMonth) ? grid.slice(0, 35) : grid;

        const dayGrid = parent.createDiv("gym-cal-grid");
        for (const day of rows) {
            const cell = dayGrid.createEl("button", {
                cls: "gym-cal-cell",
                attr: { "aria-label": day.date },
            });
            cell.createSpan({ text: String(day.day), cls: "gym-cal-day" });

            cell.toggleClass("is-other", !day.isCurrentMonth);
            cell.toggleClass("is-today", day.isToday);

            if (day.session) {
                const stats = this.sessionStats(day.session);
                const complete = stats.totalSets > 0 && stats.doneSets === stats.totalSets;
                cell.addClass(complete ? "is-complete" : "has-workout");
            }

            if (day.isCurrentMonth) {
                cell.onclick = () => this.onDateClick(day.date);
            } else {
                cell.disabled = true;
            }
        }

        const legend = parent.createDiv("gym-cal-legend");
        this.addLegend(legend, "is-complete", "All sets done");
        this.addLegend(legend, "has-workout", "In progress");
    }

    private addLegend(parent: HTMLElement, cls: string, label: string): void {
        const item = parent.createSpan("gym-cal-legend-item");
        item.createSpan(`gym-cal-legend-dot ${cls}`);
        item.createSpan({ text: label });
    }

    // ── Workouts of the shown month ──

    private renderWorkoutList(parent: HTMLElement, sessions: WorkoutSession[]): void {
        parent.createDiv({ text: "Workouts", cls: "gym-section-label" });
        const list = parent.createDiv("gym-cal-list");

        if (sessions.length === 0) {
            list.createDiv({
                text: "No workouts this month yet.",
                cls: "gym-cal-empty",
            });
            return;
        }

        const unit = this.store.getSettings().weightUnit === "lbs" ? "lbs" : "kg";
        const sorted = [...sessions].sort((a, b) => b.date.localeCompare(a.date));
        for (const session of sorted) {
            const stats = this.sessionStats(session);
            const date = new Date(`${session.date}T00:00:00`);

            const row = list.createEl("button", { cls: "gym-cal-row" });
            const badge = row.createDiv("gym-cal-row-date");
            badge.createDiv({ text: String(date.getDate()), cls: "gym-cal-row-day" });
            badge.createDiv({
                text: date.toLocaleDateString("en-US", { weekday: "short" }),
                cls: "gym-cal-row-weekday",
            });

            const text = row.createDiv("gym-cal-row-text");
            text.createDiv({ text: session.templateName || "Workout", cls: "gym-cal-row-name" });
            const volume = stats.volume > 0 ? ` · ${Math.round(stats.volume).toLocaleString()} ${unit}` : "";
            text.createDiv({
                text: `${stats.doneSets}/${stats.totalSets} sets${volume}`,
                cls: "gym-cal-row-meta",
            });

            setIcon(row.createSpan("gym-cal-row-chevron"), "chevron-right");
            row.onclick = () => this.onDateClick(session.date);
        }
    }

    // ── Sticky actions ──

    private renderActions(parent: HTMLElement): void {
        const bar = parent.createDiv("gym-bottom-bar gym-cal-actions");

        const hasToday = !!this.store.getSession(todayStr());
        const startBtn = bar.createEl("button", { cls: "gym-cal-start-btn" });
        setIcon(startBtn.createSpan(), hasToday ? "play" : "plus");
        startBtn.createSpan({ text: hasToday ? "Continue today's workout" : "Start workout" });
        startBtn.onclick = () => this.onStartWorkout();

        const statsBtn = bar.createEl("button", { cls: "gym-cal-stats-btn", attr: { "aria-label": "Statistics" } });
        setIcon(statsBtn, "bar-chart-3");
        statsBtn.onclick = () => this.onOpenStats();
    }

    /** Checked sets and volume of a session; unchecked sets are stored as skipped. */
    private sessionStats(session: WorkoutSession): { doneSets: number; totalSets: number; volume: number } {
        let doneSets = 0;
        let totalSets = 0;
        let volume = 0;
        for (const ex of session.exercises) {
            for (const set of ex.sets) {
                totalSets++;
                if (set.skipped || ex.skipped) continue;
                doneSets++;
                volume += set.reps * set.weight;
            }
        }
        return { doneSets, totalSets, volume };
    }
}
