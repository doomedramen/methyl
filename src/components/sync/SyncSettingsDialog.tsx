"use client";

import { useCallback, useEffect, useState } from "react";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { useSync } from "@/lib/browser/sync-context";
import {
  getPairing,
  listDevices,
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
 * Shared sync connection settings and device pairing, reachable from the
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
  const [showToken, setShowToken] = useState(false);
  const [test, setTest] = useState<TestResult>({ kind: "idle" });
  const [saving, setSaving] = useState(false);
  const [pairing, setPairing] = useState<Awaited<ReturnType<typeof getPairing>> | null>(null);

  const trimmed = () => ({
    serverUrl: serverUrl.trim(),
    adminToken: adminToken.trim(),
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
  }, []);
  useEffect(() => {
    const url = serverUrl.trim();
    const timer = setTimeout(() => void refreshPairing(url), 300);
    return () => clearTimeout(timer);
  }, [serverUrl, refreshPairing]);

  const runTest = useCallback(async () => {
    const { serverUrl: url, adminToken: token } = trimmed();
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
    const candidate: SyncConfig = { serverUrl: url, ...(token ? { authToken: token } : {}) };
    const result = await testConnection(candidate);
    setTest(result.ok ? { kind: "ok" } : { kind: "error", message: result.error });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverUrl, adminToken, testConnection]);

  const onSave = useCallback(async () => {
    const { serverUrl: url, adminToken: token } = trimmed();
    if (!validUrl(url)) {
      setTest({ kind: "error", message: "That doesn't look like a valid URL." });
      return;
    }
    setSaving(true);
    try {
      if (token) {
        const paired = await pairDevice({ serverUrl: url, adminToken: token });
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
        if (status.device.vaults !== "*") {
          setTest({
            kind: "error",
            message: "This browser is paired for some vaults only. Enter the admin token to sync every vault.",
          });
          return;
        }
      }
      save({ serverUrl: url });
      setDialogOpen(false);
    } finally {
      setSaving(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverUrl, adminToken, save, setDialogOpen]);

  const onDisconnect = useCallback(() => {
    disconnect();
    setDialogOpen(false);
  }, [disconnect, setDialogOpen]);

  const paired = pairing?.paired ? pairing : null;

  return (
    <>
      <DialogHeader>
        <DialogTitle>Sync</DialogTitle>
        <DialogDescription>
          Connect this browser to a Methyl server. Every vault on this browser syncs in the
          background, and server vaults appear here automatically.
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
            {paired ? "Admin token (to enable all vaults or remove other devices)" : "Admin token"}
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
            Used once to pair this browser for every vault, then forgotten. The server keeps this
            browser signed in with a cookie that scripts on the page can&apos;t read.
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
