import { PROVENANCE_KEYS } from "./constants.js";

/**
 * Packing linked compendium entries into the adventure.
 *
 * Entries the adventure links to in the chosen compendiums are added to the adventure as documents of their own, and
 * the links are changed from `Compendium.<pack>.<Type>.<id>` to `<Type>.<id>`. Adventure imports keep document ids
 * (`Adventure#importContent` uses `keepId: true`), so the changed links point to the imported copies.
 *
 * Documents of this world that the adventure links to but doesn't contain can be added too. Their links need no
 * change: world documents keep their ids.
 *
 * Links are followed all the way down: entries that added entries link to in the chosen compendiums are added too,
 * round after round, until no new ones turn up. Every entry is added once, so loops end. Links into compendiums that
 * were not chosen stay as they are; the scan of the result lists those compendiums, so the GM can choose them too.
 */

/** Safety limit for entries added in total, against links that pull in a whole compendium chain by chain. */
export const MAX_ENTRIES = 5000;

/** Entries loaded per request. */
const BATCH = 100;

/** `Compendium.<package>.<pack>.<Type>.<id>` or the old form without the type. */
const COMPENDIUM_UUID = /Compendium\.([\w-]+)\.([\w-]+)\.(?:([A-Z]\w*)\.)?([a-zA-Z0-9]{16})(?![a-zA-Z0-9])/g;

/** Old enricher syntax `@Compendium[<package>.<pack>.<id>]`. */
const LEGACY_LINK = /@Compendium\[([\w-]+)\.([\w-]+)\.([a-zA-Z0-9]{16})\]/g;

/** Key for world documents in the maps of linked ids. Their ids are stored as `<Type>.<id>`. */
export const WORLD = "@world";

/** Data options as core's adventure exporter uses them: keep ids, folders and flags; clear ownership and state. */
const DATA_OPTIONS = {
  clearSort: false, clearFolder: false, clearFlags: false, clearSource: false, clearOwnership: true, clearState: true,
  keepId: true
};

let worldPatterns;

/**
 * Patterns for links to world documents: `<Type>.<id>` not preceded by a dot (that would be a compendium or embedded
 * link), and the old `@<Type>[<id>]` syntax.
 * @returns {{uuid: RegExp, legacy: RegExp}}
 */
function getWorldPatterns() {
  if ( worldPatterns ) return worldPatterns;
  const types = contentTypes().join("|");
  worldPatterns = {
    uuid: new RegExp(`(?<![\\w.])(${types})\\.([a-zA-Z0-9]{16})(?![a-zA-Z0-9])`, "g"),
    legacy: new RegExp(`@(${types})\\[([a-zA-Z0-9]{16})\\]`, "g")
  };
  return worldPatterns;
}

/**
 * Document types an adventure can hold, except folders.
 * @returns {string[]}
 */
function contentTypes() {
  return Object.values(CONFIG.Adventure.documentClass.contentFields).map(cls => cls.documentName)
    .filter(t => t !== "Folder");
}

/* -------------------------------------------- */

/**
 * Can entries of this compendium be packed in? Only document types an Adventure can hold, and never compendiums of the
 * game system (SRD content): every GM using the module has the system, so those links keep working, and SRD content
 * is not redistributed.
 * @param {CompendiumCollection} pack
 * @returns {boolean}
 */
export function canPackIn(pack) {
  if ( !pack || (pack.metadata?.packageType === "system") ) return false;
  return contentTypes().includes(pack.documentName);
}

/* -------------------------------------------- */

/**
 * Apply a function to every string in a value, except under provenance keys (`_stats`, `compendiumSource`…).
 * Returns a new value; the input is not changed.
 * @param {any} value
 * @param {function(string): string} fn
 * @returns {any}
 */
function mapStrings(value, fn) {
  if ( typeof value === "string" ) return fn(value);
  if ( Array.isArray(value) ) return value.map(v => mapStrings(v, fn));
  if ( value && (typeof value === "object") ) {
    const out = {};
    for ( const [k, v] of Object.entries(value) ) out[k] = PROVENANCE_KEYS.has(k) ? v : mapStrings(v, fn);
    return out;
  }
  return value;
}

/**
 * Collect the entries a value links to, in the chosen compendiums and (optionally) in the world.
 * @param {any} value
 * @param {Set<string>} selected  Compendium collection ids
 * @param {boolean} world         Also collect links to world documents, under the key WORLD
 * @param {Map<string, Set<string>>} [found]
 * @returns {Map<string, Set<string>>}  Ids by compendium; `<Type>.<id>` under WORLD
 */
function collectLinks(value, selected, world, found = new Map()) {
  const add = (collection, id) => {
    if ( !found.has(collection) ) found.set(collection, new Set());
    found.get(collection).add(id);
  };
  const patterns = world ? getWorldPatterns() : null;
  mapStrings(value, str => {
    if ( str.length < 20 ) return str;
    if ( str.includes("Compendium") ) {
      for ( const [, pkg, pack, , id] of str.matchAll(COMPENDIUM_UUID) ) {
        if ( selected.has(`${pkg}.${pack}`) ) add(`${pkg}.${pack}`, id);
      }
      for ( const [, pkg, pack, id] of str.matchAll(LEGACY_LINK) ) {
        if ( selected.has(`${pkg}.${pack}`) ) add(`${pkg}.${pack}`, id);
      }
    }
    if ( patterns ) {
      for ( const [, type, id] of str.matchAll(patterns.uuid) ) add(WORLD, `${type}.${id}`);
      for ( const [, type, id] of str.matchAll(patterns.legacy) ) add(WORLD, `${type}.${id}`);
    }
    return str;
  });
  return found;
}

/**
 * Scene fields that store a bare world document id.
 * @param {object[]} scenes  Scene source data
 * @param {Map<string, Set<string>>} found
 */
function collectSceneIds(scenes, found) {
  const add = (type, id) => {
    if ( !id ) return;
    if ( !found.has(WORLD) ) found.set(WORLD, new Set());
    found.get(WORLD).add(`${type}.${id}`);
  };
  for ( const scene of scenes ) {
    add("JournalEntry", scene.journal);
    add("Playlist", scene.playlist);
    for ( const token of scene.tokens ?? [] ) add("Actor", token.actorId);
    for ( const note of scene.notes ?? [] ) add("JournalEntry", note.entryId);
  }
}

/* -------------------------------------------- */

/**
 * @typedef {object} PackInResult
 * @property {object} source                           Adventure source with the entries added and links changed
 * @property {Map<string, {packed: number, missing: number}>} stats  Per compendium (WORLD for the world): entries
 *   added, ids not found
 * @property {number} depth                            Rounds of links followed
 * @property {boolean} limited                         Stopped at MAX_ENTRIES; some links were not followed
 */

/**
 * Add the linked entries of the chosen compendiums, and optionally the linked world documents, to the adventure.
 * @param {object} baseSource           Adventure source; not changed
 * @param {Set<string>} selected        Compendium collection ids to pack in
 * @param {object} [options]
 * @param {boolean} [options.world=false]      Also add world documents the adventure links to
 * @param {string} [options.worldFolder]       Folder name for added world documents
 * @param {function(number, number): void} [options.onProgress]  Sources done, total
 * @returns {Promise<PackInResult>}
 */
export async function packInLinks(baseSource, selected, { world = false, worldFolder = "", onProgress } = {}) {
  const source = foundry.utils.deepClone(baseSource);
  const fields = {};
  const ids = {};
  for ( const [field, cls] of Object.entries(CONFIG.Adventure.documentClass.contentFields) ) {
    fields[cls.documentName] = field;
    source[field] ??= [];
    ids[cls.documentName] = new Set(source[field].map(d => d._id));
  }
  const stats = new Map();
  const folders = new Map();
  const tried = new Set();

  /** One folder per compendium (and per type for world documents), so added entries are easy to find. */
  const folderFor = (key, name, type) => {
    if ( folders.has(key) ) return folders.get(key);
    const folder = {
      _id: foundry.utils.randomID(), name, type, folder: null,
      sorting: "a", sort: 0, color: null, description: "", flags: {}
    };
    source.folders.push(folder);
    ids.Folder?.add(folder._id);
    folders.set(key, folder._id);
    return folder._id;
  };

  /**
   * Add one document's data to the adventure.
   * @param {string} type
   * @param {object} data
   * @param {object[]} added
   */
  const addData = (type, data, added) => {
    source[fields[type]].push(data);
    ids[type].add(data._id);
    added.push({ type, data });
  };

  /**
   * Respect the entry limit.
   * @param {string[]} todo
   * @returns {string[]}
   */
  const limit = todo => {
    if ( count + todo.length > MAX_ENTRIES ) {
      todo = todo.slice(0, Math.max(0, MAX_ENTRIES - count));
      limited = true;
    }
    count += todo.length;
    return todo;
  };

  let queue = collectLinks(source, selected, world);
  if ( world ) collectSceneIds(source.scenes ?? [], queue);
  let done = 0;
  let total = 0;
  let count = 0;
  let depth = 0;
  let limited = false;
  while ( queue.size && !limited ) {
    depth++;
    const added = [];
    total += queue.size;
    for ( const [collection, linked] of queue ) {
      if ( collection === WORLD ) {
        const stat = stats.get(WORLD) ?? { packed: 0, missing: 0 };
        stats.set(WORLD, stat);
        const todo = limit([...linked].filter(key => {
          const [type, id] = key.split(".");
          return ids[type] && !ids[type].has(id) && !tried.has(`${WORLD}.${key}`);
        }));
        for ( const key of todo ) {
          tried.add(`${WORLD}.${key}`);
          const [type, id] = key.split(".");
          const document = game.collections.get(type)?.get(id);
          if ( !document ) {
            stat.missing++;
            continue;
          }
          const data = document.toCompendium(null, DATA_OPTIONS);
          data.folder = folderFor(`${WORLD}.${type}`, worldFolder || game.world.title, type);
          addData(type, data, added);
          stat.packed++;
        }
        onProgress?.(++done, total);
        continue;
      }
      const pack = game.packs.get(collection);
      if ( !canPackIn(pack) ) continue;
      const type = pack.documentName;
      const stat = stats.get(collection) ?? { packed: 0, missing: 0 };
      stats.set(collection, stat);
      const todo = limit([...linked].filter(id => !tried.has(`${collection}.${id}`) && !ids[type].has(id)));
      for ( const id of todo ) tried.add(`${collection}.${id}`);
      for ( let i = 0; i < todo.length; i += BATCH ) {
        const batch = todo.slice(i, i + BATCH);
        const documents = await pack.getDocuments({ _id__in: batch });
        stat.missing += batch.length - documents.length;
        for ( const document of documents ) {
          const data = document.toCompendium(null, DATA_OPTIONS);
          data.folder = folderFor(collection, pack.title, type);
          data._stats = { ...data._stats, compendiumSource: document.uuid };
          addData(type, data, added);
          stat.packed++;
        }
      }
      onProgress?.(++done, total);
    }
    queue = collectLinks(added.map(a => a.data), selected, world);
    if ( world ) collectSceneIds(added.filter(a => a.type === "Scene").map(a => a.data), queue);
    // Drop what is already there, so the loop ends when nothing new is linked.
    for ( const [collection, linked] of queue ) {
      for ( const key of linked ) {
        const [type, id] = collection === WORLD ? key.split(".") : [game.packs.get(collection)?.documentName, key];
        if ( ids[type]?.has(id) || tried.has(`${collection}.${key}`) ) linked.delete(key);
      }
      if ( !linked.size ) queue.delete(collection);
    }
  }

  // Change links whose target is now part of the adventure.
  const resolve = (collection, type, id) => {
    if ( !selected.has(collection) ) return null;
    const pack = game.packs.get(collection);
    if ( !canPackIn(pack) ) return null;
    const docType = pack.documentName;
    if ( !docType || (type && (type !== docType)) || !ids[docType]?.has(id) ) return null;
    return `${docType}.${id}`;
  };
  const rewritten = mapStrings(source, str => {
    if ( !str.includes("Compendium") ) return str;
    return str
      .replace(LEGACY_LINK, (m, pkg, pack, id) => {
        const target = resolve(`${pkg}.${pack}`, null, id);
        return target ? `@UUID[${target}]` : m;
      })
      .replace(COMPENDIUM_UUID, (m, pkg, pack, type, id) => resolve(`${pkg}.${pack}`, type, id) ?? m);
  });
  return { source: rewritten, stats, depth, limited };
}
