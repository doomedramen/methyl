"use client";

import { useCallback, useEffect, useState } from "react";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useSync } from "@/lib/browser/sync-context";
import {
  DEFAULT_REMOTE_VAULT,
  createServerVault,
  getPairing,
  listDevices,
  listServerVaults,
  pairDevice,
  removeDevice,
  type PairedDevice,
  type SyncConfig,
} from "@/lib/browser/sync-config";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

type TestResult = { kind: "idle" } | { kind: "testing" } | { kind: "ok" } | { kind: "error"; message: string };

/**
 * Sync connection settings: server URL, server vault and device pairing, reachable from the
 * sidebar footer status popover and the ⌘K command menu (both just flip
 * `dialogOpen` via useSync()).
 */
export function SyncSettingsDialog() {
  const { dialogOpen, setDialogOpen } = useSync();
  // The form lives in its own component so it mounts fresh — with state
  // initialised from the saved config — every time the dialog opens.
  return (
    <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
      <DialogContent>{dialogOpen && <SyncSettingsForm />}</DialogContent>
    </Dialog>
  );
}

function SyncSettingsForm() {
  const { config, setDialogOpen, save, disconnect, testConnection } = useSync();
  // The app is almost always served by the server it syncs with, so with
  // no saved config start from the current origin and let the user edit it.
  // "Test connection" is what proves it, not a probe before showing the field.
  const [serverUrl, setServerUrl] = useState(
    () => config?.serverUrl ?? (typeof window === "undefined" ? "" : window.location.origin),
  );
  // Used once, to pair this browser; never saved.
  const [adminToken, setAdminToken] = useState("");
  const [remoteVaultId, setRemoteVaultId] = useState(() => config?.remoteVaultId ?? DEFAULT_REMOTE_VAULT);
  // The server's vaults, offered as suggestions once known.
  const [serverVaults, setServerVaults] = useState<string[]>([]);
  const [showToken, setShowToken] = useState(false);
  const [test, setTest] = useState<TestResult>({ kind: "idle" });
  const [saving, setSaving] = useState(false);
  const [creatingServerVault, setCreatingServerVault] = useState(false);
  const [pairing, setPairing] = useState<Awaited<ReturnType<typeof getPairing>> | null>(null);

  const trimmed = () => ({
    serverUrl: serverUrl.trim(),
    adminToken: adminToken.trim(),
    remoteVaultId: remoteVaultId.trim() || DEFAULT_REMOTE_VAULT,
  });

  const validUrl = (url: string): boolean => {
    try {
      new URL(url);
      return true;
    } catch {
      return false;
    }
  };

  // Is this browser already paired with the server in the URL field?
  const refreshPairing = useCallback(async (url: string) => {
    if (!validUrl(url)) return setPairing(null);
    const status = await getPairing(url);
    setPairing(status);
    setServerVaults(status.paired ? status.vaults : []);
  }, []);
  useEffect(() => {
    const url = serverUrl.trim();
    const timer = setTimeout(() => void refreshPairing(url), 300);
    return () => clearTimeout(timer);
  }, [serverUrl, refreshPairing]);

  const runTest = useCallback(async () => {
    const { serverUrl: url, adminToken: token, remoteVaultId: vault } = trimmed();
    if (!url) {
      setTest({ kind: "error", message: "Enter the server URL first." });
      return;
    }
    if (!validUrl(url)) {
      setTest({ kind: "error", message: "That doesn't look like a valid URL." });
      return;
    }
    setTest({ kind: "testing" });
    // Before pairing, test with the admin token; afterwards, as this device.
    const candidate: SyncConfig = { serverUrl: url, remoteVaultId: vault, ...(token ? { authToken: token } : {}) };
    const [result, vaults] = await Promise.all([testConnection(candidate), listServerVaults(candidate)]);
    if (vaults.ok) setServerVaults(vaults.vaults);
    let message = result.ok ? "" : result.error;
    if (!result.ok && vaults.ok && vaults.vaults.length > 0 && !vaults.vaults.includes(vault)) {
      message += `. The server's vaults: ${vaults.vaults.join(", ")}.`;
    }
    setTest(result.ok ? { kind: "ok" } : { kind: "error", message });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverUrl, adminToken, remoteVaultId, testConnection]);

  const onCreateServerVault = useCallback(async () => {
    const { serverUrl: url, adminToken: token, remoteVaultId: id } = trimmed();
    if (!validUrl(url)) {
      setTest({ kind: "error", message: "Enter a valid server URL first." });
      return;
    }
    if (!token) {
      setTest({ kind: "error", message: "Enter the server's admin token to create a vault." });
      return;
    }
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) {
      setTest({ kind: "error", message: "Use a server vault ID with lower-case letters, digits and hyphens." });
      return;
    }

    setCreatingServerVault(true);
    setTest({ kind: "idle" });
    try {
      const listed = await listServerVaults({ serverUrl: url, authToken: token });
      if (!listed.ok) {
        setTest({ kind: "error", message: listed.error });
        return;
      }
      setServerVaults(listed.vaults);
      if (listed.vaults.includes(id)) {
        setTest({ kind: "error", message: `A server vault named "${id}" already exists. Select it and pair this browser.` });
        return;
      }

      const created = await createServerVault({ serverUrl: url, adminToken: token, id });
      if (!created.ok) {
        setTest({ kind: "error", message: created.error });
        return;
      }
      setServerVaults((current) => [...new Set([...current, id])].sort());
      toast.success(`Created server vault "${id}"`);
    } finally {
      setCreatingServerVault(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverUrl, adminToken, remoteVaultId]);

  const onSave = useCallback(async () => {
    const { serverUrl: url, adminToken: token, remoteVaultId: vault } = trimmed();
    if (!validUrl(url)) {
      setTest({ kind: "error", message: "That doesn't look like a valid URL." });
      return;
    }
    setSaving(true);
    try {
      if (token) {
        const paired = await pairDevice({ serverUrl: url, adminToken: token, remoteVaultId: vault });
        if (!paired.ok) {
          setTest({ kind: "error", message: paired.error });
          return;
        }
      } else {
        const status = await getPairing(url);
        if (!status.paired) {
          setTest({ kind: "error", message: "Enter the server's admin token to pair this browser." });
          return;
        }
        if (!status.vaults.includes(vault)) {
          setTest({
            kind: "error",
            message: `This browser isn't paired for "${vault}" yet. Enter the admin token to add it.`,
          });
          return;
        }
      }
      save({ serverUrl: url, remoteVaultId: vault });
      setDialogOpen(false);
    } finally {
      setSaving(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverUrl, adminToken, remoteVaultId, save, setDialogOpen]);

  const onDisconnect = useCallback(() => {
    disconnect();
    setDialogOpen(false);
  }, [disconnect, setDialogOpen]);

  const paired = pairing?.paired ? pairing : null;
  const serverVaultId = remoteVaultId.trim() || DEFAULT_REMOTE_VAULT;
  const serverVaultAlreadyExists = serverVaults.includes(serverVaultId);

  return (
    <>
      <DialogHeader>
        <DialogTitle>Sync</DialogTitle>
        <DialogDescription>
          The browser keeps its own local vault. Connect this device to a Methyl server so notes
          — including files copied into the server&apos;s vault folder — sync here.
        </DialogDescription>
      </DialogHeader>

      <div className="flex flex-col gap-4">
        <Field>
          <FieldLabel htmlFor="sync-server-url">Server URL</FieldLabel>
          <Input
            id="sync-server-url"
            placeholder="https://methyl.example.com"
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </Field>

        <Field>
          <FieldLabel htmlFor="sync-admin-token">
            {paired ? "Admin token (only to add a vault or remove other devices)" : "Admin token"}
          </FieldLabel>
          <div className="relative">
            <Input
              id="sync-admin-token"
              type={showToken ? "text" : "password"}
              placeholder={paired ? "Not needed — this browser is paired" : "The server's METHYL_AUTH_TOKEN"}
              value={adminToken}
              onChange={(e) => setAdminToken(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              className="pr-9"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="absolute top-1/2 right-1 -translate-y-1/2"
              onClick={() => setShowToken((v) => !v)}
              aria-label={showToken ? "Hide token" : "Show token"}
            >
              {showToken ? <EyeOff /> : <Eye />}
            </Button>
          </div>
          <FieldDescription>
            Used once to pair this browser, then forgotten. The server keeps this browser signed
            in with a cookie that scripts on the page can&apos;t read.
          </FieldDescription>
        </Field>

        <Field>
          <FieldLabel htmlFor="sync-remote-vault">Server vault</FieldLabel>
          <div className="flex gap-2">
            <Input
              id="sync-remote-vault"
              list="sync-remote-vaults"
              placeholder={DEFAULT_REMOTE_VAULT}
              value={remoteVaultId}
              onChange={(e) => setRemoteVaultId(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              className="min-w-0 flex-1"
            />
            {adminToken.trim() && (
              <Button
                type="button"
                variant="outline"
                onClick={() => void onCreateServerVault()}
                disabled={creatingServerVault || saving || serverVaultAlreadyExists}
              >
                {creatingServerVault && <Loader2 data-icon="inline-start" className="animate-spin" />}
                {serverVaultAlreadyExists ? "Vault exists" : "Create vault"}
              </Button>
            )}
          </div>
          <datalist id="sync-remote-vaults">
            {serverVaults.map((id) => (
              <option key={id} value={id} />
            ))}
          </datalist>
          <FieldDescription>
            Creates an empty server vault under the server&apos;s vaults directory. Pair and save to
            sync this browser&apos;s local vault into it. IDs use lower-case letters, digits and hyphens.
          </FieldDescription>
        </Field>

        {test.kind === "error" && <FieldError>{test.message}</FieldError>}
        {test.kind === "ok" && (
          <p className="text-sm text-primary" role="status">
            Connected — the server is reachable and this browser can sync with it.
          </p>
        )}

        {paired && (
          <DeviceList
            serverUrl={serverUrl.trim()}
            adminToken={adminToken.trim()}
            onUnpaired={() => {
              void refreshPairing(serverUrl.trim());
              onDisconnect();
            }}
          />
        )}
      </div>

      <DialogFooter className="flex-row items-center justify-between sm:justify-between">
        <div className="flex gap-2">
          {config && (
            <Button type="button" variant="outline" onClick={onDisconnect}>
              Disconnect
            </Button>
          )}
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={runTest} disabled={test.kind === "testing"}>
            {test.kind === "testing" && <Loader2 data-icon="inline-start" className="animate-spin" />}
            Test connection
          </Button>
          <Button type="button" onClick={() => void onSave()} disabled={!serverUrl.trim() || saving}>
            {saving && <Loader2 data-icon="inline-start" className="animate-spin" />}
            {paired || !adminToken.trim() ? "Save" : "Pair and save"}
          </Button>
        </div>
      </DialogFooter>
    </>
  );
}

/** This server's paired devices; remove this one, or others with the admin token. */
function DeviceList({
  serverUrl,
  adminToken,
  onUnpaired,
}: {
  serverUrl: string;
  adminToken: string;
  onUnpaired: () => void;
}) {
  const [devices, setDevices] = useState<PairedDevice[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await listDevices(serverUrl);
    if (result.ok) {
      setDevices(result.devices);
      setError(null);
    } else {
      setError(result.error);
    }
  }, [serverUrl]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const remove = async (device: PairedDevice) => {
    const result = await removeDevice(serverUrl, device.id, device.current ? undefined : adminToken);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    if (device.current) onUnpaired();
    else void load();
  };

  if (!devices && !error) return null;
  return (
    <section aria-labelledby="sync-devices-heading" className="flex flex-col gap-2">
      <h3 id="sync-devices-heading" className="text-sm font-medium">Paired devices</h3>
      {error && <FieldError>{error}</FieldError>}
      <ul className="flex flex-col gap-1">
        {devices?.map((device) => (
          <li key={device.id} className="flex items-center justify-between gap-2 text-sm">
            <span className="min-w-0 truncate">
              {device.name}
              {device.current && <span className="text-muted-foreground"> (this browser)</span>}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void remove(device)}
              disabled={!device.current && !adminToken}
              title={!device.current && !adminToken ? "Enter the admin token to remove other devices" : undefined}
            >
              {device.current ? "Unpair" : "Remove"}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
