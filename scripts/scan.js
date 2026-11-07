import { ASSET_KINDS, CONCURRENCY, CORE_DIRS, LINK_TYPES, MODULE_ID, PROVENANCE_KEYS, SKIP_KEYS } from "./constants.js";

/* -------------------------------------------- */
/*  Path detection                              */
/* -------------------------------------------- */

let patterns;

/**
 * Regular expressions for file paths with a media extension. Built on first use from core's extension lists, so new
 * formats Foundry accepts are found too.
 * @returns {{whole: RegExp, embedded: RegExp}}
 */
function getPatterns() {
  if ( patterns ) return patterns;
  const exts = new Set(["pdf"]);
  for ( const list of ["IMAGE_FILE_EXTENSIONS", "AUDIO_FILE_EXTENSIONS", "VIDEO_FILE_EXTENSIONS", "FONT_FILE_EXTENSIONS",
    "TEXTURE_FILE_EXTENSIONS", "GRAPHICS_FILE_EXTENSIONS"] ) {
    for ( const ext of Object.keys(CONST[list] ?? {}) ) exts.add(ext.toLowerCase());
  }
  const ext = [...exts].sort((a, b) => b.length - a.length).join("|");
  patterns = {
    // A string that is nothing but a path (file path fields, flags). Group 1: path, group 2: query or hash.
    whole: new RegExp(`^(?!data:)([^\\s"'<>|][^\\n\\r"'<>|]*?\\.(?:${ext}))([?#][^\\s"'<>]*)?$`, "i"),
    // A path inside quotes or url(…): HTML attributes, inline styles, macro code. Group 2: path.
    embedded: new RegExp(
      `(["'\`(])((?!data:)[^\\s"'\`()<>][^"'\`()<>\\n\\r]*?\\.(?:${ext}))([?#][^"'\`()<>\\s]*)?(?=["'\`)])`, "gi")
  };
  return patterns;
}

/**
 * Find file paths in a string.
 * @param {string} str
 * @returns {{start: number, raw: string}[]}  Position and text of each path (without query or hash)
 */
export function findPaths(str) {
  if ( str.length < 5 ) return [];
  const { whole, embedded } = getPatterns();
  const match = whole.exec(str);
  if ( match ) return [{ start: 0, raw: match[1] }];
  if ( !/["'`(]/.test(str) ) return [];
  const found = [];
  for ( const m of str.matchAll(embedded) ) {
    const raw = m[2];
    if ( raw.includes("${") || raw.includes("\\") ) continue; // Template literals and escaped code
    found.push({ start: m.index + m[1].length, raw });
  }
  return found;
}

/**
 * Turn a path as written in a document into a lookup key: decoded, without the leading slash or route prefix.
 * Same-origin URLs become relative paths. Other URLs stay absolute.
 * @param {string} raw
 * @returns {string|null}  The key, or null for things that cannot be copied (blob:, file:, "..")
 */
export function normalizePath(raw) {
  let path = raw.trim();
  if ( /%[0-9a-f]{2}/i.test(path) ) {
    try { path = decodeURI(path); } catch { /* keep as written */ }
  }
  const origin = window.location.origin;
  let absolute = path.startsWith("/");
  if ( path.startsWith(`${origin}/`) ) {
    path = path.slice(origin.length);
    absolute = true;
  }
  if ( path.startsWith("//") ) path = `${window.location.protocol}${path}`;
  if ( /^https?:\/\//i.test(path) ) return path;
  if ( /^[a-z][a-z0-9+.-]*:/i.test(path) ) return null;
  path = path.replace(/^(\.\/)+/, "").replace(/^\/+/, "");
  const prefix = globalThis.ROUTE_PREFIX;
  if ( absolute && prefix && path.startsWith(`${prefix}/`) ) path = path.slice(prefix.length + 1);
  if ( !path || path.split("/").includes("..") ) return null;
  return path;
}

/**
 * Where a path points to.
 * @param {string} key  A normalized path
 * @returns {{kind: string, host?: string, packageId?: string}}
 */
export function classifyPath(key) {
  if ( /^https?:\/\//i.test(key) ) {
    let host = "";
    try { host = new URL(key).hostname; } catch { return { kind: "external", host }; }
    const FilePicker = foundry.applications.apps.FilePicker.implementation;
    const own = (host === "assets.forge-vtt.com") || !!FilePicker.matchS3URL?.(key);
    return { kind: own ? "storage" : "external", host };
  }
  const [first, second] = key.split("/");
  if ( CORE_DIRS.has(first) ) return { kind: "core" };
  if ( first === "systems" ) return { kind: "system", packageId: second };
  if ( first === "modules" ) return { kind: "module", packageId: second };
  if ( first === "worlds" ) return { kind: "world", packageId: second };
  return { kind: "data" };
}

/**
 * The path of a copied asset inside the new module's `assets/` folder, before collisions are resolved.
 * World files lose their `worlds/<world>/` prefix, remote files go to `remote/<host>/`.
 * @param {object} entry  An asset entry
 * @returns {string}
 */
export function destFor(entry) {
  let dest;
  if ( entry.kind === "world" ) dest = entry.key.split("/").slice(2).join("/");
  else if ( (entry.kind === "storage") || (entry.kind === "external") ) {
    let path = new URL(entry.key).pathname;
    try { path = decodeURIComponent(path); } catch { /* keep encoded */ }
    dest = `remote/${entry.host}${path}`;
  }
  else dest = entry.key;
  // Characters Windows does not allow in file names. "*" stays: it is the wildcard of a token image pattern.
  return dest.replace(/[:"<>|]/g, "_");
}

/**
 * The URL to fetch a normalized path from.
 * @param {string} key
 * @returns {string}
 */
export function toUrl(key) {
  if ( /^https?:\/\//i.test(key) ) return key;
  return foundry.utils.getRoute(key.split("/").map(encodeURIComponent).join("/"));
}

/**
 * The file name of a path or URL, decoded.
 * @param {string} key
 * @returns {string}
 */
export function baseName(key) {
  const name = /^https?:\/\//i.test(key) ? new URL(key).pathname.split("/").pop() : key.split("/").pop();
  try { return decodeURIComponent(name); } catch { return name; }
}

/**
 * Run an async task for each item, at most `limit` at a time.
 * @param {any[]} items
 * @param {number} limit
 * @param {Function} task
 */
export async function runPool(items, limit, task) {
  let next = 0;
  const worker = async () => {
    while ( next < items.length ) await task(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/* -------------------------------------------- */
/*  References                                  */
/* -------------------------------------------- */

const UUID_LINK = /@UUID\[([^\]]+)\]/g;
const LEGACY_LINK = new RegExp(`@(${LINK_TYPES.join("|")}|Compendium)\\[([^\\]]+)\\]`, "g");
const WHOLE_UUID = new RegExp(
  `^(?:Compendium\\.[^.\\s]+\\.[^.\\s]+\\.\\S+|(?:${LINK_TYPES.join("|")})\\.[a-zA-Z0-9]{16}(?:\\.\\S+)?)$`);
const ID = /^[a-zA-Z0-9]{16}$/;

/* -------------------------------------------- */
/*  Scan                                        */
/* -------------------------------------------- */

/**
 * @typedef {object} AssetEntry
 * @property {number} index         Position in the report, used as form field name
 * @property {string} key           Normalized path or URL
 * @property {string} kind          A key of ASSET_KINDS
 * @property {string} [host]        Host name of a URL
 * @property {string} [packageId]   Module, system or world folder the file lives in
 * @property {boolean} wildcard     A token image pattern such as `tokens/goblin/*.webp`
 * @property {boolean} include      Copy it into the module
 * @property {string} status        pending, ok, missing, unchecked
 * @property {number|null} size     Bytes, if the server said
 * @property {string[]|null} files  The files a wildcard matched
 * @property {number} count         How often it is used
 * @property {Set<string>} docs     Labels of the documents using it
 */

/**
 * Everything the packer needs to know about an adventure: the assets it uses, links that will break, and modules
 * it depends on.
 */
export default class AdventureScan {
  /**
   * @param {object} source          Adventure source data (raw, as stored)
   * @param {object} [options]
   * @param {string} [options.pack]  The compendium the adventure is stored in
   */
  constructor(source, { pack = null } = {}) {
    this.source = source;
    this.pack = pack;
    this.contentFields = CONFIG.Adventure.documentClass.contentFields;

    /** @type {Record<string, Set<string>>} Ids of the documents in the adventure, by document type. */
    this.contentIds = {};
    for ( const [field, cls] of Object.entries(this.contentFields) ) {
      this.contentIds[cls.documentName] = new Set((this.source[field] ?? []).map(d => d._id));
    }

    /** @type {Map<string, AssetEntry>} */
    this.assets = new Map();
    /** @type {Map<string, {type: string, uuid: string, name: string, docs: Set<string>}>} */
    this.issues = new Map();
    /** @type {Map<string, {id: string, title: string, installed: boolean, reasons: Set<string>}>} */
    this.dependencies = new Map();
    /** Newest core and system versions the documents were saved with. */
    this.coreVersion = null;
    this.systemVersion = null;
  }

  /* -------------------------------------------- */

  /**
   * Load the source data of an adventure in a compendium, without building documents.
   * An index request with every field reads the raw record on the server and sends it as is. Loading the Document
   * instead would construct and validate every actor, scene and journal of the adventure, on the server and the
   * client, which takes long for large adventures.
   * @param {string} pack  Compendium collection id
   * @param {string} id    Adventure id
   * @returns {Promise<object>}
   */
  static async load(pack, id) {
    const cls = CONFIG.Adventure.documentClass;
    const indexFields = Array.from(cls.schema.keys());
    try {
      const [data] = await cls.database.get(cls, { pack, query: { _id: id }, index: true, indexFields });
      if ( data ) return data;
    } catch(err) {
      console.warn(`${MODULE_ID} | Raw loading failed, loading the Adventure document instead`, err);
    }
    const document = await game.packs.get(pack)?.getDocument(id);
    if ( !document ) throw new Error(game.i18n.localize("NATM.Errors.NoAdventure"));
    return document.toObject();
  }

  /** Label of the document being scanned. */
  #context = "";

  /** @type {AssetEntry[]} */
  get entries() {
    return [...this.assets.values()];
  }

  /* -------------------------------------------- */

  /**
   * The adventure itself and each document in it, with a label for the report.
   * @returns {Generator<{label: string, documentName: string, data: object}>}
   */
  *#documents() {
    const top = { ...this.source };
    for ( const field of Object.keys(this.contentFields) ) delete top[field];
    yield { label: `${game.i18n.localize("DOCUMENT.Adventure")}: ${this.source.name}`, documentName: "Adventure",
      data: top };
    for ( const [field, cls] of Object.entries(this.contentFields) ) {
      const type = game.i18n.localize(cls.metadata.label);
      for ( const data of this.source[field] ?? [] ) {
        yield { label: `${type}: ${data.name ?? data._id}`, documentName: cls.documentName, data };
      }
    }
  }

  /* -------------------------------------------- */

  /**
   * Scan the adventure. Pauses every few milliseconds so the window stays responsive on large adventures.
   * @param {function(number, number): void} [onProgress]  Documents scanned, total
   */
  async collect(onProgress) {
    const documents = [...this.#documents()];
    let pause = performance.now();
    for ( const [i, { label, documentName, data }] of documents.entries() ) {
      this.#context = label;
      this.#visit(data, null);
      this.#visitMeta(data);
      if ( documentName === "Scene" ) this.#checkSceneLinks(data);
      if ( performance.now() - pause > 30 ) {
        onProgress?.(i + 1, documents.length);
        await new Promise(resolve => setTimeout(resolve, 0));
        pause = performance.now();
      }
    }
    for ( const entry of this.assets.values() ) {
      if ( entry.kind === "module" ) this.#addDependency(entry.packageId, "assets");
    }
    onProgress?.(documents.length, documents.length);
  }

  /* -------------------------------------------- */

  /**
   * Walk a value and look at every string in it.
   * @param {any} value
   * @param {string|null} key  The property the value is stored under
   */
  #visit(value, key) {
    if ( typeof value === "string" ) {
      if ( !SKIP_KEYS.has(key) ) for ( const { raw } of findPaths(value) ) this.#addAsset(raw);
      this.#scanReferences(value);
    }
    else if ( Array.isArray(value) ) {
      for ( const v of value ) this.#visit(v, key);
    }
    else if ( value && (typeof value === "object") ) {
      for ( const [k, v] of Object.entries(value) ) {
        if ( !PROVENANCE_KEYS.has(k) ) this.#visit(v, k);
      }
    }
  }

  /* -------------------------------------------- */

  /**
   * Collect module flags and the newest `_stats` versions.
   * @param {any} value
   */
  #visitMeta(value) {
    if ( Array.isArray(value) ) {
      for ( const v of value ) this.#visitMeta(v);
      return;
    }
    if ( !value || (typeof value !== "object") ) return;
    const { flags, _stats: stats } = value;
    if ( flags && (typeof flags === "object") && !Array.isArray(flags) ) {
      for ( const scope of Object.keys(flags) ) {
        if ( (scope !== MODULE_ID) && game.modules.has(scope) ) this.#addDependency(scope, "flags");
      }
    }
    if ( stats && (typeof stats === "object") ) {
      const newer = (a, b) => (a && (!b || foundry.utils.isNewerVersion(a, b))) ? a : b;
      this.coreVersion = newer(stats.coreVersion, this.coreVersion);
      if ( stats.systemId === game.system.id ) this.systemVersion = newer(stats.systemVersion, this.systemVersion);
    }
    for ( const [k, v] of Object.entries(value) ) {
      if ( (k !== "_stats") && v && (typeof v === "object") ) this.#visitMeta(v);
    }
  }

  /* -------------------------------------------- */

  /** @param {string} raw */
  #addAsset(raw) {
    const key = normalizePath(raw);
    if ( !key ) return;
    let entry = this.assets.get(key);
    if ( !entry ) {
      const { kind, host, packageId } = classifyPath(key);
      entry = {
        index: this.assets.size, key, kind, host, packageId,
        wildcard: key.includes("*"),
        include: ASSET_KINDS[kind].copy,
        status: "pending",
        size: null,
        files: null,
        count: 0,
        docs: new Set()
      };
      this.assets.set(key, entry);
    }
    entry.count++;
    entry.docs.add(this.#context);
  }

  /* -------------------------------------------- */

  /** @param {string} str */
  #scanReferences(str) {
    if ( str.length < 22 ) return; // "Actor." + 16 characters
    if ( WHOLE_UUID.test(str) ) this.#addReference(str);
    if ( !str.includes("@") ) return;
    for ( const m of str.matchAll(UUID_LINK) ) this.#addReference(m[1]);
    for ( const [, type, target] of str.matchAll(LEGACY_LINK) ) {
      if ( type === "Compendium" ) this.#addReference(`Compendium.${target}`);
      else if ( ID.test(target) ) this.#addReference(`${type}.${target}`);
    }
  }

  /* -------------------------------------------- */

  /** @param {string} uuid */
  #addReference(uuid) {
    uuid = uuid.trim();
    if ( !uuid || uuid.startsWith(".") ) return; // Relative links stay inside their document
    const parts = uuid.split(".");
    if ( parts[0] === "Compendium" ) {
      const collection = `${parts[1]}.${parts[2]}`;
      if ( collection === this.pack ) return this.#addIssue("sourcePack", uuid);
      const pack = game.packs.get(collection);
      if ( !pack ) {
        this.#addIssue("unknownPack", uuid);
        if ( game.modules.has(parts[1]) ) this.#addDependency(parts[1], "compendium");
        return;
      }
      const { packageType, packageName } = pack.metadata;
      if ( packageType === "world" ) this.#addIssue("worldPack", uuid);
      else if ( packageType === "module" ) this.#addDependency(packageName, "compendium");
      return;
    }
    const [type, id] = parts;
    const ids = this.contentIds[type];
    if ( ids && ID.test(id) && !ids.has(id) ) this.#addIssue("missingDocument", `${type}.${id}`);
  }

  /* -------------------------------------------- */

  /**
   * Scene fields that store a bare document id.
   * @param {object} scene  Scene source
   */
  #checkSceneLinks(scene) {
    const check = (type, id) => {
      if ( id && !this.contentIds[type]?.has(id) ) this.#addIssue("missingDocument", `${type}.${id}`);
    };
    check("JournalEntry", scene.journal);
    check("Playlist", scene.playlist);
    for ( const token of scene.tokens ?? [] ) check("Actor", token.actorId);
    for ( const note of scene.notes ?? [] ) check("JournalEntry", note.entryId);
  }

  /* -------------------------------------------- */

  /**
   * @param {string} type  missingDocument, sourcePack, worldPack, unknownPack
   * @param {string} uuid
   */
  #addIssue(type, uuid) {
    const key = `${type}|${uuid}`;
    let issue = this.issues.get(key);
    if ( !issue ) {
      let name = "";
      try { name = foundry.utils.fromUuidSync(uuid, { strict: false })?.name ?? ""; } catch { /* unresolvable */ }
      issue = { type, uuid, name, docs: new Set() };
      this.issues.set(key, issue);
    }
    issue.docs.add(this.#context);
  }

  /* -------------------------------------------- */

  /**
   * @param {string} id      Module id
   * @param {string} reason  assets, compendium, flags
   */
  #addDependency(id, reason) {
    if ( !id || (id === MODULE_ID) ) return;
    let dep = this.dependencies.get(id);
    if ( !dep ) {
      const module = game.modules.get(id);
      dep = { id, title: module?.title ?? id, installed: !!module, reasons: new Set() };
      this.dependencies.set(id, dep);
    }
    dep.reasons.add(reason);
  }

  /* -------------------------------------------- */
  /*  Checking files                              */
  /* -------------------------------------------- */

  /**
   * Check which files exist, read their sizes and expand wildcards.
   * @param {function(number, number): void} [onProgress]
   */
  async check(onProgress) {
    const entries = this.entries;
    let done = 0;
    await runPool(entries, CONCURRENCY, async entry => {
      await this.#checkEntry(entry);
      onProgress?.(++done, entries.length);
    });
  }

  /* -------------------------------------------- */

  /** @param {AssetEntry} entry */
  async #checkEntry(entry) {
    const remote = (entry.kind === "storage") || (entry.kind === "external");
    try {
      if ( entry.wildcard ) {
        entry.files = await this.#browseWildcard(entry);
        if ( entry.files === null ) entry.status = "unchecked";
        else entry.status = entry.files.length ? "ok" : "missing";
        return;
      }
      if ( entry.kind === "external" ) {
        entry.status = "unchecked";
        return;
      }
      const response = await fetch(toUrl(entry.key), { method: "HEAD" });
      entry.status = response.ok ? "ok" : "missing";
      const size = Number(response.headers.get("content-length"));
      if ( response.ok && size ) entry.size = size;
    } catch(err) {
      // Remote servers often refuse HEAD requests from another origin. The download may still work.
      entry.status = remote ? "unchecked" : "missing";
      entry.error = err.message;
    }
  }

  /* -------------------------------------------- */

  /**
   * The files a token image wildcard matches.
   * @param {AssetEntry} entry
   * @returns {Promise<string[]|null>}  Normalized paths, or null if the storage cannot be searched
   */
  async #browseWildcard(entry) {
    const FilePicker = foundry.applications.apps.FilePicker.implementation;
    let source = "data";
    let target = entry.key;
    const options = { wildcard: true };
    if ( entry.kind === "core" ) source = "public";
    else if ( entry.kind === "storage" ) {
      const match = FilePicker.matchS3URL(entry.key);
      if ( !match ) return null;
      source = "s3";
      target = decodeURIComponent(match.groups.key);
      options.bucket = match.groups.bucket;
    }
    else if ( entry.kind === "external" ) return null;
    const result = await FilePicker.browse(source, target, options);
    return (result?.files ?? []).map(f => normalizePath(f)).filter(Boolean);
  }

  /* -------------------------------------------- */
  /*  Rewriting                                   */
  /* -------------------------------------------- */

  /**
   * A copy of the adventure source with paths replaced.
   * @param {Map<string, string>} map  Normalized path → new path
   * @returns {object}
   */
  rewrite(map) {
    const replace = str => {
      const found = findPaths(str);
      if ( !found.length ) return str;
      let out = "";
      let last = 0;
      for ( const { start, raw } of found ) {
        const key = normalizePath(raw);
        const next = key && map.get(key);
        if ( !next ) continue;
        // Keep the encoding the text used: HTML usually has %20, file path fields usually plain spaces.
        out += str.slice(last, start) + (/%[0-9a-f]{2}/i.test(raw) ? encodeURI(next) : next);
        last = start + raw.length;
      }
      return out + str.slice(last);
    };
    const transform = (value, key) => {
      if ( typeof value === "string" ) return SKIP_KEYS.has(key) ? value : replace(value);
      if ( Array.isArray(value) ) return value.map(v => transform(v, key));
      if ( value && (typeof value === "object") ) {
        const out = {};
        for ( const [k, v] of Object.entries(value) ) out[k] = PROVENANCE_KEYS.has(k) ? foundry.utils.deepClone(v) : transform(v, k);
        return out;
      }
      return value;
    };
    return transform(this.source, null);
  }
}
