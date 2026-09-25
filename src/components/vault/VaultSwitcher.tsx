"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, ChevronsUpDown, Settings2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { VaultInfo } from "@/lib/browser/vault-registry";

type Actions = typeof import("@/lib/browser/vault-actions");
// Loaded on demand: the actions pull in the vault engine, which must stay
// out of the server-rendered module graph.
const loadActions = (): Promise<Actions> => import("@/lib/browser/vault-actions");

function useVaults(ready: boolean) {
  const [state, setState] = useState<{ vaults: VaultInfo[]; current: VaultInfo | null }>({
    vaults: [],
    current: null,
  });
  const refresh = useCallback(() => {
    void loadActions()
      .then((a) => a.listVaults())
      .then(setState)
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    if (ready) refresh();
  }, [ready, refresh]);
  return { ...state, refresh };
}

/**
 * The vault name at the top of the sidebar: a menu to open another vault,
 * and "Manage vaults…" for creating, renaming, archiving and importing them.
 */
/** Window event the "Manage vaults" command sends to open the dialog. */
export const OPEN_VAULTS_EVENT = "methyl:open-vaults";

export function VaultSwitcher({ ready }: { ready: boolean }) {
  const { vaults, current, refresh } = useVaults(ready);
  const [manageOpen, setManageOpen] = useState(false);
  useEffect(() => {
    const open = () => {
      refresh();
      setManageOpen(true);
    };
    window.addEventListener(OPEN_VAULTS_EVENT, open);
    return () => window.removeEventListener(OPEN_VAULTS_EVENT, open);
  }, [refresh]);

  return (
    <>
      <DropdownMenu onOpenChange={(open) => open && refresh()}>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              className="h-8 min-w-0 justify-start gap-1 px-1.5 text-base font-semibold tracking-tight"
              aria-label={`Vault: ${current?.name ?? "Methyl"}. Switch vault`}
            >
              <span className="min-w-0 truncate">{current?.name ?? "Methyl"}</span>
              <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
            </Button>
          }
        />
        <DropdownMenuContent align="start" className="min-w-56">
          {vaults.map((vault) => (
            <DropdownMenuItem
              key={vault.id}
              onClick={() => {
                if (vault.id !== current?.id) void loadActions().then((a) => a.openVault(vault.id));
              }}
            >
              <Check className={vault.id === current?.id ? "" : "invisible"} />
              <span className="truncate">{vault.name}</span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setManageOpen(true)}>
            <Settings2 />
            Manage vaults…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ManageVaultsDialog
        open={manageOpen}
        onOpenChange={setManageOpen}
        vaults={vaults}
        current={current}
        onChanged={refresh}
      />
    </>
  );
}

function ManageVaultsDialog({
  open,
  onOpenChange,
  vaults,
  current,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  vaults: VaultInfo[];
  current: VaultInfo | null;
  onChanged: () => void;
}) {
  const [newName, setNewName] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [archiving, setArchiving] = useState<VaultInfo | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);

  const run = async (label: string, action: (a: Actions) => Promise<void>) => {
    setBusy(true);
    try {
      await action(await loadActions());
      onChanged();
    } catch (error) {
      toast.error(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Vaults</DialogTitle>
          <DialogDescription>
            Vaults sync in the background. Archiving removes a vault from active lists while keeping its files.
            Opening another vault reloads the app.
          </DialogDescription>
        </DialogHeader>

        <ul className="flex flex-col gap-1" aria-label="Vaults">
          {vaults.map((vault) => (
            <li key={vault.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/50">
              {renaming?.id === vault.id ? (
                <form
                  className="flex flex-1 gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void run("Rename failed", (a) => a.renameVaultTo(vault.id, renaming.name)).then(() =>
                      setRenaming(null),
                    );
                  }}
                >
                  <Input
                    autoFocus
                    aria-label="Vault name"
                    value={renaming.name}
                    onChange={(e) => setRenaming({ id: vault.id, name: e.target.value })}
                  />
                  <Button type="submit" size="sm" disabled={busy || !renaming.name.trim()}>
                    Save
                  </Button>
                </form>
              ) : (
                <>
                  <span className="flex-1 truncate">
                    {vault.name}
                    {vault.id === current?.id && <span className="text-muted-foreground"> (open)</span>}
                  </span>
                  {vault.id !== current?.id && (
                    <Button size="sm" variant="ghost" onClick={() => void loadActions().then((a) => a.openVault(vault.id))}>
                      Open
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => setRenaming({ id: vault.id, name: vault.name })}>
                    Rename
                  </Button>
                  {vault.id !== current?.id && vaults.length > 1 && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive"
                      onClick={() => {
                        setArchiving(vault);
                        setConfirmText("");
                      }}
                    >
                      Archive
                    </Button>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>

        {archiving && (
          <form
            className="flex flex-col gap-2 rounded-md border border-destructive/40 p-3"
            onSubmit={(e) => {
              e.preventDefault();
              void run("Archive failed", (a) => a.archiveVault(archiving.id)).then(() => setArchiving(null));
            }}
          >
            <Field>
              <FieldLabel htmlFor="archive-vault-confirm">
                Archive “{archiving.name}” and hide it from active vault lists?
              </FieldLabel>
              <FieldDescription>
                Local files stay on this browser; if synced, server files are preserved in the server archive.
                Type the vault&apos;s name to confirm.
              </FieldDescription>
              <Input
                id="archive-vault-confirm"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                autoComplete="off"
              />
            </Field>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => setArchiving(null)}>
                Cancel
              </Button>
              <Button type="submit" variant="destructive" size="sm" disabled={busy || confirmText !== archiving.name}>
                Archive vault
              </Button>
            </div>
          </form>
        )}

        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void run("Couldn't create the vault", (a) => a.createAndOpenVault(newName));
          }}
        >
          <Field className="flex-1">
            <FieldLabel htmlFor="new-vault-name">New vault</FieldLabel>
            <Input
              id="new-vault-name"
              placeholder="Name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
          </Field>
          <Button type="submit" disabled={busy || !newName.trim()}>
            Create
          </Button>
        </form>

        <DialogFooter className="sm:justify-start">
          <Button
            variant="outline"
            disabled={busy}
            render={<label />}
            nativeButton={false}
          >
            Import full backup as a new vault…
            <input
              type="file"
              accept=".zip,application/zip"
              className="sr-only"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (!file) return;
                const name = file.name.replace(/\.zip$/i, "");
                void run("Import failed", (a) => a.importBackupAsVault(file, name));
              }}
            />
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
