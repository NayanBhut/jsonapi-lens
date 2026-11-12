/* Recursive tree view: primary data + included resources, resolved deeply. */
(function () {
  "use strict";

  var Lens = window.Lens;
  var core = window.JsonApiCore;
  var el = Lens.el;
  var isObject = Lens.isObject;
  var hasOwn = Lens.hasOwn;

  var INCLUDED_RENDER_LIMIT = 200;
  var VALUE_PREVIEW_LIMIT = 200000;
  var PLAIN_DEPTH_LIMIT = 8;
  var PLAIN_CHILD_LIMIT = 200;
  // Hard ceiling on DOM rows built eagerly for a plain document. Branching
  // documents (e.g. 200 keys per level, several levels deep) would otherwise
  // create millions of elements and freeze or crash the tab even though the
  // JSON text itself is small enough to pass the input size check.
  var PLAIN_ROW_BUDGET = 20000;

  // Working state for the current plain render; reset by renderPlain().
  var plainRows = 0;
  var plainCapped = false;

  function shortPath(labels) {
    if (labels.length <= 5) return labels.join(" › ");
    return "… › " + labels.slice(-5).join(" › ");
  }

  function safeStringify(value) {
    try {
      return JSON.stringify(value, null, 2);
    } catch (err) {
      return "(too deeply nested to preview)";
    }
  }

  function safePreview(value, limit) {
    var text = safeStringify(value);
    if (text.length > limit) {
      return text.slice(0, limit) + "\n… preview truncated (" + Lens.formatBytes(text.length) + ")";
    }
    return text;
  }

  function renderTree() {
    var state = Lens.state;
    var model = state.model;
    var fragment = el("div", { class: "tree" });

    if (!model || model.kind === "invalid") {
      fragment.appendChild(renderInvalid());
      return fragment;
    }

    if (model.kind === "plain") {
      fragment.appendChild(renderPlain());
      return fragment;
    }

    if (model.kind === "resource" || model.kind === "collection") {
      fragment.appendChild(renderToolbar());
    }

    var docExtras = renderDocExtras();
    if (docExtras) fragment.appendChild(docExtras);

    if (model.kind === "errors") {
      fragment.appendChild(renderErrorsSection());
    } else if (model.kind === "meta") {
      fragment.appendChild(renderMetaSection());
    } else if (model.kind === "null") {
      fragment.appendChild(renderNullSection());
    } else {
      fragment.appendChild(renderPrimarySection());
    }

    if (model.included.length) {
      fragment.appendChild(renderIncludedSection());
    }

    return fragment;
  }

  // -------------------------------------------------------------------------
  // Toolbar
  // -------------------------------------------------------------------------

  function renderToolbar() {
    var state = Lens.state;
    var model = state.model;
    var toolbar = el("div", { class: "tree-toolbar" });

    toolbar.appendChild(el("span", { class: "toolbar-label" }, "Relations"));
    toolbar.appendChild(
      el(
        "button",
        {
          class: "tool-btn primary",
          type: "button",
          dataset: { action: "expand-all" },
          title: "Expand primary resources recursively (cycles stop automatically)"
        },
        "Expand all"
      )
    );
    toolbar.appendChild(
      el(
        "button",
        {
          class: "tool-btn",
          type: "button",
          dataset: { action: "collapse-all" },
          title: "Collapse every expanded relationship"
        },
        "Collapse"
      )
    );

    var depthWrap = el("label", { class: "depth-select", title: "How many relationship hops Expand all should open" });
    depthWrap.appendChild(document.createTextNode("depth"));
    var select = el("select", { dataset: { depthSelect: "" }, "aria-label": "Expansion depth" });
    [2, 3, 4, 5, 6, 8].forEach(function (depth) {
      select.appendChild(
        el("option", { value: String(depth), selected: state.maxDepth === depth ? "" : null }, String(depth))
      );
    });
    depthWrap.appendChild(select);
    toolbar.appendChild(depthWrap);

    toolbar.appendChild(el("span", { class: "toolbar-spacer" }));

    if (model.stats.missingCount) {
      toolbar.appendChild(
        el(
          "span",
          {
            class: "chip is-warn",
            title:
              model.stats.missingCount +
              " linkage target(s) are not present in data or included. This is allowed for sparse documents."
          },
          el("span", { class: "chip-dot" }),
          el("b", { text: String(model.stats.missingCount) }),
          " unresolved"
        )
      );
    }
    if (model.orphanIncluded.size) {
      toolbar.appendChild(
        el(
          "span",
          {
            class: "chip is-warn",
            title: "Included resources that no relationship points to. JSON:API requires full linkage."
          },
          el("span", { class: "chip-dot" }),
          el("b", { text: String(model.orphanIncluded.size) }),
          " unlinked"
        )
      );
    }

    return toolbar;
  }

  // -------------------------------------------------------------------------
  // Document extras
  // -------------------------------------------------------------------------

  function renderDocExtras() {
    var doc = Lens.state.doc;
    if (!isObject(doc)) return null;
    var parts = [];
    if (isObject(doc.jsonapi)) parts.push("jsonapi:\n" + safeStringify(doc.jsonapi));
    if (doc.links !== undefined) parts.push("links:\n" + safeStringify(doc.links));
    if (doc.meta !== undefined) parts.push("meta:\n" + safeStringify(doc.meta));
    if (!parts.length) return null;

    var details = el("details", { class: "doc-extra" });
    details.appendChild(el("summary", {}, "Document-level jsonapi, links & meta"));
    details.appendChild(el("pre", {}, parts.join("\n\n")));
    return details;
  }

  // -------------------------------------------------------------------------
  // Primary / included sections
  // -------------------------------------------------------------------------

  function renderPrimarySection() {
    var state = Lens.state;
    var model = state.model;
    var section = el("section", { class: "section" });
    var head = el("div", { class: "section-head" });
    head.appendChild(el("span", {}, "Primary data"));
    head.appendChild(el("span", { class: "count-pill" }, String(model.primary.length)));
    if (model.kind === "collection") {
      head.appendChild(el("span", { class: "section-kicker" }, "collection"));
    } else {
      head.appendChild(el("span", { class: "section-kicker" }, "single resource"));
    }
    section.appendChild(head);

    if (!model.primary.length) {
      section.appendChild(
        el(
          "div",
          { class: "notice info" },
          el("span", { class: "notice-icon" }, "i"),
          el(
            "div",
            {},
            el("strong", {}, "Primary data is an empty array"),
            el("div", {}, "There are no primary resources, but a document may still contain included resources.")
          )
        )
      );
      return section;
    }

    var limit = Math.max(1, state.primaryRenderCount || 200);
    var shown = Math.min(model.primary.length, limit);

    model.primary.slice(0, shown).forEach(function (entry, index) {
      var ctx = {
        pathKey: "d" + index,
        ancestors: new Set(),
        depth: 0,
        pathLabels: [model.kind === "collection" ? "data[" + index + "]" : "data"],
        pointer: entry.pointer,
        via: false
      };
      section.appendChild(renderCard(entry, ctx));
    });

    if (shown < model.primary.length) {
      var capped = el("div", { class: "included-capped" });
      capped.appendChild(
        el(
          "span",
          {},
          "Showing the first " +
            shown +
            " of " +
            model.primary.length +
            " primary resources to keep the page responsive."
        )
      );
      capped.appendChild(
        el(
          "button",
          { class: "tool-btn", type: "button", dataset: { action: "show-more-primary" } },
          "Show " + Math.min(200, model.primary.length - shown) + " more"
        )
      );
      section.appendChild(capped);
    }

    return section;
  }

  function renderIncludedSection() {
    var state = Lens.state;
    var model = state.model;
    var section = el("section", { class: "section included-section" });
    var head = el("div", { class: "section-head" });

    var toggle = el("button", {
      class: "section-collapse",
      type: "button",
      dataset: { action: "toggle-included" },
      "aria-expanded": state.includedOpen ? "true" : "false",
      title: state.includedOpen ? "Hide included resources" : "Show included resources"
    });
    toggle.appendChild(el("span", { class: "chev" }, "▾"));
    toggle.appendChild(el("span", {}, "Included resources"));
    head.appendChild(toggle);
    head.appendChild(el("span", { class: "count-pill" }, String(model.included.length)));
    if (model.orphanIncluded.size) {
      head.appendChild(
        el(
          "span",
          { class: "count-pill warn", title: "Not reachable through any relationship (full-linkage violation)" },
          String(model.orphanIncluded.size) + " unlinked"
        )
      );
    }
    section.appendChild(head);

    if (!state.includedOpen) return section;

    var groups = new Map();
    model.included.forEach(function (entry) {
      var type = entry.type || "unknown";
      if (!groups.has(type)) groups.set(type, []);
      groups.get(type).push(entry);
    });

    var orderedTypes = Array.from(groups.keys()).sort(function (a, b) {
      return a.localeCompare(b);
    });

    var limit = state.showAllIncluded ? Infinity : INCLUDED_RENDER_LIMIT;
    var shown = 0;

    orderedTypes.forEach(function (type) {
      if (shown >= limit) return;
      var entries = groups.get(type);
      var group = el("div", { class: "type-group" });
      var groupHead = el("div", { class: "type-group-head" });
      groupHead.appendChild(Lens.typeBadge(type));
      groupHead.appendChild(el("span", { class: "count-pill" }, String(entries.length)));
      group.appendChild(groupHead);

      entries.forEach(function (entry) {
        if (shown >= limit) return;
        shown += 1;
        group.appendChild(
          renderCard(entry, {
            pathKey: "inc[" + entry.index + "]",
            ancestors: new Set(),
            depth: 0,
            pathLabels: ["included[" + entry.index + "]"],
            pointer: entry.pointer,
            via: false
          })
        );
      });

      section.appendChild(group);
    });

    if (shown < model.included.length) {
      var capped = el("div", { class: "included-capped" });
      capped.appendChild(
        el(
          "span",
          {},
          "Rendering the first " +
            shown +
            " of " +
            model.included.length +
            " included resources to keep the page responsive."
        )
      );
      capped.appendChild(
        el(
          "button",
          { class: "tool-btn", type: "button", dataset: { action: "show-all-included" } },
          "Show all " + model.included.length
        )
      );
      section.appendChild(capped);
    }

    return section;
  }

  // -------------------------------------------------------------------------
  // Resource card
  // -------------------------------------------------------------------------

  function renderCard(entry, ctx) {
    var state = Lens.state;
    var model = state.model;
    var resource = entry.resource;

    var classes = "card" + (ctx.depth > 0 ? " card-nested" : "");
    var attrs = { class: classes };
    if (entry.key) attrs.dataset = { resKey: entry.key };
    var card = el("article", attrs);

    if (ctx.via) {
      var strip = el("div", { class: "via-strip" });
      strip.appendChild(el("span", { class: "via-arrow" }, "↳"));
      strip.appendChild(
        el(
          "span",
          { class: "via-path", title: ctx.pathLabels.join(" › ") },
          shortPath(ctx.pathLabels)
        )
      );
      if (ctx.pointer) {
        strip.appendChild(
          el(
            "button",
            {
              class: "icon-action",
              type: "button",
              title: "Copy JSON pointer to this linkage: " + ctx.pointer,
              "aria-label": "Copy relationship pointer",
              dataset: { copy: ctx.pointer, copyLabel: "Linkage pointer copied" }
            },
            "⧉"
          )
        );
      }
      card.appendChild(strip);
    }

    var head = el("div", { class: "card-head" });
    head.appendChild(Lens.typeBadge(entry.type));

    var idText = entry.id !== null && entry.id !== undefined ? "#" + String(entry.id) : entry.lid !== null && entry.lid !== undefined ? "lid:" + entry.lid : "no id";
    head.appendChild(el("span", { class: "card-id", title: "Resource id" }, idText));
    if (entry.label && entry.label !== idText) {
      head.appendChild(el("span", { class: "card-label", title: entry.label }, entry.label));
    }

    var badges = el("span", { class: "card-badges" });
    if (entry.origin === "included" && ctx.depth === 0) {
      badges.appendChild(el("span", { class: "mini-badge" }, "included"));
    }
    if (entry.duplicate) {
      badges.appendChild(el("span", { class: "mini-badge warn", title: "Duplicate type/id pair" }, "duplicate"));
    }
    if (ctx.depth === 0 && entry.origin === "included" && (!entry.key || model.orphanIncluded.has(entry.key))) {
      badges.appendChild(el("span", { class: "mini-badge warn", title: "Not linked from primary data" }, "unlinked"));
    }
    if (badges.childNodes.length) head.appendChild(badges);

    head.appendChild(el("span", { class: "spacer" }));
    head.appendChild(
      el(
        "button",
        {
          class: "icon-action",
          type: "button",
          title: "Copy resolved JSON — relationships inlined",
          "aria-label": "Copy resolved JSON",
          dataset: { action: "copy-resource", pointer: entry.pointer }
        },
        "{}"
      )
    );
    card.appendChild(head);

    var body = el("div", { class: "card-body" });
    var attrBlock = renderAttributes(resource);
    if (attrBlock) body.appendChild(attrBlock);

    var relBlock = renderRelationships(entry, ctx);
    if (relBlock) body.appendChild(relBlock);

    if (!attrBlock && !relBlock) {
      body.appendChild(el("div", { class: "card-empty" }, "No attributes or relationships"));
    }

    card.appendChild(body);

    var extras = renderCardExtras(resource);
    if (extras) card.appendChild(extras);

    return card;
  }

  function renderAttributes(resource) {
    var attrs = isObject(resource.attributes) ? resource.attributes : {};
    var names = Object.keys(attrs);
    if (!names.length) return null;

    var block = el("div", { class: "attrs" });
    names.forEach(function (name) {
      var row = el("div", { class: "attr" });
      row.appendChild(el("span", { class: "attr-name", title: name }, name));
      var valueCell = el("div", { class: "attr-value" });
      valueCell.appendChild(renderValue(attrs[name]));
      row.appendChild(valueCell);
      block.appendChild(row);
    });
    return block;
  }

  function renderValue(value) {
    if (value === null) return el("span", { class: "val-null" }, "null");
    if (typeof value === "string") return el("span", { class: "val-string" }, JSON.stringify(value));
    if (typeof value === "number") return el("span", { class: "val-number" }, String(value));
    if (typeof value === "boolean") return el("span", { class: "val-boolean" }, String(value));

    if (Array.isArray(value) || isObject(value)) {
      var isArray = Array.isArray(value);
      var count = isArray ? value.length + " items" : Object.keys(value).length + " keys";
      var label = (isArray ? "array" : "object") + " · " + count;
      var text = null;
      try {
        text = JSON.stringify(value, null, 2);
      } catch (err) {
        text = null;
      }
      if (text === undefined) text = null;
      if (text === null) {
        var fallback = el("div", { class: "value-details value-deep" });
        fallback.appendChild(el("div", { class: "value-deep-head" }, label));
        fallback.appendChild(
          el("div", { class: "value-deep-note" }, "Too deeply nested to preview. Open the JSON tab to see the original text.")
        );
        return fallback;
      }
      if (!text.includes("\n") && text.length <= 72) {
        return el("span", { class: "val-object" }, text);
      }
      if (text.length > VALUE_PREVIEW_LIMIT) {
        var big = el("div", { class: "value-details value-deep" });
        big.appendChild(el("div", { class: "value-deep-head" }, label));
        big.appendChild(
          el(
            "div",
            { class: "value-deep-note" },
            "Value is too large to preview (" + Lens.formatBytes(text.length) + "). Open the JSON tab to see the full document."
          )
        );
        return big;
      }
      var details = el("details", { class: "value-details" });
      details.appendChild(el("summary", {}, label));
      details.appendChild(el("pre", {}, text));
      return details;
    }

    return el("span", { class: "val-object" }, String(value));
  }

  function renderRelationships(entry, ctx) {
    var resource = entry.resource;
    var relationships = isObject(resource.relationships) ? resource.relationships : {};
    var names = Object.keys(relationships);
    if (!names.length) return null;

    var ancestors = new Set(ctx.ancestors);
    if (entry.key) ancestors.add(entry.key);

    var block = el("div", { class: "rels" });
    names.forEach(function (name) {
      block.appendChild(renderRelationship(name, relationships[name], entry, ctx, ancestors));
    });
    return block;
  }

  function renderRelationship(name, rel, entry, ctx, ancestors) {
    var state = Lens.state;
    var model = state.model;
    var block = el("div", { class: "rel" });
    var row = el("div", { class: "rel-row" });
    row.appendChild(el("span", { class: "rel-name", title: name }, name));
    var targets = el("div", { class: "rel-targets" });
    row.appendChild(targets);
    block.appendChild(row);

    var relPointer = core.pointerJoin(core.pointerJoin(entry.pointer, "relationships"), name);

    if (!isObject(rel)) {
      targets.appendChild(el("span", { class: "linkage-note" }, "invalid relationship object"));
      return block;
    }

    if (!hasOwn(rel, "data")) {
      if (rel.links) {
        targets.appendChild(el("span", { class: "linkage-note", title: "This relationship exposes links but no resource linkage" }, "linkage not in document"));
        appendRelationLinks(targets, rel.links);
      } else if (rel.meta) {
        targets.appendChild(el("span", { class: "linkage-note" }, "meta only"));
      } else {
        targets.appendChild(el("span", { class: "linkage-note" }, "no data, links or meta"));
      }
      return block;
    }

    if (rel.data === null) {
      targets.appendChild(el("span", { class: "null-chip" }, "null · empty to-one"));
      appendRelationLinks(targets, rel.links);
      return block;
    }

    var isArray = Array.isArray(rel.data);
    var identifiers = isArray ? rel.data : [rel.data];
    if (!identifiers.length) {
      targets.appendChild(el("span", { class: "null-chip" }, "empty array"));
      appendRelationLinks(targets, rel.links);
      return block;
    }

    var children = null;

    identifiers.forEach(function (identifier, index) {
      if (!isObject(identifier)) {
        targets.appendChild(el("span", { class: "linkage-note" }, "invalid resource identifier"));
        return;
      }

      var targetKey = core.identityKey(identifier);
      var target = targetKey ? model.byKey.get(targetKey) : null;
      var expandKey = ctx.pathKey + ">" + name + ">" + index;
      var isOpen = state.expanded.has(expandKey);

      var chip = el("button", {
        class: "target-chip" + (target ? "" : " is-missing") + (isOpen ? " is-open" : ""),
        type: "button",
        dataset: { action: "toggle-rel", path: expandKey },
        "aria-expanded": isOpen ? "true" : "false",
        title: target
          ? "Expand " + Lens.identityText(identifier.type, identifier.id, identifier.lid)
          : "Referenced resource is not present in data or included"
      });
      chip.style.setProperty("--h", Lens.hueFor(identifier.type));
      chip.appendChild(el("span", { class: "caret" }, isOpen ? "▾" : "▸"));
      chip.appendChild(el("span", { class: "t-type" }, identifier.type || "unknown"));
      chip.appendChild(el("span", { class: "t-sep" }, ":"));
      chip.appendChild(
        el(
          "span",
          { class: "t-id" },
          identifier.id !== undefined && identifier.id !== null
            ? String(identifier.id)
            : identifier.lid !== undefined && identifier.lid !== null
            ? "lid:" + identifier.lid
            : "?"
        )
      );
      if (target && target.label) {
        chip.appendChild(el("span", { class: "t-label" }, core.truncate(target.label, 28)));
      }
      if (!target) {
        chip.appendChild(el("span", { class: "missing-mark" }, "missing"));
      }
      targets.appendChild(chip);

      if (!isOpen) return;

      if (!children) {
        children = el("div", { class: "rel-children" });
      }

      var linkagePointer = relPointer + "/data" + (isArray ? "/" + index : "");

      if (!target) {
        children.appendChild(renderMissing(identifier, linkagePointer));
      } else if (ancestors.has(target.key)) {
        children.appendChild(renderCycle(target, ctx));
      } else {
        var viaLabel = isArray ? name + "[" + index + "]" : name;
        children.appendChild(
          renderCard(target, {
            pathKey: expandKey,
            ancestors: ancestors,
            depth: ctx.depth + 1,
            pathLabels: ctx.pathLabels.concat([viaLabel]),
            pointer: linkagePointer,
            via: true
          })
        );
      }
    });

    appendRelationLinks(targets, rel.links);

    if (children) block.appendChild(children);
    return block;
  }

  function appendRelationLinks(targets, links) {
    if (!isObject(links)) return;
    var seen = false;
    ["related", "self"].forEach(function (name) {
      if (seen) return;
      var href = Lens.linkHref(links[name]);
      if (!href) return;
      seen = true;
      targets.appendChild(
        el(
          "a",
          {
            class: "rel-link",
            href: href,
            target: "_blank",
            rel: "noopener noreferrer",
            title: "Open the relationship " + name + " link"
          },
          name + " ↗"
        )
      );
    });
  }

  function renderMissing(identifier, pointer) {
    var note = el("div", { class: "missing-card" });
    note.appendChild(el("span", { class: "note-icon" }, "!"));
    var body = el("div", { class: "note-body" });
    body.appendChild(el("div", { class: "note-title" }, "Resource not included"));
    body.appendChild(
      el(
        "div",
        {},
        "This relationship points to ",
        el("code", {}, Lens.identityText(identifier.type, identifier.id, identifier.lid)),
        ", but no matching object exists in data or included. Sparse linkage is legal — add the resource to included to inspect its fields."
      )
    );
    body.appendChild(el("div", { class: "note-meta" }, "Linkage pointer: " + pointer));
    note.appendChild(body);
    return note;
  }

  function renderCycle(target, ctx) {
    var note = el("div", { class: "cycle-note" });
    note.appendChild(el("span", { class: "note-icon" }, "↻"));
    var body = el("div", { class: "note-body" });
    body.appendChild(el("div", { class: "note-title" }, "Cycle detected — expansion stops here"));
    body.appendChild(
      el(
        "div",
        {},
        el("code", {}, target.key),
        " already appears on this path (",
        el("code", {}, shortPath(ctx.pathLabels)),
        "), so following it again would loop forever."
      )
    );
    note.appendChild(body);
    return note;
  }

  function renderCardExtras(resource) {
    var parts = [];
    if (resource.links !== undefined) parts.push("links:\n" + safeStringify(resource.links));
    if (resource.meta !== undefined) parts.push("meta:\n" + safeStringify(resource.meta));
    if (!parts.length) return null;

    var details = el("details", { class: "card-more" });
    details.appendChild(el("summary", {}, "links & meta"));
    details.appendChild(el("pre", {}, parts.join("\n\n")));
    return details;
  }

  // -------------------------------------------------------------------------
  // Other document shapes
  // -------------------------------------------------------------------------

  function renderErrorsSection() {
    var doc = Lens.state.doc;
    var errors = isObject(doc) && Array.isArray(doc.errors) ? doc.errors : [];
    var section = el("section", { class: "section" });
    var head = el("div", { class: "section-head" });
    head.appendChild(el("span", {}, "Error objects"));
    head.appendChild(el("span", { class: "count-pill" }, String(errors.length)));
    section.appendChild(head);

    if (!errors.length) {
      section.appendChild(el("div", { class: "notice info" }, el("span", { class: "notice-icon" }, "i"), el("div", {}, "The errors array is empty.")));
      return section;
    }

    errors.forEach(function (errorObject, index) {
      var box = el("div", { class: "issue is-error" });
      box.appendChild(el("span", { class: "issue-icon" }, "✕"));
      var main = el("div", { class: "issue-main" });
      var titleLine = el("div", { class: "issue-title-line" });
      titleLine.appendChild(
        el("span", { class: "issue-title" }, isObject(errorObject) && errorObject.title ? errorObject.title : "Error object #" + (index + 1))
      );
      if (isObject(errorObject) && errorObject.status) {
        titleLine.appendChild(el("span", { class: "mini-badge danger" }, String(errorObject.status)));
      }
      if (isObject(errorObject) && errorObject.code) {
        titleLine.appendChild(el("span", { class: "issue-code" }, String(errorObject.code)));
      }
      main.appendChild(titleLine);

      if (isObject(errorObject) && errorObject.detail) {
        main.appendChild(el("p", { class: "issue-message" }, String(errorObject.detail)));
      }
      var foot = el("div", { class: "issue-foot" });
      if (isObject(errorObject) && isObject(errorObject.source) && errorObject.source.pointer) {
        var pointer = el("span", { class: "pointer" });
        pointer.appendChild(document.createTextNode(String(errorObject.source.pointer)));
        pointer.appendChild(
          el(
            "button",
            {
              type: "button",
              title: "Copy source pointer",
              dataset: { copy: String(errorObject.source.pointer), copyLabel: "Source pointer copied" }
            },
            "⧉"
          )
        );
        foot.appendChild(pointer);
      }
      if (isObject(errorObject) && errorObject.id) {
        foot.appendChild(el("span", { class: "pointer" }, "id " + String(errorObject.id)));
      }
      var about = isObject(errorObject) && isObject(errorObject.links) ? Lens.linkHref(errorObject.links.about) : null;
      if (about) {
        foot.appendChild(
          el("a", { class: "issue-spec", href: about, target: "_blank", rel: "noopener noreferrer" }, "about ↗")
        );
      }
      if (foot.childNodes.length) main.appendChild(foot);
      box.appendChild(main);
      section.appendChild(box);
    });

    return section;
  }

  function renderMetaSection() {
    var doc = Lens.state.doc;
    var section = el("section", { class: "section" });
    var head = el("div", { class: "section-head" });
    head.appendChild(el("span", {}, "Document"));
    head.appendChild(el("span", { class: "section-kicker" }, "meta only"));
    section.appendChild(head);
    section.appendChild(
      el(
        "div",
        { class: "notice info" },
        el("span", { class: "notice-icon" }, "i"),
        el(
          "div",
          {},
          el("strong", {}, "This document has no data or errors."),
          el("div", {}, "It is a valid meta-only document, often used for health checks or pagination metadata.")
        )
      )
    );
    section.appendChild(el("pre", { class: "json-code" }, safePreview(doc, VALUE_PREVIEW_LIMIT)));
    return section;
  }

  function renderNullSection() {
    var section = el("section", { class: "section" });
    var head = el("div", { class: "section-head" });
    head.appendChild(el("span", {}, "Primary data"));
    head.appendChild(el("span", { class: "section-kicker" }, "null"));
    section.appendChild(head);
    section.appendChild(
      el(
        "div",
        { class: "notice info" },
        el("span", { class: "notice-icon" }, "i"),
        el(
          "div",
          {},
          el("strong", {}, "data is null"),
          el("div", {}, "The document parsed successfully. Null primary data usually represents an empty to-one resource or a successful operation with no content.")
        )
      )
    );
    return section;
  }

  // -------------------------------------------------------------------------
  // Plain JSON (not a JSON:API document)
  // -------------------------------------------------------------------------

  function plainLabel(value) {
    var isArray = Array.isArray(value);
    var length = isArray ? value.length : Object.keys(value).length;
    if (isArray) return "array · " + length + (length === 1 ? " item" : " items");
    return "object · " + length + (length === 1 ? " key" : " keys");
  }

  // Cheap node used once the eager-render budget is gone: no recursion and no
  // JSON.stringify of the subtree, so an exhausted budget cannot blow up either.
  function plainPlaceholder(value) {
    var label = Array.isArray(value) || isObject(value) ? plainLabel(value) : "value";
    var wrap = el("div", { class: "value-details value-deep" });
    wrap.appendChild(el("div", { class: "value-deep-head" }, label));
    wrap.appendChild(
      el("div", { class: "value-deep-note" }, "Preview cap reached — open the JSON tab to inspect this value.")
    );
    plainCapped = true;
    return wrap;
  }

  // `depth` is the nesting level of `value`. At the limit the subtree is shown
  // as a single pretty-printed <pre> so a pathological document still terminates.
  function renderPlainNode(value, depth) {
    if ((Array.isArray(value) || isObject(value)) && plainRows >= PLAIN_ROW_BUDGET) {
      return plainPlaceholder(value);
    }
    if (depth >= PLAIN_DEPTH_LIMIT) return renderValue(value);
    if (!Array.isArray(value) && !isObject(value)) return renderValue(value);

    var isArray = Array.isArray(value);
    var keys = isArray
      ? value.map(function (_, index) {
          return index;
        })
      : Object.keys(value);

    var details = el("details", { class: "value-details" });
    details.appendChild(el("summary", {}, plainLabel(value)));

    var rows = el("div", { class: "attrs" });
    var more = null;
    var rendered = 0;

    function appendBatch() {
      var built = 0;
      while (rendered < keys.length && built < PLAIN_CHILD_LIMIT) {
        if (plainRows >= PLAIN_ROW_BUDGET) {
          plainCapped = true;
          break;
        }
        var key = keys[rendered];
        var row = el("div", { class: "attr" });
        row.appendChild(
          el("span", { class: "attr-name", title: String(key) }, isArray ? "[" + key + "]" : String(key))
        );
        var cell = el("div", { class: "attr-value" });
        plainRows += 1;
        cell.appendChild(renderPlainNode(value[key], depth + 1));
        row.appendChild(cell);
        rows.appendChild(row);
        rendered += 1;
        built += 1;
      }
      if (more) rows.appendChild(more);
    }

    if (keys.length > PLAIN_CHILD_LIMIT) {
      more = el("button", { class: "tool-btn", type: "button" }, "Show " + PLAIN_CHILD_LIMIT + " more");
      more.addEventListener("click", function () {
        if (plainRows >= PLAIN_ROW_BUDGET) {
          plainCapped = true;
          more.textContent = "Preview cap reached — use the JSON tab";
          more.disabled = true;
          return;
        }
        appendBatch();
        var remaining = keys.length - rendered;
        if (remaining > 0) {
          more.textContent = "Show " + Math.min(PLAIN_CHILD_LIMIT, remaining) + " more";
          if (plainRows >= PLAIN_ROW_BUDGET) {
            plainCapped = true;
            more.textContent = "Preview cap reached — use the JSON tab";
            more.disabled = true;
          }
        } else {
          more.remove();
        }
      });
    }

    appendBatch();
    details.appendChild(rows);
    return details;
  }

  function renderPlain() {
    var state = Lens.state;
    var section = el("section", { class: "section" });

    plainRows = 0;
    plainCapped = false;

    section.appendChild(
      el(
        "div",
        { class: "notice info" },
        el("span", { class: "notice-icon" }, "i"),
        el(
          "div",
          {},
          el("strong", {}, "Plain JSON"),
          el("div", {}, "Not a JSON:API document. Showing a generic tree.")
        )
      )
    );

    var root = el("div", {});
    if (Array.isArray(state.doc) || isObject(state.doc)) {
      root.appendChild(renderPlainNode(state.doc, 0));
    } else {
      var row = el("div", { class: "attr" });
      row.appendChild(el("span", { class: "attr-name" }, "root"));
      var cell = el("div", { class: "attr-value" });
      cell.appendChild(renderValue(state.doc));
      row.appendChild(cell);
      var attrs = el("div", { class: "attrs" });
      attrs.appendChild(row);
      root.appendChild(attrs);
    }
    section.appendChild(root);

    if (plainCapped) {
      section.appendChild(
        el(
          "div",
          { class: "included-capped" },
          el(
            "span",
            {},
            "Preview limited to " +
              PLAIN_ROW_BUDGET.toLocaleString() +
              " rows to keep the page responsive. Open the JSON tab for the complete document."
          )
        )
      );
    }
    return section;
  }

  function renderInvalid() {
    var section = el("section", { class: "section" });
    section.appendChild(
      el(
        "div",
        { class: "notice error" },
        el("span", { class: "notice-icon" }, "!"),
        el(
          "div",
          {},
          el("strong", {}, "Valid JSON — but not a JSON:API document"),
          el(
            "div",
            {},
            "This document declares data, errors or meta but is not a structurally valid JSON:API document. Open the Issues tab for the details."
          )
        )
      )
    );
    section.appendChild(
      el(
        "div",
        { class: "empty-actions" },
        el(
          "button",
          { class: "secondary-btn", type: "button", dataset: { action: "open-issues" } },
          "View validation report"
        )
      )
    );
    return section;
  }

  Lens.renderTree = renderTree;
})();
