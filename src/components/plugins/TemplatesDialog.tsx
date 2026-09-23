"use client";

import { useCallback, useState, useSyncExternalStore } from "react";
import { FilePlus, LayoutTemplate, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { usePluginHost, usePluginStatuses } from "@/lib/plugins/react";
import { CoreTemplatesPlugin, CORE_TEMPLATES_MANIFEST, type Template } from "@/plugins/core-templates";

const EMPTY_TEMPLATES: readonly Template[] = [];

export type TemplateDialogMode = "manage" | "create";

export function useTemplatesPlugin(): CoreTemplatesPlugin | null {
  const host = usePluginHost();
  usePluginStatuses();
  const plugin = host.getPlugin(CORE_TEMPLATES_MANIFEST.id);
  return plugin instanceof CoreTemplatesPlugin ? plugin : null;
}

function useTemplatesStore(): {
  plugin: CoreTemplatesPlugin | null;
  templates: readonly Template[];
} {
  const plugin = useTemplatesPlugin();
  const subscribe = useCallback(
    (callback: () => void) => plugin?.subscribe(callback) ?? (() => {}),
    [plugin],
  );
  const getSnapshot = useCallback(() => plugin?.getTemplates() ?? EMPTY_TEMPLATES, [plugin]);
  const templates = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return { plugin, templates };
}

interface TemplatesDialogProps {
  open: boolean;
  mode: TemplateDialogMode;
  onOpenChange: (open: boolean) => void;
  onCreate: (template: Template) => void;
  onManage: () => void;
}

export function TemplatesDialog({
  open,
  mode,
  onOpenChange,
  onCreate,
  onManage,
}: TemplatesDialogProps) {
  if (mode === "manage") {
    return <TemplateManagerDialog key="manage" open={open} onOpenChange={onOpenChange} />;
  }
  return (
    <TemplatePickerDialog
      key="create"
      open={open}
      onOpenChange={onOpenChange}
      onCreate={onCreate}
      onManage={onManage}
    />
  );
}

function TemplatePickerDialog({
  open,
  onOpenChange,
  onCreate,
  onManage,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (template: Template) => void;
  onManage: () => void;
}) {
  const { plugin, templates } = useTemplatesStore();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedTemplateId = selectedId ?? templates[0]?.id ?? null;

  const selected = templates.find((template) => template.id === selectedTemplateId);

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) setSelectedId(null);
    onOpenChange(nextOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>New note from template</DialogTitle>
          <DialogDescription>Choose reusable Markdown for your new note.</DialogDescription>
        </DialogHeader>

        {!plugin ? (
          <p className="text-sm text-muted-foreground">Templates plugin is disabled.</p>
        ) : templates.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <LayoutTemplate className="size-8 text-muted-foreground" />
            <div>
              <p className="font-medium">No templates yet</p>
              <p className="text-sm text-muted-foreground">Define a template before creating a note from one.</p>
            </div>
            <Button type="button" variant="outline" onClick={onManage}>
              <Plus data-icon="inline-start" />
              Manage templates
            </Button>
          </div>
        ) : (
          <div className="grid min-h-64 gap-4 sm:grid-cols-[minmax(10rem,0.75fr)_minmax(0,1.5fr)]">
            <div className="flex flex-col gap-2" role="group" aria-label="Templates">
              {templates.map((template) => (
                <button
                  key={template.id}
                  type="button"
                  aria-pressed={template.id === selectedTemplateId}
                  className="rounded-lg border px-3 py-2 text-left text-sm transition-colors hover:bg-muted aria-pressed:border-primary aria-pressed:bg-muted"
                  onClick={() => setSelectedId(template.id)}
                >
                  <span className="flex items-center gap-2 font-medium">
                    <FilePlus className="size-4 text-muted-foreground" />
                    {template.name}
                  </span>
                </button>
              ))}
            </div>
            <div className="min-w-0 rounded-lg border bg-muted/30 p-4">
              {selected ? (
                <>
                  <h3 className="mb-3 font-medium">{selected.name}</h3>
                  <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-sm text-muted-foreground">
                    {selected.content || "Empty template"}
                  </pre>
                </>
              ) : null}
            </div>
          </div>
        )}

        <DialogFooter>
          {plugin && templates.length > 0 ? (
            <Button type="button" variant="ghost" onClick={onManage}>
              Manage templates
            </Button>
          ) : null}
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {plugin && templates.length > 0 ? (
            <Button
              type="button"
              onClick={() => {
                if (selected) {
                  onCreate(selected);
                  onOpenChange(false);
                }
              }}
              disabled={!selected}
            >
              <FilePlus data-icon="inline-start" />
              Create note
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TemplateManagerDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { plugin, templates } = useTemplatesStore();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Template | null>(null);

  const resetEditor = () => {
    setEditingId(null);
    setName("");
    setContent("");
    setError(null);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) resetEditor();
    onOpenChange(nextOpen);
  };

  const editing = editingId ? templates.find((template) => template.id === editingId) : undefined;

  const startNew = () => {
    setEditingId("");
    setName("");
    setContent("");
    setError(null);
  };

  const startEdit = (template: Template) => {
    setEditingId(template.id);
    setName(template.name);
    setContent(template.content);
    setError(null);
  };

  const save = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!plugin) return;
    setSaving(true);
    setError(null);
    try {
      if (editingId) await plugin.updateTemplate(editingId, name, content);
      else await plugin.createTemplate(name, content);
      setEditingId(null);
      setName("");
      setContent("");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Couldn't save template");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!plugin || !deleteTarget) return;
    try {
      await plugin.deleteTemplate(deleteTarget.id);
      if (editingId === deleteTarget.id) setEditingId(null);
      setDeleteTarget(null);
    } catch (deleteError) {
      toast.error(deleteError instanceof Error ? deleteError.message : "Couldn't delete template");
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="max-w-2xl">
          {editingId !== null ? (
            <form onSubmit={save}>
              <DialogHeader>
                <DialogTitle>{editing ? "Edit template" : "New template"}</DialogTitle>
                <DialogDescription>Save Markdown you want to reuse in new notes.</DialogDescription>
              </DialogHeader>
              <div className="mt-4 space-y-4">
                <Field>
                  <FieldLabel htmlFor="template-name">Name</FieldLabel>
                  <FieldContent>
                    <Input
                      id="template-name"
                      autoFocus
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      placeholder="Meeting notes"
                    />
                  </FieldContent>
                </Field>
                <Field>
                  <FieldLabel htmlFor="template-content">Markdown</FieldLabel>
                  <FieldContent>
                    <Textarea
                      id="template-content"
                      value={content}
                      onChange={(event) => setContent(event.target.value)}
                      placeholder="# Meeting\n\n- Attendees\n- Notes\n"
                      className="min-h-64 font-mono"
                    />
                    <FieldDescription>Content is copied into each note created from this template.</FieldDescription>
                  </FieldContent>
                </Field>
                {error ? <p className="text-sm text-destructive">{error}</p> : null}
              </div>
              <DialogFooter className="mt-4">
                <Button type="button" variant="outline" onClick={() => setEditingId(null)} disabled={saving}>
                  Cancel
                </Button>
                <Button type="submit" disabled={saving || !name.trim()}>
                  {saving ? "Saving…" : "Save template"}
                </Button>
              </DialogFooter>
            </form>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>Templates</DialogTitle>
                <DialogDescription>Define reusable Markdown for new notes.</DialogDescription>
              </DialogHeader>
              {!plugin ? (
                <p className="py-8 text-sm text-muted-foreground">Templates plugin is disabled.</p>
              ) : templates.length === 0 ? (
                <div className="flex flex-col items-center gap-3 py-8 text-center">
                  <LayoutTemplate className="size-8 text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">No templates defined.</p>
                </div>
              ) : (
                <ul className="max-h-96 space-y-2 overflow-auto">
                  {templates.map((template) => (
                    <li key={template.id} className="flex items-center gap-3 rounded-lg border p-3">
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium">{template.name}</p>
                        <p className="truncate text-sm text-muted-foreground">
                          {template.content.split("\n")[0] || "Empty template"}
                        </p>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Edit ${template.name}`}
                        onClick={() => startEdit(template)}
                      >
                        <Pencil />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Delete ${template.name}`}
                        onClick={() => setDeleteTarget(template)}
                      >
                        <Trash2 />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                  Close
                </Button>
                {plugin ? (
                  <Button type="button" onClick={startNew}>
                    <Plus data-icon="inline-start" />
                    New template
                  </Button>
                ) : null}
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={Boolean(deleteTarget)} onOpenChange={(next) => !next && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleteTarget?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>This removes template from future note creation.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void remove()}>
              <Trash2 data-icon="inline-start" />
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export function useTemplatesEnabled(): boolean {
  return useTemplatesPlugin() !== null;
}
