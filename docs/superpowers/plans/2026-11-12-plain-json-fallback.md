# Plain JSON fallback — implementation plan

**Design:** `docs/superpowers/specs/2026-11-11-plain-json-fallback-design.md`
**Goal:** Any valid JSON opens in the viewer. JSON:API documents behave exactly as today.
**Stack:** static HTML/CSS/vanilla JS, no build step. Tests are a single Node script.

## Architecture

Three layers change, no new files beyond the plan itself:

| Layer | File | Change |
| --- | --- | --- |
| Detection | `core.js` | One helper `isJsonApiDocument(doc)`, a new `kind: "plain"`, and `validate()` skipping non-JSON:API documents. |
| Rendering | `tree.js` | `renderTree` routes `kind === "plain"` to `renderPlain()`, a recursive renderer capped at depth 8 and 200 children per node. |
| Chrome | `app.js` | Neutral `Plain JSON` chip, honest status line, Graph tab disabled, Issues tab copy for plain documents. |

Detection rule (single source of truth, used by both `validate` and `buildModel`):

```js
function isJsonApiDocument(doc) {
  return isObject(doc) && (hasOwn(doc, "data") || hasOwn(doc, "errors") || hasOwn(doc, "meta"));
}
```

So `{ data: 12 }` is still JSON:API and still fails validation; `{ users: [] }`, top-level arrays and primitives are plain.

## Conventions

- Run tests from the repo root: `node tests/core.test.js`.
- Every commit message below is literal.
- No new runtime dependency. No build step. No new page or URL.
- Existing guards stay: 50 MB input cap, 8 MB pretty-print cap, 200 KB value preview, 200-node render caps.

---

## Task 0 — Commit the approved design

**Files:** `docs/superpowers/specs/2026-11-11-plain-json-fallback-design.md`, `robots.txt`

- [ ] **Step 1:** Confirm the design doc exists.

Run: `test -f docs/superpowers/specs/2026-11-11-plain-json-fallback-design.md && echo ok`

Expected: `ok`

- [ ] **Step 2:** Confirm `robots.txt` disallows the plan/spec directory.

Run: `grep -n "Disallow: /docs/superpowers/" robots.txt`

Expected: one matching line.

- [ ] **Step 3:** Commit.

```bash
git add docs/superpowers/specs/2026-11-11-plain-json-fallback-design.md robots.txt
git commit -m "docs: design plain-JSON fallback and keep specs out of the index"
```

---

## Task 1 — Core: detect plain JSON and stop validating it

**Files:** `core.js`, `tests/core.test.js`

**Interfaces produced:**

- `core.buildModel(value)` returns `kind: "plain"` when `isJsonApiDocument(value)` is false.
- `core.validate(value)` returns `[]` for those same values.

### Step 1: Write the failing tests

Add these `test(...)` blocks to `tests/core.test.js` immediately before the `var failed = ...` block.

```js
test("classifies non-JSON:API objects as plain", function () {
  assert.strictEqual(core.buildModel({ users: [{ id: 1 }] }).kind, "plain");
  assert.strictEqual(core.buildModel({ jsonapi: { version: "1.1" } }).kind, "plain");
});

test("classifies top-level arrays as plain", function () {
  assert.strictEqual(core.buildModel([1, 2, 3]).kind, "plain");
  assert.strictEqual(core.buildModel([]).kind, "plain");
});

test("classifies primitives as plain", function () {
  [null, "text", 42, true].forEach(function (value) {
    assert.strictEqual(core.buildModel(value).kind, "plain");
  });
});

test("emits no JSON:API issues for plain documents", function () {
  [{ users: [] }, { jsonapi: { version: "1.1" } }, [1, 2], "text", 42, true, null].forEach(function (doc) {
    assert.deepStrictEqual(core.validate(doc), []);
  });
});

test("plain models stay empty", function () {
  var model = core.buildModel({ users: [{ id: 1 }] });
  assert.strictEqual(model.primary.length, 0);
  assert.strictEqual(model.included.length, 0);
  assert.strictEqual(model.stats.primaryCount, 0);
});

test("declaring data still makes a document JSON:API", function () {
  assert.strictEqual(core.buildModel({ data: 12 }).kind, "invalid");
  assert.ok(core.validate({ data: 12 }).length > 0);
  assert.strictEqual(core.buildModel({ data: null }).kind, "null");
  assert.strictEqual(core.buildModel({ data: { type: "articles", id: "1" } }).kind, "resource");
  assert.strictEqual(core.buildModel({ data: [] }).kind, "collection");
});

test("errors and meta documents keep their kinds", function () {
  assert.strictEqual(core.buildModel({ errors: [] }).kind, "errors");
  assert.strictEqual(core.buildModel({ meta: {} }).kind, "meta");
});
```

### Step 1b: Adjust the one pre-existing test the new rule invalidates

`test("detects included without data")` currently uses `{ included: [...] }` and asserts `INCLUDED_WITHOUT_DATA` plus `EMPTY_DOCUMENT`. Under the new rule that document is plain, so `validate()` correctly returns `[]`, and `EMPTY_DOCUMENT` is unreachable for any JSON:API document (it must declare `data`, `errors` or `meta`). Rewrite that test to keep its intent:

```js
test("detects included without data", function () {
  var doc = { errors: [], included: [{ type: "people", id: "1" }] };
  // ...keep the existing assertions against `doc`...
  assert.ok(codes.includes("INCLUDED_WITHOUT_DATA"));
  assert.deepStrictEqual(core.validate({ included: [{ type: "people", id: "1" }] }), [], "included-only documents are plain JSON");
});
```

Leave the now-unreachable `EMPTY_DOCUMENT` rule in `core.js`; removing it is out of scope.

### Step 2: Run the tests and watch them fail

Run: `node tests/core.test.js`

Expected: FAIL on the new plain cases (`classifies non-JSON:API objects as plain` first), with the tail showing fewer than 33 passing tests. Existing 26 must still pass.

### Step 3: Add the detection helper

In `core.js`, immediately below `hasOwn` (around line 30), add:

```js
  // A document is JSON:API when it declares one of the three primary members.
  // Everything else is ordinary JSON and is rendered, not validated.
  function isJsonApiDocument(doc) {
    return isObject(doc) && (hasOwn(doc, "data") || hasOwn(doc, "errors") || hasOwn(doc, "meta"));
  }
```

### Step 4: Make `validate` skip plain documents

In `core.js`, inside `validate(doc)`, replace the opening guard

```js
    if (!isObject(doc)) {
      add(
        "error",
        "DOCUMENT_TYPE",
```

through the end of that `if` block (the `return issues;` and closing brace) with:

```js
    if (!isJsonApiDocument(doc)) {
      return issues;
    }
```

This removes the `DOCUMENT_TYPE` error path entirely. Non-objects and objects without `data`/`errors`/`meta` now produce no issues. Do not touch any other rule.

### Step 5: Give `buildModel` a plain kind

In `core.js`, inside `buildModel(doc)`, replace

```js
    if (!isObject(doc)) return model;

    // Determine document shape ------------------------------------------------
```

with

```js
    if (!isJsonApiDocument(doc)) {
      model.kind = "plain";
      return model;
    }

    // Determine document shape ------------------------------------------------
```

Then, at the end of the existing shape detection, replace

```js
    } else if (isObject(doc.meta)) {
      model.kind = "meta";
    }
```

with

```js
    } else if (isObject(doc.meta)) {
      model.kind = "meta";
    } else {
      // `errors` or `meta` declared with the wrong type: still JSON:API, but
      // structurally invalid. `plain` must never be reachable from here.
      model.kind = "invalid";
    }
```

The `else` branch is defensive only: `isJsonApiDocument` already guarantees one of the three members exists.

### Step 6: Run the tests

Run: `node tests/core.test.js`

Expected: `33/33 tests passed` and exit code 0.

If `declaring data still makes a document JSON:API` fails on `{ data: null }`, the `hasOwn(doc, "data")` branch was altered — it must stay.

### Step 7: Commit

```bash
git add core.js tests/core.test.js
git commit -m "feat(core): classify plain JSON and skip JSON:API validation for it"
```

---

## Task 2 — Tree: render a generic recursive tree

**Files:** `tree.js`

There is no DOM test harness (the project is dependency-free), so this task is verified by `node --check` and the browser checklist in Task 5. Keep the code in the existing IIFE style: `var`, `function`, `el(...)`.

### Step 1: Add the plain constants

In `tree.js`, after `var VALUE_PREVIEW_LIMIT = 200000;` (line ~15), add:

```js
  var PLAIN_DEPTH_LIMIT = 8;
  var PLAIN_CHILD_LIMIT = 200;
```

### Step 2: Add `renderPlain` and `renderPlainNode`

Insert immediately before `function renderInvalid()` (line ~835).

```js
  // -------------------------------------------------------------------------
  // Plain JSON (not a JSON:API document)
  // -------------------------------------------------------------------------

  function plainLabel(value) {
    var isArray = Array.isArray(value);
    if (isArray) return "array · " + value.length + " items";
    return "object · " + Object.keys(value).length + " keys";
  }

  // `depth` is the nesting level of `value`. At the limit the subtree is shown
  // as a single pretty-printed <pre> so a pathological document still terminates.
  function renderPlainNode(value, depth) {
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
      var end = Math.min(keys.length, rendered + PLAIN_CHILD_LIMIT);
      for (var i = rendered; i < end; i += 1) {
        var key = keys[i];
        var row = el("div", { class: "attr" });
        row.appendChild(
          el("span", { class: "attr-name", title: String(key) }, isArray ? "[" + key + "]" : String(key))
        );
        var cell = el("div", { class: "attr-value" });
        cell.appendChild(renderPlainNode(value[key], depth + 1));
        row.appendChild(cell);
        rows.appendChild(row);
      }
      rendered = end;
      if (more) rows.appendChild(more);
    }

    if (keys.length > PLAIN_CHILD_LIMIT) {
      more = el("button", { class: "tool-btn", type: "button" }, "Show " + PLAIN_CHILD_LIMIT + " more");
      more.addEventListener("click", function () {
        appendBatch();
        var remaining = keys.length - rendered;
        if (remaining > 0) {
          more.textContent = "Show " + Math.min(PLAIN_CHILD_LIMIT, remaining) + " more";
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
    return section;
  }
```

Note: `appendBatch()` runs once with `more === null` for the common case; when there are more children it appends `more` after the first 200 rows, then repeatedly appends batches above the button.

### Step 3: Route the new kind

In `renderTree()`, replace

```js
    if (!model || model.kind === "invalid") {
      fragment.appendChild(renderInvalid());
      return fragment;
    }
```

with

```js
    if (!model || model.kind === "invalid") {
      fragment.appendChild(renderInvalid());
      return fragment;
    }

    if (model.kind === "plain") {
      fragment.appendChild(renderPlain());
      return fragment;
    }
```

### Step 4: Update the invalid-state copy

Plain JSON no longer reaches `renderInvalid`. Replace the body text in `renderInvalid()` so it describes malformed JSON:API only. Replace

```js
            "The top-level value must be an object containing at least one of data, errors or meta. Open the Issues tab for the structural details."
```

with

```js
            "This document declares data, errors or meta but is not a structurally valid JSON:API document. Open the Issues tab for the details."
```

### Step 5: Syntax check

Run: `node --check tree.js`

Expected: no output, exit code 0.

### Step 6: Commit

```bash
git add tree.js
git commit -m "feat(tree): render plain JSON as a generic recursive tree"
```

---

## Task 3 — Chrome: summary, status, tabs, issues

**Files:** `app.js`

### Step 1: Neutral summary chip

In `renderSummary()`, after

```js
    var errors = countSeverity("error");
    var warnings = countSeverity("warning");
    var infos = countSeverity("info");
    var model = state.model;
```

insert:

```js
    if (model.kind === "plain") {
      var plainChip = makeChip("is-info", "This document is valid JSON but not JSON:API, so it is not validated.");
      plainChip.appendChild(el("b", {}, "Plain JSON"));
      summary.appendChild(plainChip);
      return;
    }
```

No error/warning/resource/linkage/type chips render for plain documents.

### Step 2: Honest status line

In `updateStatus()`, replace

```js
      parts.push(state.model.stats.primaryCount + state.model.stats.includedCount + " resources");
```

with

```js
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
```

`state.doc` is always defined when `state.model` exists (both are set from the same parse), so the primitive branch has no undefined hazard.

### Step 3: Disable the Graph tab

In `renderTabs()`, replace the tab loop with:

```js
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
```

`tab.disabled = true` on a `<button role="tab">` blocks clicks without new CSS. Do not add styles.

### Step 4: Never land on Graph in plain mode

In `applyInput()`, immediately after

```js
    state.issues = core.validate(parsed.value);
```

insert:

```js
    if (state.model.kind === "plain" && state.tab === "graph") state.tab = "tree";
```

This covers a saved `graph` tab from `localStorage`.

Also harden `switchTab()`: at the top of the function, before `if (tab === state.tab)`, add

```js
    if (tab === "graph" && state.model && state.model.kind === "plain") return;
```

### Step 5: Plain copy in the Issues tab

In `renderIssuesView()`, before the `if (!state.issues.length)` block, add:

```js
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
```

Without this, plain documents falsely claim "Checked 0 resources and 0 relationships".

### Step 6: Syntax check

Run: `node --check app.js`

Expected: no output, exit code 0.

### Step 7: Commit

```bash
git add app.js
git commit -m "feat(app): plain-JSON summary, status, and tab behaviour"
```

---

## Task 4 — Docs: one sentence each

**Files:** `index.html`, `README.md`

### Step 1: Landing page

In `index.html`, find the hero lead paragraph (`<p class="lead">` at ~line 158, beginning "Paste a JSON:API response"). After the sentence ending "everything runs in your browser." add this sentence, inside the same `<p>`:

```
It also opens ordinary JSON as a plain tree, so any document you paste is readable.
```

No new element, no new heading, no keyword changes.

### Step 2: README

In `README.md`, after the first paragraph (ending "shows exactly which linkage targets are missing from the document."), add a standalone paragraph:

```
The viewer also opens ordinary JSON as a plain tree — JSON:API documents get relationship expansion and validation, everything else gets a readable tree.
```

### Step 3: Commit

```bash
git add index.html README.md
git commit -m "docs: mention the plain-JSON fallback"
```

---

## Task 5 — Verify end to end

**Files:** none (verification only)

### Step 1: Unit tests

Run: `node tests/core.test.js`

Expected: `33/33 tests passed`, exit code 0 (`echo $?` prints `0`).

### Step 2: Serve the site

Run from the repo root:

```bash
python3 -m http.server 8000
```

Open `http://localhost:8000/viewer/`.

### Step 3: Plain object

Paste:

```json
{"users":[{"id":1,"name":"Ada","tags":["math","code"],"active":true}]}
```

Confirm all of:

- Tree tab shows the blue **Plain JSON** notice and a collapsible `object · 1 keys` tree.
- Summary bar shows a single neutral **Plain JSON** chip, no error count.
- Status line reads `Valid JSON · N lines · size · 1 key` (no "resources").
- Graph tab is visually disabled and cannot be selected.
- Issues tab shows **No JSON:API rules apply**.
- JSON tab shows the document unchanged.

### Step 4: Top-level array and primitive

Paste `[1,2,3]` → tree shows `array · 3 items`; status says `3 items`.
Paste `"hello"` → notice plus a `root` row showing `"hello"`.

### Step 5: No JSON:API regression

Load the built-in deep sample (the sample menu → the article/people/company document). Confirm all of:

- Summary shows `0 errors` (or the same status as before this change) and resource/linkage/type chips.
- Expand all still resolves people, companies and comments, including the cycle back to the article.
- Graph tab is enabled and draws nodes.
- Copy resolved JSON still works.
- Issues tab still reports the same findings as before this change.

### Step 6: Malformed data is still JSON:API

Paste `{"data":12}`. Confirm:

- Tree shows the invalid notice, not a plain tree.
- Summary shows an error chip and the Issues tab reports `DOCUMENT_TYPE` / data-shape errors.
- The Graph tab remains reachable and shows its empty state.

### Step 7: Push

```bash
git push origin main
```

Then watch the Pages build:

```bash
gh api repos/NayanBhut/jsonapi-lens/pages -q .status
```

Expected: `building` then `built`.

---

## Self-review

| Spec requirement | Covered by |
| --- | --- |
| Object with `data`/`errors`/`meta` unchanged | Task 1 tests `declaring data still makes a document JSON:API`, `errors and meta documents keep their kinds` |
| Other objects, arrays, primitives → plain | Task 1 tests `classifies …` |
| Plain documents emit zero issues | Task 1 test `emits no JSON:API issues for plain documents` |
| Generic tree: primitives inline, objects/arrays details | Task 2 `renderPlainNode` |
| Depth cap 8 → `<pre>` fallback | Task 2 `if (depth >= PLAIN_DEPTH_LIMIT) return renderValue(value)` |
| 200 children with "Show 200 more" | Task 2 `appendBatch` |
| Neutral `Plain JSON` chip | Task 3 Step 1 |
| Graph and per-resource copy disabled | Task 3 Steps 3–4 (per-resource copy is inside the JSON:API tree only, so plain mode never renders it) |
| JSON tab unchanged | No change to `renderJsonView` |
| Existing guards reused | Task 2 reuses `renderValue` at the depth limit and existing `val-*` classes |
| One-sentence landing + README mention | Task 4 |
| No new URL/page | No files added under `viewer/` or `docs/` |

**Proportion check:** one helper, one branch in two core functions, one new renderer, four small `app.js` edits, two doc sentences. No new dependency, no build step, no new CSS.
