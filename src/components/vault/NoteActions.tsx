"use client";

import { useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { Field, FieldContent, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

interface RenameDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentTitle: string;
  onRename: (title: string) => Promise<void>;
}

export function RenameNoteDialog({
  open,
  onOpenChange,
  currentTitle,
  onRename,
}: RenameDialogProps) {
  const [value, setValue] = useState(currentTitle);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setValue(currentTitle);
          setError(null);
        }
        if (!next && submitting) return;
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const trimmed = value.trim();
            if (!trimmed || submitting) return;
            setSubmitting(true);
            setError(null);
            try {
              await onRename(trimmed);
              onOpenChange(false);
            } catch {
              setError("Couldn't rename note. Try again.");
            } finally {
              setSubmitting(false);
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>Rename note</DialogTitle>
          </DialogHeader>
          <Field className="mt-4">
            <FieldLabel htmlFor="rename-note-title">Title</FieldLabel>
            <FieldContent>
              <Input
                id="rename-note-title"
                autoFocus
                value={value}
                aria-invalid={Boolean(error)}
                onChange={(e) => setValue(e.target.value)}
              />
            </FieldContent>
          </Field>
          {error && <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}
          <DialogFooter className="mt-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!value.trim() || submitting}>
              <Pencil data-icon="inline-start" />
              Rename
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

interface DeleteAlertProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  noteTitle: string;
  onConfirm: () => void;
}

export function DeleteNoteAlert({
  open,
  onOpenChange,
  noteTitle,
  onConfirm,
}: DeleteAlertProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete &ldquo;{noteTitle}&rdquo;?</AlertDialogTitle>
          <AlertDialogDescription>
            You can&apos;t undo this.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => {
              onConfirm();
              onOpenChange(false);
            }}
          >
            <Trash2 data-icon="inline-start" />
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

interface RenameFolderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentName: string;
  onRename: (name: string) => void;
}

export function RenameFolderDialog({
  open,
  onOpenChange,
  currentName,
  onRename,
}: RenameFolderDialogProps) {
  const [value, setValue] = useState(currentName);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) setValue(currentName);
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const trimmed = value.trim();
            if (!trimmed) return;
            onRename(trimmed);
            onOpenChange(false);
          }}
        >
          <DialogHeader>
            <DialogTitle>Rename folder</DialogTitle>
          </DialogHeader>
          <Field className="mt-4">
            <FieldLabel htmlFor="rename-folder-name">Name</FieldLabel>
            <FieldContent>
              <Input
                id="rename-folder-name"
                autoFocus
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            </FieldContent>
          </Field>
          <DialogFooter className="mt-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!value.trim()}>
              <Pencil data-icon="inline-start" />
              Rename
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function RenameAssetDialog({
  open,
  onOpenChange,
  currentName,
  onRename,
}: RenameFolderDialogProps) {
  const [value, setValue] = useState(currentName);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) setValue(currentName);
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = value.trim();
            if (!trimmed) return;
            onRename(trimmed);
            onOpenChange(false);
          }}
        >
          <DialogHeader>
            <DialogTitle>Rename attachment</DialogTitle>
          </DialogHeader>
          <Field className="mt-4">
            <FieldLabel htmlFor="rename-attachment-name">Name</FieldLabel>
            <FieldContent>
              <Input
                id="rename-attachment-name"
                autoFocus
                value={value}
                onChange={(event) => setValue(event.target.value)}
              />
            </FieldContent>
          </Field>
          <DialogFooter className="mt-4">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!value.trim()}>
              <Pencil data-icon="inline-start" />
              Rename
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function DeleteAssetAlert({
  open,
  onOpenChange,
  assetName,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  assetName: string;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete &ldquo;{assetName}&rdquo;?</AlertDialogTitle>
          <AlertDialogDescription>
            This removes the attachment and its ordinary file from the vault.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => {
              onConfirm();
              onOpenChange(false);
            }}
          >
            <Trash2 data-icon="inline-start" />
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

interface NewFolderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (name: string) => void;
}

export function NewFolderDialog({
  open,
  onOpenChange,
  onCreate,
}: NewFolderDialogProps) {
  const [value, setValue] = useState("");

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) setValue("");
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const trimmed = value.trim();
            if (!trimmed) return;
            onCreate(trimmed);
            onOpenChange(false);
          }}
        >
          <DialogHeader>
            <DialogTitle>New folder</DialogTitle>
          </DialogHeader>
          <Field className="mt-4">
            <FieldLabel htmlFor="new-folder-name">Name</FieldLabel>
            <FieldContent>
              <Input
                id="new-folder-name"
                autoFocus
                placeholder="Folder name"
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            </FieldContent>
          </Field>
          <DialogFooter className="mt-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!value.trim()}>
              <Plus data-icon="inline-start" />
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

interface DeleteFolderAlertProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  folderName: string;
  noteCount: number;
  onConfirm: () => void;
}

export function DeleteFolderAlert({
  open,
  onOpenChange,
  folderName,
  noteCount,
  onConfirm,
}: DeleteFolderAlertProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete &ldquo;{folderName}&rdquo;?</AlertDialogTitle>
          <AlertDialogDescription>
            {noteCount > 0
              ? `Also deletes the ${noteCount} note${noteCount === 1 ? "" : "s"} inside. You can't undo this.`
              : "You can't undo this."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => {
              onConfirm();
              onOpenChange(false);
            }}
          >
            <Trash2 data-icon="inline-start" />
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
