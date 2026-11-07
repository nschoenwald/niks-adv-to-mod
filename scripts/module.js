import { MODULE_ID, SETTINGS } from "./constants.js";
import PackerApp from "./apps/packer-app.js";
import AdventureScan from "./scan.js";
import { exportModule, planAssets } from "./export.js";
import { openSink } from "./zip.js";
import { packInLinks } from "./link-pack.js";

Hooks.once("init", () => {
  // Remembered between exports, per user.
  game.settings.register(MODULE_ID, SETTINGS.author, { scope: "user", config: false, type: String, default: "" });
  game.settings.register(MODULE_ID, SETTINGS.url, { scope: "user", config: false, type: String, default: "" });

  Hooks.on("getAdventureContextOptions", addContextOption);
  Hooks.on("getHeaderControlsAdventureImporterV2", addHeaderControl);

  const api = {
    open,
    AdventureScan,
    packInLinks,
    planAssets,
    exportModule,
    openSink
  };
  game.modules.get(MODULE_ID).api = api;
  globalThis.NiksAdventureToModule = api;
});

/* -------------------------------------------- */

/**
 * Open the export window for an adventure. Brings an open window for the same adventure to the front.
 * The window opens at once; the adventure is loaded in it.
 * @param {Adventure|string|{pack: string, id: string}} adventure  An Adventure document, its UUID, or pack and id
 * @returns {Promise<PackerApp|null>}
 */
async function open(adventure) {
  if ( !game.user.isGM ) {
    ui.notifications.warn("NATM.Errors.GMOnly", { localize: true });
    return null;
  }
  const ref = resolveAdventure(adventure);
  if ( !ref ) {
    ui.notifications.error("NATM.Errors.NoAdventure", { localize: true });
    return null;
  }
  const existing = foundry.applications.instances.get(PackerApp.appId(ref));
  if ( existing ) {
    existing.bringToFront();
    return existing;
  }
  return new PackerApp({ adventure: ref }).render({ force: true });
}

/**
 * Which adventure to open, without loading it. Name and image come from the compendium index.
 * @param {Adventure|string|{pack: string, id: string}} adventure
 * @returns {{pack: string|null, id: string, name: string, img?: string, source?: object}|null}
 */
function resolveAdventure(adventure) {
  if ( adventure instanceof foundry.documents.Adventure ) {
    const ref = { pack: adventure.pack, id: adventure.id, name: adventure.name, img: adventure.img };
    if ( !adventure.pack ) ref.source = adventure.toObject();
    return ref;
  }
  let pack;
  let id;
  if ( typeof adventure === "string" ) {
    const parsed = foundry.utils.parseUuid(adventure);
    if ( parsed?.documentType !== "Adventure" ) return null;
    pack = parsed.collection?.collection;
    id = parsed.id;
  }
  else ({ pack, id } = adventure ?? {});
  const entry = game.packs.get(pack)?.index.get(id);
  if ( !entry ) return null;
  return { pack, id, name: entry.name, img: entry.img };
}

/* -------------------------------------------- */

/**
 * "Export as Module" in the context menu of Adventure entries in a compendium.
 * @param {Compendium} app
 * @param {ContextMenuEntry[]} options
 */
function addContextOption(app, options) {
  if ( !(app.collection instanceof foundry.documents.collections.CompendiumCollection) ) return;
  options.push({
    label: "NATM.ContextMenu",
    icon: "fa-solid fa-file-zipper",
    visible: () => game.user.isGM,
    onClick: (event, li) => open({ pack: app.collection.collection, id: li.dataset.entryId })
  });
}

/* -------------------------------------------- */

/**
 * "Export as Module" in the header menu of the adventure window (opened by clicking an adventure).
 * @param {AdventureImporterV2} app
 * @param {ApplicationHeaderControlsEntry[]} controls
 */
function addHeaderControl(app, controls) {
  if ( !game.user.isGM ) return;
  controls.push({
    icon: "fa-solid fa-file-zipper",
    label: "NATM.ContextMenu",
    action: `${MODULE_ID}-export`,
    onClick: () => open(app.document)
  });
}
