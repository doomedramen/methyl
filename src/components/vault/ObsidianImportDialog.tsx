"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  FileArchive,
  FileText,
  FolderOpen,
  Image as ImageIcon,
  Loader2,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  importSummary,
  isObsidianMarkdownPath,
  prepareObsidianImport,
  type ObsidianImportEntry,
  type ObsidianImportProgress,
  type ObsidianImportReport,
} from "@/lib/vault/obsidian-import";

interface ObsidianImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImport: (
    entries: ObsidianImportEntry[],
    onProgress: (progress: ObsidianImportProgress) => void,
  ) => Promise<ObsidianImportReport>;
}

type ImportStage = "choose" | "ready" | "importing" | "complete";

interface DirectoryHandleLike {
  kind: "directory";
  name: string;
  values(): AsyncIterable<DirectoryEntryLike>;
}

interface FileHandleLike {
  kind: "file";
  name: string;
  getFile(): Promise<File>;
}

type DirectoryEntryLike = DirectoryHandleLike | FileHandleLike;

interface DirectoryPickerWindow extends Window {
  showDirectoryPicker?: () => Promise<DirectoryHandleLike>;
}

function pathParts(path: string): string[] {
  return path.replaceAll("\\", "/").split("/").filter(Boolean);
}

function commonInputRoot(paths: string[]): string | undefined {
  const parts = paths.map(pathParts);
  const root = parts[0]?.[0];
  if (!root || parts.length < 1 || !parts.every((current) => current[0] === root)) return undefined;
  return parts.some((current) => current.length > 1) ? root : undefined;
}

function fileEntries(files: File[], stripRoot: boolean): ObsidianImportEntry[] {
  const rawPaths = files.map((file) => file.webkitRelativePath || file.name);
  const root = stripRoot ? commonInputRoot(rawPaths) : undefined;

  return files.map((file, index) => {
    const rawPath = rawPaths[index]!;
    const parts = pathParts(rawPath);
    const path = root && parts[0] === root ? parts.slice(1).join("/") : parts.join("/");
    return {
      path,
      size: file.size,
      read: async () => new Uint8Array(await file.arrayBuffer()),
    };
  });
}

async function directoryEntries(
  directory: DirectoryHandleLike,
  prefix = "",
): Promise<ObsidianImportEntry[]> {
  const entries: ObsidianImportEntry[] = [];
  for await (const child of directory.values()) {
    const path = prefix ? `${prefix}/${child.name}` : child.name;
    if (child.kind === "directory") {
      entries.push(...(await directoryEntries(child, path)));
      continue;
    }
    const fileHandle = child;
    const file = await fileHandle.getFile();
    entries.push({
      path,
      size: file.size,
      read: async () => new Uint8Array(await (await fileHandle.getFile()).arrayBuffer()),
    });
  }
  return entries;
}

function sourceSummary(entries: ObsidianImportEntry[]): {
  notes: number;
  files: number;
  skipped: number;
} {
  const prepared = prepareObsidianImport(entries);
  return {
    notes: prepared.entries.filter((entry) => isObsidianMarkdownPath(entry.path)).length,
    files: prepared.entries.filter((entry) => !isObsidianMarkdownPath(entry.path)).length,
    skipped: prepared.skipped.length,
  };
}

export function ObsidianImportDialog({
  open,
  onOpenChange,
  onImport,
}: ObsidianImportDialogProps) {
  const [stage, setStage] = useState<ImportStage>("choose");
  const [entries, setEntries] = useState<ObsidianImportEntry[]>([]);
  const [sourceName, setSourceName] = useState<string | null>(null);
  const [progress, setProgress] = useState<ObsidianImportProgress | null>(null);
  const [report, setReport] = useState<ObsidianImportReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const filesInputRef = useRef<HTMLInputElement>(null);

  const prepared = useMemo(() => prepareObsidianImport(entries), [entries]);
  const summary = useMemo(() => sourceSummary(entries), [entries]);

  useEffect(() => {
    const input = folderInputRef.current;
    if (!input) return;
    input.setAttribute("webkitdirectory", "");
    input.setAttribute("directory", "");
  }, []);

  const reset = useCallback(() => {
    setStage("choose");
    setEntries([]);
    setSourceName(null);
    setProgress(null);
    setReport(null);
    setError(null);
  }, []);

  const selectEntries = useCallback((nextEntries: ObsidianImportEntry[], name: string) => {
    if (nextEntries.length === 0) {
      setError("No files found in that selection.");
      return;
    }
    setEntries(nextEntries);
    setSourceName(name);
    setProgress(null);
    setReport(null);
    setError(null);
    setStage("ready");
  }, []);

  const chooseFolder = useCallback(async () => {
    setError(null);
    const picker = (window as DirectoryPickerWindow).showDirectoryPicker;
    if (!picker) {
      folderInputRef.current?.click();
      return;
    }
    try {
      const directory = await picker();
      selectEntries(await directoryEntries(directory), directory.name);
    } catch (pickerError) {
      if (pickerError instanceof DOMException && pickerError.name === "AbortError") return;
      setError(pickerError instanceof Error ? pickerError.message : "Couldn't read that folder.");
    }
  }, [selectEntries]);

  const handleFolderInput = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    const root = commonInputRoot(files.map((file) => file.webkitRelativePath || file.name));
    selectEntries(fileEntries(files, true), root ?? "Selected folder");
  }, [selectEntries]);

  const handleFilesInput = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    selectEntries(fileEntries(files, false), files.length === 1 ? files[0]!.name : `${files.length} selected files`);
  }, [selectEntries]);

  const startImport = useCallback(async () => {
    if (prepared.entries.length === 0) return;
    setStage("importing");
    setProgress({ current: 0, total: prepared.entries.length, path: "Starting…", kind: "file" });
    setError(null);
    try {
      const imported = await onImport(prepared.entries, setProgress);
      setReport(imported);
      setStage("complete");
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : "Couldn't import this vault.");
      setStage("ready");
    }
  }, [onImport, prepared.entries]);

  const percent = progress && progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;
  const close = () => {
    reset();
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && stage === "importing") return;
        if (!nextOpen) reset();
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent className="max-w-lg" showCloseButton={stage !== "importing"}>
        {stage === "choose" && (
          <>
            <DialogHeader>
              <div className="mb-1 flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <FolderOpen className="size-5" />
              </div>
              <DialogTitle>Import Obsidian vault</DialogTitle>
              <DialogDescription>
                Bring notes and supporting files into this vault. Folder structure and Markdown stay intact.
              </DialogDescription>
            </DialogHeader>

            <div className="rounded-xl border border-dashed bg-muted/20 p-6 text-center">
              <FileArchive className="mx-auto mb-3 size-8 text-muted-foreground" />
              <p className="font-medium">Choose your vault folder</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Methyl skips <code>.obsidian</code>, <code>.trash</code>, and app metadata.
              </p>
              <div className="mt-5 flex flex-col justify-center gap-2 sm:flex-row">
                <Button type="button" onClick={() => void chooseFolder()}>
                  <FolderOpen data-icon="inline-start" />
                  Choose folder
                </Button>
                <Button type="button" variant="outline" onClick={() => filesInputRef.current?.click()}>
                  Choose files
                </Button>
              </div>
            </div>
            {error ? <ErrorMessage>{error}</ErrorMessage> : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={close}>Cancel</Button>
            </DialogFooter>
          </>
        )}

        {stage === "ready" && (
          <>
            <DialogHeader>
              <DialogTitle>Ready to import</DialogTitle>
              <DialogDescription className="break-all">{sourceName}</DialogDescription>
            </DialogHeader>

            <div className="grid grid-cols-3 divide-x rounded-xl border bg-muted/20 py-4 text-center">
              <ImportStat icon={<FileText />} value={summary.notes} label="notes" />
              <ImportStat icon={<ImageIcon />} value={summary.files} label="files" />
              <ImportStat icon={<TriangleAlert />} value={summary.skipped} label="skipped" muted={summary.skipped === 0} />
            </div>
            <p className="text-sm text-muted-foreground">
              Imported files keep their relative folders. Name conflicts get a numbered suffix so existing notes stay safe.
            </p>
            {error ? <ErrorMessage>{error}</ErrorMessage> : null}
            <DialogFooter className="sm:justify-between">
              <Button type="button" variant="ghost" onClick={reset}>
                <RefreshCw data-icon="inline-start" />
                Choose another
              </Button>
              <Button type="button" onClick={() => void startImport()} disabled={prepared.entries.length === 0}>
                Import vault
              </Button>
            </DialogFooter>
          </>
        )}

        {stage === "importing" && (
          <>
            <DialogHeader>
              <DialogTitle>Importing vault</DialogTitle>
              <DialogDescription>Keep this window open while files are copied into your local vault.</DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="flex items-center gap-3">
                <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                  <Loader2 className="size-5 animate-spin" />
                </div>
                <div className="min-w-0">
                  <p className="font-medium">{progress?.current ?? 0} of {progress?.total ?? prepared.entries.length}</p>
                  <p className="truncate text-sm text-muted-foreground">{progress?.path}</p>
                </div>
                <span className="ml-auto tabular-nums text-sm text-muted-foreground">{percent}%</span>
              </div>
              <div
                role="progressbar"
                aria-label="Import progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
                className="h-2 overflow-hidden rounded-full bg-muted"
              >
                <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${percent}%` }} />
              </div>
            </div>
          </>
        )}

        {stage === "complete" && report && (
          <>
            <DialogHeader>
              <div className="mb-1 flex size-10 items-center justify-center rounded-full bg-primary/10 text-primary">
                <CheckCircle2 className="size-5" />
              </div>
              <DialogTitle>Vault imported</DialogTitle>
              <DialogDescription>{importSummary(report)}.</DialogDescription>
            </DialogHeader>
            <div className="space-y-2 text-sm">
              {report.skipped.length > 0 ? (
                <p className="text-muted-foreground">{report.skipped.length} metadata or unsupported files skipped.</p>
              ) : null}
              {report.failed.length > 0 ? (
                <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-destructive">
                  <p className="font-medium">{report.failed.length} files could not be imported.</p>
                  <p className="mt-1 break-words text-xs">{report.failed[0]!.path}: {report.failed[0]!.reason}</p>
                </div>
              ) : null}
            </div>
            <DialogFooter>
              <Button type="button" onClick={close}>Done</Button>
            </DialogFooter>
          </>
        )}

        <input ref={folderInputRef} type="file" multiple className="hidden" onChange={handleFolderInput} />
        <input ref={filesInputRef} type="file" multiple className="hidden" onChange={handleFilesInput} />
      </DialogContent>
    </Dialog>
  );
}

function ImportStat({
  icon,
  value,
  label,
  muted = false,
}: {
  icon: React.ReactNode;
  value: number;
  label: string;
  muted?: boolean;
}) {
  return (
    <div className={cn("flex flex-col items-center gap-1", muted && "text-muted-foreground/60")}>
      <span className="text-muted-foreground [&_svg]:size-4">{icon}</span>
      <span className="text-lg font-semibold tabular-nums">{value}</span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}

function ErrorMessage({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-2 text-sm text-destructive" role="alert">
      <TriangleAlert className="mt-0.5 size-4 shrink-0" />
      <span>{children}</span>
    </p>
  );
}
