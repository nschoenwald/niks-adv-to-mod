import { ASSET_KINDS, MODULE_ID, SETTINGS } from "../constants.js";
import AdventureScan from "../scan.js";
import { exportModule } from "../export.js";
import { openSink } from "../zip.js";

const { ApplicationV2, HandlebarsApplicationMixin, DialogV2 } = foundry.applications.api;

/** Most document labels listed in a tooltip. */
const MAX_TOOLTIP_DOCS = 12;

/**
 * The export window: module details, the asset report, broken links and dependencies.
 */
export default class PackerApp extends HandlebarsApplicationMixin(ApplicationV2) {

  /**
   * The window opens at once. The adventure is loaded, scanned and its files checked afterwards, with progress shown
   * in the window.
   * @param {object} options
   * @param {{pack: string|null, id: string, name: string, img?: string, source?: object}} options.adventure
   *   Which adventure to export. `source` skips loading (for adventures outside compendiums).
   */
  constructor({ adventure, ...options } = {}) {
    super({ id: PackerApp.appId(adventure), ...options });
    this.adventure = { ...adventure };
    this.#load();
  }

  /**
   * The window id for an adventure.
   * @param {{pack: string|null, id: string}} adventure
   * @returns {string}
   */
  static appId({ pack, id }) {
    return `${MODULE_ID}-${pack ?? "world"}-${id}`.replace(/[^\w-]/g, "-");
  }

  /** @type {AdventureScan|null} Set once the adventure is loaded. */
  scan = null;

  static DEFAULT_OPTIONS = {
    tag: "form",
    classes: [MODULE_ID],
    window: {
      title: "NATM.App.Title",
      icon: "fa-solid fa-file-zipper",
      contentClasses: ["standard-form"],
      resizable: true
    },
    position: { width: 760, height: 760 },
    form: {
      handler: PackerApp.#onSubmit,
      closeOnSubmit: false
    },
    actions: {
      toggleGroup: PackerApp.#onToggleGroup
    }
  };

  static PARTS = {
    header: { template: `modules/${MODULE_ID}/templates/header.hbs` },
    tabs: { template: "templates/generic/tab-navigation.hbs" },
    details: { template: `modules/${MODULE_ID}/templates/details.hbs`, scrollable: [""] },
    assets: { template: `modules/${MODULE_ID}/templates/assets.hbs`, scrollable: [""] },
    links: { template: `modules/${MODULE_ID}/templates/links.hbs`, scrollable: [""] },
    footer: { template: "templates/generic/form-footer.hbs" }
  };

  static TABS = {
    sheet: {
      tabs: [
        { id: "details", icon: "fa-solid fa-cube" },
        { id: "assets", icon: "fa-solid fa-images" },
        { id: "links", icon: "fa-solid fa-link" }
      ],
      initial: "details",
      labelPrefix: "NATM.Tabs"
    }
  };

  /** @inheritDoc */
  get title() {
    if ( !this.adventure ) return super.title; // Read during construction, before the adventure is set
    return game.i18n.format("NATM.App.TitleFor", { name: this.adventure.name });
  }

  /** loading, scanning, checking, ready, error */
  #stage = "loading";

  /** Progress of the current stage. */
  #progress = { done: 0, total: 0 };

  /** Error message if loading failed. */
  #error = "";

  /** The file check has finished. */
  get #checked() {
    return this.#stage === "ready";
  }

  /** Resolves after the first render, so later partial renders don't race it. Declared in this order on purpose. */
  #resolveFirstRender;
  #firstRender = new Promise(resolve => { this.#resolveFirstRender = resolve; });

  /** An export is running. */
  #exporting = false;

  /** @type {Map<string, string>} Dependency level chosen per module. */
  #levels = new Map();

  /* -------------------------------------------- */

  /** Load and scan the adventure, then check its files. */
  async #load() {
    const times = [performance.now()];
    try {
      const { pack, id } = this.adventure;
      const source = this.adventure.source ?? await AdventureScan.load(pack, id);
      delete this.adventure.source;
      Object.assign(this.adventure, { name: source.name, img: source.img });
      times.push(performance.now());

      this.scan = new AdventureScan(source, { pack });
      this.#setStage("scanning");
      await this.scan.collect((done, total) => this.#setProgress(done, total));
      times.push(performance.now());
      this.#levels = new Map([...this.scan.dependencies.values()].map(dep => [dep.id, defaultLevel(dep)]));

      this.#setStage("checking", this.scan.assets.size);
      await this.#firstRender;
      this.#fillDescription(source);
      await this.render({ parts: ["header", "assets", "links", "footer"] });
      await this.scan.check((done, total) => this.#setProgress(done, total));
      times.push(performance.now());
      console.debug(`${MODULE_ID} | ${source.name}: loaded in ${Math.round(times[1] - times[0])} ms, scanned in `
        + `${Math.round(times[2] - times[1])} ms, ${this.scan.assets.size} files checked in `
        + `${Math.round(times[3] - times[2])} ms`);
      this.#setStage("ready");
    } catch(err) {
      console.error(`${MODULE_ID} | Loading the adventure failed`, err);
      this.#error = err.message;
      this.#setStage("error");
      ui.notifications.error("NATM.Errors.LoadFailed", { format: { error: err.message } });
    }
    await this.#firstRender;
    if ( this.rendered ) this.render({ parts: ["header", "assets", "links", "footer"] });
  }

  /* -------------------------------------------- */

  /**
   * @param {string} stage
   * @param {number} [total]
   */
  #setStage(stage, total = 0) {
    this.#stage = stage;
    this.#setProgress(0, total);
  }

  /**
   * Show progress in place, without rendering.
   * @param {number} done
   * @param {number} total
   */
  #setProgress(done, total) {
    this.#progress = { done, total };
    const text = this.#statusText();
    for ( const el of this.element?.querySelectorAll(".natm-status-text") ?? [] ) el.textContent = text;
  }

  /** @returns {string} */
  #statusText() {
    const { done, total } = this.#progress;
    switch ( this.#stage ) {
      case "loading": return game.i18n.localize("NATM.App.Loading");
      case "scanning": return game.i18n.format("NATM.App.Scanning", { done, total });
      case "checking": return game.i18n.format("NATM.Assets.Checking", { done, total });
      case "error": return game.i18n.format("NATM.Errors.LoadFailed", { error: this.#error });
    }
    const entries = this.scan.entries;
    const copied = entries.filter(e => willCopy(e));
    return game.i18n.format("NATM.App.Summary", {
      assets: entries.length,
      copied: copied.length,
      size: formatBytes(sum(copied)),
      issues: this.scan.issues.size
    });
  }

  /**
   * The description only arrives with the adventure. Fill it in unless the GM typed something already.
   * @param {object} source
   */
  #fillDescription(source) {
    const field = this.form?.elements.description;
    if ( !field || field.value ) return;
    const text = (source.caption || source.description || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    field.value = text.length > 400 ? `${text.slice(0, 397)}…` : text;
  }

  /* -------------------------------------------- */

  /** @inheritDoc */
  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    this.#resolveFirstRender();
  }

  /* -------------------------------------------- */
  /*  Rendering                                   */
  /* -------------------------------------------- */

  /** @inheritDoc */
  async _preparePartContext(partId, context, options) {
    context = await super._preparePartContext(partId, context, options);
    if ( context.tabs?.[partId] ) context.tab = context.tabs[partId];
    switch ( partId ) {
      case "header": return this.#prepareHeader(context);
      case "details": return this.#prepareDetails(context);
      case "assets": return this.#prepareAssets(context);
      case "links": return this.#prepareLinks(context);
      case "footer":
        context.buttons = [{
          type: "submit", icon: "fa-solid fa-file-zipper", label: "NATM.App.Export",
          disabled: !this.#checked || this.#exporting
        }];
        return context;
    }
    return context;
  }

  /* -------------------------------------------- */

  #prepareHeader(context) {
    context.adventure = {
      name: this.adventure.name,
      img: this.adventure.img,
      pack: game.packs.get(this.adventure.pack)?.title ?? ""
    };
    context.busy = !["ready", "error"].includes(this.#stage);
    context.error = this.#stage === "error";
    context.status = this.#statusText();
    return context;
  }

  /* -------------------------------------------- */

  #prepareDetails(context) {
    const adventure = this.adventure;
    context.values = {
      id: adventure.name.slugify({ strict: true }) || "my-adventure",
      title: adventure.name,
      version: "1.0.0",
      author: game.settings.get(MODULE_ID, SETTINGS.author) || game.user.name,
      url: game.settings.get(MODULE_ID, SETTINGS.url),
      description: ""
    };
    return context;
  }

  /* -------------------------------------------- */

  #prepareAssets(context) {
    context.checked = this.#checked;
    context.busy = !["ready", "error"].includes(this.#stage);
    context.status = this.#statusText();
    context.scanned = !!this.scan && !["loading", "scanning"].includes(this.#stage);
    if ( !context.scanned ) return context;
    const groups = {};
    for ( const entry of this.scan.entries ) {
      const kind = ASSET_KINDS[entry.kind];
      const group = groups[entry.kind] ??= {
        kind: entry.kind,
        icon: kind.icon,
        label: `NATM.Kinds.${entry.kind}.Label`,
        hint: `NATM.Kinds.${entry.kind}.Hint`,
        copyable: kind.copyable,
        rows: []
      };
      group.rows.push(this.#prepareRow(entry));
    }
    context.groups = Object.keys(ASSET_KINDS).filter(k => groups[k]).map(k => {
      const group = groups[k];
      group.count = group.rows.length;
      const bytes = group.rows.reduce((n, r) => n + (r.bytes ?? 0), 0);
      group.size = bytes ? formatBytes(bytes) : "";
      return group;
    });
    context.empty = !context.groups.length;
    return context;
  }

  /* -------------------------------------------- */

  /**
   * @param {object} entry  Asset entry
   * @returns {object}
   */
  #prepareRow(entry) {
    const docs = [...entry.docs];
    const more = docs.length - MAX_TOOLTIP_DOCS;
    let tooltip = docs.slice(0, MAX_TOOLTIP_DOCS).map(foundry.utils.escapeHTML).join("<br>");
    if ( more > 0 ) tooltip += `<br>${game.i18n.format("NATM.Assets.More", { count: more })}`;
    const status = this.#checked ? entry.status : "pending";
    let bytes = entry.size;
    let note = "";
    if ( entry.wildcard ) {
      note = entry.files ? game.i18n.format("NATM.Assets.WildcardFiles", { count: entry.files.length })
        : game.i18n.localize("NATM.Assets.WildcardUnknown");
      bytes = null;
    }
    const own = (entry.kind === "module") && (entry.packageId === this.#moduleId);
    return {
      index: entry.index,
      key: entry.key,
      include: entry.include || own,
      disabled: own,
      status,
      statusIcon: STATUS_ICONS[status],
      statusLabel: `NATM.Status.${status}`,
      bytes,
      size: bytes ? formatBytes(bytes) : "",
      note,
      uses: game.i18n.format("NATM.Assets.Uses", { count: entry.count }),
      tooltip,
      module: entry.kind === "module" ? (game.modules.get(entry.packageId)?.title ?? entry.packageId) : null
    };
  }

  /* -------------------------------------------- */

  #prepareLinks(context) {
    context.scanned = !!this.scan && !["loading", "scanning"].includes(this.#stage);
    context.busy = !["ready", "error"].includes(this.#stage);
    context.status = this.#statusText();
    if ( !context.scanned ) return context;
    const issues = {};
    for ( const issue of this.scan.issues.values() ) {
      (issues[issue.type] ??= []).push({
        uuid: issue.uuid,
        name: issue.name,
        docs: [...issue.docs].join(", ")
      });
    }
    context.issueGroups = ["missingDocument", "worldPack", "sourcePack", "unknownPack"]
      .filter(t => issues[t])
      .map(type => ({ type, label: `NATM.Issues.${type}.Label`, hint: `NATM.Issues.${type}.Hint`, items: issues[type] }));

    context.dependencies = [...this.scan.dependencies.values()]
      .sort((a, b) => a.title.localeCompare(b.title, game.i18n.lang))
      .map(dep => ({
        id: dep.id,
        title: dep.title,
        installed: dep.installed,
        reasons: [...dep.reasons].map(r => game.i18n.localize(`NATM.Dependencies.Reasons.${r}`)).join(", "),
        level: this.#levels.get(dep.id)
      }));
    context.levelChoices = {
      requires: "NATM.Dependencies.Levels.requires",
      recommends: "NATM.Dependencies.Levels.recommends",
      none: "NATM.Dependencies.Levels.none"
    };
    return context;
  }

  /* -------------------------------------------- */

  /** The module id currently typed in the form. */
  get #moduleId() {
    return this.form?.elements.id?.value?.trim() ?? "";
  }

  /* -------------------------------------------- */
  /*  Events                                      */
  /* -------------------------------------------- */

  /** @inheritDoc */
  _onChangeForm(formConfig, event) {
    super._onChangeForm(formConfig, event);
    const target = event.target;
    const name = target?.name ?? "";
    if ( name.startsWith("include.") && this.scan ) {
      const entry = this.scan.entries[Number(name.slice(8))];
      if ( entry ) entry.include = target.checked;
      this.render({ parts: ["header"] });
    }
    else if ( name.startsWith("level.") ) this.#levels.set(name.slice(6), target.value);
  }

  /* -------------------------------------------- */

  /**
   * "Copy all" / "Copy none" for one group.
   * @this {PackerApp}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static #onToggleGroup(event, target) {
    const { kind, value } = target.dataset;
    const include = value === "true";
    for ( const entry of this.scan?.entries ?? [] ) {
      if ( entry.kind !== kind ) continue;
      entry.include = include;
      const box = this.form.elements[`include.${entry.index}`];
      if ( box && !box.disabled ) box.checked = include;
    }
    this.render({ parts: ["header"] });
  }

  /* -------------------------------------------- */

  /**
   * Validate the form, ask where to save, and export.
   * @this {PackerApp}
   * @param {SubmitEvent} event
   * @param {HTMLFormElement} form
   * @param {FormDataExtended} formData
   */
  static async #onSubmit(event, form, formData) {
    if ( this.#exporting || !this.#checked ) return;
    const data = formData.object;
    const options = {
      id: String(data.id ?? "").trim(),
      title: String(data.title ?? "").trim(),
      version: String(data.version ?? "").trim(),
      author: String(data.author ?? "").trim(),
      url: String(data.url ?? "").trim(),
      description: String(data.description ?? "").trim(),
      dependencies: [...this.#levels].map(([id, level]) => ({ id, level }))
    };
    if ( !/^[a-z0-9][a-z0-9_-]*$/.test(options.id) ) throw new Error(game.i18n.localize("NATM.Errors.InvalidId"));
    if ( !options.title ) throw new Error(game.i18n.localize("NATM.Errors.NoTitle"));
    if ( !options.version ) throw new Error(game.i18n.localize("NATM.Errors.NoVersion"));
    if ( (options.id === MODULE_ID) || game.system.id === options.id ) {
      throw new Error(game.i18n.localize("NATM.Errors.ReservedId"));
    }

    // The save dialog needs the click's user gesture, so it comes before anything else that waits.
    let sink;
    try {
      sink = await openSink(`${options.id}-${options.version}.zip`);
    } catch(err) {
      if ( err.name === "AbortError" ) return;
      throw err;
    }

    if ( game.modules.has(options.id) ) {
      ui.notifications.warn("NATM.Warnings.IdInstalled", { format: { id: options.id } });
    }
    this.#exporting = true;
    this.render({ parts: ["footer"] });
    const progress = ui.notifications.info("NATM.Export.Started", { localize: true, progress: true });
    let result;
    try {
      result = await exportModule(this.scan, options, sink, (done, total) => {
        progress.update({ pct: total ? done / total : 1,
          message: game.i18n.format("NATM.Export.Progress", { done, total }) });
      });
      progress.update({ pct: 1, message: game.i18n.localize("NATM.Export.Finished") });
    } catch(err) {
      progress.remove();
      await sink.abort?.().catch(() => {});
      throw err;
    } finally {
      this.#exporting = false;
      this.render({ parts: ["footer"] });
    }

    await game.settings.set(MODULE_ID, SETTINGS.author, options.author);
    await game.settings.set(MODULE_ID, SETTINGS.url, options.url);
    await showResult(result, options);
  }
}

/* -------------------------------------------- */
/*  Helpers                                     */
/* -------------------------------------------- */

const STATUS_ICONS = {
  pending: "fa-solid fa-spinner fa-spin",
  ok: "fa-solid fa-check",
  missing: "fa-solid fa-triangle-exclamation",
  unchecked: "fa-solid fa-circle-question"
};

/**
 * Required for modules the adventure takes assets or compendium content from, recommended for modules that only
 * left flags on its documents.
 * @param {{reasons: Set<string>}} dep
 * @returns {"requires"|"recommends"}
 */
function defaultLevel(dep) {
  return (dep.reasons.has("assets") || dep.reasons.has("compendium")) ? "requires" : "recommends";
}

/**
 * @param {object} entry
 * @returns {boolean}
 */
function willCopy(entry) {
  return entry.include && (entry.status !== "missing");
}

/**
 * @param {object[]} entries
 * @returns {number}
 */
function sum(entries) {
  return entries.reduce((n, e) => n + (e.size ?? 0), 0);
}

/**
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
  if ( !bytes ) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / (1024 ** i);
  return `${value.toLocaleString(game.i18n.lang, { maximumFractionDigits: i ? 1 : 0 })} ${units[i]}`;
}

/**
 * Tell the GM what was written, and which files failed.
 * @param {import("../export.js").ExportResult} result
 * @param {object} options
 */
async function showResult(result, options) {
  const esc = foundry.utils.escapeHTML;
  let content = `<p>${game.i18n.format("NATM.Result.Done", {
    id: esc(options.id), files: result.files, size: formatBytes(result.bytes)
  })}</p>`;
  if ( !result.streamed ) content += `<p>${game.i18n.localize("NATM.Result.Downloaded")}</p>`;
  if ( result.failures.length ) {
    content += `<p>${game.i18n.format("NATM.Result.Failures", { count: result.failures.length })}</p>`;
    content += `<ul class="natm-failures">${result.failures
      .map(f => `<li><code>${esc(f.src)}</code> <span>${esc(f.error)}</span></li>`).join("")}</ul>`;
  }
  content += `<p class="hint">${game.i18n.localize("NATM.Result.Install")}</p>`;
  await DialogV2.prompt({
    window: { title: "NATM.Result.Title", icon: "fa-solid fa-file-zipper" },
    classes: [MODULE_ID],
    content,
    ok: { label: "NATM.Result.Ok", icon: "fa-solid fa-check" },
    rejectClose: false
  });
}
