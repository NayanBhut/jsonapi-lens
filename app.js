/* JSON:API Lens — application state, views, and input pipeline. */
(function () {
  "use strict";

  var Lens = window.Lens;
  var core = window.JsonApiCore;
  var el = Lens.el;
  var isObject = Lens.isObject;

  var STORE_INPUT = "jsonapi-lens:input";
  var STORE_THEME = "jsonapi-lens:theme";
  var STORE_TAB = "jsonapi-lens:tab";
  var STORE_DEPTH = "jsonapi-lens:depth";
  var ISSUE_RENDER_LIMIT = 200;
  // Hard ceiling for parsing. Beyond this the renderer can run out of memory,
  // so the app refuses the document instead of freezing the page.
  var MAX_INPUT_CHARS = 50 * 1024 * 1024;
  // Above this size, skip pretty-printing (it roughly doubles the string and
  // can take tens of seconds) and show the original text instead.
  var JSON_PRETTY_LIMIT = 8 * 1024 * 1024;
  // Individual attribute values larger than this are summarized, not dumped.
  var VALUE_PREVIEW_LIMIT = 200000;

  var state = (Lens.state = {
    raw: "",
    doc: undefined,
    model: null,
    issues: [],
    parseError: null,
    tooLarge: null,
    tab: "tree",
    expanded: new Set(),
    maxDepth: 4,
    includedOpen: true,
    showAllIncluded: false,
    primaryRenderCount: 200,
    wrapJson: false,
    selectedGraphKey: null,
    graphTransform: null,
    graphUserAdjusted: false,
    graphLabels: true,
    graphShowMissing: false,
    theme: "dark"
  });

  var ui = {};

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------

  function init() {
    ui.editor = document.getElementById("editor");
    ui.view = document.getElementById("view");
    ui.summary = document.getElementById("summary");
    ui.tabs = document.getElementById("tabs");
    ui.issuesCount = document.getElementById("issues-count");
    ui.statusDot = document.getElementById("parse-dot");
    ui.statusText = document.getElementById("parse-status");
    ui.inputMeta = document.getElementById("input-meta");
    ui.dropzone = document.getElementById("dropzone");
    ui.exampleSelect = document.getElementById("example-select");
    ui.fileInput = document.getElementById("file-input");
    ui.themeToggle = document.getElementById("theme-toggle");
    ui.formatBtn = document.getElementById("format-btn");
    ui.clearBtn = document.getElementById("clear-btn");
    ui.uploadBtn = document.getElementById("upload-btn");
    ui.urlBtn = document.getElementById("url-btn");
    ui.urlBar = document.getElementById("url-bar");
    ui.urlInput = document.getElementById("url-input");
    ui.urlLoad = document.getElementById("url-load");
    ui.urlClose = document.getElementById("url-close");

    state.theme = Lens.readStore(STORE_THEME) === "light" ? "light" : "dark";
    applyTheme(state.theme);

    var savedTab = Lens.readStore(STORE_TAB);
    if (["tree", "graph", "json", "issues"].indexOf(savedTab) !== -1) state.tab = savedTab;

    var savedDepth = Number(Lens.readStore(STORE_DEPTH));
    if ([2, 3, 4, 5, 6, 8].indexOf(savedDepth) !== -1) state.maxDepth = savedDepth;

    Lens.renderView = renderView;
    wireEvents();

    var saved = Lens.readStore(STORE_INPUT);
    if (saved === null) {
      loadExample("deep", { silent: true });
    } else {
      ui.editor.value = saved;
      applyInput(saved, { silent: true });
    }
  }

  function applyTheme(theme) {
    state.theme = theme === "light" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", state.theme);
    if (ui.themeToggle) {
      ui.themeToggle.textContent = state.theme === "light" ? "☀" : "☾";
      ui.themeToggle.setAttribute("aria-label", state.theme === "light" ? "Switch to dark theme" : "Switch to light theme");
    }
    Lens.writeStore(STORE_THEME, state.theme);
  }

  // -------------------------------------------------------------------------
  // Input pipeline
  // -------------------------------------------------------------------------

  function loadExample(name, options) {
    var example = Lens.examples[name];
    if (!example) return;
    var text = JSON.stringify(example, null, 2);
    ui.editor.value = text;
    ui.exampleSelect.value = "";
    state.tab = "tree";
    Lens.writeStore(STORE_TAB, "tree");
    applyInput(text, { resetExpansion: true });
    if (!options || !options.silent) {
      Lens.toast("Loaded example document");
    }
  }

  function applyInput(text, options) {
    state.raw = typeof text === "string" ? text : "";
    state.graphTransform = null;
    state.graphUserAdjusted = false;
    state.selectedGraphKey = null;
    state.showAllIncluded = false;
    state.primaryRenderCount = 200;
    state.tooLarge = null;

    if (!state.raw.trim()) {
      state.parseError = null;
      state.doc = undefined;
      state.model = null;
      state.issues = [];
      if (options && options.resetExpansion) state.expanded = new Set();
      persistInput("");
      updateStatus();
      renderAll();
      ui.view.scrollTop = 0;
      return;
    }

    if (state.raw.length > MAX_INPUT_CHARS) {
      state.tooLarge = state.raw.length;
      state.parseError = null;
      state.doc = undefined;
      state.model = null;
      state.issues = [];
      if (options && options.resetExpansion) state.expanded = new Set();
      persistInput("");
      updateStatus();
      renderAll();
      ui.view.scrollTop = 0;
      return;
    }

    var parsed = core.parseJson(state.raw);
    if (!parsed.ok) {
      state.parseError = parsed.error;
      state.doc = undefined;
      state.model = null;
      state.issues = [];
      if (options && options.resetExpansion) state.expanded = new Set();
      persistInput(state.raw);
      updateStatus();
      renderAll();
      ui.view.scrollTop = 0;
      return;
    }

    state.parseError = null;
    state.doc = parsed.value;
    state.model = core.buildModel(parsed.value);
    state.issues = core.validate(parsed.value);
    if (state.model.kind === "plain" && state.tab === "graph") state.tab = "tree";
    if (options && options.resetExpansion) state.expanded = new Set();
    persistInput(state.raw);
    updateStatus();
    renderAll();
    ui.view.scrollTop = 0;
  }

  function persistInput(text) {
    if (text.length > 1500000) {
      Lens.removeStore(STORE_INPUT);
      return;
    }
    Lens.writeStore(STORE_INPUT, text);
  }

  function updateStatus() {
    if (!ui.statusDot) return;
    ui.statusDot.classList.remove("ok", "bad");
    ui.statusText.removeAttribute("title");

    var bytes;
    var lines;

    if (state.tooLarge) {
      ui.statusDot.classList.add("bad");
      ui.statusText.textContent = "Document too large";
      ui.statusText.title =
        "This document is " + Lens.formatBytes(state.tooLarge) + ". The viewer accepts up to " + Lens.formatBytes(MAX_INPUT_CHARS) + ".";
      ui.inputMeta.textContent = Lens.formatBytes(state.tooLarge);
      return;
    }

    bytes = new Blob([state.raw]).size;
    lines = state.raw ? state.raw.split("\n").length : 0;

    if (state.parseError) {
      ui.statusDot.classList.add("bad");
      ui.statusText.textContent = "Invalid JSON";
      ui.statusText.title = state.parseError.message;
      if (state.parseError.line) {
        ui.inputMeta.textContent =
          "line " + state.parseError.line + (state.parseError.column ? ", col " + state.parseError.column : "");
      } else {
        ui.inputMeta.textContent = Lens.formatBytes(bytes);
      }
      return;
    }

    if (state.model) {
      ui.statusDot.classList.add("ok");
      ui.statusText.textContent = "Valid JSON";
      var parts = [];
      if (lines) parts.push(lines + " lines");
      if (bytes) parts.push(Lens.formatBytes(bytes));
      if (state.model.kind === "plain") {
        if (Array.isArray(state.doc)) {
          parts.push(state.doc.length + (state.doc.length === 1 ? " item" : " items"));
        } else if (isObject(state.doc)) {
          var keyCount = Object.keys(state.doc).length;
          parts.push(keyCount + (keyCount === 1 ? " key" : " keys"));
        } else {
          parts.push("1 value");
        }
      } else {
        parts.push(state.model.stats.primaryCount + state.model.stats.includedCount + " resources");
      }
      ui.inputMeta.textContent = parts.join(" · ");
    } else {
      ui.statusText.textContent = "Waiting for input";
      ui.inputMeta.textContent = "";
    }
  }

  // -------------------------------------------------------------------------
  // Summary + tabs
  // -------------------------------------------------------------------------

  function countSeverity(severity) {
    return state.issues.filter(function (issue) {
      return issue.severity === severity;
    }).length;
  }

  function makeChip(kind, title, action) {
    var attrs = { class: "chip" + (kind ? " " + kind : "") };
    if (title) attrs.title = title;
    if (action) {
      attrs.type = "button";
      attrs.dataset = { action: action };
    }
    return el(action ? "button" : "span", attrs);
  }

  function renderSummary() {
    var summary = ui.summary;
    summary.textContent = "";

    if (state.parseError) {
      var badChip = makeChip("is-bad", state.parseError.message);
      badChip.appendChild(el("span", { class: "chip-dot" }));
      badChip.appendChild(el("b", {}, "Invalid JSON"));
      summary.appendChild(badChip);
      if (state.parseError.line) {
        var lineChip = makeChip("", "The parser could not read this document");
        lineChip.appendChild(el("b", {}, "line " + state.parseError.line));
        if (state.parseError.column) {
          lineChip.appendChild(document.createTextNode(", col " + state.parseError.column));
        }
        summary.appendChild(lineChip);
      }
      return;
    }

    if (state.tooLarge) {
      var bigChip = makeChip("is-bad", "Document exceeds the " + Lens.formatBytes(MAX_INPUT_CHARS) + " limit");
      bigChip.appendChild(el("span", { class: "chip-dot" }));
      bigChip.appendChild(el("b", {}, "Too large"));
      summary.appendChild(bigChip);
      return;
    }

    if (!state.model) return;

    var errors = countSeverity("error");
    var warnings = countSeverity("warning");
    var infos = countSeverity("info");
    var model = state.model;

    if (model.kind === "plain") {
      var plainChip = makeChip("is-info", "This document is valid JSON but not JSON:API, so it is not validated.");
      plainChip.appendChild(el("b", {}, "Plain JSON"));
      summary.appendChild(plainChip);
      return;
    }

    var statusKind = errors ? "is-bad" : warnings ? "is-warn" : "is-ok";
    var statusText = errors
      ? errors + " error" + (errors === 1 ? "" : "s")
      : warnings
      ? warnings + " warning" + (warnings === 1 ? "" : "s")
      : model.kind === "errors"
      ? "Valid error document"
      : "Valid JSON:API";
    var status = makeChip(statusKind, "Open the validation report", "open-issues");
    status.appendChild(el("span", { class: "chip-dot" }));
    status.appendChild(el("b", {}, statusText));
    summary.appendChild(status);

    if (errors && warnings) {
      var warnChip = makeChip("is-warn", "Open the validation report", "open-issues");
      warnChip.appendChild(el("span", { class: "chip-dot" }));
      warnChip.appendChild(el("b", {}, String(warnings)));
      warnChip.appendChild(document.createTextNode(" warnings"));
      summary.appendChild(warnChip);
    }

    if (!errors && !warnings && infos) {
      var infoChip = makeChip("is-info", "Open the validation report", "open-issues");
      infoChip.appendChild(el("span", { class: "chip-dot" }));
      infoChip.appendChild(el("b", {}, String(infos)));
      infoChip.appendChild(document.createTextNode(" notes"));
      summary.appendChild(infoChip);
    }

    var primaryLabel;
    var primaryKind = "";
    if (model.kind === "errors") {
      primaryLabel = (Array.isArray(state.doc.errors) ? state.doc.errors.length : 0) + " error objects";
    } else if (model.kind === "null") {
      primaryLabel = "data: null";
    } else if (model.kind === "meta") {
      primaryLabel = "meta document";
    } else if (model.kind === "invalid") {
      primaryLabel = "invalid document";
      primaryKind = "is-bad";
    } else if (model.kind === "resource") {
      primaryLabel = "1 primary resource";
    } else {
      primaryLabel = model.stats.primaryCount + " primary resource" + (model.stats.primaryCount === 1 ? "" : "s");
    }
    var primaryChip = makeChip(primaryKind, "Top-level data");
    primaryChip.appendChild(el("b", {}, primaryLabel));
    summary.appendChild(primaryChip);

    if (model.stats.includedCount) {
      var includedChip = makeChip("", "Resources resolved from the included array");
      includedChip.appendChild(el("b", {}, String(model.stats.includedCount)));
      includedChip.appendChild(document.createTextNode(" included"));
      summary.appendChild(includedChip);
    }

    if (model.stats.edgeCount) {
      var edgeChip = makeChip("", "Relationship linkage entries across all resources");
      edgeChip.appendChild(el("b", {}, String(model.stats.edgeCount)));
      edgeChip.appendChild(document.createTextNode(" linkages"));
      summary.appendChild(edgeChip);
    }

    if (model.stats.typeCount) {
      var typesChip = makeChip(
        "",
        model.types
          .map(function (entry) {
            return entry.type + " (" + entry.primary + " primary, " + entry.included + " included)";
          })
          .join("\n")
      );
      typesChip.appendChild(el("b", {}, String(model.stats.typeCount)));
      typesChip.appendChild(document.createTextNode(" types"));
      summary.appendChild(typesChip);
    }

    if (model.stats.missingCount) {
      var missingChip = makeChip(
        "is-warn",
        "Linkage points to resources that are not present in data or included"
      );
      missingChip.appendChild(el("span", { class: "chip-dot" }));
      missingChip.appendChild(el("b", {}, String(model.stats.missingCount)));
      missingChip.appendChild(document.createTextNode(" unresolved"));
      summary.appendChild(missingChip);
    }

    if (model.orphanIncluded.size) {
      var orphanChip = makeChip("is-warn", "Included resources are not reachable through any relationship");
      orphanChip.appendChild(el("span", { class: "chip-dot" }));
      orphanChip.appendChild(el("b", {}, String(model.orphanIncluded.size)));
      orphanChip.appendChild(document.createTextNode(" unlinked"));
      summary.appendChild(orphanChip);
    }

    if (isObject(state.doc) && isObject(state.doc.jsonapi) && state.doc.jsonapi.version) {
      var version = String(state.doc.jsonapi.version);
      var versionChip = makeChip(/^1\.\d+$/.test(version) ? "is-info" : "is-warn", "jsonapi.version");
      versionChip.appendChild(el("b", {}, "JSON:API " + version));
      summary.appendChild(versionChip);
    }
  }

  function renderTabs() {
    if (!ui.tabs) return;
    var plain = !!state.model && state.model.kind === "plain";
    Array.prototype.forEach.call(ui.tabs.querySelectorAll(".tab"), function (tab) {
      var active = tab.dataset.tab === state.tab;
      var disabled = plain && tab.dataset.tab === "graph";
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-selected", active ? "true" : "false");
      tab.disabled = disabled;
      tab.setAttribute("aria-disabled", disabled ? "true" : "false");
      tab.title = disabled ? "Graph is only available for JSON:API documents" : "";
    });

    var errors = countSeverity("error");
    var warnings = countSeverity("warning");
    ui.issuesCount.textContent = String(state.issues.length);
    ui.issuesCount.classList.toggle("has-errors", errors > 0);
    ui.issuesCount.classList.toggle("has-warnings", errors === 0 && warnings > 0);
    ui.issuesCount.title = errors + " errors, " + warnings + " warnings, " + countSeverity("info") + " notes";
  }

  function renderAll() {
    renderSummary();
    renderTabs();
    renderView();
  }

  function switchTab(tab) {
    if (tab === "graph" && state.model && state.model.kind === "plain") return;
    if (tab === state.tab) {
      renderView();
      return;
    }
    state.tab = tab;
    Lens.writeStore(STORE_TAB, tab);
    renderTabs();
    renderView();
    ui.view.scrollTop = 0;
  }

  // -------------------------------------------------------------------------
  // View dispatch
  // -------------------------------------------------------------------------

  function renderView() {
    var view = ui.view;
    view.classList.toggle("view--graph", state.tab === "graph" && !state.parseError && !state.tooLarge);
    view.textContent = "";

    if (state.tooLarge) {
      view.appendChild(renderTooLarge());
      return;
    }

    if (state.parseError) {
      view.appendChild(renderParseError());
      return;
    }

    if (!state.model) {
      view.appendChild(renderEmpty());
      return;
    }

    if (state.tab === "graph") {
      var graph = Lens.renderGraph();
      view.appendChild(graph);
      Lens.mountGraph(graph);
      return;
    }

    if (state.tab === "json") {
      view.appendChild(renderJsonView());
      return;
    }

    if (state.tab === "issues") {
      view.appendChild(renderIssuesView());
      return;
    }

    view.appendChild(Lens.renderTree());
  }

  // -------------------------------------------------------------------------
  // Empty state
  // -------------------------------------------------------------------------

  function renderEmpty() {
    var wrap = el("div", { class: "empty" });
    wrap.appendChild(el("div", { class: "empty-mark" }, "{ }"));
    wrap.appendChild(el("h2", {}, "Follow every relationship, all the way down"));

    var actions = el("div", { class: "empty-actions" });
    actions.appendChild(
      el("button", { class: "primary-btn", type: "button", dataset: { action: "load-example", name: "deep" } }, "Load deep example")
    );
    actions.appendChild(
      el("button", { class: "secondary-btn", type: "button", dataset: { action: "load-example", name: "violations" } }, "See validation")
    );
    wrap.appendChild(actions);

    wrap.appendChild(
      el(
        "p",
        {},
        "Paste or drop a JSON:API document in the editor. Relationships are resolved recursively through included — including the ones the usual viewers stop at."
      )
    );

    var features = el("div", { class: "empty-features" });
    [
      ["Recursive", "included resolution"],
      ["Cycle", "detection"],
      ["Full-linkage", "validation"],
      ["Interactive", "relationship graph"],
      ["Local", "nothing uploaded"]
    ].forEach(function (pair) {
      var pill = el("span", { class: "feature-pill" });
      pill.appendChild(el("b", {}, pair[0]));
      pill.appendChild(document.createTextNode(" " + pair[1]));
      features.appendChild(pill);
    });
    wrap.appendChild(features);
    return wrap;
  }

  // -------------------------------------------------------------------------
  // Parse error view
  // -------------------------------------------------------------------------

  function renderTooLarge() {
    var wrap = el("div", { class: "parse-error" });
    var head = el("div", { class: "parse-error-head" });
    head.appendChild(el("div", { class: "parse-error-icon" }, "!"));
    var headText = el("div", {});
    headText.appendChild(el("h2", {}, "This document is too large to open"));
    headText.appendChild(
      el(
        "p",
        {},
        "It is " +
          Lens.formatBytes(state.tooLarge) +
          ". The viewer accepts up to " +
          Lens.formatBytes(MAX_INPUT_CHARS) +
          " so the page stays responsive instead of running out of memory."
      )
    );
    head.appendChild(headText);
    wrap.appendChild(head);

    var meta = el("div", { class: "parse-error-meta" });
    meta.appendChild(el("span", { class: "chip is-bad" }, Lens.formatBytes(state.tooLarge)));
    meta.appendChild(el("span", { class: "chip" }, "Limit " + Lens.formatBytes(MAX_INPUT_CHARS)));
    wrap.appendChild(meta);

    wrap.appendChild(
      el(
        "div",
        { class: "parse-hint" },
        el("span", { class: "tip" }, "Tip"),
        el(
          "span",
          {},
          "Filter or paginate the response first, then open a smaller document. Your input stays in the editor, so nothing is lost."
        )
      )
    );

    return wrap;
  }

  function renderParseError() {
    var error = state.parseError;
    var wrap = el("div", { class: "parse-error" });
    var head = el("div", { class: "parse-error-head" });
    head.appendChild(el("div", { class: "parse-error-icon" }, "!"));
    var headText = el("div", {});
    headText.appendChild(el("h2", {}, "Couldn't parse this JSON"));
    var message = String(error.message || "Unknown parse error").replace(/^JSON\.parse:\s*/i, "");
    if (message.length > 190) message = message.slice(0, 190) + "…";
    headText.appendChild(el("p", {}, message));
    head.appendChild(headText);
    wrap.appendChild(head);

    var meta = el("div", { class: "parse-error-meta" });
    if (error.line) {
      meta.appendChild(el("span", { class: "chip is-bad" }, "Line " + error.line));
      if (error.column) meta.appendChild(el("span", { class: "chip is-bad" }, "Column " + error.column));
    }
    meta.appendChild(el("span", { class: "chip" }, Lens.formatBytes(new Blob([state.raw]).size)));
    wrap.appendChild(meta);

    var lines = state.raw.split("\n");
    var badIndex = error.line ? error.line - 1 : -1;
    var center = badIndex >= 0 ? badIndex : 0;
    var start = Math.max(0, center - 3);
    var end = Math.min(lines.length, center + 3);

    if (lines.length && (lines[0] !== "" || lines.length > 1)) {
      var snippet = el("pre", { class: "code-snippet" });
      for (var i = start; i < end; i += 1) {
        var row = el("div", { class: "snippet-line" + (i === badIndex ? " is-bad" : "") });
        row.appendChild(el("span", { class: "ln" }, String(i + 1)));
        row.appendChild(el("span", {}, lines[i]));
        snippet.appendChild(row);
      }
      wrap.appendChild(snippet);
    }

    wrap.appendChild(
      el(
        "div",
        { class: "parse-hint" },
        el("span", { class: "tip" }, "Tip"),
        el(
          "span",
          {},
          "Typical culprits are a trailing comma, an unquoted key, or a string that starts with an apostrophe. Your input stays in the editor — nothing is lost."
        )
      )
    );

    return wrap;
  }

  // -------------------------------------------------------------------------
  // JSON view
  // -------------------------------------------------------------------------

  function renderJsonView() {
    var text;
    var note = null;
    if (state.raw.length > JSON_PRETTY_LIMIT) {
      text = state.raw;
      note = "This document is too large to pretty-print, so the original text is shown.";
    } else {
      try {
        text = JSON.stringify(state.doc, null, 2);
      } catch (err) {
        text = state.raw;
        note = "This document is too deeply nested to pretty-print, so the original text is shown.";
      }
    }
    if (text === undefined) text = "null";
    var wrap = el("div", {});

    var toolbar = el("div", { class: "json-toolbar" });
    toolbar.appendChild(el("span", { class: "toolbar-label" }, "Document"));
    var copyBtn = el("button", { class: "tool-btn", type: "button", title: "Copy the whole document" }, "Copy JSON");
    copyBtn.addEventListener("click", function () {
      Lens.copyText(text, "Document copied");
    });
    toolbar.appendChild(copyBtn);

    var wrapBtn = el("button", { class: "tool-btn" + (state.wrapJson ? " primary" : ""), type: "button", title: "Toggle line wrapping" }, "Wrap");
    wrapBtn.addEventListener("click", function () {
      var top = ui.view.scrollTop;
      state.wrapJson = !state.wrapJson;
      renderView();
      ui.view.scrollTop = top;
    });
    toolbar.appendChild(wrapBtn);

    var bytes = new Blob([text]).size;
    toolbar.appendChild(el("span", { class: "json-meta" }, text.split("\n").length + " lines · " + Lens.formatBytes(bytes)));
    if (note) toolbar.appendChild(el("span", { class: "json-meta" }, note));
    wrap.appendChild(toolbar);

    var pre = el("pre", { class: "json-code" + (state.wrapJson ? " wrap" : "") });
    if (text.length > 1200000) {
      pre.classList.add("json-plain");
      pre.textContent = text;
    } else {
      pre.innerHTML = Lens.highlightJson(text);
    }
    wrap.appendChild(pre);
    return wrap;
  }

  // -------------------------------------------------------------------------
  // Issues view
  // -------------------------------------------------------------------------

  function renderIssuesView() {
    var errors = countSeverity("error");
    var warnings = countSeverity("warning");
    var infos = countSeverity("info");

    if (state.model && state.model.kind === "plain") {
      var plain = el("div", { class: "empty" });
      plain.appendChild(el("div", { class: "empty-mark" }, "✓"));
      plain.appendChild(el("h2", {}, "No JSON:API rules apply"));
      plain.appendChild(
        el(
          "p",
          {},
          "This is a plain JSON document, so JSON:API structural rules are not checked. Paste a JSON:API document to run the validator."
        )
      );
      return plain;
    }

    if (!state.issues.length) {
      var clean = el("div", { class: "empty" });
      clean.appendChild(el("div", { class: "empty-mark" }, "✓"));
      clean.appendChild(el("h2", {}, "No spec violations found"));
      clean.appendChild(
        el(
          "p",
          {},
          "Checked " +
            (state.model ? state.model.stats.primaryCount + state.model.stats.includedCount : 0) +
            " resources and " +
            (state.model ? state.model.stats.relationshipCount : 0) +
            " relationships against the JSON:API 1.1 structure rules. Business rules are out of scope."
        )
      );
      clean.appendChild(renderChecks());
      return clean;
    }

    var wrap = el("div", {});
    var toolbar = el("div", { class: "issues-toolbar" });
    toolbar.appendChild(el("span", { class: "toolbar-label" }, "Validation report"));
    if (errors) toolbar.appendChild(el("span", { class: "chip is-bad" }, errors + " errors"));
    if (warnings) toolbar.appendChild(el("span", { class: "chip is-warn" }, warnings + " warnings"));
    if (infos) toolbar.appendChild(el("span", { class: "chip is-info" }, infos + " notes"));
    toolbar.appendChild(el("span", { class: "toolbar-spacer" }));
    if (state.issues.length > ISSUE_RENDER_LIMIT) {
      var copyAll = el("button", { class: "tool-btn", type: "button", title: "Copy the complete validation report as JSON" }, "Copy all issues");
      copyAll.addEventListener("click", function () {
        Lens.copyText(JSON.stringify(state.issues, null, 2), "Validation report copied");
      });
      toolbar.appendChild(copyAll);
    }
    toolbar.appendChild(el("span", { class: "json-meta" }, "JSON:API 1.1 structure rules"));
    wrap.appendChild(toolbar);

    [
      ["error", "Errors"],
      ["warning", "Warnings"],
      ["info", "Notes"]
    ].forEach(function (group) {
      var severity = group[0];
      var list = state.issues.filter(function (issue) {
        return issue.severity === severity;
      });
      if (!list.length) return;

      var label = el("div", { class: "issue-group-label" });
      label.appendChild(document.createTextNode(group[1]));
      label.appendChild(el("span", { class: "count-pill" + (severity === "error" ? " warn" : "") }, String(list.length)));
      wrap.appendChild(label);

      list.slice(0, ISSUE_RENDER_LIMIT).forEach(function (issue) {
        wrap.appendChild(renderIssue(issue));
      });

      if (list.length > ISSUE_RENDER_LIMIT) {
        wrap.appendChild(
          el(
            "div",
            { class: "included-capped" },
            el(
              "span",
              {},
              "Showing the first " +
                ISSUE_RENDER_LIMIT +
                " of " +
                list.length +
                " " +
                group[1].toLowerCase() +
                ". Use “Copy all issues” for the complete report."
            )
          )
        );
      }
    });

    var note = el("div", { class: "notice info", style: "margin-top:14px" });
    note.appendChild(el("span", { class: "notice-icon" }, "i"));
    note.appendChild(
      el(
        "div",
        {},
        el("strong", {}, "Structural validation only."),
        el(
          "div",
          {},
          "This report covers document shape, resource identifiers, linkage and full-linkage rules. It cannot know your application's business constraints."
        )
      )
    );
    wrap.appendChild(note);
    return wrap;
  }

  function renderChecks() {
    var grid = el("div", { class: "checks-grid" });
    [
      "Required type identifiers and string ids",
      "Reserved field names (type, id, lid)",
      "Attribute / relationship collisions",
      "Relationship data, links and meta shape",
      "Duplicate primary and included resources",
      "Included full linkage from primary data",
      "Resource identifier and link objects",
      "Top-level data / errors exclusivity",
      "Error document structure"
    ].forEach(function (text) {
      var item = el("div", { class: "check-item" });
      item.appendChild(el("span", { class: "tick" }, "✓"));
      item.appendChild(el("span", {}, text));
      grid.appendChild(item);
    });
    return grid;
  }

  function renderIssue(issue) {
    var wrap = el("div", { class: "issue is-" + issue.severity });
    var icons = { error: "✕", warning: "!", info: "i" };
    wrap.appendChild(el("span", { class: "issue-icon" }, icons[issue.severity] || "i"));

    var main = el("div", { class: "issue-main" });
    var titleLine = el("div", { class: "issue-title-line" });
    titleLine.appendChild(el("span", { class: "issue-title" }, issue.title));
    titleLine.appendChild(el("span", { class: "issue-code" }, issue.code));
    main.appendChild(titleLine);
    main.appendChild(el("p", { class: "issue-message" }, issue.message));

    var foot = el("div", { class: "issue-foot" });
    var pointer = el("span", { class: "pointer" });
    pointer.appendChild(document.createTextNode(issue.pointer || "/ (document root)"));
    if (issue.pointer) {
      pointer.appendChild(
        el(
          "button",
          {
            type: "button",
            title: "Copy JSON pointer",
            dataset: { copy: issue.pointer, copyLabel: "JSON pointer copied" }
          },
          "⧉"
        )
      );
    }
    foot.appendChild(pointer);
    foot.appendChild(
      el("a", { class: "issue-spec", href: issue.spec, target: "_blank", rel: "noopener noreferrer" }, "JSON:API spec ↗")
    );
    main.appendChild(foot);
    wrap.appendChild(main);
    return wrap;
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  function toggleExpansion(path) {
    var top = ui.view.scrollTop;
    if (state.expanded.has(path)) state.expanded.delete(path);
    else state.expanded.add(path);
    renderView();
    ui.view.scrollTop = top;
  }

  function expandAll() {
    if (!state.model) return;
    var expanded = new Set();
    var budget = 450;

    function walk(entry, pathKey, ancestors, depth) {
      if (!entry || budget <= 0 || depth >= state.maxDepth) return;
      var nextAncestors = new Set(ancestors);
      if (entry.key) nextAncestors.add(entry.key);
      var relationships = isObject(entry.resource.relationships) ? entry.resource.relationships : {};

      Object.keys(relationships).forEach(function (name) {
        var rel = relationships[name];
        if (!isObject(rel) || !Lens.hasOwn(rel, "data") || rel.data === null) return;
        var identifiers = Array.isArray(rel.data) ? rel.data : [rel.data];
        identifiers.forEach(function (identifier, index) {
          if (budget <= 0) return;
          var targetKey = core.identityKey(identifier);
          var target = targetKey ? state.model.byKey.get(targetKey) : null;
          if (!target) return;
          var expandKey = pathKey + ">" + name + ">" + index;
          expanded.add(expandKey);
          budget -= 1;
          if (nextAncestors.has(targetKey)) return;
          walk(target, expandKey, nextAncestors, depth + 1);
        });
      });
    }

    state.model.primary.forEach(function (entry, index) {
      walk(entry, "d" + index, new Set(), 0);
    });

    state.expanded = expanded;
    renderView();
    Lens.toast("Expanded primary relationships to depth " + state.maxDepth);
  }

  function collapseAll() {
    state.expanded = new Set();
    renderView();
  }

  function focusResource(key) {
    if (!state.model) return;
    state.tab = "tree";
    state.includedOpen = true;
    var includedIndex = state.model.included.findIndex(function (entry) {
      return entry.key === key;
    });
    if (includedIndex >= 200) state.showAllIncluded = true;
    Lens.writeStore(STORE_TAB, "tree");
    renderTabs();
    renderView();

    window.requestAnimationFrame(function () {
      var cards = ui.view.querySelectorAll("[data-res-key]");
      var target = null;
      for (var i = 0; i < cards.length; i += 1) {
        if (cards[i].getAttribute("data-res-key") === key) {
          target = cards[i];
          break;
        }
      }
      if (!target) {
        Lens.toast("Resource is not rendered in the tree");
        return;
      }
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      target.classList.remove("flash");
      void target.offsetWidth;
      target.classList.add("flash");
      window.setTimeout(function () {
        target.classList.remove("flash");
      }, 1600);
    });
  }

  function copyResource(pointer) {
    if (!state.model || !pointer) return;
    var all = state.model.primary.concat(state.model.included);
    var entry = all.find(function (candidate) {
      return candidate.pointer === pointer;
    });
    if (!entry) {
      Lens.toast("Could not find that resource");
      return;
    }
    var plain = core.toPlainResource(entry, state.model, { budget: 5000 });
    if (!plain) {
      Lens.toast("Could not resolve that resource");
      return;
    }
    var text;
    try {
      text = JSON.stringify(plain, null, 2);
    } catch (err) {
      Lens.toast("This resource is too deeply nested to serialize");
      return;
    }
    Lens.copyText(
      text,
      plain._truncated ? "Resolved JSON copied — truncated at 5,000 resources" : "Resolved JSON copied"
    );
  }

  function handleAction(element) {
    var action = element.dataset.action;
    if (!action) return;

    if (action === "open-issues") switchTab("issues");
    else if (action === "copy-resource") copyResource(element.dataset.pointer);
    else if (action === "load-example") loadExample(element.dataset.name);
    else if (action === "toggle-rel") toggleExpansion(element.dataset.path);
    else if (action === "expand-all") expandAll();
    else if (action === "collapse-all") collapseAll();
    else if (action === "toggle-included") {
      var top = ui.view.scrollTop;
      state.includedOpen = !state.includedOpen;
      renderView();
      ui.view.scrollTop = top;
    } else if (action === "show-all-included") {
      state.showAllIncluded = true;
      renderView();
    } else if (action === "show-more-primary") {
      var primaryTop = ui.view.scrollTop;
      state.primaryRenderCount = (state.primaryRenderCount || 200) + 200;
      renderView();
      ui.view.scrollTop = primaryTop;
    } else if (action === "focus-res") focusResource(element.dataset.key);
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  function readFile(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var text = String(reader.result || "");
      ui.editor.value = text;
      applyInput(text, { resetExpansion: true });
      Lens.toast("Loaded " + file.name);
    };
    reader.onerror = function () {
      Lens.toast("Could not read that file");
    };
    reader.readAsText(file);
  }

  function loadFromUrl() {
    if (ui.urlLoad.disabled) return;
    var raw = ui.urlInput.value.trim();
    if (!raw) {
      ui.urlInput.focus();
      return;
    }
    var url;
    try {
      url = new URL(raw);
    } catch (err) {
      Lens.toast("Enter a valid URL");
      return;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      Lens.toast("Only http(s) URLs can be fetched");
      return;
    }

    var controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timer = controller
      ? window.setTimeout(function () {
          controller.abort();
        }, 25000)
      : null;
    var label = ui.urlLoad.textContent;
    ui.urlLoad.disabled = true;
    ui.urlLoad.textContent = "Fetching…";

    fetch(url.href, {
      headers: { Accept: "application/vnd.api+json, application/json;q=0.9, */*;q=0.1" },
      signal: controller ? controller.signal : undefined,
      credentials: "omit",
      redirect: "follow"
    })
      .then(function (response) {
        if (!response.ok) {
          throw new Error("The URL returned HTTP " + response.status);
        }
        var contentType = response.headers.get("content-type") || "";
        if (/text\/html/i.test(contentType)) {
          throw new Error("The URL returned HTML, not JSON");
        }
        return response.text();
      })
      .then(function (text) {
        if (!text.trim()) throw new Error("The response was empty");
        if (text.length > 12 * 1024 * 1024) throw new Error("The response is over 12 MB");
        state.tab = "tree";
        Lens.writeStore(STORE_TAB, "tree");
        ui.editor.value = text;
        applyInput(text, { resetExpansion: true });
        ui.urlBar.hidden = true;
        Lens.toast("Fetched " + Lens.formatBytes(new Blob([text]).size));
      })
      .catch(function (err) {
        var message = err && err.name === "AbortError" ? "The request timed out after 25 seconds" : err && err.message;
        if (err instanceof TypeError) {
          message = "Could not fetch that URL — the API must allow CORS from this page";
        }
        Lens.toast(message || "Could not fetch that URL");
      })
      .then(function () {
        if (timer) window.clearTimeout(timer);
        ui.urlLoad.disabled = false;
        ui.urlLoad.textContent = label;
      });
  }

  function formatEditor() {
    if (ui.editor.value.length > JSON_PRETTY_LIMIT) {
      Lens.toast("This document is too large to format");
      return;
    }
    var parsed = core.parseJson(ui.editor.value);
    if (!parsed.ok) {
      Lens.toast("Fix the JSON before formatting");
      return;
    }
    var pretty;
    try {
      pretty = JSON.stringify(parsed.value, null, 2);
    } catch (err) {
      Lens.toast("This document is too deeply nested to format");
      return;
    }
    if (pretty === ui.editor.value) {
      Lens.toast("Already formatted");
      return;
    }
    ui.editor.value = pretty;
    applyInput(pretty);
    Lens.toast("Formatted JSON");
  }

  function wireEvents() {
    var timer = null;
    ui.editor.addEventListener("input", function () {
      clearTimeout(timer);
      timer = setTimeout(function () {
        applyInput(ui.editor.value);
      }, 220);
    });

    ui.tabs.addEventListener("click", function (event) {
      var tab = event.target.closest("[data-tab]");
      if (!tab) return;
      switchTab(tab.dataset.tab);
    });

    function onActionClick(event) {
      var copyEl = event.target.closest("[data-copy]");
      if (copyEl) {
        event.preventDefault();
        Lens.copyText(copyEl.getAttribute("data-copy"), copyEl.getAttribute("data-copy-label") || "Copied");
        return;
      }
      var actionEl = event.target.closest("[data-action]");
      if (actionEl) handleAction(actionEl);
    }

    ui.summary.addEventListener("click", onActionClick);
    ui.view.addEventListener("click", onActionClick);

    ui.view.addEventListener("change", function (event) {
      if (!event.target.matches("[data-depth-select]")) return;
      var value = Number(event.target.value);
      if (!value) return;
      state.maxDepth = value;
      Lens.writeStore(STORE_DEPTH, String(value));
    });

    ui.exampleSelect.addEventListener("change", function () {
      var name = ui.exampleSelect.value;
      if (name) loadExample(name);
    });

    ui.themeToggle.addEventListener("click", function () {
      applyTheme(state.theme === "dark" ? "light" : "dark");
    });

    ui.formatBtn.addEventListener("click", formatEditor);
    ui.clearBtn.addEventListener("click", function () {
      ui.editor.value = "";
      state.tab = "tree";
      Lens.writeStore(STORE_TAB, "tree");
      applyInput("", { resetExpansion: true });
      Lens.removeStore(STORE_INPUT);
      ui.editor.focus();
    });

    ui.uploadBtn.addEventListener("click", function () {
      ui.fileInput.click();
    });
    ui.fileInput.addEventListener("change", function () {
      var file = ui.fileInput.files && ui.fileInput.files[0];
      readFile(file);
      ui.fileInput.value = "";
    });

    ui.urlBtn.addEventListener("click", function () {
      ui.urlBar.hidden = !ui.urlBar.hidden;
      if (!ui.urlBar.hidden) {
        ui.urlInput.focus();
        ui.urlInput.select();
      }
    });
    ui.urlClose.addEventListener("click", function () {
      ui.urlBar.hidden = true;
      ui.urlBtn.focus();
    });
    ui.urlBar.addEventListener("submit", function (event) {
      event.preventDefault();
      loadFromUrl();
    });

    var pane = document.getElementById("input-pane");
    ["dragenter", "dragover"].forEach(function (name) {
      pane.addEventListener(name, function (event) {
        event.preventDefault();
        event.stopPropagation();
        ui.dropzone.classList.add("is-dragging");
      });
    });
    pane.addEventListener("dragleave", function (event) {
      if (!pane.contains(event.relatedTarget)) {
        ui.dropzone.classList.remove("is-dragging");
      }
    });
    pane.addEventListener("drop", function (event) {
      event.preventDefault();
      event.stopPropagation();
      ui.dropzone.classList.remove("is-dragging");
      var file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
      if (file) readFile(file);
    });

    document.addEventListener("keydown", function (event) {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        formatEditor();
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
