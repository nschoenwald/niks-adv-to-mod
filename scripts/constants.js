export const MODULE_ID = "niks-adv-to-mod";

export const SETTINGS = {
  author: "author",
  url: "url"
};

/**
 * Asset kinds, in the order the report lists them.
 * `copy`: copied into the module by default. `copyable`: the GM can choose to copy it.
 */
export const ASSET_KINDS = {
  world: { copy: true, copyable: true, icon: "fa-solid fa-globe" },
  data: { copy: true, copyable: true, icon: "fa-solid fa-folder" },
  storage: { copy: true, copyable: true, icon: "fa-solid fa-cloud" },
  module: { copy: false, copyable: true, icon: "fa-solid fa-cube" },
  external: { copy: false, copyable: true, icon: "fa-solid fa-link" },
  core: { copy: false, copyable: false, icon: "fa-solid fa-dice-d20" },
  system: { copy: false, copyable: false, icon: "fa-solid fa-book" }
};

/** Top-level folders served by Foundry itself (public/), never from the user data folder. */
export const CORE_DIRS = new Set([
  "canvas", "cards", "css", "docs", "fonts", "icons", "lang", "nue", "scripts", "sounds", "toolclips", "tours", "ui"
]);

/** Keys whose values only record where a document came from. Not followed as references or assets. */
export const PROVENANCE_KEYS = new Set(["_stats", "compendiumSource", "duplicateSource", "exportSource"]);

/** Keys never treated as file paths. */
export const SKIP_KEYS = new Set(["_id", "name", "_key", "sort"]);

/** Primary document types that can be linked by `Type.id`. */
export const LINK_TYPES = [
  "Actor", "Adventure", "Cards", "Folder", "Item", "JournalEntry", "Macro", "Playlist", "RollTable", "Scene"
];

/** Parallel requests when checking or downloading assets. */
export const CONCURRENCY = 6;
