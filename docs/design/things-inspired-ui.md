# Methyl: a quieter place to think

## Research, 19 September 2026

The reference is Cultured Code's approach to personal software. Methyl remains a Markdown notebook with folders, linked notes, graphs, and offline storage.

Primary sources reviewed:

- [Things features](https://culturedcode.com/things/features/): progressive disclosure, heading groups, Quick Find, Magic Plus, and Slim Mode. The embedded item-expansion movie shows a compact row becoming a writing surface; optional actions live along its lower edge. The Magic Plus movie shows insertion happening at the point of intent and neighboring content making space. Desktop and phone screenshots separate information with whitespace and weight.
- [Things blog: OS 26 design](https://culturedcode.com/things/blog/): more relaxed spacing, adjusted curves, lightly translucent navigation, and press feedback. [Mac screenshot](https://culturedcode.com/frozen/2025/09/things-os26-screenshot-macos-io75.jpg) and [iPhone screenshot](https://culturedcode.com/frozen/2025/09/things-os26-screenshot-ios-io75.jpg).
- [Quick Find](https://culturedcode.com/things/support/articles/2803584/): navigation and retrieval share one fast entry point. Methyl keeps its full-text search and quick switcher shortcuts, avoiding type-to-search while someone is writing.
- [Quick Entry](https://culturedcode.com/things/support/articles/2249437/): capture requires little context switching. Provide a direct new-note action in a collection, alongside the existing menu for other document types.
- [Show and hide the sidebar](https://culturedcode.com/things/support/articles/3238254/): collapsing navigation preserves the current work and leaves an obvious way back.
- [Mac keyboard shortcuts](https://culturedcode.com/things/support/articles/2785159/): pointer convenience coexists with keyboard access.

## Design plan

Palette: paper #ffffff, navigation #f3f4f6, ink #292d34, secondary ink #6b7079, selection #e0eafb, action blue #2869d8. Blue identifies actions and current location. Amber, blue, and purple distinguish the note library, Inbox, and graphs. Existing optional themes remain supported.

Typography: platform system font, 14px navigation, 16px writing, 30px collection titles. Weight and space establish hierarchy. Labels use sentence case.

Layout: a quiet 256px sidebar beside a continuous paper canvas. The collection has a left-aligned title and description, then recent notes and folder groups. Notes use the available pane width up to 1100px, with 24–48px gutters shared by the title and editor. This wider canvas reflects review feedback; collection lists keep their narrower reading width. Tabs remain available for parallel work, with less visual weight than the document. Mobile uses a drawer, 44px primary controls, and narrower page gutters.

    Methyl              |    All notes
    Search              |    A little space for everything on your mind.
                        |
    All notes        12 |    Recently opened
    Inbox             2 |    note title                         folder
    Graphs            1 |
                        |    Notes / folder headings
    Your notes          |    note title
      folder            |    note title
        note            |
                        |    + New note
    Storage status      |

This is an application, so no hero, decorative dashboard cards, fake metrics, or sample tasks are needed. Real notes supply the content. Counts represent actual data; Inbox maps to direct children of the existing capture folder, case-insensitively. Opening a collection preserves open documents.

## Interaction and motion

Respond on press with restrained scale/color feedback. Menus originate at their triggers. Collection navigation uses a short, small reveal; typing never animates or remounts the editor. Folder chevrons turn in place. Existing pointer-tracked drag and drop remains authoritative. Reduced motion disables translation/scale and keeps static feedback. These are web adaptations, not claims to reproduce Cultured Code's proprietary animation engine.

Document titles expose renaming where users look for the name. Creation belongs beside the collection content and routes into Inbox when appropriate. Recent notes use existing workspace history, not invented timestamps.

## Review criteria

Verify blank and populated libraries, direct creation, Inbox routing, search, note renaming, keyboard focus, tabs/splits, light/dark appearance, and narrow mobile layouts. Preserve the existing vault, synchronization, attachments, and Markdown behavior.
