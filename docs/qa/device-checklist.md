# Device QA checklist

Run this on real devices before each minor release (spec item 16). Chromium
emulation in the e2e suite doesn't cover Safari's storage rules, the software
keyboard, touch gestures or what iOS does to a backgrounded app.

**Devices each time:**

- a current iPhone: Safari, and the installed PWA (Add to Home Screen);
- a current Android phone: Chrome, and the installed PWA.

**Setup:** a Methyl server behind HTTPS (the app needs a secure context) with
a vault of a few dozen notes, some folders and one attachment. Pair each
device in Sync settings.

Record every run in [Results](#results) below. File each failure as its own
entry in `TODO.md` with the device, OS and browser version, and link it from
the results row.

## Checklist

### Install and start

1. Install the app from the browser (iOS: Share → Add to Home Screen; Android:
   Install app). It opens standalone, with no browser UI.
2. Close it fully and reopen it with a vault already loaded. Note the time to
   an editable note. On iPhone, also take the `methyl:engine-ready` mark from
   Safari's Web Inspector (Develop menu on a Mac, then Timelines or the
   console: `performance.getEntriesByName("methyl:engine-ready")`). This is
   the real-device figure spec item 20 asks for.
3. The status popover shows the app version and "Works offline".

### Offline

4. Stop the server (or turn on airplane mode). Reopen the app: it starts and
   the notes are there.
5. Edit a note and create one. Both save locally; the sync row says the
   changes are waiting, never "Synced" (SPEC §15).
6. *Export full backup* (command menu) downloads a zip that opens on another
   machine. (SPEC §41's "Export unsynced backup" isn't built; this covers it.)
7. Start the server again, then bring the app to the foreground: it syncs
   without a reload, and the other device sees the edits.

### iOS storage and background limits (SPEC §15, §41)

8. The status popover's *Notes protected* row. Installed PWA on iOS: note
   whether storage is persistent.
9. With unsynced changes, background the app for 10 minutes, then return: the
   changes are still there and sync when the server is reachable.
10. Background the app while a sync is running (a large first sync is easiest).
    On return it resumes and finishes; nothing is duplicated or lost.
11. Leave the installed PWA unused for a week, then open it: the vault is
    still there. Record if iOS evicted anything.

### Editing

12. Open a long note and put the cursor near the bottom. The software keyboard
    doesn't cover the line being typed; the toolbar stays reachable.
13. Paste text from another app; select a word and paste a URL over it.
14. Undo and redo with the keyboard's controls (or shake to undo on iOS).

### Layout and gestures

15. Rotate the phone. Nothing sits under the notch, the Dynamic Island or the
    home indicator (safe-area insets), in portrait or landscape.
16. Edge-swipe from the left opens the sidebar; swiping it back closes it,
    without triggering the browser's own back gesture in the installed PWA.
17. Press and hold a note in the sidebar, then drag it into a folder. A tap
    still opens the note, and a quick swipe still scrolls the list.
18. The vault switcher, the command menu and each dialog open and close with
    touch, and focus returns to what opened them.

### Sync and vaults

19. Rename a note on another device: it's renamed here within a few seconds
    while the app is open.
20. Switch to a second vault and back; each keeps its own notes and sync.

### Screen reader

21. VoiceOver on iOS (and on macOS Safari): move through the sidebar tree,
    open a note, and use the command menu. Folders announce expanded or
    collapsed, and each dialog announces its title.
22. TalkBack on Android: the same three tasks.

## Results

| Date | Build (version) | Device | OS | Browser / mode | Result | Failures (TODO.md) | Startup (`engine-ready`) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| | | | | | | | |
