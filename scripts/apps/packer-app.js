import { ASSET_KINDS, MODULE_ID, SETTINGS } from "../constants.js";
import AdventureScan from "../scan.js";
import { exportModule, planAssets } from "../export.js";
import { openSink } from "../zip.js";
import { MAX_ENTRIES, WORLD, canPackIn, packInLinks } from "../link-pack.js";

const { ApplicationV2, HandlebarsApplicationMixin, DialogV2 } = foundry.applications.api;

/** Most document labels listed in a tooltip. */
const MAX_TOOLTIP_DOCS = 12;

/** Size from which an export that is held in memory (no direct saving) asks first. */
const LARGE_IN_MEMORY = 1024 ** 3;

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
      toggleGroup: PackerApp.#onToggleGroup,
      cancelExport: PackerApp.#onCancelExport
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

  /** @type {AbortController|null} Cancels the running export. */
  #abort = null;

  /** @type {Map<string, string>} Dependency level chosen per module. */
  #levels = new Map();

  /** @type {Set<string>} Modules whose dependency level the GM chose by hand. Those are never changed automatically. */
  #manualLevels = new Set();

  /** The adventure as loaded, and its scan. Packing in linked entries starts from these each time. */
  #baseSource = null;
  #baseScan = null;

  /** @type {Set<string>} Compendiums whose linked entries are packed into the adventure. */
  #packIn = new Set();

  /** Add linked world documents that are not part of the adventure. On by default: it is the GM's own content. */
  #packWorld = true;

  /** @type {import("../link-pack.js").PackInResult|null} */
  #packResult = null;

  /* -------------------------------------------- */

  /** Load and scan the adventure, then pack in linked entries and check its files. */
  async #load() {
    const times = [performance.now()];
    try {
      const { pack, id } = this.adventure;
      const source = this.adventure.source ?? await AdventureScan.load(pack, id);
      delete this.adventure.source;
      Object.assign(this.adventure, { name: source.name, img: source.img });
      times.push(performance.now());

      this.#baseSource = source;
      this.#baseScan = new AdventureScan(source, { pack });
      this.#setStage("scanning");
      await this.#baseScan.collect((done, total) => this.#setProgress(done, total));
      times.push(performance.now());
      console.debug(`${MODULE_ID} | ${source.name}: loaded in ${Math.round(times[1] - times[0])} ms, scanned in `
        + `${Math.round(times[2] - times[1])} ms`);

      // World compendiums are the GM's own content, and other GMs don't have them: pack them in by default.
      for ( const collection of this.#baseScan.compendiumLinks.keys() ) {
        const linked = game.packs.get(collection);
        if ( (linked?.metadata.packageType === "world") && canPackIn(linked) ) this.#packIn.add(collection);
      }
      await this.#firstRender;
      this.#fillDescription(source);
    } catch(err) {
      this.#fail(err);
      return;
    }
    await this.#rebuild();
  }

  /* -------------------------------------------- */

  /**
   * Build the adventure to export: pack in the linked entries of the chosen compendiums, scan the result, keep the
   * GM's choices from the previous scan, and check the files that are new.
   */
  async #rebuild() {
    const previous = this.scan;
    try {
      let scan = this.#baseScan;
      this.#packResult = null;
      if ( this.#packIn.size || this.#packWorld ) {
        this.#setStage("packing");
        this.#packResult = await packInLinks(this.#baseSource, this.#packIn, {
          world: this.#packWorld,
          worldFolder: game.i18n.localize("NATM.PackIn.WorldFolder"),
          onProgress: (done, total) => this.#setProgress(done, total)
        });
        scan = new AdventureScan(this.#packResult.source, { pack: this.adventure.pack });
        this.#setStage("scanning");
        await scan.collect((done, total) => this.#setProgress(done, total));
      }
      if ( previous && (previous !== scan) ) scan.adopt(previous);
      this.scan = scan;
      this.#levels = new Map([...scan.dependencies.values()].map(dep => {
        const manual = this.#manualLevels.has(dep.id) && this.#levels.has(dep.id);
        return [dep.id, manual ? this.#levels.get(dep.id) : autoLevel(scan, dep)];
      }));

      this.#setStage("checking");
      await this.render({ parts: ["header", "assets", "links", "footer"] });
      await scan.check((done, total) => this.#setProgress(done, total));
      this.#setStage("ready");
    } catch(err) {
      this.#fail(err);
      return;
    }
    if ( this.rendered ) this.render({ parts: ["header", "assets", "links", "footer"] });
  }

  /* -------------------------------------------- */

  /** @param {Error} err */
  #fail(err) {
    console.error(`${MODULE_ID} | Loading the adventure failed`, err);
    this.#error = err.message;
    this.#setStage("error");
    ui.notifications.error("NATM.Errors.LoadFailed", { format: { error: err.message } });
    this.#firstRender.then(() => {
      if ( this.rendered ) this.render({ parts: ["header", "assets", "links", "footer"] });
    });
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
      case "packing": return game.i18n.format("NATM.App.Packing", { done, total });
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
        context.buttons = this.#exporting
          ? [{ type: "button", action: "cancelExport", icon: "fa-solid fa-ban", label: "NATM.App.Cancel" }]
          : [{ type: "submit", icon: "fa-solid fa-file-zipper", label: "NATM.App.Export", disabled: !this.#checked }];
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
        // Inactive modules matter too: their compendiums can't be read, so their links can't be checked or packed in.
        warning: dep.active ? "" : `NATM.Dependencies.${dep.installed ? "Inactive" : "NotInstalled"}`,
        reasons: [...dep.reasons].map(r => game.i18n.localize(`NATM.Dependencies.Reasons.${r}`)).join(", "),
        level: this.#levels.get(dep.id),
        allCopied: dep.reasons.has("assets") && allFilesCopied(this.scan, dep.id)
      }));
    context.compendiums = this.#prepareCompendiums(context.busy);
    context.packLimited = this.#packResult?.limited ? game.i18n.format("NATM.PackIn.Limited", { max: MAX_ENTRIES }) : "";
    context.levelChoices = {
      requires: "NATM.Dependencies.Levels.requires",
      recommends: "NATM.Dependencies.Levels.recommends",
      none: "NATM.Dependencies.Levels.none"
    };
    return context;
  }

  /* -------------------------------------------- */

  /**
   * The compendiums the adventure links to: those of the loaded adventure, and those only linked from packed-in
   * entries.
   * @param {boolean} busy
   * @returns {object[]}
   */
  #prepareCompendiums(busy) {
    const linked = new Map();
    for ( const scan of [this.#baseScan, this.scan] ) {
      for ( const [collection, ids] of scan?.compendiumLinks ?? [] ) {
        if ( !linked.has(collection) ) linked.set(collection, new Set());
        for ( const id of ids ) linked.get(collection).add(id);
      }
    }
    const order = { world: 0, module: 1, system: 2 };
    const rows = [];
    // World documents the adventure links to but doesn't contain
    const missing = [...this.#baseScan?.issues.values() ?? []].filter(i => i.type === "missingDocument").length;
    const worldStat = this.#packResult?.stats.get(WORLD);
    if ( missing || worldStat?.packed ) {
      let note = "";
      if ( worldStat ) {
        note = game.i18n.format("NATM.PackIn.Packed", { count: worldStat.packed });
        if ( worldStat.missing ) note += ` ${game.i18n.format("NATM.PackIn.Missing", { count: worldStat.missing })}`;
      }
      rows.push({
        collection: WORLD,
        title: game.i18n.localize("NATM.PackIn.WorldDocuments"),
        owner: game.world.title,
        linked: game.i18n.format("NATM.PackIn.Linked", { count: missing }),
        checked: this.#packWorld,
        disabled: busy,
        note,
        sort: -1
      });
    }
    return rows.concat([...linked].map(([collection, ids]) => {
      const pack = game.packs.get(collection);
      const { packageType, packageName } = pack?.metadata ?? {};
      let owner = game.i18n.localize("NATM.PackIn.Unavailable");
      if ( packageType === "world" ) owner = game.i18n.localize("NATM.PackIn.World");
      else if ( packageType === "module" ) owner = game.modules.get(packageName)?.title ?? packageName;
      else if ( packageType === "system" ) owner = game.system.title;
      const stat = this.#packResult?.stats.get(collection);
      const packable = canPackIn(pack) && (collection !== this.adventure.pack);
      let note = "";
      if ( !pack ) note = game.i18n.localize("NATM.PackIn.NotAvailable");
      else if ( packageType === "system" ) note = game.i18n.localize("NATM.PackIn.SystemPack");
      else if ( !packable ) note = game.i18n.localize("NATM.PackIn.NotPackable");
      else if ( stat ) {
        note = game.i18n.format("NATM.PackIn.Packed", { count: stat.packed });
        if ( stat.missing ) note += ` ${game.i18n.format("NATM.PackIn.Missing", { count: stat.missing })}`;
      }
      return {
        collection,
        title: pack?.title ?? collection,
        owner,
        linked: game.i18n.format("NATM.PackIn.Linked", { count: ids.size }),
        checked: this.#packIn.has(collection),
        disabled: busy || !packable,
        note,
        sort: order[packageType] ?? 3
      };
    })).sort((a, b) => (a.sort - b.sort) || a.title.localeCompare(b.title, game.i18n.lang));
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
    if ( this.#exporting ) return; // The tabs are inert while exporting; this is a safety net
    if ( name.startsWith("include.") && this.scan ) {
      const entry = this.scan.entries[Number(name.slice(8))];
      if ( entry ) entry.include = target.checked;
      this.render({ parts: ["header"] });
      if ( entry?.kind === "module" ) this.#syncAssetDependencies([entry.packageId]);
    }
    else if ( name.startsWith("packIn.") ) {
      if ( !["ready", "error"].includes(this.#stage) || !this.#baseScan ) {
        target.checked = !target.checked; // Busy: the checkboxes are disabled again on the next render
        return;
      }
      const collection = name.slice(7);
      if ( collection === WORLD ) this.#packWorld = target.checked;
      else if ( target.checked ) this.#packIn.add(collection);
      else this.#packIn.delete(collection);
      this.#rebuild();
    }
    else if ( name.startsWith("level.") ) {
      const id = name.slice(6);
      this.#levels.set(id, target.value);
      this.#manualLevels.add(id);
    }
  }

  /* -------------------------------------------- */

  /**
   * A module the adventure only needs for its files is not listed once all of them are copied, and becomes required
   * again when one is unticked. Modules the GM set by hand, and modules also needed for compendium links or module
   * data, are left alone.
   * @param {Iterable<string>} moduleIds
   */
  #syncAssetDependencies(moduleIds) {
    for ( const id of new Set(moduleIds) ) {
      const dep = this.scan.dependencies.get(id);
      if ( !dep || this.#manualLevels.has(id) ) continue;
      this.#levels.set(id, autoLevel(this.scan, dep));
    }
    // The links part holds no other inputs: its selects are rendered from #levels, and the "all files copied" notes
    // change with the checkboxes.
    this.render({ parts: ["links"] });
  }

  /* -------------------------------------------- */

  /**
   * "Copy all" / "Copy none" for one group.
   * @this {PackerApp}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static #onToggleGroup(event, target) {
    if ( this.#exporting ) return;
    const { kind, value } = target.dataset;
    const include = value === "true";
    for ( const entry of this.scan?.entries ?? [] ) {
      if ( entry.kind !== kind ) continue;
      entry.include = include;
      const box = this.form.elements[`include.${entry.index}`];
      if ( box && !box.disabled ) box.checked = include;
    }
    this.render({ parts: ["header"] });
    if ( kind === "module" ) {
      this.#syncAssetDependencies(this.scan.entries.filter(e => e.kind === "module").map(e => e.packageId));
    }
  }

  /* -------------------------------------------- */

  /**
   * Cancel the running export.
   * @this {PackerApp}
   */
  static #onCancelExport() {
    this.#abort?.abort();
  }

  /* -------------------------------------------- */

  /**
   * Lock the tabs while an export runs, so nothing the export reads changes under it, and swap Export for Cancel.
   * @param {boolean} exporting
   */
  #setExporting(exporting) {
    this.#exporting = exporting;
    for ( const tab of this.element?.querySelectorAll(".tab[data-group='sheet']") ?? [] ) tab.inert = exporting;
    this.element?.classList.toggle("natm-exporting", exporting);
    this.render({ parts: ["footer"] });
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

    // Without direct saving, the browser holds the whole ZIP in memory until the download starts.
    if ( !sink.streamed ) {
      const bytes = planAssets(this.scan, options.id).plan.reduce((n, p) => n + (p.entry.size ?? 0), 0);
      if ( bytes > LARGE_IN_MEMORY ) {
        const proceed = await DialogV2.confirm({
          window: { title: "NATM.Warnings.LargeTitle", icon: "fa-solid fa-memory" },
          content: `<p>${game.i18n.format("NATM.Warnings.LargeInMemory", { size: formatBytes(bytes) })}</p>`,
          rejectClose: false
        });
        if ( !proceed ) {
          await sink.abort?.();
          return;
        }
      }
    }

    if ( game.modules.has(options.id) ) {
      ui.notifications.warn("NATM.Warnings.IdInstalled", { format: { id: options.id } });
    }
    const scan = this.scan;
    this.#abort = new AbortController();
    this.#setExporting(true);
    const progress = ui.notifications.info("NATM.Export.Started", { localize: true, progress: true });
    let result;
    try {
      result = await exportModule(scan, options, sink, (done, total) => {
        progress.update({ pct: total ? done / total : 1,
          message: game.i18n.format("NATM.Export.Progress", { done, total }) });
      }, { signal: this.#abort.signal });
      progress.update({ pct: 1, message: game.i18n.localize("NATM.Export.Finished") });
    } catch(err) {
      progress.remove();
      await sink.abort?.().catch(() => {});
      if ( err?.name === "AbortError" ) {
        ui.notifications.info("NATM.Export.Cancelled", { localize: true });
        return;
      }
      throw err;
    } finally {
      this.#abort = null;
      this.#setExporting(false);
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
 * The level a dependency gets automatically: not listed if the adventure only needs the module for its files and all
 * of them are copied, otherwise the default.
 * @param {AdventureScan} scan
 * @param {{id: string, reasons: Set<string>}} dep
 * @returns {"requires"|"recommends"|"none"}
 */
function autoLevel(scan, dep) {
  const onlyFiles = (dep.reasons.size === 1) && dep.reasons.has("assets");
  return (onlyFiles && allFilesCopied(scan, dep.id)) ? "none" : defaultLevel(dep);
}

/**
 * Whether every file of a module that exists here is ticked for copying.
 * @param {AdventureScan} scan
 * @param {string} moduleId
 * @returns {boolean}
 */
function allFilesCopied(scan, moduleId) {
  const files = scan.entries.filter(e => (e.kind === "module") && (e.packageId === moduleId) && (e.status !== "missing"));
  return files.length > 0 && files.every(e => e.include);
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
