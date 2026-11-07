# JSON:API Lens

A dependency-free, browser-based JSON:API viewer, validator, and relationship explorer focused on **deep relationships**. Unlike viewers that stop after one level of `included` expansion, Lens resolves nested relationships recursively, detects cycles, and shows exactly which linkage targets are missing from the document.

Live site: **https://nayanbhut.github.io/jsonapi-lens/**

- Landing page: `/`
- Viewer: `/viewer/`
- Guides: `/docs/jsonapi-viewer/`, `/docs/jsonapi-validator/`, `/docs/jsonapi-relationships/`, `/docs/jsonapi-vs-json/`

Run it locally from any static server:

```sh
cd ~/jsonapi-inspector
python3 -m http.server 8765
# landing  http://127.0.0.1:8765/
# viewer   http://127.0.0.1:8765/viewer/
```

The site is plain static HTML/CSS/JS. There is no build step and no runtime dependency. `.nojekyll` tells GitHub Pages to serve the files as-is.

## Features

- **Recursive relationship tree** — follows `included` resources through any depth, with breadcrumbs and JSON pointers on every linkage.
- **Cycle detection** — stops expansion when a resource already appears on the current path and explains where the loop closes.
- **Sparse linkage handling** — unresolved targets stay visible as `missing` chips and expand into an explanation; unique unresolved resources are counted in the summary.
- **Included resource inspector** — browse all `included` resources grouped by type, including unlinked (full-linkage violation) badges.
- **Copy resolved JSON** — the `{}` button on any resource card (and **Copy JSON** in the graph inspector) projects the resource into plain JSON: attributes are flattened and relationships are replaced with the resolved resource data, recursively. This is not the JSON:API envelope.
  - Missing linkage becomes `{ "type": "...", "id": "...", "_missing": true }`.
  - Cycles become `{ "type": "...", "id": "...", "_cycle": true }`.
  - Relationship names that collide with an attribute are kept under `_relationships`.
- **Validation report** — structural JSON:API 1.1 checks (types, ids, reserved members, relationship shape, duplicates, full linkage, error documents) with spec pointers.
- **Relationship graph** — layered graph with pan/zoom, selection inspector, edge labels, and a toggle for unresolved targets.
- **Input options** — paste, upload, drag and drop, load a built-in example, or fetch a document from a URL.
- **Dark/light theme, responsive layout, keyboard-friendly controls.**

## Testing

Core parser and model tests:

```sh
node tests/core.test.js
# 26/26 tests passed
```

## Large documents

The parser and model builder are linear and handle very large documents; the
rendering layer is what needed limits. Measured in headless Chrome on a local
server:

| Resources | Size | Load | Notes |
| --- | --- | --- | --- |
| 10,000 | 2.4 MB | ~0.5 s | |
| 50,000 | 12.2 MB | ~1.7 s | 200 primary cards rendered |
| 100,000 | 24.4 MB | ~3.4 s | ~190 MB heap |
| 200,000 | 49.3 MB | ~13 s | ~340 MB heap, JSON tab shows raw text |
| 400,000 | 99 MB | — | refused before parsing |

Safeguards that keep the page from hanging:

- **50 MB hard input cap.** Larger documents are not parsed; the app shows a
  notice with the size and the limit instead of freezing or crashing the tab.
- **Primary cards render in pages of 200** with a **Show 200 more** button.
  Included resources are capped at 200 with a **Show all** button.
- **Validation issues render in pages of 200 per severity** with **Copy all
  issues** for the complete report.
- **JSON tab** switches to plain text above 1.2 MB, and skips pretty-printing
  above 8 MB (showing the original text) so it cannot spend tens of seconds
  re-serializing a huge document.
- **Attribute previews** are summarized above 200 KB, and values too deeply
  nested to serialize get a short placeholder instead of crashing the tree.
- **Copy resolved JSON** stops after 5,000 resources and marks the result with
  `_truncated: true`.
- **Graph** renders at most 400 nodes; extra edges are summarized in the toolbar.
- **localStorage** only persists input under 1.5 MB.

Practical guidance: up to ~10 MB feels instant, ~25 MB is comfortable, and
~50 MB is usable but slow. Filter or paginate the API response for anything
larger.

## Verified against a real response

Tested with:

```
https://api-legacy.sssports.com/v1/screens/1685?include=widgets.blocks.actions,widgets.blocks.customisations&filter[kind]=categories&filter[first]=1&filter[locale]=en_AE
```

Result:

- `200`, `application/vnd.api+json`, 28,788 bytes
- Valid JSON:API document, **0 spec violations**
- 1 primary `screens` resource, 39 included resources, 59 linkages, 4 types
- Deep chain resolves correctly:
  `screens #1685 → widgets #25676 → blocks #92683 → actions #93027`
- All 31 `actions` resolve under their blocks; all 4 `widgets` and 4 `blocks` are reachable
- 19 unique unresolved targets (`stores`, `screen-revisions`) are expected sparse linkage — they were not requested in `include`
- Every `customisations` relationship in this response is `null`, so the requested customisations path has no resources to expand
- No orphan included resources; no duplicate `type/id` pairs
- Graph: 40 resolved nodes / 39 edges, with 19 unresolved targets hidden by default (`unresolved` toggle shows them)

## Notes

- URL fetching is subject to the API's CORS policy. The SSSports endpoint allows the local origin; APIs without `Access-Control-Allow-Origin` will report a CORS error.
- The last document, theme, tab, and expansion depth are stored in `localStorage`. Documents over 1.5 MB are not persisted.
- Documents over 50 MB are rejected with a notice rather than parsed.

## Deployment

The site is hosted on GitHub Pages from the `main` branch root.

```sh
git push origin main
```

Pages rebuilds automatically. To re-enable Pages from scratch:

```sh
gh api --method POST repos/NayanBhut/jsonapi-lens/pages \
  --input - <<'JSON'
{"source":{"branch":"main","path":"/"}}
JSON
```

## Search and discovery

- `robots.txt` and `sitemap.xml` cover the landing page, viewer, and four guides.
- Every page has a unique title, meta description, canonical URL, Open Graph/Twitter image, and JSON-LD (`WebSite`, `SoftwareApplication`, `Article`, `FAQPage`, `BreadcrumbList`).
- `404.html` is served for unknown paths.
- IndexNow is enabled with a key file at the repository root; submit URLs with:

```sh
curl -s https://api.indexnow.org/indexnow \
  -H 'Content-Type: application/json' \
  -d '{"host":"nayanbhut.github.io","key":"<key>","keyLocation":"https://nayanbhut.github.io/jsonapi-lens/<key>.txt","urlList":["https://nayanbhut.github.io/jsonapi-lens/"]}'
```

If the site moves to a custom domain, update the canonical, Open Graph, JSON-LD, `robots.txt`, and `sitemap.xml` URLs.

