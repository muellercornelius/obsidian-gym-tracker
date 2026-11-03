import { ItemView, Notice, WorkspaceLeaf, ViewStateResult, setIcon } from "obsidian";
import { DataStore } from "../data/DataStore";
import { confirmAction } from "../utils/ConfirmModal";
import { askTemplateChoice } from "../utils/TemplateChoiceModal";
import { openAddExercise, AddedExercise } from "./AddExerciseModal";
import {
    WorkoutTemplate,
    TemplateExercise,
    WorkoutSession,
    SessionExercise,
    SessionSet,
} from "../types";
import { CALENDAR_VIEW_TYPE, CalendarView } from "./CalendarView";

export const WORKOUT_VIEW_TYPE = "gym-tracker-workout";

interface WorkSet {
    setNumber: number;
    reps: number;
    weight: number;
    done: boolean;
}

/** One exercise of today's workout. Unchecked sets are not tracked. */
interface WorkExercise {
    id: string;
    name: string;
    note: string;
    sets: WorkSet[];
    datasetId?: string;
    category?: string;
    equipment?: string;
    target?: string;
    muscleGroup?: string;
    secondaryMuscles?: string[];
}

type Page = "workout" | "edit";

const DEFAULT_NEW_SETS = 3;
const DEFAULT_NEW_REPS = 10;
const DEFAULT_REST_SECONDS = 90;
const MAX_SETS = 20;
const IDLE_LIMIT_MS = 2 * 60 * 60 * 1000;

export class WorkoutView extends ItemView {
    private store: DataStore;
    private date: string = "";

    // Form state
    private template: WorkoutTemplate | null = null;
    private sessionId: string = "";
    private sessionNote: string = "";
    private startedAt: string = "";
    private lastActivity: number = Date.now();
    private exercises: WorkExercise[] = [];
    private expandedIds: Set<string> = new Set();
    private openNotes: Set<string> = new Set();
    private page: Page = "workout";
    /** Creating or editing a template (no session yet); nothing is saved until "Save". */
    private draft: boolean = false;
    private draftTemplateId: string | null = null;
    private draftName: string = "";
    private draftBaseline: string = "";
    private promptedSignature: string | null = null;
    private progressEl: HTMLElement | null = null;
    private durationEl: HTMLElement | null = null;

    private isDeleted: boolean = false;
    private saveTimeout: number | null = null;
    private saveChain: Promise<void> = Promise.resolve();

    constructor(leaf: WorkspaceLeaf, store: DataStore) {
        super(leaf);
        this.store = store;
        this.navigation = false;
    }

    getViewType(): string {
        return WORKOUT_VIEW_TYPE;
    }

    getDisplayText(): string {
        if (this.date) {
            return `Workout — ${this.date}`;
        }
        return "Workout";
    }

    getIcon(): string {
        return "dumbbell";
    }

    getState(): Record<string, unknown> {
        return { date: this.date };
    }

    async setState(state: Record<string, unknown>, result: ViewStateResult): Promise<void> {
        const newDate = (state.date as string) ?? "";
        // Save current session before switching to a different date
        if (newDate !== this.date && this.date) {
            await this.flushSave();
        }
        this.date = newDate;
        result.history = false;
        await this.render();
    }

    async onOpen(): Promise<void> {
        // setState() is called after onOpen() with the date from ViewState
        this.registerInterval(window.setInterval(() => this.tickDuration(), 1000));
    }

    // ── Render ──

    private async render(): Promise<void> {
        const container = this.contentEl;
        container.empty();
        container.addClass("gym-workout-view");

        if (!this.date) return;

        // Cancel any pending debounced save from the previous view
        if (this.saveTimeout !== null) {
            window.clearTimeout(this.saveTimeout);
            this.saveTimeout = null;
        }

        // Reset form state for the new date so stale data never leaks across views
        this.template = null;
        this.sessionId = "";
        this.sessionNote = "";
        this.startedAt = "";
        this.lastActivity = Date.now();
        this.exercises = [];
        this.expandedIds = new Set();
        this.openNotes = new Set();
        this.page = "workout";
        this.draft = false;
        this.draftTemplateId = null;
        this.promptedSignature = null;
        this.isDeleted = false;

        const existingSession = this.store.getSession(this.date);

        if (existingSession) {
            this.loadExistingSession(existingSession);
            this.openFirstUnfinished();
            this.renderPage();
        } else {
            this.showPicker();
        }
    }

    /** Template list, or straight to the template editor when there is no template yet. */
    private showPicker(): void {
        this.draft = false;
        this.template = null;
        this.exercises = [];
        this.expandedIds = new Set();
        this.page = "workout";
        if (this.store.getTemplates().length === 0) {
            this.startDraft(null);
            return;
        }
        const container = this.contentEl;
        container.empty();
        this.renderTemplatePicker(container);
    }

    /** Open the template editor: empty for a new template, filled for an existing one. */
    private startDraft(tpl: WorkoutTemplate | null): void {
        this.draft = true;
        this.template = null;
        this.draftTemplateId = tpl?.id ?? null;
        this.draftName = tpl?.name ?? "";
        this.exercises = tpl ? tpl.exercises.map(ex => this.workExerciseFromTemplate(ex)) : [];
        this.expandedIds = new Set();
        this.page = "edit";
        this.draftBaseline = this.draftSignature();
        this.renderPage();
        this.contentEl.scrollTop = 0;
    }

    private draftSignature(): string {
        const parts = this.exercises.map(ex => `${ex.id}:${ex.sets.length}`);
        return `${this.draftName.trim()}|${parts.join(",")}`;
    }

    private workExerciseFromTemplate(ex: TemplateExercise): WorkExercise {
        return {
            id: ex.id,
            name: ex.name,
            note: "",
            datasetId: ex.datasetId,
            category: ex.category,
            equipment: ex.equipment,
            target: ex.target,
            muscleGroup: ex.muscleGroup,
            secondaryMuscles: ex.secondaryMuscles,
            sets: ex.sets.map(s => ({ setNumber: s.setNumber, reps: s.reps, weight: s.weight, done: false })),
        };
    }

    /** Re-render the current page, keeping the scroll position. */
    private renderPage(): void {
        const container = this.contentEl;
        const scrollTop = container.scrollTop;
        container.empty();
        this.progressEl = null;
        this.durationEl = null;

        if (this.page === "edit") {
            this.renderEditPage(container);
        } else {
            this.renderWorkoutPage(container);
        }
        container.scrollTop = scrollTop;
    }

    // ── Template picker (new session) ──

    private renderTemplatePicker(container: HTMLElement): void {
        const header = container.createDiv("gym-wk-header");
        const titleBox = header.createDiv("gym-wk-header-text");
        titleBox.createDiv({ text: this.formatDate(), cls: "gym-wk-kicker" });
        titleBox.createEl("h1", { text: "Start workout", cls: "gym-wk-title" });

        const newBtn = header.createEl("button", { cls: "gym-pill-btn", attr: { "aria-label": "New template" } });
        setIcon(newBtn.createSpan("gym-pill-icon"), "plus");
        newBtn.createSpan({ text: "New" });
        newBtn.onclick = () => this.startDraft(null);

        // Most recently used templates first
        const lastUsed = new Map<string, string>();
        for (const session of this.store.getAllSessions()) {
            if (!lastUsed.has(session.templateId)) lastUsed.set(session.templateId, session.date);
        }
        const templates = [...this.store.getTemplates()].sort((a, b) =>
            (lastUsed.get(b.id) ?? "").localeCompare(lastUsed.get(a.id) ?? "")
        );

        container.createDiv({ text: "Choose a template", cls: "gym-section-label" });
        const list = container.createDiv("gym-tpl-list");

        for (const tpl of templates) {
            const row = list.createDiv("gym-tpl-row");
            const card = row.createEl("button", { cls: "gym-tpl-card" });
            const text = card.createDiv("gym-tpl-text");
            text.createDiv({ text: tpl.name, cls: "gym-tpl-name" });
            text.createDiv({ text: this.previewExercises(tpl), cls: "gym-tpl-preview" });
            const setCount = tpl.exercises.reduce((n, ex) => n + ex.sets.length, 0);
            const meta = `${tpl.exercises.length} exercise${tpl.exercises.length === 1 ? "" : "s"} · ${setCount} sets`;
            text.createDiv({ text: meta, cls: "gym-tpl-meta" });

            const side = card.createDiv("gym-tpl-side");
            const last = lastUsed.get(tpl.id);
            side.createSpan({ text: last ? this.relativeDay(last) : "New", cls: "gym-tpl-last" });
            setIcon(side.createSpan("gym-tpl-chevron"), "chevron-right");

            card.onclick = () => void this.startSession(tpl);

            const actions = row.createDiv("gym-tpl-actions");
            const edit = actions.createEl("button", {
                cls: "gym-tpl-action",
                attr: { "aria-label": `Edit ${tpl.name}` },
            });
            setIcon(edit, "pencil");
            edit.onclick = () => this.startDraft(tpl);

            const del = actions.createEl("button", {
                cls: "gym-tpl-action gym-tpl-action-danger",
                attr: { "aria-label": `Delete ${tpl.name}` },
            });
            setIcon(del, "trash-2");
            del.onclick = async () => {
                if (!(await confirmAction(this.app, `Delete template "${tpl.name}"? Past workouts are kept.`))) return;
                await this.store.deleteTemplate(tpl.id);
                this.showPicker();
            };
        }
    }

    /** Create the session from a template and open it. */
    private async startSession(tpl: WorkoutTemplate): Promise<void> {
        this.template = tpl;
        this.sessionId = this.store.generateId();
        this.startedAt = new Date().toISOString();
        this.lastActivity = Date.now();
        this.exercises = [];
        this.initFromTemplate(tpl);
        this.expandedIds = new Set();
        this.openFirstUnfinished();
        this.page = "workout";
        // Auto-save initial draft
        await this.autoSave();
        this.renderPage();
    }

    private previewExercises(tpl: WorkoutTemplate): string {
        const names = tpl.exercises.map(ex => ex.name);
        if (names.length <= 3) return names.join(" · ");
        return `${names.slice(0, 3).join(" · ")} +${names.length - 3}`;
    }

    private relativeDay(date: string): string {
        const then = new Date(`${date}T00:00:00`).getTime();
        const now = new Date(`${this.todayString()}T00:00:00`).getTime();
        const days = Math.round((now - then) / 86400000);
        if (Number.isNaN(days)) return date;
        if (days <= 0) return "Today";
        if (days === 1) return "Yesterday";
        if (days < 14) return `${days} days ago`;
        if (days < 60) return `${Math.round(days / 7)} weeks ago`;
        return `${Math.round(days / 30)} months ago`;
    }

    private todayString(): string {
        const d = new Date();
        const m = String(d.getMonth() + 1).padStart(2, "0");
        const day = String(d.getDate()).padStart(2, "0");
        return `${d.getFullYear()}-${m}-${day}`;
    }

    // ── Load existing session into form state ──

    private loadExistingSession(session: WorkoutSession): void {
        this.sessionId = session.id;
        this.template = this.store.getTemplate(session.templateId) ?? {
            id: session.templateId,
            name: session.templateName || "(Deleted)",
            exercises: [],
        };
        this.sessionNote = session.note || "";
        this.startedAt = session.startedAt ?? "";
        const completed = Date.parse(session.completedAt);
        this.lastActivity = Number.isNaN(completed) ? Date.now() : completed;

        this.exercises = session.exercises.map(ex => {
            const tplEx = this.template?.exercises.find(t => t.id === ex.templateExerciseId);
            return {
                id: ex.templateExerciseId,
                name: ex.name,
                note: ex.note || "",
                datasetId: ex.datasetId ?? tplEx?.datasetId,
                category: ex.category ?? tplEx?.category,
                equipment: ex.equipment ?? tplEx?.equipment,
                target: ex.target ?? tplEx?.target,
                muscleGroup: ex.muscleGroup ?? tplEx?.muscleGroup,
                secondaryMuscles: ex.secondaryMuscles ?? tplEx?.secondaryMuscles,
                sets: ex.sets.map(s => ({
                    setNumber: s.setNumber,
                    reps: s.reps,
                    weight: s.weight,
                    done: !s.skipped && !ex.skipped,
                })),
            };
        });
    }

    // ── Initialize from template (new session) ──

    private initFromTemplate(tpl: WorkoutTemplate): void {
        this.exercises = tpl.exercises.map(ex => {
            const lastData = this.store.getLastSetDataForExercise(ex.id, this.date, ex.name);
            return {
                id: ex.id,
                name: ex.name,
                note: "",
                datasetId: ex.datasetId,
                category: ex.category,
                equipment: ex.equipment,
                target: ex.target,
                muscleGroup: ex.muscleGroup,
                secondaryMuscles: ex.secondaryMuscles,
                // Pre-fill with last time if available, otherwise template defaults
                sets: ex.sets.map(tSet => {
                    const last = lastData.get(tSet.setNumber);
                    return {
                        setNumber: tSet.setNumber,
                        reps: last ? last.reps : tSet.reps,
                        weight: last ? last.weight : tSet.weight,
                        done: false,
                    };
                }),
            };
        });
    }

    // ── Workout page ──

    private renderWorkoutPage(container: HTMLElement): void {
        if (!this.template) return;

        const header = container.createDiv("gym-wk-header");
        const titleBox = header.createDiv("gym-wk-header-text");
        titleBox.createDiv({
            text: `${this.template.name} · ${this.formatDate()}`,
            cls: "gym-wk-kicker",
        });
        titleBox.createEl("h1", { text: "Workout", cls: "gym-wk-title" });

        const editBtn = header.createEl("button", { cls: "gym-pill-btn" });
        setIcon(editBtn.createSpan("gym-pill-icon"), "list");
        editBtn.createSpan({ text: "Edit" });
        editBtn.onclick = () => {
            this.page = "edit";
            this.renderPage();
            this.contentEl.scrollTop = 0;
        };

        this.progressEl = container.createDiv("gym-progress-card");
        this.fillProgress();

        const list = container.createDiv("gym-ex-list");
        if (this.exercises.length === 0) {
            list.createDiv({
                text: "No exercises yet. Tap Edit to add some.",
                cls: "gym-workout-empty",
            });
        }
        for (const ex of this.exercises) {
            this.renderExerciseCard(list, ex);
        }

        this.renderSessionNote(container);

        if (this.store.getSession(this.date)) {
            const deleteBtn = container.createEl("button", {
                text: "Delete workout",
                cls: "gym-delete-link",
            });
            deleteBtn.onclick = async () => {
                if (await confirmAction(this.app, "Delete this workout? This cannot be undone.")) {
                    this.isDeleted = true;
                    await this.store.deleteSession(this.date);
                    this.refreshCalendars();
                    this.leaf.detach();
                }
            };
        }

        const finishBtn = container.createEl("button", { text: "Finish workout", cls: "gym-finish-btn" });
        finishBtn.onclick = async () => {
            await this.flushSave();
            this.leaf.detach();
        };

        // Keeps the button reachable above the floating mobile navbar
        container.createDiv("gym-page-end");
    }

    private renderSessionNote(container: HTMLElement): void {
        const noteSection = container.createDiv("gym-session-note");
        noteSection.createEl("label", { text: "Session note" });
        const noteInput = noteSection.createEl("textarea", {
            cls: "gym-session-note-input",
            attr: { rows: "2", placeholder: "How are you feeling today?" },
        });
        noteInput.value = this.sessionNote;
        noteInput.oninput = () => {
            this.sessionNote = noteInput.value;
            this.touch();
        };
    }

    private fillProgress(): void {
        const el = this.progressEl;
        if (!el) return;
        el.empty();
        this.durationEl = null;

        const doneExercises = this.exercises.filter(ex => this.isComplete(ex)).length;
        const totalSets = this.exercises.reduce((n, ex) => n + ex.sets.length, 0);
        const doneSets = this.exercises.reduce((n, ex) => n + ex.sets.filter(s => s.done).length, 0);
        const percent = totalSets > 0 ? Math.round((doneSets / totalSets) * 100) : 0;
        const volume = this.exercises.reduce(
            (sum, ex) => sum + ex.sets.reduce((v, s) => v + (s.done ? s.reps * s.weight : 0), 0),
            0
        );

        const top = el.createDiv("gym-progress-top");
        top.createSpan({
            text: `${doneExercises} of ${this.exercises.length} exercises done`,
            cls: "gym-progress-label",
        });
        top.createSpan({ text: `${percent}%`, cls: "gym-progress-percent" });

        const track = el.createDiv("gym-progress-track");
        track.createDiv("gym-progress-fill").style.width = `${percent}%`;

        const stats = el.createDiv("gym-progress-stats");
        const unit = this.store.getSettings().weightUnit === "lbs" ? "lbs" : "kg";
        this.addStat(stats, `${doneSets} / ${totalSets}`, "Sets");
        this.addStat(stats, `${Math.round(volume).toLocaleString()} ${unit}`, "Volume");
        const duration = this.formatDuration();
        if (duration) this.durationEl = this.addStat(stats, duration, "Duration");
    }

    private addStat(parent: HTMLElement, value: string, label: string): HTMLElement {
        const stat = parent.createDiv("gym-progress-stat");
        const valueEl = stat.createDiv({ text: value, cls: "gym-progress-stat-value" });
        stat.createDiv({ text: label, cls: "gym-progress-stat-label" });
        return valueEl;
    }

    /** Keep the duration ticking while the workout page is open. */
    private tickDuration(): void {
        if (!this.durationEl || !this.durationEl.isConnected) return;
        this.durationEl.setText(this.formatDuration());
    }

    private renderExerciseCard(list: HTMLElement, ex: WorkExercise): void {
        const complete = this.isComplete(ex);
        const expanded = this.expandedIds.has(ex.id);
        const card = list.createDiv("gym-ex-card");
        card.toggleClass("is-done", complete);
        card.toggleClass("is-expanded", expanded);

        const head = card.createDiv("gym-ex-head");

        const check = head.createEl("button", {
            cls: "gym-check gym-check-ex",
            attr: { "aria-label": complete ? "Mark all sets as not done" : "Mark all sets as done" },
        });
        check.toggleClass("is-checked", complete);
        if (complete) setIcon(check, "check");
        check.onclick = (ev) => {
            ev.stopPropagation();
            const target = !complete;
            for (const s of ex.sets) s.done = target;
            this.afterCheckChange(ex);
        };

        const titleBox = head.createDiv("gym-ex-title");
        titleBox.createDiv({ text: ex.name, cls: "gym-ex-name" });
        if (expanded) {
            this.renderTags(titleBox, ex);
        } else if (!complete && ex.sets.length > 0) {
            titleBox.createDiv({ text: this.summarizeSets(ex), cls: "gym-ex-sub" });
        }

        const doneCount = ex.sets.filter(s => s.done).length;
        const counter = head.createSpan({
            text: complete && !expanded ? `${doneCount}/${ex.sets.length} sets` : `${doneCount}/${ex.sets.length}`,
            cls: "gym-ex-count",
        });
        counter.toggleClass("is-done", complete);

        head.onclick = () => {
            if (expanded) this.expandedIds.delete(ex.id);
            else this.expandedIds.add(ex.id);
            this.renderPage();
        };

        if (expanded) this.renderExerciseBody(card, ex);
    }

    private renderTags(parent: HTMLElement, ex: WorkExercise): void {
        const tags = [ex.muscleGroup || ex.target || ex.category, ex.equipment].filter((t): t is string => !!t);
        if (tags.length === 0) return;
        const row = parent.createDiv("gym-ex-tags");
        tags.forEach((t, i) => {
            row.createSpan({ text: t, cls: `gym-tag ${i === 0 ? "gym-tag-category" : "gym-tag-equipment"}` });
        });
    }

    private renderExerciseBody(card: HTMLElement, ex: WorkExercise): void {
        const body = card.createDiv("gym-ex-body");
        const unit = this.store.getSettings().weightUnit === "lbs" ? "LBS" : "KG";

        if (ex.note || this.openNotes.has(ex.id)) {
            const noteInput = body.createEl("input", {
                cls: "gym-exercise-note-input",
                attr: { placeholder: "e.g. warm-up with empty bar" },
            });
            noteInput.value = ex.note;
            noteInput.oninput = () => {
                ex.note = noteInput.value;
                this.touch();
            };
        }

        const labels = body.createDiv("gym-set-row gym-set-labels");
        labels.createSpan("gym-set-cell gym-set-check-col");
        labels.createSpan({ text: "SET", cls: "gym-set-cell gym-set-num" });
        labels.createSpan({ text: "LAST", cls: "gym-set-cell gym-set-last" });
        labels.createSpan({ text: "REPS", cls: "gym-set-cell gym-set-field" });
        labels.createSpan({ text: unit, cls: "gym-set-cell gym-set-field" });

        const lastData = this.store.getLastSetDataForExercise(ex.id, this.date, ex.name);

        for (const set of ex.sets) {
            const row = body.createDiv("gym-set-row");
            row.toggleClass("is-done", set.done);

            const check = row.createEl("button", {
                cls: "gym-check gym-set-check-col",
                attr: { "aria-label": `Set ${set.setNumber} done` },
            });
            check.toggleClass("is-checked", set.done);
            if (set.done) setIcon(check, "check");
            check.onclick = () => {
                set.done = !set.done;
                this.afterCheckChange(ex);
            };

            row.createSpan({ text: String(set.setNumber), cls: "gym-set-cell gym-set-num" });

            const last = lastData.get(set.setNumber);
            row.createSpan({
                text: last ? `${last.reps} × ${last.weight}` : "–",
                cls: "gym-set-cell gym-set-last",
            });

            const repsInput = this.createNumberInput(row, String(set.reps), "numeric", "999", "1");
            repsInput.oninput = () => {
                set.reps = this.parseNumber(repsInput.value);
                this.touch();
                this.fillProgress();
            };

            const kgInput = this.createNumberInput(row, String(set.weight), "decimal", "9999", "0.5");
            kgInput.oninput = () => {
                set.weight = this.parseNumber(kgInput.value);
                this.touch();
                this.fillProgress();
            };
        }

        const footer = body.createDiv("gym-ex-footer");
        const addSet = footer.createEl("button", { text: "+ Add set", cls: "gym-link-btn gym-link-accent" });
        addSet.onclick = () => {
            this.appendSet(ex);
            this.touch();
            this.renderPage();
        };

        if (ex.sets.length > 1) {
            const removeSet = footer.createEl("button", { text: "− Remove set", cls: "gym-link-btn" });
            removeSet.onclick = () => {
                ex.sets.pop();
                this.touch();
                this.renderPage();
            };
        }

        if (!ex.note && !this.openNotes.has(ex.id)) {
            const addNote = footer.createEl("button", { text: "Add note", cls: "gym-link-btn gym-footer-end" });
            addNote.onclick = () => {
                this.openNotes.add(ex.id);
                this.renderPage();
            };
        }
    }

    private createNumberInput(
        row: HTMLElement,
        value: string,
        inputMode: string,
        max: string,
        step: string
    ): HTMLInputElement {
        const input = row.createEl("input", {
            cls: "gym-set-cell gym-set-field gym-input-num",
            attr: { type: "number", min: "0", max, step, inputmode: inputMode },
        });
        input.value = value;
        input.onfocus = () => input.select();
        return input;
    }

    /** A check changed: advance to the next open exercise once the current one is complete. */
    private afterCheckChange(changed: WorkExercise): void {
        if (this.expandedIds.has(changed.id) && this.isComplete(changed)) {
            const next = this.nextOpenExerciseId(changed.id);
            if (next) this.expandedIds.add(next);
        }
        this.touch();
        this.renderPage();
    }

    // ── Edit page (reorder / delete / add) ──

    private renderEditPage(container: HTMLElement): void {
        const nav = container.createDiv("gym-edit-nav");
        const back = nav.createEl("button", { cls: "gym-edit-back" });
        setIcon(back.createSpan(), "chevron-left");
        back.createSpan({ text: "Back" });
        back.onclick = () => void (this.draft ? this.cancelDraft() : this.finishEditing());
        const title = !this.draft ? "Edit exercises" : this.draftTemplateId ? "Edit template" : "New template";
        nav.createDiv({ text: title, cls: "gym-edit-title" });
        const done = nav.createEl("button", { text: this.draft ? "Save" : "Done", cls: "gym-edit-done" });
        done.onclick = () => void this.finishEditing();

        if (this.draft) {
            const nameInput = container.createEl("input", {
                cls: "gym-template-name",
                attr: { type: "text", placeholder: "Template name, e.g. Push day", maxlength: "60" },
            });
            nameInput.value = this.draftName;
            done.disabled = this.draftName.trim().length === 0;
            nameInput.oninput = () => {
                this.draftName = nameInput.value;
                done.disabled = this.draftName.trim().length === 0;
            };
        }

        container.createDiv({
            text: this.draft
                ? "Add exercises and set how many sets each one has."
                : "Drag the handle to reorder.",
            cls: "gym-edit-hint",
        });

        const list = container.createDiv("gym-edit-list");
        for (const ex of this.exercises) {
            this.renderEditRow(list, ex);
        }

        const add = container.createEl("button", { cls: "gym-edit-add" });
        setIcon(add.createSpan(), "plus");
        add.createSpan({ text: "Add exercise" });
        add.onclick = () => this.openAddSheet();

        // Keeps the last rows reachable above the floating mobile navbar
        container.createDiv("gym-page-end");
    }

    private renderEditRow(list: HTMLElement, ex: WorkExercise): void {
        const row = list.createDiv("gym-edit-row");
        row.dataset.id = ex.id;

        const handle = row.createDiv({ cls: "gym-edit-handle", attr: { "aria-label": "Drag to reorder" } });
        setIcon(handle, "menu");
        this.enableDrag(handle, row, list);

        const text = row.createDiv("gym-edit-row-text");
        text.createDiv({ text: ex.name, cls: "gym-edit-row-name" });
        const doneCount = ex.sets.filter(s => s.done).length;
        const status = this.isComplete(ex) ? "done" : doneCount > 0 ? `${doneCount}/${ex.sets.length} done` : "";
        const meta = [ex.muscleGroup || ex.target || ex.category, status]
            .filter(Boolean)
            .join(" · ");
        text.createDiv({ text: meta, cls: "gym-edit-row-meta" });

        this.renderSetStepper(row, ex);

        const del = row.createEl("button", { cls: "gym-edit-delete", attr: { "aria-label": `Remove ${ex.name}` } });
        setIcon(del, "trash-2");
        del.onclick = async () => {
            if (doneCount > 0 && !(await confirmAction(this.app, `Remove "${ex.name}" and its checked sets from this workout?`))) {
                return;
            }
            this.exercises = this.exercises.filter(e => e.id !== ex.id);
            this.expandedIds.delete(ex.id);
            this.touch();
            this.renderPage();
        };
    }

    /** − / + control to change how many sets an exercise has. */
    private renderSetStepper(row: HTMLElement, ex: WorkExercise): void {
        const stepper = row.createDiv("gym-stepper");

        const minus = stepper.createEl("button", {
            text: "−",
            cls: "gym-stepper-btn",
            attr: { "aria-label": `Remove a set from ${ex.name}` },
        });
        minus.disabled = ex.sets.length <= 1;
        minus.onclick = () => {
            ex.sets.pop();
            this.touch();
            this.renderPage();
        };

        stepper.createSpan({
            text: `${ex.sets.length} ${ex.sets.length === 1 ? "set" : "sets"}`,
            cls: "gym-stepper-value",
        });

        const plus = stepper.createEl("button", {
            text: "+",
            cls: "gym-stepper-btn",
            attr: { "aria-label": `Add a set to ${ex.name}` },
        });
        plus.disabled = ex.sets.length >= MAX_SETS;
        plus.onclick = () => {
            this.appendSet(ex);
            this.touch();
            this.renderPage();
        };
    }

    private appendSet(ex: WorkExercise): void {
        const prev = ex.sets[ex.sets.length - 1];
        ex.sets.push({
            setNumber: ex.sets.length + 1,
            reps: prev ? prev.reps : DEFAULT_NEW_REPS,
            weight: prev ? prev.weight : 0,
            done: false,
        });
    }

    /** Pointer-based drag so reordering also works on touch screens. */
    private enableDrag(handle: HTMLElement, row: HTMLElement, list: HTMLElement): void {
        handle.addEventListener("pointerdown", (down: PointerEvent) => {
            down.preventDefault();
            handle.setPointerCapture(down.pointerId);
            const startY = down.clientY;
            const startTop = row.offsetTop;
            row.addClass("is-dragging");

            const onMove = (ev: PointerEvent): void => {
                // Where the row's centre should be under the finger; independent of sibling swaps
                const center = startTop + (ev.clientY - startY) + row.offsetHeight / 2;
                // Move the neighbour, not the dragged row: detaching the row would drop the pointer capture
                let swapped = true;
                while (swapped) {
                    swapped = false;
                    const prev = row.previousElementSibling as HTMLElement | null;
                    const next = row.nextElementSibling as HTMLElement | null;
                    if (prev && center < prev.offsetTop + prev.offsetHeight / 2) {
                        list.insertBefore(prev, row.nextSibling);
                        swapped = true;
                    } else if (next && center > next.offsetTop + next.offsetHeight / 2) {
                        list.insertBefore(next, row);
                        swapped = true;
                    }
                }
                // offsetTop shrinks/grows when siblings swap, so the transform makes up the difference
                row.style.transform = `translateY(${center - row.offsetHeight / 2 - row.offsetTop}px)`;
            };

            const onEnd = (): void => {
                handle.removeEventListener("pointermove", onMove);
                handle.removeEventListener("pointerup", onEnd);
                handle.removeEventListener("pointercancel", onEnd);
                row.removeClass("is-dragging");
                row.style.transform = "";
                this.applyDomOrder(list);
            };

            handle.addEventListener("pointermove", onMove);
            handle.addEventListener("pointerup", onEnd);
            handle.addEventListener("pointercancel", onEnd);
        });
    }

    private applyDomOrder(list: HTMLElement): void {
        const ids = Array.from(list.children).map(el => (el as HTMLElement).dataset.id);
        const byId = new Map(this.exercises.map(ex => [ex.id, ex]));
        const reordered = ids.map(id => byId.get(id ?? "")).filter((ex): ex is WorkExercise => !!ex);
        if (reordered.length !== this.exercises.length) return;
        if (reordered.every((ex, i) => ex === this.exercises[i])) return;
        this.exercises = reordered;
        this.touch();
    }

    private openAddSheet(): void {
        openAddExercise(
            this.app,
            (added) => {
                this.addExercise(added);
                this.renderPage();
            },
            (candidate) => this.exercises.some(ex =>
                (!!candidate.info && ex.datasetId === candidate.info.id)
                || ex.name.toLowerCase() === candidate.name.toLowerCase()
            )
        );
    }

    private addExercise(added: AddedExercise): void {
        const id = this.store.generateId();
        const last = this.store.getLastSetDataForExercise(id, this.date, added.name);
        const sets: WorkSet[] = last.size > 0
            ? [...last.entries()]
                .sort((a, b) => a[0] - b[0])
                .map(([setNumber, data]) => ({ setNumber, reps: data.reps, weight: data.weight, done: false }))
            : Array.from({ length: DEFAULT_NEW_SETS }, (_, i) => ({
                setNumber: i + 1,
                reps: DEFAULT_NEW_REPS,
                weight: 0,
                done: false,
            }));

        const info = added.info;
        this.exercises.push({
            id,
            name: added.name,
            note: "",
            sets,
            datasetId: info?.id,
            category: info?.category,
            equipment: info?.equipment,
            target: info?.target,
            muscleGroup: info?.muscle_group,
            secondaryMuscles: info?.secondary_muscles,
        });
        this.touch();
    }

    /** Leave the edit page; offer to carry the changes over into the template. */
    private async finishEditing(): Promise<void> {
        if (this.draft) {
            await this.saveDraft();
            return;
        }

        const tpl = this.template ? this.store.getTemplate(this.template.id) : undefined;
        const diff = tpl ? this.diffAgainstTemplate(tpl) : null;

        if (tpl && diff && diff.signature !== this.promptedSignature) {
            const choice = await askTemplateChoice(this.app, diff.summary, tpl.name);
            if (choice === "cancel") return;
            if (choice === "template") {
                await this.applyToTemplate(tpl);
            } else {
                this.promptedSignature = diff.signature;
            }
        }

        this.page = "workout";
        const present = new Set(this.exercises.map(ex => ex.id));
        this.expandedIds = new Set([...this.expandedIds].filter(id => present.has(id)));
        if (this.expandedIds.size === 0) this.openFirstUnfinished();
        this.renderPage();
        this.contentEl.scrollTop = 0;
    }

    /** Save the template. A new one starts today's workout; an edited one returns to the list. */
    private async saveDraft(): Promise<void> {
        const name = this.draftName.trim();
        if (!name) return;
        if (this.exercises.length === 0) {
            new Notice("Add at least one exercise first.");
            return;
        }

        const existing = this.draftTemplateId ? this.store.getTemplate(this.draftTemplateId) : undefined;
        if (existing) {
            existing.name = name;
            await this.applyToTemplate(existing);
            this.showPicker();
            return;
        }

        const tpl: WorkoutTemplate = {
            id: this.store.generateId(),
            name,
            exercises: this.exercises.map(ex => this.templateExerciseFrom(ex)),
        };
        await this.store.saveTemplate(tpl);

        this.draft = false;
        this.draftTemplateId = null;
        this.template = tpl;
        this.sessionId = this.store.generateId();
        this.startedAt = new Date().toISOString();
        this.lastActivity = Date.now();
        this.page = "workout";
        this.expandedIds = new Set();
        this.openFirstUnfinished();
        await this.autoSave();
        this.renderPage();
        this.contentEl.scrollTop = 0;
    }

    /** Discard the template changes and go back to the template list (or close if there is none). */
    private async cancelDraft(): Promise<void> {
        if (this.draftSignature() !== this.draftBaseline
            && !(await confirmAction(this.app, "Discard your changes to this template?"))) {
            return;
        }
        if (this.store.getTemplates().length === 0) {
            this.leaf.detach();
            return;
        }
        this.showPicker();
    }

    private diffAgainstTemplate(tpl: WorkoutTemplate): { summary: string; signature: string } | null {
        const tplIds = tpl.exercises.map(e => e.id);
        const workIds = this.exercises.map(e => e.id);
        const added = workIds.filter(id => !tplIds.includes(id)).length;
        const removed = tplIds.filter(id => !workIds.includes(id)).length;
        const commonInTpl = tplIds.filter(id => workIds.includes(id));
        const commonInWork = workIds.filter(id => tplIds.includes(id));
        const reordered = commonInTpl.some((id, i) => id !== commonInWork[i]);
        const resized = this.exercises.filter(ex => {
            const tplEx = tpl.exercises.find(t => t.id === ex.id);
            return !!tplEx && tplEx.sets.length !== ex.sets.length;
        }).length;

        const parts: string[] = [];
        if (added > 0) parts.push(`added ${added} exercise${added > 1 ? "s" : ""}`);
        if (removed > 0) parts.push(`removed ${removed}`);
        if (reordered) parts.push("reordered the list");
        if (resized > 0) parts.push(`changed the set count of ${resized} exercise${resized > 1 ? "s" : ""}`);
        if (parts.length === 0) return null;

        const joined = parts.length > 1
            ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`
            : parts[0];
        const signature = `${workIds.join(",")}|${this.exercises.map(ex => ex.sets.length).join(",")}`;
        return { summary: `You ${joined}.`, signature };
    }

    private async applyToTemplate(tpl: WorkoutTemplate): Promise<void> {
        const existing = new Map(tpl.exercises.map(e => [e.id, e]));
        tpl.exercises = this.exercises.map((ex): TemplateExercise => {
            const known = existing.get(ex.id);
            if (known) {
                this.syncSetCount(known, ex.sets.length);
                return known;
            }
            return this.templateExerciseFrom(ex);
        });
        this.template = tpl;
        await this.store.saveTemplate(tpl);
    }

    /** Grow or shrink a template exercise to `count` sets, repeating the last set when growing. */
    private syncSetCount(tplEx: TemplateExercise, count: number): void {
        if (tplEx.sets.length > count) tplEx.sets.length = count;
        while (tplEx.sets.length < count) {
            const last = tplEx.sets[tplEx.sets.length - 1];
            tplEx.sets.push({
                setNumber: tplEx.sets.length + 1,
                reps: last ? last.reps : DEFAULT_NEW_REPS,
                weight: last ? last.weight : 0,
                restSeconds: last ? last.restSeconds : DEFAULT_REST_SECONDS,
            });
        }
    }

    private templateExerciseFrom(ex: WorkExercise): TemplateExercise {
        return {
            id: ex.id,
            name: ex.name,
            note: "",
            sets: ex.sets.map(s => ({
                setNumber: s.setNumber,
                reps: s.reps,
                weight: s.weight,
                restSeconds: DEFAULT_REST_SECONDS,
            })),
            datasetId: ex.datasetId,
            category: ex.category,
            equipment: ex.equipment,
            target: ex.target,
            muscleGroup: ex.muscleGroup,
            secondaryMuscles: ex.secondaryMuscles,
        };
    }

    // ── Exercise helpers ──

    private isComplete(ex: WorkExercise): boolean {
        return ex.sets.length > 0 && ex.sets.every(s => s.done);
    }

    private openFirstUnfinished(): void {
        const first = this.exercises.find(ex => !this.isComplete(ex));
        if (first) this.expandedIds.add(first.id);
    }

    /** The next unfinished exercise after `afterId` (wrapping around), or null when all are done. */
    private nextOpenExerciseId(afterId: string): string | null {
        const start = this.exercises.findIndex(ex => ex.id === afterId);
        for (let i = 1; i <= this.exercises.length; i++) {
            const candidate = this.exercises[(start + i) % this.exercises.length];
            if (!this.isComplete(candidate)) return candidate.id;
        }
        return null;
    }

    private summarizeSets(ex: WorkExercise): string {
        const first = ex.sets[0];
        const unit = this.store.getSettings().weightUnit === "lbs" ? "lbs" : "kg";
        const load = first.weight > 0 ? ` · ${first.reps} × ${first.weight} ${unit}` : ` · ${first.reps} reps`;
        return `${ex.sets.length} sets${load}`;
    }

    private parseNumber(value: string): number {
        const n = parseFloat(value);
        return Number.isNaN(n) ? 0 : n;
    }

    // ── Auto-save ──

    /** Record activity (keeps the duration current) and schedule a save. */
    private touch(): void {
        this.lastActivity = Date.now();
        this.scheduleAutoSave();
    }

    /** Schedule a debounced save. Every call resets the timer so rapid
     *  changes (e.g. typing in an input field) only trigger one write. */
    private scheduleAutoSave(): void {
        if (this.saveTimeout !== null) {
            window.clearTimeout(this.saveTimeout);
        }
        this.saveTimeout = window.setTimeout(() => {
            this.saveTimeout = null;
            void this.enqueueAutoSave();
        }, 300);
    }

    /** Enqueue an autoSave so all saves run sequentially via a promise chain.
     *  Prevents concurrent writes from racing each other. */
    private enqueueAutoSave(): Promise<void> {
        this.saveChain = this.saveChain
            .then(() => this.autoSave())
            .catch(err => {
                console.error('Gym Tracker: autoSave failed:', err);
            });
        return this.saveChain;
    }

    /** Persist the current form state to storage immediately.
     *  Unchecked sets are stored as `skipped`, so stats and "last time" ignore them. */
    private async autoSave(): Promise<void> {
        if (!this.template || this.isDeleted) return;

        const exercises: SessionExercise[] = this.exercises.map(ex => {
            const sets: SessionSet[] = ex.sets.map(s => {
                const set: SessionSet = { setNumber: s.setNumber, reps: s.reps, weight: s.weight };
                if (!s.done) set.skipped = true;
                return set;
            });

            const exercise: SessionExercise = {
                templateExerciseId: ex.id,
                name: ex.name,
                note: ex.note,
                sets,
                datasetId: ex.datasetId,
                category: ex.category,
                equipment: ex.equipment,
                target: ex.target,
                muscleGroup: ex.muscleGroup,
                secondaryMuscles: ex.secondaryMuscles,
            };
            if (!ex.sets.some(s => s.done)) exercise.skipped = true;
            return exercise;
        });

        const session: WorkoutSession = {
            id: this.sessionId,
            date: this.date,
            templateId: this.template.id,
            templateName: this.template.name,
            note: this.sessionNote,
            exercises,
            completedAt: new Date(this.lastActivity).toISOString(),
        };
        if (this.startedAt) session.startedAt = this.startedAt;

        await this.store.saveSession(session);
        this.refreshCalendars();
    }

    private refreshCalendars(): void {
        const calLeaves = this.app.workspace.getLeavesOfType(CALENDAR_VIEW_TYPE);
        for (const leaf of calLeaves) {
            (leaf.view as CalendarView).refresh();
        }
    }

    /** Cancel any pending debounced save and persist immediately.
     *  Called when the view is closed so no data is ever lost. */
    private async flushSave(): Promise<void> {
        if (this.saveTimeout !== null) {
            window.clearTimeout(this.saveTimeout);
            this.saveTimeout = null;
        }
        // Wait for any in-flight save to complete, then save with latest state
        await this.saveChain;
        await this.autoSave();
    }

    async onClose(): Promise<void> {
        // Flush any pending debounced save immediately on close
        await this.flushSave();
    }

    // ── Formatting ──

    private formatDate(): string {
        const d = new Date(`${this.date}T00:00:00`);
        if (Number.isNaN(d.getTime())) return this.date;
        return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
    }

    /** "34:12" or "1:05:12"; empty when the start time is unknown.
     *  Runs live while the workout is being worked on, and freezes at the last change after a long pause. */
    private formatDuration(): string {
        const start = Date.parse(this.startedAt);
        if (Number.isNaN(start)) return "";
        const now = Date.now();
        const end = now - this.lastActivity < IDLE_LIMIT_MS ? now : this.lastActivity;
        if (end < start) return "";
        const total = Math.floor((end - start) / 1000);
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = total % 60;
        const mm = String(m).padStart(h > 0 ? 2 : 1, "0");
        const ss = String(s).padStart(2, "0");
        return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
    }
}
