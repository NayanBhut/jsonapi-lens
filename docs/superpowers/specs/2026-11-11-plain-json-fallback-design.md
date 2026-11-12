# Plain JSON fallback — design

**Date:** 2026-11-11
**Status:** awaiting approval
**Size:** small change

## Intent

Today JSON:API Lens rejects any document that is not JSON:API. A developer who
pastes ordinary JSON gets an error screen ("Document has no primary content")
even though the JSON is perfectly valid. This change makes the viewer open any
valid JSON and render it as a readable tree, while keeping every JSON:API
feature exactly as it is today.

Chosen over building a second "JSON viewer" page: generic JSON-viewer queries are
the most competitive terms in developer tooling, so a new page would not earn
reach. This is a usability fix, not an SEO play.

## Goals

- A valid non-JSON:API document (object, array, or primitive) renders as a tree.
- No JSON:API structural errors are reported for those documents.
- JSON:API documents behave exactly as they do now.

## Non-goals

- No new URL, page, or keyword target.
- No JSONPath, query, schema inference, or diff features.
- No change to the validator, graph, or resolved-copy behaviour for JSON:API.

## Detection rules

| Parsed value | Mode |
| --- | --- |
| Object with own `data`, `errors`, or `meta` | JSON:API (unchanged) |
| Any other object | Plain JSON |
| Top-level array | Plain JSON |
| Primitive (`string`, `number`, `boolean`, `null`) | Plain JSON |
| Invalid JSON (parse error) | Parse error (unchanged) |

`data` present but of the wrong type still counts as JSON:API and still fails
validation — declaring `data` is an assertion that the document is JSON:API.

## Changes

### `core.js`

- `buildModel` gains `kind: "plain"` for the cases above instead of leaving the
  kind unset.
- `validate` returns `[]` when the document is plain, skipping every JSON:API
  rule (including `EMPTY_DOCUMENT` and `DOCUMENT_TYPE`).

### `tree.js`

- `renderTree` routes `kind === "plain"` to a new `renderPlain()`.
- `renderPlain()`:
  - a one-line notice: "Plain JSON — not a JSON:API document. Showing a generic
    tree." (info styling, not error)
  - a generic recursive renderer: primitives inline, objects/arrays as
    `<details>` rows, depth limit 8 before falling back to a pretty-printed
    `<pre>`, children capped at 200 per node with a "Show 200 more" control.
  - reuses existing classes (`val-string`, `val-number`, `val-object`,
    `value-details`) so no new CSS is needed beyond one notice style.
- `renderInvalid` now means "invalid JSON:API", not "not JSON:API".

### `app.js`

- Summary bar in plain mode: a neutral chip reading `Plain JSON` instead of an
  error count; resource/linkage/type chips are skipped.
- Status line keeps `Valid JSON · N lines · size`.
- Graph tab and per-resource copy are disabled in plain mode (they have no
  meaning); the JSON tab keeps working.

### Docs

- One sentence on the landing page and in `README.md`: the viewer also opens
  ordinary JSON as a plain tree.

## Large-document behaviour

Reuses the existing guards: 50 MB input cap, 200 children per node, 8 MB
pretty-print limit, 200 KB value previews, depth limit with a `<pre>` fallback.
No new unbounded rendering path.

## Verification

- `node tests/core.test.js` — existing 26 tests plus new cases: plain object,
  top-level array, primitive, JSON:API document still classified `resource`, no
  issues emitted for plain documents, `data` of the wrong type still validated.
- Browser check at `/viewer/`: paste plain JSON, confirm tree renders, Issues
  tab is empty, JSON tab unchanged, graph disabled; re-run the JSON:API deep
  sample and confirm no regression.
