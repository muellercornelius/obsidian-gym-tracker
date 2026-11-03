import { App, Modal, setIcon } from "obsidian";
import { ExerciseInfo, getAllExercises, searchExercises } from "../data/exerciseDataset";

export interface AddedExercise {
    name: string;
    info?: ExerciseInfo;
}

const MAX_RESULTS = 60;

/** Bottom-sheet style picker that searches the exercise dataset. */
export class AddExerciseModal extends Modal {
    private onAdd: (added: AddedExercise) => void;
    private isAdded: (candidate: AddedExercise) => boolean;
    private query = "";
    private group = "";
    private listEl!: HTMLElement;

    constructor(
        app: App,
        onAdd: (added: AddedExercise) => void,
        isAdded: (candidate: AddedExercise) => boolean
    ) {
        super(app);
        this.onAdd = onAdd;
        this.isAdded = isAdded;
    }

    onOpen(): void {
        const { contentEl, modalEl } = this;
        modalEl.addClass("gym-add-sheet");
        contentEl.empty();

        const header = contentEl.createDiv("gym-sheet-header");
        header.createEl("h3", { text: "Add exercise", cls: "gym-sheet-title" });
        const doneBtn = header.createEl("button", { text: "Done", cls: "gym-sheet-done" });
        doneBtn.onclick = () => this.close();

        const searchWrap = contentEl.createDiv("gym-sheet-search");
        setIcon(searchWrap.createSpan("gym-sheet-search-icon"), "search");
        const input = searchWrap.createEl("input", {
            attr: { type: "search", placeholder: "Search exercises…" },
        });
        input.oninput = () => {
            this.query = input.value;
            this.renderList();
        };

        const chips = contentEl.createDiv("gym-sheet-chips");
        const groups = this.collectGroups();
        const chipEls = new Map<string, HTMLElement>();
        for (const g of ["", ...groups]) {
            const chip = chips.createEl("button", {
                text: g ? capitalize(g) : "All",
                cls: "gym-chip",
            });
            chipEls.set(g, chip);
            chip.onclick = () => {
                this.group = g;
                chipEls.forEach((el, key) => el.toggleClass("is-active", key === g));
                this.renderList();
            };
        }
        chipEls.get("")?.addClass("is-active");

        this.listEl = contentEl.createDiv("gym-sheet-list");
        this.renderList();
        window.setTimeout(() => input.focus(), 50);
    }

    private collectGroups(): string[] {
        const counts = new Map<string, number>();
        for (const ex of getAllExercises()) {
            counts.set(ex.muscle_group, (counts.get(ex.muscle_group) ?? 0) + 1);
        }
        return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([g]) => g);
    }

    private renderList(): void {
        this.listEl.empty();
        const q = this.query.trim();

        let pool = q ? searchExercises(q, 1000) : [...getAllExercises()].sort((a, b) => a.name.localeCompare(b.name));
        if (this.group) pool = pool.filter(ex => ex.muscle_group === this.group);
        const shown = pool.slice(0, MAX_RESULTS);

        for (const info of shown) {
            const row = this.listEl.createDiv("gym-sheet-row");
            const text = row.createDiv("gym-sheet-row-text");
            text.createDiv({ text: info.name, cls: "gym-sheet-row-name" });
            text.createDiv({ text: `${info.muscle_group} · ${info.equipment}`, cls: "gym-sheet-row-meta" });
            this.renderAction(row, { name: info.name, info });
        }

        if (pool.length > shown.length) {
            this.listEl.createDiv({
                text: `${pool.length - shown.length} more – refine your search`,
                cls: "gym-sheet-more",
            });
        }

        const exact = q && getAllExercises().some(ex => ex.name.toLowerCase() === q.toLowerCase());
        if (q && !exact && !this.isAdded({ name: q })) {
            const custom = this.listEl.createEl("button", {
                text: `Create "${q}" as custom exercise`,
                cls: "gym-sheet-custom",
            });
            custom.onclick = () => {
                this.onAdd({ name: q });
                this.renderList();
            };
        }

        if (!pool.length && !q) {
            this.listEl.createDiv({ text: "No exercises found.", cls: "gym-sheet-more" });
        }
    }

    private renderAction(row: HTMLElement, candidate: AddedExercise): void {
        if (this.isAdded(candidate)) {
            row.addClass("is-added");
            const badge = row.createDiv("gym-sheet-added");
            setIcon(badge.createSpan(), "check");
            badge.createSpan({ text: "Added" });
            return;
        }
        const btn = row.createEl("button", { cls: "gym-sheet-add", attr: { "aria-label": `Add ${candidate.name}` } });
        setIcon(btn, "plus");
        btn.onclick = () => {
            this.onAdd(candidate);
            row.removeClass("is-added");
            row.querySelector(".gym-sheet-add")?.remove();
            this.renderAction(row, candidate);
        };
    }

    onClose(): void {
        this.contentEl.empty();
    }
}

function capitalize(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
}

export function openAddExercise(
    app: App,
    onAdd: (added: AddedExercise) => void,
    isAdded: (candidate: AddedExercise) => boolean
): void {
    new AddExerciseModal(app, onAdd, isAdded).open();
}
