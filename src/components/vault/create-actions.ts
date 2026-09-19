import type { NoteCreationOptions } from "@/lib/plugins/api";
import type { TreeID } from "loro-crdt";

export type CreateRequest =
  | { kind: "note"; parentTreeId?: TreeID; options?: NoteCreationOptions }
  | { kind: "template"; parentTreeId?: TreeID }
  | { kind: "graph"; parentTreeId?: TreeID }
  | { kind: "folder"; parentTreeId?: TreeID; name: string };

export type CreateHandler = (request: CreateRequest) => string | void | Promise<string | void>;
