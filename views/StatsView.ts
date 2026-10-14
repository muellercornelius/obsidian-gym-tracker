import { ItemView, WorkspaceLeaf } from "obsidian";
import { DataStore } from "../data/DataStore";
import {
    computeStats, ExerciseSummary, RANGE_LABELS, rangeStart, StatsRange, todayString,
} from "../utils/stats";

export const STATS_VIEW_TYPE = "gym-tracker-stats";

type SortKey = "volume" | "recent" | "trend" | "name";
const SVG_NS = "http://www.w3.org/2000/svg";

export class StatsView extends ItemView {
    private store: DataStore;
    private onBack: () => void;
    private range: StatsRange = "90d";
    private sort: SortKey = "volume";
    private filter = "";
    private selected: string | null = null;

    constructor(leaf: WorkspaceLeaf, store: DataStore, onBack: () => void) {
        super(leaf);
        this.store = store;
        this.onBack = onBack;
    }

    getViewType(): string { return STATS_VIEW_TYPE; }
    getDisplayText(): string { return "Gym Statistics"; }
    getIcon(): string { return "bar-chart-3"; }

    async onOpen(): Promise<void> { this.render(); }

    refresh(): void { this.render(); }

    private render(): void {
        const el = this.contentEl;
        el.empty();
        el.addClass("gym-stats-view");

        const settings = this.store.getSettings();
        const unit = settings.weightUnit;
        const data = this.store.getData();
        const stats = computeStats(
            data.sessions, data.templates, settings.bodyWeight ?? 0, rangeStart(this.range), todayString()
        );
        const num = (n: number) => Math.round(n).toLocaleString();

        // ── Header ──
        const head = el.createDiv("gym-stats-topbar");
        const back = head.createEl("button", { text: "← Calendar", cls: "gym-stats-back" });
        back.onclick = () => this.onBack();
        head.createEl("h3", { text: "Statistics" });
        const sel = head.createEl("select", { cls: "dropdown" });
        for (const key of Object.keys(RANGE_LABELS) as StatsRange[]) {
            sel.createEl("option", { text: RANGE_LABELS[key], value: key });
        }
        sel.value = this.range;
        sel.onchange = () => { this.range = sel.value as StatsRange; this.render(); };

        if (stats.workouts === 0) {
            el.createDiv({ text: "No workouts in this range.", cls: "gym-stats-muted" });
            return;
        }

        if (!settings.bodyWeight) {
            el.createDiv({
                text: "Tip: set your body weight in the plugin settings to include it in bodyweight exercises.",
                cls: "gym-stats-muted gym-stats-tip",
            });
        }

        // ── Cards ──
        const cards = el.createDiv("gym-stats-cards");
        const card = (label: string, value: string) => {
            const c = cards.createDiv("gym-stats-card");
            c.createDiv({ text: value, cls: "gym-stats-value" });
            c.createDiv({ text: label, cls: "gym-stats-label" });
        };
        card("Workouts", String(stats.workouts));
        card("Per week", stats.avgPerWeek.toFixed(1));
        card("Sets", num(stats.sets));
        card("Reps", num(stats.reps));
        card(`Volume (${unit})`, num(stats.volume));
        card("Week streak", `${stats.currentStreakWeeks} (best ${stats.longestStreakWeeks})`);

        // ── Weekly activity ──
        el.createEl("h4", { text: "Weekly activity" });
        const maxW = Math.max(1, ...stats.weeks.map(w => w.workouts));
        const cols = el.createDiv("gym-stats-columns");
        for (const w of stats.weeks) {
            const col = cols.createDiv("gym-stats-col");
            col.setAttr("aria-label", `Week of ${w.label}: ${w.workouts} workouts, ${num(w.volume)} ${unit}`);
            const bar = col.createDiv("gym-stats-col-bar");
            bar.style.height = `${(w.workouts / maxW) * 100}%`;
            if (w.workouts === 0) bar.addClass("is-empty");
        }

        // ── Muscle distribution ──
        if (stats.muscles.length > 0) {
            el.createEl("h4", { text: "Sets per muscle group" });
            const maxM = stats.muscles[0].sets;
            for (const m of stats.muscles) {
                this.barRow(el, m.name, String(m.sets), m.sets / maxM);
            }
        }

        // ── Exercises ──
        el.createEl("h4", { text: "Exercises" });
        const tools = el.createDiv("gym-stats-tools");
        const search = tools.createEl("input", { type: "text", placeholder: "Filter…", cls: "gym-stats-search" });
        search.value = this.filter;
        const sortSel = tools.createEl("select", { cls: "dropdown" });
        const sorts: Record<SortKey, string> = {
            volume: "Most volume", recent: "Most recent", trend: "Best progress", name: "Name",
        };
        for (const k of Object.keys(sorts) as SortKey[]) sortSel.createEl("option", { text: sorts[k], value: k });
        sortSel.value = this.sort;
        sortSel.onchange = () => { this.sort = sortSel.value as SortKey; this.render(); };

        const list = el.createDiv("gym-stats-exlist");
        const draw = () => {
            list.empty();
            let items = stats.exercises.filter(e => e.name.toLowerCase().includes(this.filter.toLowerCase()));
            items = items.sort((a, b) => {
                switch (this.sort) {
                    case "recent": return b.lastDate.localeCompare(a.lastDate);
                    case "trend": return (b.trend ?? -Infinity) - (a.trend ?? -Infinity);
                    case "name": return a.name.localeCompare(b.name);
                    default: return b.volume - a.volume || b.reps - a.reps;
                }
            });
            for (const ex of items) this.exerciseCard(list, ex, unit);
        };
        search.oninput = () => { this.filter = search.value; draw(); };
        draw();
    }

    private barRow(parent: HTMLElement, label: string, value: string, ratio: number): void {
        const row = parent.createDiv("gym-stats-bar-row");
        const top = row.createDiv("gym-stats-bar-top");
        top.createSpan({ text: label });
        top.createSpan({ text: value, cls: "gym-stats-muted" });
        row.createDiv("gym-stats-bar").createDiv("gym-stats-bar-fill").style.width = `${ratio * 100}%`;
    }

    private exerciseCard(parent: HTMLElement, ex: ExerciseSummary, unit: string): void {
        const num = (n: number) => Math.round(n).toLocaleString();
        const r1 = (n: number) => String(Math.round(n * 10) / 10);
        const open = this.selected === ex.name;
        const card = parent.createDiv("gym-stats-excard");
        if (open) card.addClass("is-open");

        const row = card.createDiv("gym-stats-exrow");
        row.onclick = () => { this.selected = open ? null : ex.name; this.render(); };

        const info = row.createDiv("gym-stats-exinfo");
        info.createDiv({ text: ex.name, cls: "gym-stats-exname" });
        const bits = [ex.muscleGroup, `${ex.sessions}× trained`];
        if (ex.isBodyweight) bits.push("bodyweight");
        info.createDiv({ text: bits.join(" · "), cls: "gym-stats-muted" });

        const spark = row.createDiv("gym-stats-spark");
        this.lineChart(spark, ex.points.map(p => (ex.repsBased ? p.maxReps : p.e1rm)), true);

        const side = row.createDiv("gym-stats-exside");
        side.createDiv({
            text: ex.repsBased ? `${ex.bestReps} reps` : `${r1(ex.bestE1RM)} ${unit}`,
            cls: "gym-stats-exbest",
        });
        if (ex.trend !== null) {
            const up = ex.trend >= 0;
            side.createDiv({
                text: `${up ? "▲" : "▼"} ${Math.abs(Math.round(ex.trend))}%`,
                cls: `gym-stats-trend ${up ? "is-up" : "is-down"}`,
            });
        }

        if (!open) return;

        const detail = card.createDiv("gym-stats-detail");
        const grid = detail.createDiv("gym-stats-cards");
        const mini = (label: string, value: string) => {
            const c = grid.createDiv("gym-stats-card");
            c.createDiv({ text: value, cls: "gym-stats-value" });
            c.createDiv({ text: label, cls: "gym-stats-label" });
        };
        if (!ex.repsBased) {
            mini(`Est. 1RM (${unit})`, r1(ex.bestE1RM));
            mini(`Heaviest load (${unit})`, r1(ex.bestLoad));
            mini(`Best set (${unit})`, num(ex.bestSetVolume));
        }
        mini("Most reps in a set", String(ex.bestReps));
        mini("Total sets", String(ex.sets));
        mini("Total reps", num(ex.reps));
        if (!ex.repsBased) mini(`Total volume (${unit})`, num(ex.volume));
        mini("PR date", ex.prDate || "–");

        const chart = (title: string, values: number[], suffix: string) => {
            detail.createEl("h5", { text: title });
            const wrap = detail.createDiv("gym-stats-chart");
            this.lineChart(wrap, values, false);
            if (values.length > 0) {
                const axis = detail.createDiv("gym-stats-bar-top gym-stats-muted");
                axis.createSpan({ text: `${ex.points[0].date} · ${r1(values[0])}${suffix}` });
                axis.createSpan({
                    text: `${ex.points[ex.points.length - 1].date} · ${r1(values[values.length - 1])}${suffix}`,
                });
            }
        };
        if (ex.repsBased) {
            chart("Best reps per session", ex.points.map(p => p.maxReps), "");
        } else {
            chart(`Estimated 1RM (${unit})`, ex.points.map(p => p.e1rm), "");
            chart(`Volume per session (${unit})`, ex.points.map(p => p.volume), "");
        }

        detail.createEl("h5", { text: "Recent sessions" });
        for (const p of ex.points.slice(-5).reverse()) {
            const line = detail.createDiv("gym-stats-bar-top");
            line.createSpan({ text: p.date });
            line.createSpan({
                text: ex.repsBased
                    ? `${p.sets} sets · max ${p.maxReps} reps`
                    : `${p.sets} sets · top ${r1(p.maxLoad)} ${unit} · ${num(p.volume)} ${unit}`,
                cls: "gym-stats-muted",
            });
        }
    }

    private lineChart(parent: HTMLElement, values: number[], compact: boolean): void {
        if (values.length < 2) {
            if (!compact) parent.createDiv({ text: "Not enough data.", cls: "gym-stats-muted" });
            return;
        }
        const W = 300, H = compact ? 36 : 120, P = compact ? 3 : 8;
        const min = Math.min(...values), max = Math.max(...values);
        const range = max - min || 1;
        const xy = values.map((v, i) => [
            P + (i / (values.length - 1)) * (W - 2 * P),
            H - P - ((v - min) / range) * (H - 2 * P),
        ]);
        const svg = document.createElementNS(SVG_NS, "svg");
        svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
        svg.setAttribute("preserveAspectRatio", "none");

        const area = document.createElementNS(SVG_NS, "polygon");
        const pts = xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`);
        area.setAttribute("points", `${P},${H - P} ${pts.join(" ")} ${W - P},${H - P}`);
        area.setAttribute("class", "gym-stats-area");
        svg.appendChild(area);

        const line = document.createElementNS(SVG_NS, "polyline");
        line.setAttribute("points", pts.join(" "));
        line.setAttribute("class", "gym-stats-line");
        svg.appendChild(line);

        if (!compact) {
            for (const [x, y] of xy) {
                const c = document.createElementNS(SVG_NS, "circle");
                c.setAttribute("cx", x.toFixed(1));
                c.setAttribute("cy", y.toFixed(1));
                c.setAttribute("r", "2.5");
                c.setAttribute("class", "gym-stats-dot");
                svg.appendChild(c);
            }
        }
        parent.appendChild(svg);
    }
}
