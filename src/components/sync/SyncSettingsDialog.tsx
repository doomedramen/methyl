"use client";

import { useCallback, useEffect, useState } from "react";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { useSync } from "@/lib/browser/sync-context";
import type { SyncConfig } from "@/lib/browser/sync-config";
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
 * Sync connection settings: server URL + access token, reachable from the
 * sidebar footer status popover and the ⌘K command menu (both just flip
 * `dialogOpen` via useSync()).
 */
export function SyncSettingsDialog() {
  const { config, dialogOpen, setDialogOpen, save, disconnect, testConnection } = useSync();
  const [serverUrl, setServerUrl] = useState("");
  const [authToken, setAuthToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [test, setTest] = useState<TestResult>({ kind: "idle" });

  useEffect(() => {
    if (!dialogOpen) return;
    setTest({ kind: "idle" });
    if (config) {
      setServerUrl(config.serverUrl);
      setAuthToken(config.authToken);
      return;
    }
    // The app is almost always served by the server it syncs with, so
    // start from the current origin and let the user edit it. "Test
    // connection" is what proves it, not a probe before showing the field.
    setServerUrl(typeof window === "undefined" ? "" : window.location.origin);
    setAuthToken("");
  }, [dialogOpen, config]);

  const runTest = useCallback(async () => {
    if (!serverUrl.trim() || !authToken.trim()) {
      setTest({ kind: "error", message: "Enter a server URL and an access token first." });
      return;
    }
    setTest({ kind: "testing" });
    const candidate: SyncConfig = { serverUrl: serverUrl.trim(), authToken: authToken.trim() };
    try {
      new URL(candidate.serverUrl);
    } catch {
      setTest({ kind: "error", message: "That doesn't look like a valid URL." });
      return;
    }
    const result = await testConnection(candidate);
    setTest(result.ok ? { kind: "ok" } : { kind: "error", message: result.error });
  }, [serverUrl, authToken, testConnection]);

  const onSave = useCallback(() => {
    const trimmedUrl = serverUrl.trim();
    const trimmedToken = authToken.trim();
    if (!trimmedUrl || !trimmedToken) return;
    save({ serverUrl: trimmedUrl, authToken: trimmedToken });
    setDialogOpen(false);
  }, [serverUrl, authToken, save, setDialogOpen]);

  const onDisconnect = useCallback(() => {
    disconnect();
    setDialogOpen(false);
  }, [disconnect, setDialogOpen]);

  return (
    <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Sync</DialogTitle>
          <DialogDescription>
            The browser keeps its own local vault. Connect this device to a Methyl server so notes
            — including files copied into the server&apos;s mounted vault — sync here. The server
            address and access token are saved in this browser only.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <Field>
            <FieldLabel htmlFor="sync-server-url">Server URL</FieldLabel>
            <Input
              id="sync-server-url"
              placeholder="https://adhd.example.com"
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="sync-access-token">Access token</FieldLabel>
            <div className="relative">
              <Input
                id="sync-access-token"
                type={showToken ? "text" : "password"}
                placeholder="Paste the token from your server"
                value={authToken}
                onChange={(e) => setAuthToken(e.target.value)}
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
              Stored in this browser&apos;s local storage, not in a cookie — anyone with access to
              this browser profile could read it.
            </FieldDescription>
          </Field>

          {test.kind === "error" && <FieldError>{test.message}</FieldError>}
          {test.kind === "ok" && (
            <p className="text-sm text-primary" role="status">
              Connected — the server is reachable and the token works.
            </p>
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
            <Button type="button" onClick={onSave} disabled={!serverUrl.trim() || !authToken.trim()}>
              Save
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
