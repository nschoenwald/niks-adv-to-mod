import { CONCURRENCY, MODULE_ID } from "./constants.js";
import { baseName, destFor, runPool, toUrl } from "./scan.js";
import ZipWriter from "./zip.js";

/**
 * @typedef {object} ExportOptions
 * @property {string} id            Id of the new module
 * @property {string} title
 * @property {string} version
 * @property {string} [author]
 * @property {string} [url]
 * @property {string} [description]
 * @property {{id: string, level: "requires"|"recommends"|"none"}[]} dependencies
 */

/**
 * @typedef {object} ExportResult
 * @property {number} files       Asset files written
 * @property {number} bytes       Asset bytes written
 * @property {{src: string, error: string}[]} failures  Files that could not be downloaded; their paths stay unchanged
 * @property {boolean} streamed   Written straight to disk (true) or downloaded at the end
 */

const encoder = new TextEncoder();

/* -------------------------------------------- */

/**
 * Decide which files go where.
 * @param {AdventureScan} scan
 * @param {string} moduleId
 * @returns {{plan: {entry: object, target: string, files: {src: string, path: string}[]}[], map: Map<string, string>}}
 */
export function planAssets(scan, moduleId) {
  const used = new Set();
  const plan = [];
  const map = new Map();
  for ( const entry of scan.entries ) {
    // Files already in the new module's own folder (packing a module's adventure again) keep their path.
    const own = (entry.kind === "module") && (entry.packageId === moduleId);
    if ( !own && !entry.include ) continue;
    if ( entry.status === "missing" ) continue;
    if ( entry.wildcard && !entry.files?.length ) continue;

    let dest = own ? entry.key.split("/").slice(2).join("/") : `assets/${destFor(entry)}`;
    if ( !entry.wildcard ) dest = uniquePath(dest, used);
    const target = `modules/${moduleId}/${dest}`;
    map.set(entry.key, target);

    let files;
    if ( entry.wildcard ) {
      // The pattern keeps its file name part, so every match goes next to it under its own name.
      const dir = dest.split("/").slice(0, -1).join("/");
      files = entry.files.map(src => ({ src, path: `${dir}/${baseName(src)}` }));
    }
    else files = [{ src: entry.key, path: dest }];
    plan.push({ entry, target, files });
  }
  return { plan, map };
}

/**
 * Add "-1", "-2"… before the extension until the path is unused. Compared case-insensitively, as on macOS and
 * Windows.
 * @param {string} path
 * @param {Set<string>} used
 * @returns {string}
 */
function uniquePath(path, used) {
  let candidate = path;
  let n = 1;
  while ( used.has(candidate.toLowerCase()) ) {
    candidate = path.replace(/(\.[^./]+)?$/, ext => `-${n}${ext}`);
    n++;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

/* -------------------------------------------- */

/**
 * Download one file.
 * @param {string} src  Normalized path or URL
 * @returns {Promise<Uint8Array>}
 */
async function download(src, signal) {
  const response = await fetch(toUrl(src), { signal });
  if ( !response.ok ) throw new Error(`${response.status} ${response.statusText}`.trim());
  return new Uint8Array(await response.arrayBuffer());
}

/* -------------------------------------------- */

/**
 * Pack the adventure into a module ZIP.
 * @param {AdventureScan} scan
 * @param {ExportOptions} options
 * @param {import("./zip.js").ZipSink & {streamed: boolean}} sink
 * @param {function(number, number): void} [onProgress]
 * @param {object} [config]
 * @param {AbortSignal} [config.signal]  Cancels the export; it then rejects with an AbortError
 * @returns {Promise<ExportResult>}
 */
export async function exportModule(scan, options, sink, onProgress, { signal } = {}) {
  const zip = new ZipWriter(sink);
  const root = `${options.id}/`;
  const { plan, map } = planAssets(scan, options.id);

  // Assets first: paths of files that fail to download stay as they were in the adventure.
  const jobs = plan.flatMap(item => item.files.map(file => ({ item, file })));
  const written = new Set();
  const failures = [];
  let done = 0;
  let bytes = 0;
  let files = 0;
  let queue = Promise.resolve();
  await runPool(jobs, CONCURRENCY, async ({ item, file }) => {
    signal?.throwIfAborted();
    const path = file.path.toLowerCase();
    if ( !written.has(path) ) {
      written.add(path);
      let data;
      try {
        data = await download(file.src, signal);
      } catch(err) {
        if ( signal?.aborted ) throw err;
        failures.push({ src: file.src, error: err.message });
        item.failed = (item.failed ?? 0) + 1;
      }
      if ( data ) {
        // Downloads run in parallel, writes one at a time. Write errors (disk full…) end the export.
        const write = queue.then(() => zip.addFile(root + file.path, data));
        queue = write.catch(() => {});
        await write;
        bytes += data.length;
        files++;
      }
    }
    onProgress?.(++done, jobs.length);
  });
  signal?.throwIfAborted();
  for ( const item of plan ) {
    if ( item.failed && !item.entry.wildcard ) map.delete(item.entry.key);
  }

  const packName = "adventure";
  const adventure = scan.rewrite(map);
  adventure.folder = null;
  adventure._stats = { ...adventure._stats, compendiumSource: null, duplicateSource: null };
  const manifest = buildManifest(scan, options, packName, adventure.img);

  await zip.addFile(`${root}packs/${packName}.db`, encoder.encode(`${JSON.stringify(adventure)}\n`), { compress: true });
  await zip.addFile(`${root}module.json`, encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`), { compress: true });
  await zip.addFile(`${root}README.md`, encoder.encode(buildReadme(manifest, options)), { compress: true });
  await zip.finish();
  return { files, bytes, failures, streamed: sink.streamed };
}

/* -------------------------------------------- */

/**
 * The module.json of the new module.
 * The adventure is shipped as a NeDB file (`packs/<name>.db`, one JSON line). Foundry converts it to LevelDB the
 * first time the pack is opened (`ServerDocumentMixin._migrateNEDBToLevelDB`), so no database has to be built in the
 * browser.
 * @param {AdventureScan} scan
 * @param {ExportOptions} options
 * @param {string} packName
 * @param {string} [cover]  The adventure image, already rewritten
 * @returns {object}
 */
function buildManifest(scan, options, packName, cover) {
  const requires = [];
  const recommends = [];
  for ( const { id, level } of options.dependencies ) {
    if ( (id === options.id) || (level === "none") ) continue;
    const module = game.modules.get(id);
    const relation = { id, type: "module" };
    if ( module?.manifest ) relation.manifest = module.manifest;
    (level === "requires" ? requires : recommends).push(relation);
  }

  // Documents saved by a newer Foundry or system version can't be loaded by an older one.
  const core = scan.coreVersion ?? game.version;
  const system = scan.systemVersion ?? game.system.version;

  const manifest = {
    id: options.id,
    title: options.title,
    description: options.description || "",
    version: options.version,
    compatibility: { minimum: core, verified: game.version },
    authors: options.author ? [{ name: options.author }] : [],
    relationships: {
      systems: [{ id: game.system.id, type: "system", compatibility: { minimum: system } }],
      requires,
      recommends
    },
    packs: [{
      name: packName,
      label: options.title,
      path: `packs/${packName}`,
      type: "Adventure",
      system: game.system.id,
      ownership: { PLAYER: "OBSERVER", ASSISTANT: "OWNER" }
    }],
    flags: {
      [MODULE_ID]: { version: game.modules.get(MODULE_ID)?.version ?? null, packedAt: new Date().toISOString() }
    }
  };
  if ( options.url ) manifest.url = options.url;
  if ( cover && !/^https?:/i.test(cover) ) manifest.media = [{ type: "cover", url: cover }];
  return manifest;
}

/* -------------------------------------------- */

/**
 * A README for the people who receive the module. English, since it goes to other GMs.
 * @param {object} manifest
 * @param {ExportOptions} options
 * @returns {string}
 */
function buildReadme(manifest, options) {
  const system = manifest.relationships.systems[0];
  const lines = [`# ${manifest.title}`, ""];
  if ( options.description ) lines.push(options.description, "");
  if ( options.author ) lines.push(`By ${options.author}. Version ${manifest.version}.`, "");
  lines.push(
    "## Installation", "",
    `1. Extract this ZIP into the \`modules\` folder of your Foundry VTT user data, so that you get \`Data/modules/${manifest.id}/module.json\`.`,
    "   On a hosting service, use its upload or import feature for modules.",
    "2. Restart Foundry or return to Setup, launch your world, and enable the module in **Manage Modules**.",
    `3. Open the compendium **${manifest.packs[0].label}** and import the adventure.`,
    "",
    "## Requirements", "",
    `- Foundry VTT ${manifest.compatibility.minimum} or newer`,
    `- Game system: ${game.system.title} (\`${system.id}\`) ${system.compatibility.minimum} or newer`
  );
  for ( const rel of manifest.relationships.requires ) {
    lines.push(`- Module: ${game.modules.get(rel.id)?.title ?? rel.id} (\`${rel.id}\`)`);
  }
  if ( manifest.relationships.recommends.length ) {
    lines.push("", "Recommended:", "");
    for ( const rel of manifest.relationships.recommends ) {
      lines.push(`- ${game.modules.get(rel.id)?.title ?? rel.id} (\`${rel.id}\`)`);
    }
  }
  lines.push("", "---", "", `Packed with Nik's Adventure to Module.`, "");
  return lines.join("\n");
}
