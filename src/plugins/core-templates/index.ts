import { FilePlus, LayoutTemplate } from "lucide-react";
import { Plugin, API_VERSION, insertBlock, type NoteCreationOptions, type PluginManifest } from "@/lib/plugins/api";

export const CORE_TEMPLATES_MANIFEST: PluginManifest = {
  id: "core-templates",
  name: "Core Templates",
  description: "Create notes from reusable Markdown templates.",
  version: "1.0.0",
  minAppVersion: API_VERSION,
  isCore: true,
};

export interface Template {
  id: string;
  name: string;
  content: string;
}

interface TemplatesData {
  templates: Template[];
}

const EMPTY_TEMPLATES: readonly Template[] = [];

function createTemplateId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `template-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function normalizeTemplates(data: unknown): Template[] {
  if (!data || typeof data !== "object" || !Array.isArray((data as TemplatesData).templates)) {
    return [];
  }

  return (data as TemplatesData).templates.filter(
    (template): template is Template =>
      Boolean(template) &&
      typeof template.id === "string" &&
      typeof template.name === "string" &&
      template.name.trim().length > 0 &&
      typeof template.content === "string",
  ).map((template) => ({
    id: template.id,
    name: template.name.trim(),
    content: template.content,
  }));
}

export class CoreTemplatesPlugin extends Plugin {
  private templates: readonly Template[] = EMPTY_TEMPLATES;
  private listeners = new Set<() => void>();

  async onload(): Promise<void> {
    const data = await this.loadData<TemplatesData>();
    this.templates = normalizeTemplates(data);

    this.addCommand({
      id: "manage",
      name: "Templates: Manage",
      icon: LayoutTemplate,
      keywords: ["template", "templates", "settings"],
      callback: () => this.app.workspace.openDialog("templates"),
    });
    this.addCommand({
      id: "new-note",
      name: "New note from template",
      icon: FilePlus,
      keywords: ["template", "templates", "new", "note"],
      callback: () => this.app.workspace.openDialog("templates:create"),
    });
    // "/" menu: one entry per template, inserting its text at the cursor.
    this.registerSlashCommand(() =>
      this.templates.map((template) => ({
        id: `template-${template.id}`,
        label: `Template: ${template.name}`,
        keywords: ["template", template.name],
        apply: insertBlock(template.content),
      })),
    );
  }

  getTemplates(): readonly Template[] {
    return this.templates;
  }

  getTemplate(id: string): Template | undefined {
    return this.templates.find((template) => template.id === id);
  }

  subscribe(callback: () => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  async createTemplate(name: string, content: string): Promise<Template> {
    const template = this.newTemplate(name, content);
    await this.persistTemplates([...this.templates, template]);
    return template;
  }

  async updateTemplate(id: string, name: string, content: string): Promise<Template> {
    const current = this.getTemplate(id);
    if (!current) throw new Error("Template not found");
    const template = { ...current, name: this.normalizeName(name), content };
    await this.persistTemplates(this.templates.map((item) => (item.id === id ? template : item)));
    return template;
  }

  async deleteTemplate(id: string): Promise<void> {
    if (!this.getTemplate(id)) throw new Error("Template not found");
    await this.persistTemplates(this.templates.filter((template) => template.id !== id));
  }

  async createNoteFromTemplate(id: string, options: Omit<NoteCreationOptions, "markdown"> = {}): Promise<string> {
    const template = this.getTemplate(id);
    if (!template) throw new Error("Template not found");
    return this.app.vault.createNote({ ...options, markdown: template.content });
  }

  onunload(): void {
    this.listeners.clear();
  }

  private newTemplate(name: string, content: string): Template {
    return { id: createTemplateId(), name: this.normalizeName(name), content };
  }

  private normalizeName(name: string): string {
    const normalized = name.trim();
    if (!normalized) throw new Error("Template name is required");
    return normalized;
  }

  private async persistTemplates(templates: Template[]): Promise<void> {
    await this.saveData({ templates });
    this.templates = templates;
    for (const listener of this.listeners) listener();
  }
}
