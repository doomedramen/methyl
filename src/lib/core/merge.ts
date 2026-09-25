import { LoroDoc, type OpId } from "loro-crdt";
import type { MaterializationCheckpoint } from "@/lib/core/types";

/**
 * Handle an external filesystem edit using three-way merge (§24).
 *
 * @param loroDoc     The current LoroDoc
 * @param lastCheckpt Checkpoint from last materialization
 * @param externalMd  The external Markdown content (from disk)
 * @returns merged result (imports external branch into loroDoc)
 */
export function mergeExternalEdit(
  loroDoc: LoroDoc,
  lastCheckpt: MaterializationCheckpoint,
  externalMd: string,
): { text: string; frontiers: OpId[] } {
  const baseVersion = lastCheckpt.frontiers;
  const currentVersion = loroDoc.oplogFrontiers();

  const currentIsBehind =
    baseVersion.length === currentVersion.length &&
    baseVersion.every(
      (b, i) =>
        currentVersion[i]!.peer === b.peer &&
        currentVersion[i]!.counter === b.counter,
    );

  if (currentIsBehind) {
    loroDoc.getText("content").splice(
      0,
      loroDoc.getText("content").length,
      externalMd,
    );
    loroDoc.commit();
    return { text: externalMd, frontiers: loroDoc.oplogFrontiers() };
  }

  const externalBranch = loroDoc.forkAt(baseVersion);
  const externalText = externalBranch.getText("content");
  externalText.splice(0, externalText.length, externalMd);
  externalBranch.commit();

  const externalOps = externalBranch.export({
    mode: "update",
    from: loroDoc.oplogVersion(),
  });
  loroDoc.import(externalOps);
  loroDoc.commit();

  return {
    text: loroDoc.getText("content").toString(),
    frontiers: loroDoc.oplogFrontiers(),
  };
}