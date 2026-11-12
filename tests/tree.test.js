/*
 * Tree renderer tests — runs tree.js in Node with a minimal DOM stub so the
 * plain-JSON render budget is enforced by the suite, not just by the browser.
 * Run: node tests/tree.test.js
 */
"use strict";

var assert = require("node:assert");

var results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name: name, ok: true });
  } catch (error) {
    results.push({ name: name, ok: false, error: error });
  }
}

// ---------------------------------------------------------------------------
// DOM stub
// ---------------------------------------------------------------------------

var elements = 0;
var texts = [];

function stubNode(tag) {
  elements += 1;
  return {
    tag: tag,
    children: [],
    style: { setProperty: function () {} },
    classList: { add: function () {}, remove: function () {}, toggle: function () {} },
    dataset: {},
    disabled: false,
    appendChild: function (child) {
      this.children.push(child);
    },
    addEventListener: function () {},
    remove: function () {},
    setAttribute: function () {},
    getAttribute: function () {
      return null;
    },
    get childNodes() {
      return this.children;
    },
    textContent: "",
    className: "",
  };
}

global.window = {};
global.document = {
  createElement: stubNode,
  createElementNS: stubNode,
  createTextNode: function (text) {
    texts.push(String(text));
    return {};
  },
};

var core = require("../core.js");

// Mirror of lib.js append(): null/false booleans skipped, arrays flattened,
// stub nodes appended, everything else becomes a recorded text node.
function appendStub(parent, child) {
  if (child === null || child === undefined || child === false || child === true) return;
  if (Array.isArray(child)) {
    child.forEach(function (item) {
      appendStub(parent, item);
    });
    return;
  }
  if (child && typeof child === "object" && child.tag !== undefined) {
    parent.appendChild(child);
    return;
  }
  var text = String(child);
  texts.push(text);
  parent.appendChild({ text: text });
}

var Lens = (global.window.Lens = {
  isObject: core.isObject,
  hasOwn: function (object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
  },
  el: function (tag) {
    var node = stubNode(tag);
    var start = 1;
    var first = arguments[1];
    if (first && typeof first === "object" && !Array.isArray(first) && first.tag === undefined) start = 2;
    for (var i = start; i < arguments.length; i++) appendStub(node, arguments[i]);
    return node;
  },
  formatBytes: function () {
    return "?";
  },
  typeBadge: function () {
    return stubNode("span");
  },
  identityText: function () {
    return "";
  },
  linkHref: function () {
    return null;
  },
  hueFor: function () {
    return 0;
  },
  state: {
    doc: null,
    model: null,
    expanded: new Set(),
    includedOpen: true,
    showAllIncluded: false,
    primaryRenderCount: 200,
    maxDepth: 4,
  },
});
global.window.JsonApiCore = core;

require("../tree.js");

function reset() {
  elements = 0;
  texts = [];
}

function render(doc) {
  reset();
  Lens.state.doc = doc;
  Lens.state.model = core.buildModel(doc);
  Lens.renderTree();
}

function hasText(needle) {
  return texts.some(function (text) {
    return text.indexOf(needle) !== -1;
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("plain tree stays inside the render budget on a branching document", function () {
  // 3 levels x 60 keys = 216,000 leaves. Without a budget this builds one
  // DOM row per leaf and freezes the tab; the budget must keep it bounded.
  var doc = {};
  for (var i = 0; i < 60; i++) {
    var level1 = {};
    for (var j = 0; j < 60; j++) {
      var level2 = {};
      for (var k = 0; k < 60; k++) level2["b" + k] = k;
      level1["a" + j] = level2;
    }
    doc["k" + i] = level1;
  }

  render(doc);

  // Each row costs ~4 elements and each capped subtree ~3 more, so anything
  // far beyond ~150k elements means the budget is not being enforced.
  assert.ok(
    elements < 150000,
    "expected the render to stay bounded, built " + elements.toLocaleString() + " elements"
  );
  assert.ok(hasText("Preview limited to"), "expected the cap notice to be shown");
});

test("plain tree under the budget shows no cap notice", function () {
  var doc = {};
  for (var i = 0; i < 150; i++) doc["k" + i] = { index: i };

  render(doc);
  assert.ok(!hasText("Preview limited to"), "small documents must render without the cap notice");
  assert.ok(!hasText("Preview cap reached"), "no placeholder should appear under the budget");
});

test("deep plain chain still terminates without triggering the budget", function () {
  var doc = { v: 0 };
  var current = doc;
  for (var d = 0; d < 12; d++) {
    var next = { v: d };
    current.child = next;
    current = next;
  }

  render(doc);
  assert.ok(!hasText("Preview limited to"), "a thin deep chain needs no cap notice");
});

test("plain scalar, array and null roots still render", function () {
  render(42);
  assert.ok(hasText("42"));

  render([1, 2, 3]);
  assert.ok(hasText("array · 3 items"));

  render(null);
  assert.ok(hasText("null"));
});

test("JSON:API tree is unaffected by the plain budget", function () {
  var doc = {
    jsonapi: { version: "1.1" },
    data: [
      {
        type: "articles",
        id: "1",
        attributes: { title: "Budget regression" },
        relationships: { author: { data: { type: "people", id: "9" } } }
      }
    ],
    included: [{ type: "people", id: "9", attributes: { name: "Ada" } }]
  };

  render(doc);
  assert.ok(elements > 30, "expected a full JSON:API tree render");
  assert.ok(!hasText("Plain JSON"), "JSON:API documents must not show the plain notice");
});

var failed = results.filter(function (result) {
  return !result.ok;
});

results.forEach(function (result) {
  console.log((result.ok ? "PASS" : "FAIL") + "  " + result.name);
  if (!result.ok) console.log(result.error && result.error.stack);
});

console.log("\n" + (results.length - failed.length) + "/" + results.length + " tests passed");
if (failed.length) process.exitCode = 1;
