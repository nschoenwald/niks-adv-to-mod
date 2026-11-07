# Nik's Adventure to Module

Turn an adventure into a stand-alone module that you can share with other GMs or publish online. The module comes as
a ZIP with the adventure and every file it uses: maps, tokens, portraits, handouts, sounds. Paths in the adventure are
updated to point into the new module, so it works on any Foundry server.

- Foundry VTT 14
- System-agnostic: works with any game system that supports adventures.

## How to use it

1. Put your content into an **Adventure** in a compendium. Foundry has a built-in tool for this: create a compendium of
   type *Adventure*, create an entry in it, and drag scenes, actors, journals, items, tables, macros, playlists and
   cards into the adventure window.
2. Right-click the adventure in the compendium and choose **Export as Module**. You can also use **Export as Module**
   in the menu of the adventure window.
3. Fill in the module details: ID, title, version, author and description.
4. Check the **Files** and **Dependencies & Links** tabs (see below).
5. Click **Export ZIP** and choose where to save it.

Only GMs can export. The window opens right away; the adventure is loaded, scanned and its files are checked while
you fill in the details, with the progress shown at the top.

## What goes into the ZIP

```
<module-id>/
  module.json        The module manifest: title, version, system, dependencies, compendium
  README.md          Installation steps for the GMs you share it with
  packs/adventure.db The adventure
  assets/…           The copied files
```

The compendium has the module's title. GMs who install the module import the adventure from it like from any other
adventure module. The compendium file is converted to Foundry's database format the first time the module is used.

The new module requires the game system you exported it with, at least in the version the adventure was saved
with, and at least the Foundry version the adventure was saved with.

## Files

The adventure is searched for every file it uses: images, tokens and token wildcards, scene backgrounds and levels,
tiles, sounds and playlists, journal pages (images, video, PDF), pictures in journal text, files in module data
and macros. The **Files** tab lists them by where they are stored:

| Where | Default |
|---|---|
| World files, other files in your user data folder | Copied |
| Your S3 or Forge storage | Copied, if the storage allows the download |
| Other modules | **Not copied.** The module becomes a dependency. Tick them to pack them in. |
| Other websites | Kept as links |
| Foundry itself (`icons/`, `sounds/`…), the game system | Kept (every server has them) |

You can change this for each file or with **Copy all** / **Copy none** per group. Hover over the use count to see
which documents use a file. Files that can't be found keep their path and are marked. Token wildcards (for example
`tokens/goblins/*.webp`) copy every matching file.

Copied files keep their names. World files go to `assets/` without the `worlds/<world>/` prefix, other files keep
their folder structure under `assets/`, files from the web go to `assets/remote/<website>/`. If you export an
adventure of a module again with the same module ID, files already in that module keep their paths.

**Only share what you are allowed to share.** Maps, tokens and art from other modules or purchased packs usually may
not be redistributed. Leave them out and keep the module as a dependency.

## Dependencies & Links

**Module dependencies**: modules the adventure takes files or compendium links from are listed as *Required*.
Modules that only stored data on its documents (for example tile triggers or effects) are listed as *Recommended*.
Change each to Required, Recommended or Not listed. A warning icon marks modules that are not installed or not active
in this world: activate them, so their compendium links can be checked and packed in.

If you copy all files the adventure uses from a module, and it needs nothing else from that module, the module
switches to *Not listed* and its row says that all files are copied. Unticking one of its files makes it required
again. A choice you made by hand is kept.

**Linked content**: documents and compendiums the adventure links to, with the number of linked entries.

*Documents of this world* are the world's actors, journals, playlists and so on that the adventure links to but
doesn't contain: links in text, token actors, scene journals and playlists, map notes. They are packed in by default,
into folders named "Linked documents", so these links keep working for other GMs. Untick the row to leave them out.

Tick a compendium to pack its linked entries into the adventure. They are imported together with the adventure, into a folder named
after the compendium, and the links are changed to point to the imported copies. The compendium, and the module it
comes from, is then no longer needed for those links. Entries that packed-in entries link to in ticked compendiums are
packed in too, however many levels deep the links go; each entry is added only once, so links that loop back are no
problem. Links into compendiums you didn't tick stay as they are; those compendiums are listed too, so you can tick
them as well. Packing in stops at 5000 entries.

Compendiums of your world are ticked by default, because other GMs don't have them. Module compendiums are not: only
pack in content you are allowed to share. Compendiums of the game system, such as the SRD, are never packed in: every
GM who uses the module has the system, so those links keep working.

**Links that will break**: links, tokens and notes that point to

- world documents that are not part of the adventure,
- compendiums of your world, which other GMs don't have,
- the compendium the adventure is stored in,
- compendiums that aren't available.

With *Documents of this world* ticked, world documents are packed in automatically, so this list only shows the
ones that no longer exist. Links between documents of
the adventure keep working: Foundry keeps document IDs when it imports an adventure.

## Saving the ZIP

In Chrome, Edge and the Foundry desktop app you choose the file first, and the ZIP is written while it is built, so
large adventures don't fill up memory. Other browsers (Firefox, Safari) keep the whole ZIP in memory and download it
when it is done; for exports over 1 GB you are asked first.

While the export runs, the window is locked and **Cancel export** stops it.

After the export, a summary lists files that could not be downloaded. Their paths stay unchanged in the adventure.

## Installing the module

Extract the ZIP into the `modules` folder of the Foundry user data folder, so that you get
`Data/modules/<module-id>/module.json`. On a hosting service, use its upload feature for modules. Then enable the
module in a world and import the adventure from its compendium.

To publish the module, put the folder in a repository and add `manifest` and `download` URLs to its `module.json`.

## For Module Developers

The API is at `game.modules.get("niks-adv-to-mod").api` and `globalThis.NiksAdventureToModule`:

- `open(adventure)`: open the export window for an Adventure document, its UUID, or `{pack, id}`.
- `AdventureScan`: `await AdventureScan.load(pack, id)` loads the raw adventure data. `new AdventureScan(source, {pack})`
  and `await scan.collect()` find files (`entries`), broken links (`issues`) and dependencies (`dependencies`).
  `await scan.check()` checks which files exist and expands wildcards.
- `packInLinks(source, packs, {world})`: add the entries the adventure links to in the given compendiums (a Set of
  collection ids), and with `world: true` the linked world documents, to a copy of the source and change the links.
  Returns `{source, stats, depth, limited}`.
- `planAssets(scan, moduleId)`: which files are copied where, and the path map.
- `exportModule(scan, options, sink, onProgress, {signal})`: write the ZIP. An `AbortSignal` cancels it. `options`: `{id, title, version, author, url,
  description, dependencies: [{id, level}]}` with `level` `requires`, `recommends` or `none`.
- `openSink(filename)`: a save target for `exportModule` (asks where to save; call it from a click handler).

## License

MIT
