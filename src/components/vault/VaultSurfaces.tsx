import { FileWarning, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { COLLECTIONS, type LibraryCollection } from "./LibraryView";

/** Placeholder surfaces: loading, error, unavailable and disabled states. */
export function VaultLoading() {
  return (
    <div className="space-y-3 p-4">
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-11 w-full" />
      ))}
    </div>
  );
}

export function GraphLoading() {
  return (
    <div className="space-y-3 p-4">
      <Skeleton className="h-8 w-40" />
      <Skeleton className="h-[60vh] w-full" />
    </div>
  );
}

export function DisabledCollectionSurface({ collection }: { collection: LibraryCollection }) {
  return (
    <Empty>
      <EmptyMedia variant="icon">
        <FileWarning />
      </EmptyMedia>
      <EmptyTitle>{COLLECTIONS[collection].title} is disabled</EmptyTitle>
      <EmptyDescription>Select a note from the file and folder list in the sidebar.</EmptyDescription>
    </Empty>
  );
}

export function UnavailableSurface({
  kind,
  actionLabel,
  onAllNotes,
}: {
  kind: "note" | "attachment";
  actionLabel?: string;
  onAllNotes?: () => void;
}) {
  return (
    <Empty>
      <EmptyMedia variant="icon">
        <FileWarning />
      </EmptyMedia>
      <EmptyTitle>{kind === "note" ? "This note is unavailable" : "This attachment is unavailable"}</EmptyTitle>
      {actionLabel && onAllNotes ? (
        <Button variant="outline" size="lg" onClick={onAllNotes}>
          {actionLabel}
        </Button>
      ) : null}
    </Empty>
  );
}

export function VaultError({ message }: { message: string }) {
  return (
    <Empty>
      <EmptyMedia variant="icon">
        <TriangleAlert className="text-destructive" />
      </EmptyMedia>
      <EmptyTitle>Could not open the vault</EmptyTitle>
      <EmptyDescription className="break-words">{message}</EmptyDescription>
      <Button
        variant="outline"
        size="lg"
        onClick={() => typeof window !== "undefined" && window.location.reload()}
      >
        Reload
      </Button>
    </Empty>
  );
}
