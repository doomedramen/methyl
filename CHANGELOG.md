# Changelog

All notable changes to Methyl. Versions follow [semantic versioning](https://semver.org/);
the Docker image's `latest` tag is the newest release, and `edge` follows `main`.

## [0.1.0] - unreleased

The first tagged release.

### Added

- **Several vaults.** The browser holds separate vaults, switched from the sidebar, each with
  its own sync settings. The server serves every sub-folder of `METHYL_VAULTS_PATH` as a
  vault (`/api/v/<vault>/…`, socket `/sync/<vault>`); a single `METHYL_VAULT_PATH` is served
  as `default`.
- **Device pairing.** Browsers pair once with the admin token (`METHYL_AUTH_TOKEN`) and are
  then signed in by an HttpOnly cookie; sync sockets use one-minute tickets. Paired devices
  are listed and can be removed in Sync settings, and are allowed only the vaults they were
  paired for.
- **Live sync.** An in-house room server pushes changes into open rooms, and a change stream
  (`/api/events`) tells idle clients to sync at once; polling is a 30-second fallback.
- **Export and backup.** Export the vault as Markdown, or a full backup with metadata, from
  the command menu. The server has `backup` and `restore` commands (`--vault` for a vaults
  folder), with the sync database copied consistently while running.
- **Version shown** in the status popover, the diagnostics summary and `/healthz`, with a
  warning when the app and the server are from different releases.

### Changed

- Renamed from "adhd" to Methyl throughout: the `.methyl` metadata folder (a `.adhd` folder
  is migrated), storage keys, cache names and environment variables.
- Much faster start with a warm cache: documents load lazily and derived indexes are
  computed on demand (about 1 s to ready for 400 notes on a throttled CPU, from about 18 s).
- `latest` now follows releases instead of `main`.

### Fixed

- External edits and client edits no longer overwrite each other: three-way merges use the
  right base, and a client's save no longer clobbers an unsynced disk edit.
- A sync round no longer leaves a room before the server has stored its changes, and a
  change during a round starts another round instead of being dropped.
- Browser storage compaction no longer races a write and loses edits.
- Read-only tabs, and tabs whose writer lock was taken over, can no longer write.
- Deletes are no longer recursive by default, and the vault root and its metadata can't be
  deleted.

### Security

- Constant-time token comparison, failed-login limiting with lockouts, and validation of room
  and asset IDs.
- No sync secret in `localStorage`: an admin token saved by an older version is exchanged for
  pairing and deleted.

[0.1.0]: https://github.com/doomedramen/methyl/releases/tag/v0.1.0
