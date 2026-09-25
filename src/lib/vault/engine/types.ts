/** Result types of the vault engine's operations. */

/** Result of one `ingestExternalChanges()` pass, grouped by what happened. */
export interface IngestReport {
  /** Known paths whose content changed externally — merged into the CRDT. */
  edited: string[];
  /** Content moved/renamed to a new path — tree updated, id preserved. */
  moved: string[];
  /** Content duplicated onto a new path while the original still exists. */
  copied: string[];
  /** Genuinely new external files, adopted as new documents. */
  created: string[];
  /** Indexed paths that disappeared and weren't claimed by a move. */
  deleted: string[];
  /** Binary files adopted from the user-visible Attachments/ folder. */
  assetsCreated?: string[];
  /** Tracked binary files whose bytes changed outside the app. */
  assetsUpdated?: string[];
  /** Ordinary folders created outside the app and adopted into the tree. */
  foldersCreated?: string[];
}

export interface AssetIngestReport {
  created: string[];
  updated: string[];
}

/**
 * Recovery result from VaultEngine.open().
 * Structured so the caller can surface repair status to the UI (§42).
 */
export interface VaultRecoveryReport {
  activeIds: string[];
  persistedIds: string[];
  missingDocs: string[];
  orphanedDocs: string[];
  /**
   * Documents whose LoroText still carried a legacy `<!-- adhd:id=... -->`
   * comment (pre-sidecar-index vaults) and were migrated in place on this
   * open — the comment was deleted as a normal CRDT edit. These no longer
   * match their on-disk `.md` hash, so callers should re-materialise them
   * (e.g. via repairDocument) to write the now-clean file.
   */
  migratedLegacyIds: string[];
}
