/* Relationship graph: layered layout, pan/zoom, selection inspector. */
(function () {
  "use strict";

  var Lens = window.Lens;
  var core = window.JsonApiCore;
  var el = Lens.el;
  var svgEl = Lens.svgEl;
  var isObject = Lens.isObject;

  var NODE_W = 190;
  var NODE_H = 54;
  var COL_GAP = 270;
  var ROW_GAP = 18;
  var PAD = 46;
  var MAX_NODES = 400;

  var pendingResize = null;

  function renderGraph() {
    var state = Lens.state;
    var model = state.model;
    var graph = el("div", { class: "graph" });
    var toolbar = el("div", { class: "graph-toolbar" });
    toolbar.appendChild(el("span", { class: "toolbar-label" }, "Graph"));

    if (!model || model.kind === "invalid" || model.kind === "errors" || model.kind === "meta" || model.kind === "null") {
      toolbar.appendChild(el("span", { class: "count-pill" }, "0 nodes"));
      graph.appendChild(toolbar);
      graph.appendChild(
        el(
          "div",
          { class: "graph-empty" },
          el(
            "div",
            {},
            el("div", { style: "font-size:24px;margin-bottom:8px" }, "◌"),
            model && model.kind === "errors"
              ? "Error documents have no resource graph."
              : model && model.kind === "null"
              ? "Primary data is null — there is nothing to graph."
              : "This document has no resources to graph."
          )
        )
      );
      return graph;
    }

    var data = buildGraphData(model);
    if (!data.nodes.length) {
      toolbar.appendChild(el("span", { class: "count-pill" }, "0 nodes"));
      graph.appendChild(toolbar);
      graph.appendChild(el("div", { class: "graph-empty" }, "No resources found."));
      return graph;
    }

    toolbar.appendChild(el("span", { class: "count-pill" }, data.nodes.length + " nodes"));
    toolbar.appendChild(el("span", { class: "count-pill" }, data.edges.length + " edges"));
    if (data.truncated) {
      toolbar.appendChild(
        el(
          "span",
          { class: "chip is-warn", title: "Large document — only the first " + MAX_NODES + " reachable nodes are drawn" },
          el("span", { class: "chip-dot" }),
          data.truncated + " hidden"
        )
      );
    }

    if (model.stats.missingCount && !state.graphShowMissing) {
      toolbar.appendChild(
        el(
          "span",
          {
            class: "chip is-warn",
            title:
              model.stats.missingCount +
              " linkage target(s) are not present in data or included and are hidden from the graph. Tick “unresolved” to draw them."
          },
          el("span", { class: "chip-dot" }),
          el("b", { text: String(model.stats.missingCount) }),
          " hidden"
        )
      );
    }

    toolbar.appendChild(el("span", { class: "toolbar-spacer" }));

    if (model.stats.missingCount) {
      var missingLabel = el("label", {
        class: "depth-select",
        title: "Draw linkage targets that are not present in data or included"
      });
      missingLabel.appendChild(
        el("input", {
          type: "checkbox",
          checked: state.graphShowMissing,
          dataset: { graphMissing: "" },
          "aria-label": "Show unresolved linkage targets"
        })
      );
      missingLabel.appendChild(document.createTextNode("unresolved"));
      toolbar.appendChild(missingLabel);
    }

    var labelsLabel = el("label", { class: "depth-select", title: "Show relationship names on edges" });
    labelsLabel.appendChild(
      el("input", {
        type: "checkbox",
        checked: state.graphLabels,
        dataset: { graphLabels: "" },
        "aria-label": "Show relationship labels"
      })
    );
    labelsLabel.appendChild(document.createTextNode("labels"));
    toolbar.appendChild(labelsLabel);

    var zoomGroup = el("div", { class: "zoom-group" });
    zoomGroup.appendChild(el("button", { type: "button", dataset: { graphAction: "zoom-out" }, title: "Zoom out", "aria-label": "Zoom out" }, "−"));
    zoomGroup.appendChild(el("button", { type: "button", dataset: { graphAction: "reset" }, title: "Fit to view", "aria-label": "Fit to view" }, "⌂"));
    zoomGroup.appendChild(el("button", { type: "button", dataset: { graphAction: "zoom-in" }, title: "Zoom in", "aria-label": "Zoom in" }, "+"));
    toolbar.appendChild(zoomGroup);

    graph.appendChild(toolbar);

    var body = el("div", { class: "graph-body" });
    var canvas = el("div", { class: "graph-canvas" });
    canvas.dataset.graphWidth = String(data.width);
    canvas.dataset.graphHeight = String(data.height);

    var selected = state.selectedGraphKey ? data.nodeByKey.get(state.selectedGraphKey) : null;
    if (!selected) selected = null;

    var neighbors = new Set();
    if (selected) {
      neighbors.add(selected.key);
      data.edges.forEach(function (edge) {
        if (edge.from.key === selected.key) neighbors.add(edge.to.key);
        if (edge.to.key === selected.key) neighbors.add(edge.from.key);
      });
    }

    var svg = svgEl("svg", {
      class: "graph-svg" + (selected ? " has-selection" : ""),
      "aria-label": "Resource relationship graph",
      role: "img"
    });

    var defs = svgEl("defs");
    var marker = svgEl("marker", {
      id: "graph-arrow",
      viewBox: "0 0 10 10",
      refX: "9",
      refY: "5",
      markerWidth: "6",
      markerHeight: "6",
      orient: "auto-start-reverse"
    });
    marker.appendChild(svgEl("path", { d: "M 0 0 L 10 5 L 0 10 z", class: "graph-arrow" }));
    defs.appendChild(marker);
    svg.appendChild(defs);

    var world = svgEl("g", { class: "graph-world" });

    var edgeLayer = svgEl("g", { class: "graph-edges" });
    var showAllLabels = state.graphLabels && data.edges.length <= 14;
    data.edges.forEach(function (edge, index) {
      var hot = selected && (edge.from.key === selected.key || edge.to.key === selected.key);
      var dim = selected && !hot;
      var geometry = edgeGeometry(edge.from, edge.to);
      var path = svgEl("path", {
        class: "graph-edge" + (geometry.back ? " is-back" : "") + (hot ? " is-hot" : ""),
        d: geometry.path,
        "marker-end": "url(#graph-arrow)",
        "data-edge-index": String(index)
      });
      if (dim) path.setAttribute("opacity", "0.18");
      edgeLayer.appendChild(path);

      if (showAllLabels || (state.graphLabels && hot)) {
        var label = svgEl("text", {
          x: geometry.labelX,
          y: geometry.labelY,
          class: "graph-edge-label" + (hot ? " is-hot" : ""),
          "text-anchor": "middle"
        });
        label.textContent = core.truncate(edge.name, 18);
        edgeLayer.appendChild(label);
      }
    });
    world.appendChild(edgeLayer);

    var nodeLayer = svgEl("g", { class: "graph-nodes" });
    data.nodes.forEach(function (node) {
      var classes = "graph-node";
      if (node.root) classes += " is-root";
      if (node.orphan) classes += " is-orphan";
      if (node.missing) classes += " is-missing";
      if (selected && node.key === selected.key) classes += " is-selected";
      if (selected && !neighbors.has(node.key)) classes += " is-dim";

      var group = svgEl("g", {
        class: classes,
        transform: "translate(" + node.x + " " + node.y + ")",
        "data-node-key": node.key,
        tabindex: "0",
        role: "button",
        "aria-label": node.type + " " + (node.id !== null && node.id !== undefined ? node.id : node.lid || "")
      });
      group.style.setProperty("--h", Lens.hueFor(node.type));

      group.appendChild(svgEl("rect", { width: NODE_W, height: NODE_H, rx: 10 }));

      var typeText = svgEl("text", { x: 12, y: 20, class: "node-type" });
      typeText.textContent = core.truncate(node.type, 22);
      group.appendChild(typeText);

      var idText;
      if (node.id !== null && node.id !== undefined) idText = "#" + String(node.id);
      else if (node.lid !== null && node.lid !== undefined) idText = "lid:" + node.lid;
      else idText = "no id";
      if (node.label) idText += " · " + node.label;

      var idNode = svgEl("text", { x: 12, y: 38, class: "node-id" });
      idNode.textContent = core.truncate(idText, 27);
      group.appendChild(idNode);

      if (node.missing) {
        var missingText = svgEl("text", { x: NODE_W - 12, y: 20, class: "node-included", "text-anchor": "end" });
        missingText.textContent = "MISSING";
        group.appendChild(missingText);
      } else if (node.orphan) {
        var orphanText = svgEl("text", { x: NODE_W - 12, y: 20, class: "node-included", "text-anchor": "end" });
        orphanText.textContent = "UNLINKED";
        group.appendChild(orphanText);
      }

      var title = svgEl("title");
      title.textContent = Lens.identityText(node.type, node.id, node.lid) + (node.label ? " — " + node.label : "");
      group.appendChild(title);

      nodeLayer.appendChild(group);
    });
    world.appendChild(nodeLayer);
    svg.appendChild(world);

    canvas.appendChild(svg);

    var hint = el("div", { class: "graph-hint" });
    hint.appendChild(el("span", {}, "drag"));
    hint.appendChild(el("span", {}, "pan"));
    hint.appendChild(el("span", {}, "·"));
    hint.appendChild(el("span", {}, "scroll"));
    hint.appendChild(el("span", {}, "zoom"));
    hint.appendChild(el("span", {}, "·"));
    hint.appendChild(el("span", {}, "click"));
    hint.appendChild(el("span", {}, "inspect"));
    canvas.appendChild(hint);

    var legend = el("div", { class: "graph-legend" });
    legend.appendChild(legendRow("root", "primary data"));
    legend.appendChild(legendRow("orphan", "unlinked"));
    if (state.graphShowMissing) legend.appendChild(legendRow("missing", "not included"));
    canvas.appendChild(legend);

    body.appendChild(canvas);

    if (selected) {
      body.appendChild(renderInspector(selected, data, model));
    }

    graph.appendChild(body);
    return graph;
  }

  function legendRow(kind, label) {
    var row = el("div", { class: "legend-row" });
    row.appendChild(el("span", { class: "legend-swatch " + kind }));
    row.appendChild(el("span", {}, label));
    return row;
  }

  // -------------------------------------------------------------------------
  // Graph data + layout
  // -------------------------------------------------------------------------

  function buildGraphData(model) {
    var state = Lens.state;
    var nodeByKey = new Map();
    var nodes = [];

    function addNode(entry, options) {
      if (!entry || !entry.key || nodeByKey.has(entry.key)) return nodeByKey.get(entry.key) || null;
      var node = {
        key: entry.key,
        type: entry.type,
        id: entry.id,
        lid: entry.lid,
        label: entry.label,
        entry: entry,
        origin: entry.origin,
        depth: null,
        root: false,
        orphan: false,
        missing: false
      };
      if (options && options.root) node.root = true;
      nodeByKey.set(entry.key, node);
      nodes.push(node);
      return node;
    }

    model.primary.forEach(function (entry) {
      var node = addNode(entry, { root: true });
      if (node) node.depth = 0;
    });

    model.included.forEach(function (entry) {
      var node = addNode(entry);
      if (node && (!entry.key || model.orphanIncluded.has(entry.key))) node.orphan = true;
    });

    if (state.graphShowMissing) model.missing.forEach(function (missing) {
      if (!missing.key || nodeByKey.has(missing.key)) return;
      var node = {
        key: missing.key,
        type: missing.type,
        id: missing.id,
        lid: missing.lid,
        label: "",
        entry: null,
        origin: "missing",
        depth: null,
        root: false,
        orphan: false,
        missing: true
      };
      nodeByKey.set(node.key, node);
      nodes.push(node);
    });

    var adjacency = new Map();
    model.edges.forEach(function (edge) {
      if (!edge.fromKey || !edge.toKey) return;
      if (!adjacency.has(edge.fromKey)) adjacency.set(edge.fromKey, []);
      adjacency.get(edge.fromKey).push(edge.toKey);
    });

    var queue = nodes
      .filter(function (node) {
        return node.root;
      })
      .map(function (node) {
        return node.key;
      });
    var seen = new Set(queue);

    while (queue.length) {
      var key = queue.shift();
      var source = nodeByKey.get(key);
      var targets = adjacency.get(key) || [];
      targets.forEach(function (targetKey) {
        var target = nodeByKey.get(targetKey);
        if (!target || seen.has(targetKey)) return;
        seen.add(targetKey);
        target.depth = (source && source.depth !== null ? source.depth : 0) + 1;
        queue.push(targetKey);
      });
    }

    var maxDepth = 0;
    nodes.forEach(function (node) {
      if (node.depth !== null) maxDepth = Math.max(maxDepth, node.depth);
    });
    nodes.forEach(function (node) {
      if (node.depth === null) {
        node.depth = maxDepth + 1;
        if (!node.missing) node.orphan = true;
      }
    });

    var truncated = 0;
    if (nodes.length > MAX_NODES) {
      truncated = nodes.length - MAX_NODES;
      nodes = nodes.slice(0, MAX_NODES);
    }

    // Keep roots first (they were registered first), then BFS depth order.
    var visible = new Set(
      nodes.map(function (node) {
        return node.key;
      })
    );

    var layers = new Map();
    nodes.forEach(function (node) {
      if (!layers.has(node.depth)) layers.set(node.depth, []);
      layers.get(node.depth).push(node);
    });
    var depths = Array.from(layers.keys()).sort(function (a, b) {
      return a - b;
    });

    var maxRows = 1;
    depths.forEach(function (depth) {
      var layer = layers.get(depth);
      layer.sort(compareNodes);
      maxRows = Math.max(maxRows, layer.length);
    });

    var width = Math.max(720, PAD * 2 + Math.max(1, depths.length - 1) * COL_GAP + NODE_W);
    var height = Math.max(420, PAD * 2 + maxRows * NODE_H + (maxRows - 1) * ROW_GAP);

    depths.forEach(function (depth, column) {
      var layer = layers.get(depth);
      var columnHeight = layer.length * NODE_H + Math.max(0, layer.length - 1) * ROW_GAP;
      var startY = PAD + (height - PAD * 2 - columnHeight) / 2;
      layer.forEach(function (node, index) {
        node.x = PAD + column * COL_GAP;
        node.y = startY + index * (NODE_H + ROW_GAP);
      });
    });

    var edges = [];
    model.edges.forEach(function (edge) {
      if (!edge.fromKey || !edge.toKey) return;
      if (!visible.has(edge.fromKey) || !visible.has(edge.toKey)) return;
      edges.push({
        from: nodeByKey.get(edge.fromKey),
        to: nodeByKey.get(edge.toKey),
        name: edge.rel
      });
    });

    return {
      nodes: nodes,
      edges: edges,
      nodeByKey: nodeByKey,
      width: width,
      height: height,
      truncated: truncated
    };
  }

  function compareNodes(a, b) {
    var typeCompare = String(a.type).localeCompare(String(b.type));
    if (typeCompare !== 0) return typeCompare;
    var aId = a.id !== null && a.id !== undefined ? String(a.id) : String(a.lid || "");
    var bId = b.id !== null && b.id !== undefined ? String(b.id) : String(b.lid || "");
    return aId.localeCompare(bId);
  }

  function edgeGeometry(from, to) {
    if (from === to) {
      var sx = from.x + NODE_W - 32;
      var sy = from.y + 6;
      return {
        path:
          "M " +
          sx +
          " " +
          sy +
          " C " +
          (sx + 42) +
          " " +
          (sy - 42) +
          ", " +
          (sx - 16) +
          " " +
          (sy - 54) +
          ", " +
          (sx - 34) +
          " " +
          (sy - 8),
        labelX: sx + 1,
        labelY: sy - 48,
        back: true
      };
    }

    var x1 = from.x + NODE_W;
    var y1 = from.y + NODE_H / 2;
    var x2 = to.x;
    var y2 = to.y + NODE_H / 2;

    if (x2 > x1 + 24) {
      var midX = (x1 + x2) / 2;
      return {
        path: "M " + x1 + " " + y1 + " C " + midX + " " + y1 + ", " + midX + " " + y2 + ", " + x2 + " " + y2,
        labelX: midX,
        labelY: (y1 + y2) / 2 - 6,
        back: false
      };
    }

    var loopY = Math.max(y1, y2) + 58;
    var mx = (x1 + x2) / 2;
    return {
      path:
        "M " +
        x1 +
        " " +
        y1 +
        " C " +
        (x1 + 72) +
        " " +
        y1 +
        ", " +
        (x1 + 72) +
        " " +
        loopY +
        ", " +
        mx +
        " " +
        loopY +
        " S " +
        (x2 - 72) +
        " " +
        loopY +
        ", " +
        x2 +
        " " +
        y2,
      labelX: mx,
      labelY: loopY - 6,
      back: true
    };
  }

  // -------------------------------------------------------------------------
  // Inspector
  // -------------------------------------------------------------------------

  function renderInspector(node, data, model) {
    var aside = el("aside", { class: "graph-inspector" });
    aside.appendChild(el("div", { class: "inspector-kicker" }, "Selected resource"));

    var title = el("div", { class: "inspector-title" });
    title.appendChild(Lens.typeBadge(node.type));
    if (node.id !== null && node.id !== undefined) {
      title.appendChild(el("span", { class: "inspector-id" }, String(node.id)));
    } else if (node.lid !== null && node.lid !== undefined) {
      title.appendChild(el("span", { class: "inspector-id" }, "lid:" + node.lid));
    }
    aside.appendChild(title);

    if (node.label) {
      aside.appendChild(el("div", { class: "inspector-label" }, node.label));
    }

    if (node.missing) {
      aside.appendChild(
        el(
          "div",
          { class: "notice" },
          el("span", { class: "notice-icon" }, "!"),
          el(
            "div",
            {},
            el("strong", {}, "Not present in the document"),
            el("div", {}, "A relationship references this resource, but it is missing from data and included.")
          )
        )
      );
      var missingInfo = model.missing.get(node.key);
      if (missingInfo) {
        aside.appendChild(el("div", { class: "inspector-section-label" }, "Referenced by"));
        missingInfo.refs.forEach(function (ref) {
          aside.appendChild(
            el(
              "div",
              { class: "inspector-rel" },
              el("span", { class: "rel-target" }, ref.rel),
              el("span", { class: "rel-arrow" }, "·"),
              el("span", {}, ref.pointer)
            )
          );
        });
      }
      return aside;
    }

    var resource = node.entry.resource;
    var attributes = isObject(resource.attributes) ? resource.attributes : {};
    var relationships = isObject(resource.relationships) ? resource.relationships : {};
    var incoming = model.incoming.get(node.key) || [];
    var drawnOutgoing = data.edges.filter(function (edge) {
      return edge.from.key === node.key;
    }).length;
    var drawnIncoming = data.edges.filter(function (edge) {
      return edge.to.key === node.key;
    }).length;

    if (node.orphan) {
      aside.appendChild(
        el(
          "div",
          { class: "notice" },
          el("span", { class: "notice-icon" }, "!"),
          el(
            "div",
            {},
            el("strong", {}, "Unlinked included resource"),
            el("div", {}, "No relationship in this document points to it (full-linkage violation).")
          )
        )
      );
    }

    var stats = el("div", { class: "inspector-stats" });
    stats.appendChild(inspectorStat(Object.keys(attributes).length, "attributes"));
    stats.appendChild(inspectorStat(Object.keys(relationships).length, "relationships"));
    stats.appendChild(inspectorStat(drawnIncoming, "incoming"));
    stats.appendChild(inspectorStat(drawnOutgoing, "outgoing"));
    aside.appendChild(stats);

    var attrs = Object.keys(attributes);
    if (attrs.length) {
      aside.appendChild(el("div", { class: "inspector-section-label" }, "Attributes"));
      attrs.slice(0, 10).forEach(function (name) {
        aside.appendChild(
          el(
            "div",
            { class: "inspector-attr" },
            el("span", { class: "k" }, name),
            el("span", { class: "v" }, Lens.previewValue(attributes[name]))
          )
        );
      });
      if (attrs.length > 10) {
        aside.appendChild(el("div", { class: "inspector-label" }, "+" + (attrs.length - 10) + " more — open the tree view"));
      }
    }

    var relNames = Object.keys(relationships);
    if (relNames.length) {
      aside.appendChild(el("div", { class: "inspector-section-label" }, "Relationships"));
      relNames.forEach(function (name) {
        var rel = relationships[name];
        var identifiers = [];
        if (isObject(rel) && rel.data === null) identifiers = ["null"];
        else if (isObject(rel) && Array.isArray(rel.data)) {
          identifiers = rel.data.map(function (identifier) {
            return isObject(identifier) ? Lens.identityText(identifier.type, identifier.id, identifier.lid) : "?";
          });
        } else if (isObject(rel) && isObject(rel.data)) {
          identifiers = [Lens.identityText(rel.data.type, rel.data.id, rel.data.lid)];
        } else {
          identifiers = ["linkage not in document"];
        }
        identifiers.forEach(function (identifier) {
          aside.appendChild(
            el(
              "div",
              { class: "inspector-rel" },
              el("span", {}, name),
              el("span", { class: "rel-arrow" }, "→"),
              el("span", { class: "rel-target" }, identifier)
            )
          );
        });
      });
    }

    if (incoming.length) {
      aside.appendChild(el("div", { class: "inspector-section-label" }, "Incoming"));
      incoming.forEach(function (edge) {
        aside.appendChild(
          el(
            "div",
            { class: "inspector-rel" },
            el("span", { class: "rel-target" }, Lens.identityText(edge.fromEntry.type, edge.fromEntry.id, edge.fromEntry.lid)),
            el("span", { class: "rel-arrow" }, "→"),
            el("span", {}, edge.rel)
          )
        );
      });
    }

    var actions = el("div", { class: "inspector-actions" });
    actions.appendChild(
      el(
        "button",
        { class: "tool-btn primary", type: "button", dataset: { action: "focus-res", key: node.key } },
        "Show in tree"
      )
    );
    actions.appendChild(
      el(
        "button",
        {
          class: "tool-btn",
          type: "button",
          dataset: { copy: Lens.identityText(node.type, node.id, node.lid), copyLabel: "Identity copied" }
        },
        "Copy id"
      )
    );
    if (node.entry) {
      actions.appendChild(
        el(
          "button",
          {
            class: "tool-btn",
            type: "button",
            title: "Copy resolved JSON — relationships inlined",
            dataset: { action: "copy-resource", pointer: node.entry.pointer }
          },
          "Copy JSON"
        )
      );
    }
    aside.appendChild(actions);

    return aside;
  }

  function inspectorStat(value, label) {
    var box = el("div", { class: "inspector-stat" });
    box.appendChild(el("b", {}, String(value)));
    box.appendChild(el("span", {}, label));
    return box;
  }

  // -------------------------------------------------------------------------
  // Pan / zoom mounting
  // -------------------------------------------------------------------------

  function mountGraph(root) {
    var state = Lens.state;
    var canvas = root.querySelector(".graph-canvas");
    var svg = root.querySelector(".graph-svg");
    var world = root.querySelector(".graph-world");
    if (!canvas || !svg || !world) return;

    var graphWidth = Number(canvas.dataset.graphWidth);
    var graphHeight = Number(canvas.dataset.graphHeight);
    if (!graphWidth || !graphHeight) return;

    function sizeSvg() {
      var rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      svg.setAttribute("viewBox", "0 0 " + rect.width + " " + rect.height);
      return rect;
    }

    function applyTransform() {
      var transform = state.graphTransform;
      if (!transform) return;
      world.setAttribute(
        "transform",
        "translate(" + transform.tx + " " + transform.ty + ") scale(" + transform.scale + ")"
      );
    }

    function fit() {
      var rect = sizeSvg();
      if (!rect) return;
      var scale = Math.min((rect.width - 36) / graphWidth, (rect.height - 36) / graphHeight, 1.2);
      scale = Math.max(0.12, scale);
      state.graphTransform = {
        tx: (rect.width - graphWidth * scale) / 2,
        ty: (rect.height - graphHeight * scale) / 2,
        scale: scale
      };
      state.graphUserAdjusted = false;
      applyTransform();
    }

    function zoomAt(px, py, factor) {
      var current = state.graphTransform;
      if (!current) return;
      var next = Math.min(3.2, Math.max(0.15, current.scale * factor));
      var ratio = next / current.scale;
      state.graphTransform = {
        tx: px - (px - current.tx) * ratio,
        ty: py - (py - current.ty) * ratio,
        scale: next
      };
      state.graphUserAdjusted = true;
      applyTransform();
    }

    sizeSvg();
    if (!state.graphTransform) {
      window.requestAnimationFrame(function () {
        if (document.body.contains(canvas)) fit();
      });
    } else {
      applyTransform();
    }

    root.querySelectorAll("[data-graph-action]").forEach(function (button) {
      button.addEventListener("click", function () {
        var action = button.dataset.graphAction;
        var rect = canvas.getBoundingClientRect();
        if (action === "reset") {
          fit();
        } else if (action === "zoom-in") {
          zoomAt(rect.width / 2, rect.height / 2, 1.22);
        } else if (action === "zoom-out") {
          zoomAt(rect.width / 2, rect.height / 2, 1 / 1.22);
        }
      });
    });

    var labelsCheckbox = root.querySelector("[data-graph-labels]");
    if (labelsCheckbox) {
      labelsCheckbox.addEventListener("change", function () {
        state.graphLabels = labelsCheckbox.checked;
        Lens.renderView();
      });
    }

    var missingCheckbox = root.querySelector("[data-graph-missing]");
    if (missingCheckbox) {
      missingCheckbox.addEventListener("change", function () {
        state.graphShowMissing = missingCheckbox.checked;
        state.graphTransform = null;
        state.graphUserAdjusted = false;
        Lens.renderView();
      });
    }

    var drag = null;
    var suppressClick = false;

    canvas.addEventListener("pointerdown", function (event) {
      if (event.target.closest("[data-node-key]")) return;
      var transform = state.graphTransform || { tx: 0, ty: 0, scale: 1 };
      drag = {
        x: event.clientX,
        y: event.clientY,
        tx: transform.tx,
        ty: transform.ty,
        scale: transform.scale,
        moved: false
      };
      suppressClick = false;
      canvas.classList.add("is-panning");
      if (canvas.setPointerCapture) canvas.setPointerCapture(event.pointerId);
    });

    canvas.addEventListener("pointermove", function (event) {
      if (!drag) return;
      var dx = event.clientX - drag.x;
      var dy = event.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
      state.graphTransform = {
        tx: drag.tx + dx,
        ty: drag.ty + dy,
        scale: drag.scale
      };
      if (drag.moved) state.graphUserAdjusted = true;
      applyTransform();
    });

    function endDrag() {
      if (!drag) return;
      suppressClick = drag.moved;
      drag = null;
      canvas.classList.remove("is-panning");
    }

    canvas.addEventListener("pointerup", endDrag);
    canvas.addEventListener("pointercancel", endDrag);

    canvas.addEventListener(
      "wheel",
      function (event) {
        event.preventDefault();
        var transform = state.graphTransform;
        if (!transform) return;
        var rect = canvas.getBoundingClientRect();
        var factor = Math.exp(-event.deltaY * 0.0015);
        zoomAt(event.clientX - rect.left, event.clientY - rect.top, factor);
      },
      { passive: false }
    );

    function select(key) {
      state.selectedGraphKey = state.selectedGraphKey === key ? null : key;
      state.graphTransform = null;
      state.graphUserAdjusted = false;
      Lens.renderView();
    }

    canvas.addEventListener("click", function (event) {
      if (suppressClick) {
        suppressClick = false;
        return;
      }
      var node = event.target.closest("[data-node-key]");
      if (!node) {
        if (state.selectedGraphKey) {
          state.selectedGraphKey = null;
          Lens.renderView();
        }
        return;
      }
      select(node.getAttribute("data-node-key"));
    });

    canvas.addEventListener("keydown", function (event) {
      if (event.key !== "Enter" && event.key !== " ") return;
      var node = event.target.closest("[data-node-key]");
      if (!node) return;
      event.preventDefault();
      select(node.getAttribute("data-node-key"));
    });

    if (pendingResize) window.removeEventListener("resize", pendingResize);
    pendingResize = function () {
      if (!document.body.contains(canvas)) return;
      sizeSvg();
      if (!state.graphUserAdjusted) fit();
      else applyTransform();
    };
    window.addEventListener("resize", pendingResize);
  }

  Lens.renderGraph = renderGraph;
  Lens.mountGraph = mountGraph;
})();
