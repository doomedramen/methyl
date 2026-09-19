"use client";

import { useEffect, useState } from "react";
import { Download, File, LoaderCircle, Paperclip } from "lucide-react";
import type { TreeID } from "loro-crdt";
import type { VaultEngine } from "@/lib/vault/engine";
import { attachmentMimeType, isImageAttachment, isPlayableAttachment } from "@/lib/vault/attachments";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from "@/components/ui/empty";

export function AssetViewer({
  engine,
  treeId,
  title,
}: {
  engine: VaultEngine;
  treeId: TreeID;
  title: string;
}) {
  const [loaded, setLoaded] = useState<{
    key: string;
    url: string | null;
    error: string | null;
  } | null>(null);
  const node = engine.tree.getNode(treeId);
  const mime = attachmentMimeType(title);
  const assetKey = `${String(treeId)}:${title}`;

  useEffect(() => {
    let cancelled = false;
    void engine.readAttachment(treeId).then((bytes) => {
      if (cancelled) return;
      if (!bytes) {
        setLoaded({
          key: assetKey,
          url: null,
          error: "The attachment bytes are not available on this device.",
        });
        return;
      }
      setLoaded({
        key: assetKey,
        url: URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer], { type: mime })),
        error: null,
      });
    }).catch((reason: unknown) => {
      if (!cancelled) setLoaded({ key: assetKey, url: null, error: String(reason) });
    });
    return () => {
      cancelled = true;
    };
  }, [assetKey, engine, mime, treeId]);

  useEffect(() => () => {
    if (loaded?.url) URL.revokeObjectURL(loaded.url);
  }, [loaded?.url]);

  const url = loaded?.key === assetKey ? loaded.url : null;
  const error = loaded?.key === assetKey ? loaded.error : null;

  const download = () => {
    if (!url) return;
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = title;
    anchor.click();
  };

  if (!node || node.kind !== "binary") {
    return <MissingAsset title={title} message="This attachment is no longer in the vault tree." />;
  }
  if (error) return <MissingAsset title={title} message={error} />;
  if (!url) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <LoaderCircle className="size-5 animate-spin" aria-label="Loading attachment" />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-muted/10">
      <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2 text-sm">
        <Paperclip className="size-4 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">{title}</span>
        <Button variant="outline" size="sm" onClick={download}>
          <Download data-icon="inline-start" />
          Download
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {isImageAttachment(title) ? (
          <img src={url} alt={title} className="mx-auto max-h-full max-w-full rounded-lg object-contain" />
        ) : isPlayableAttachment(title) ? (
          mime.startsWith("video/") ? (
            <video src={url} controls className="mx-auto max-h-full max-w-full rounded-lg" />
          ) : (
            <audio src={url} controls className="mx-auto mt-12 w-full max-w-xl" />
          )
        ) : mime === "application/pdf" ? (
          <iframe title={title} src={url} className="h-full min-h-[40rem] w-full rounded-lg border" />
        ) : (
          <Empty className="h-full border-0">
            <EmptyMedia variant="icon"><File /></EmptyMedia>
            <EmptyTitle>{title}</EmptyTitle>
            <EmptyDescription>This file type can be downloaded from the attachment viewer.</EmptyDescription>
          </Empty>
        )}
      </div>
    </div>
  );
}

function MissingAsset({ title, message }: { title: string; message: string }) {
  return (
    <Empty className="h-full border-0">
      <EmptyMedia variant="icon"><Paperclip /></EmptyMedia>
      <EmptyTitle>{title}</EmptyTitle>
      <EmptyDescription>{message}</EmptyDescription>
    </Empty>
  );
}
