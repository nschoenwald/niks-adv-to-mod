# Changelog

All notable changes to Nik's Adventure to Module are documented in this file.

## [14.1.0] - 2026-11-07
### Added
- **Packing in world documents**: Actors, journals, playlists and other documents of your world that the adventure links to, but that you didn't put into the adventure, are packed in automatically. This includes token actors and scene journals and playlists. Their links keep working for other GMs. You can turn this off in the Dependencies & Links tab.
- **Cancel export**: A running export can be cancelled. The window is locked while it runs.
- **Large exports in Firefox and Safari**: These browsers keep the whole ZIP in memory. Exports over 1 GB now ask first.
- **Packing in compendium content**: The Dependencies & Links tab lists the compendiums the adventure links to. Tick one to pack its linked entries into the adventure: they are imported with it, links point to the imported copies, and the module behind the compendium is no longer needed for them. Entries those entries link to are packed in too, however many levels deep. Links into compendiums of your world are packed in by default, so they no longer break for other GMs. Game system content such as the SRD is never packed in.
- **Packing in files from other modules**: When you copy all files the adventure uses from a module, that module is no longer listed as a dependency, and the Dependencies tab says so. Untick a file and it becomes required again. Modules the adventure also needs for compendium links or module data stay listed, and dependencies you set by hand are kept.

### Fixed
- **Inactive modules**: Dependencies that are installed but not active in this world are now marked too. Before, only modules that weren't installed at all were marked.

## [14.0.0] - 2026-11-07
### Added
- **Export as Module**: Right-click an adventure in a compendium, or open the menu of the adventure window, to export it as a stand-alone module ZIP that other GMs can install.
- **Files are packed in**: Maps, tokens (wildcards included), portraits, handouts, sounds and pictures in journals are copied into the module, and the adventure is updated to use the copies.
- **File report**: See every file the adventure uses, where it is stored, how big it is and which documents use it. Choose what to copy. Files from other modules are left out by default and their modules become dependencies.
- **Dependencies & broken links**: Choose which modules the new module requires or recommends, and see links to documents that are not part of the adventure before you share it.
- **Large adventures**: The export window opens right away and shows its progress while the adventure loads and its files are checked. In Chrome, Edge and the Foundry app the ZIP is written straight to disk while it is built.
