import { App, Modal } from "obsidian";

export type TemplateChoice = "template" | "today" | "cancel";

class TemplateChoiceModal extends Modal {
    private summary: string;
    private templateName: string;
    private resolve: (choice: TemplateChoice) => void;
    private settled = false;

    constructor(app: App, summary: string, templateName: string, resolve: (choice: TemplateChoice) => void) {
        super(app);
        this.summary = summary;
        this.templateName = templateName;
        this.resolve = resolve;
    }

    onOpen(): void {
        const { contentEl, modalEl } = this;
        modalEl.addClass("gym-choice-modal");

        contentEl.createEl("h3", { text: "Save changes", cls: "gym-choice-title" });
        contentEl.createEl("p", {
            text: `${this.summary} Should the "${this.templateName}" template change too?`,
            cls: "gym-choice-text",
        });

        const choose = (choice: TemplateChoice): void => {
            this.settled = true;
            this.resolve(choice);
            this.close();
        };

        const primary = contentEl.createEl("button", {
            text: "Update template too",
            cls: "gym-choice-btn mod-cta",
        });
        primary.onclick = () => choose("template");

        const secondary = contentEl.createEl("button", {
            text: "Only today's workout",
            cls: "gym-choice-btn",
        });
        secondary.onclick = () => choose("today");

        const cancel = contentEl.createEl("button", {
            text: "Keep editing",
            cls: "gym-choice-btn gym-choice-cancel",
        });
        cancel.onclick = () => choose("cancel");
    }

    onClose(): void {
        if (!this.settled) this.resolve("cancel");
        this.contentEl.empty();
    }
}

/** Ask whether edits to the exercise list should also be written to the template. */
export function askTemplateChoice(app: App, summary: string, templateName: string): Promise<TemplateChoice> {
    return new Promise<TemplateChoice>((resolve) => {
        new TemplateChoiceModal(app, summary, templateName, resolve).open();
    });
}
