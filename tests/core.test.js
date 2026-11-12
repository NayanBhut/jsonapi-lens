"use strict";

var assert = require("node:assert");
var core = require("../core.js");

var results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name: name, ok: true });
  } catch (error) {
    results.push({ name: name, ok: false, error: error });
  }
}

function deepDoc() {
  return {
    jsonapi: { version: "1.1" },
    data: [
      {
        type: "articles",
        id: "1",
        attributes: { title: "Deep relations", wordCount: 2 },
        relationships: {
          author: { data: { type: "people", id: "9" } },
          comments: { data: [{ type: "comments", id: "5" }] },
          editor: { links: { related: "/articles/1/editor" } },
          cover: { data: null },
        },
      },
    ],
    included: [
      {
        type: "people",
        id: "9",
        attributes: { name: "Dan" },
        relationships: {
          employer: { data: { type: "companies", id: "1" } },
          articles: { data: [{ type: "articles", id: "1" }] },
        },
      },
      {
        type: "companies",
        id: "1",
        attributes: { name: "Example Org" },
        relationships: { owner: { data: { type: "people", id: "2" } } },
      },
      {
        type: "people",
        id: "2",
        attributes: { name: "Jane" },
        relationships: { employer: { data: { type: "companies", id: "1" } } },
      },
      {
        type: "comments",
        id: "5",
        attributes: { body: "First!" },
        relationships: { author: { data: { type: "people", id: "9" } } },
      },
    ],
  };
}

function errorsOf(doc) {
  return core.validate(doc).filter(function (issue) {
    return issue.severity === "error";
  });
}

test("a valid compound document has no errors", function () {
  assert.deepStrictEqual(errorsOf(deepDoc()), []);
});

test("buildModel resolves every relationship key", function () {
  var model = core.buildModel(deepDoc());
  assert.strictEqual(model.kind, "collection");
  assert.strictEqual(model.stats.primaryCount, 1);
  assert.strictEqual(model.stats.includedCount, 4);
  assert.strictEqual(model.stats.edgeCount, 7);
  assert.strictEqual(model.stats.missingCount, 0);
  assert.strictEqual(model.byKey.get("people:9").resource.attributes.name, "Dan");
  assert.strictEqual(model.byKey.get("companies:1").resource.attributes.name, "Example Org");
  assert.strictEqual(model.incoming.get("companies:1").length, 2);
});

test("deep chains can be followed with no depth limit", function () {
  var model = core.buildModel(deepDoc());
  var people = model.byKey.get("people:9");
  var company = model.byKey.get("companies:1");
  var owner = model.byKey.get("people:2");
  assert.ok(people && company && owner);
  assert.strictEqual(model.outgoing.get(people.key)[0].toEntry.key, company.key);
  assert.strictEqual(model.outgoing.get(company.key)[0].toEntry.key, owner.key);
  assert.strictEqual(model.outgoing.get(owner.key)[0].toEntry.key, company.key);
});

test("projects a resource into plain JSON with relationships inlined", function () {
  var model = core.buildModel(deepDoc());
  var plain = core.toPlainResource(model.primary[0], model);
  assert.strictEqual(plain.type, "articles");
  assert.strictEqual(plain.id, "1");
  assert.strictEqual(plain.title, "Deep relations");
  assert.strictEqual(plain.wordCount, 2);
  assert.strictEqual(plain.attributes, undefined);
  assert.strictEqual(plain.relationships, undefined);
  assert.strictEqual(plain.author.name, "Dan");
  assert.strictEqual(plain.author.employer.name, "Example Org");
  assert.strictEqual(plain.author.employer.owner.name, "Jane");
  assert.strictEqual(plain.comments[0].body, "First!");
  assert.strictEqual(plain.cover, null);
  assert.ok(!Object.prototype.hasOwnProperty.call(plain, "editor"), "linkage without data is omitted");
});

test("plain projection marks cycles instead of recursing forever", function () {
  var model = core.buildModel(deepDoc());
  var plain = core.toPlainResource(model.primary[0], model);
  assert.strictEqual(plain.author.articles[0]._cycle, true);
  assert.strictEqual(plain.author.articles[0].type, "articles");
  assert.strictEqual(plain.author.employer.owner.employer._cycle, true);
});

test("plain projection marks unresolved linkage", function () {
  var doc = deepDoc();
  doc.data[0].relationships.author.data = { type: "people", id: "404" };
  var model = core.buildModel(doc);
  var plain = core.toPlainResource(model.primary[0], model);
  assert.strictEqual(plain.author._missing, true);
  assert.strictEqual(plain.author.type, "people");
  assert.strictEqual(plain.author.id, "404");
});

test("plain projection stops at its node budget", function () {
  var model = core.buildModel(deepDoc());
  var plain = core.toPlainResource(model.primary[0], model, { budget: 2 });
  assert.strictEqual(plain._truncated, true);
  assert.strictEqual(plain.type, "articles");
  assert.ok(plain.author);
});

test("plain projection keeps a colliding relationship out of attributes", function () {
  var doc = {
    data: {
      type: "articles",
      id: "1",
      attributes: { author: "attribute value" },
      relationships: { author: { data: { type: "people", id: "9" } } },
    },
    included: [{ type: "people", id: "9", attributes: { name: "Dan" } }],
  };
  var model = core.buildModel(doc);
  var plain = core.toPlainResource(model.primary[0], model);
  assert.strictEqual(plain.author, "attribute value");
  assert.strictEqual(plain._relationships.author.name, "Dan");
});

test("detects an included resource that is not linked", function () {
  var doc = deepDoc();
  doc.included.push({ type: "tags", id: "orphan", attributes: { name: "nope" } });
  var issues = core.validate(doc);
  var linkage = issues.filter(function (issue) {
    return issue.code === "FULL_LINKAGE";
  });
  assert.strictEqual(linkage.length, 1);
  var model = core.buildModel(doc);
  assert.strictEqual(model.orphanIncluded.size, 1);
  assert.strictEqual(model.missing.size, 0);
});

test("detects a dangling relationship without flagging included", function () {
  var doc = deepDoc();
  doc.data[0].relationships.author.data = { type: "people", id: "404" };
  var model = core.buildModel(doc);
  assert.strictEqual(model.missing.size, 1);
  assert.ok(model.missing.get("people:404"));
  var issues = errorsOf(doc);
  assert.strictEqual(issues.length, 0, "linkage to a missing resource is not a structural error");
});

test("detects duplicate included resources", function () {
  var doc = deepDoc();
  doc.included.push({ type: "people", id: "9", attributes: { name: "Duplicate" } });
  var codes = core.validate(doc).map(function (issue) {
    return issue.code;
  });
  assert.ok(codes.includes("DUPLICATE_INCLUDED"));
  var model = core.buildModel(doc);
  assert.strictEqual(model.duplicateIncluded.size, 1);
});

test("detects included without data", function () {
  var doc = { errors: [], included: [{ type: "people", id: "1" }] };
  var codes = core.validate(doc).map(function (issue) {
    return issue.code;
  });
  assert.ok(codes.includes("INCLUDED_WITHOUT_DATA"));
  assert.deepStrictEqual(core.validate({ included: [{ type: "people", id: "1" }] }), [], "included-only documents are plain JSON");
});

test("detects numeric ids", function () {
  var doc = { data: { type: "articles", id: 12 } };
  var issues = errorsOf(doc);
  assert.strictEqual(issues[0].code, "RESOURCE_ID_TYPE");
  assert.strictEqual(issues[0].pointer, "/data/id");
});

test("detects reserved attribute and relationship names", function () {
  var doc = {
    data: {
      type: "articles",
      id: "1",
      attributes: { id: "oops", title: "ok" },
      relationships: { type: { data: null } },
    },
  };
  var codes = core.validate(doc).map(function (issue) {
    return issue.code;
  });
  assert.ok(codes.includes("RESERVED_FIELD_NAME"));
  assert.strictEqual(codes.filter(function (code) { return code === "RESERVED_FIELD_NAME"; }).length, 2);
});

test("detects attribute/relationship name collisions", function () {
  var doc = {
    data: {
      type: "articles",
      id: "1",
      attributes: { author: "field" },
      relationships: { author: { data: null } },
    },
  };
  var codes = core.validate(doc).map(function (issue) {
    return issue.code;
  });
  assert.ok(codes.includes("FIELD_COLLISION"));
});

test("detects id + lid together", function () {
  var doc = { data: { type: "articles", id: "1", lid: "local" } };
  var codes = core.validate(doc).map(function (issue) {
    return issue.code;
  });
  assert.ok(codes.includes("RESOURCE_ID_AND_LID"));
});

test("supports lid-only identifiers", function () {
  var doc = {
    data: { type: "articles", lid: "a1", attributes: { title: "Local" } },
    included: [
      { type: "people", lid: "p1", attributes: { name: "Local person" } },
    ],
  };
  doc.data.relationships = { author: { data: { type: "people", lid: "p1" } } };
  var model = core.buildModel(doc);
  assert.ok(model.byKey.get("people:lid:p1"));
  assert.strictEqual(model.primary[0].key, "articles:lid:a1");
  assert.strictEqual(model.edges[0].toEntry.key, "people:lid:p1");
  assert.deepStrictEqual(errorsOf(doc), []);
});

test("flags relationships with no data, links or meta", function () {
  var doc = { data: { type: "articles", id: "1", relationships: { author: {} } } };
  var codes = core.validate(doc).map(function (issue) {
    return issue.code;
  });
  assert.ok(codes.includes("RELATIONSHIP_EMPTY"));
});

test("validates error documents", function () {
  var doc = {
    errors: [
      { status: "422", code: "invalid", title: "Invalid", detail: "Bad email", source: { pointer: "/data/attributes/email" } },
      {},
    ],
  };
  var codes = core.validate(doc).map(function (issue) {
    return issue.code;
  });
  assert.ok(codes.includes("ERROR_OBJECT_EMPTY"));
  assert.ok(!codes.includes("DATA_AND_ERRORS"));
});

test("rejects a document containing both data and errors", function () {
  var doc = { data: null, errors: [{ title: "Nope" }] };
  var codes = core.validate(doc).map(function (issue) {
    return issue.code;
  });
  assert.ok(codes.includes("DATA_AND_ERRORS"));
});

test("reports JSON parse position", function () {
  var result = core.parseJson('{\n  "data": ,\n}');
  assert.strictEqual(result.ok, false);
  assert.ok(result.error.message.length > 0);
  assert.strictEqual(result.error.line, 2);
  assert.strictEqual(typeof result.error.column, "number");
});

test("parses empty input without throwing", function () {
  var result = core.parseJson("   ");
  assert.strictEqual(result.ok, false);
  assert.ok(result.error.message.includes("Nothing to parse"));
});

test("handles null primary data", function () {
  var doc = { data: null, meta: { total: 0 } };
  var model = core.buildModel(doc);
  assert.strictEqual(model.kind, "null");
  assert.strictEqual(model.primary.length, 0);
  assert.deepStrictEqual(errorsOf(doc), []);
});

test("handles meta-only documents", function () {
  var doc = { meta: { total: 12 } };
  var model = core.buildModel(doc);
  assert.strictEqual(model.kind, "meta");
  assert.deepStrictEqual(errorsOf(doc), []);
});

test("resource labels prefer human-friendly attributes", function () {
  assert.strictEqual(core.resourceLabel({ type: "people", attributes: { name: "Dan" } }), "Dan");
  assert.strictEqual(core.resourceLabel({ type: "people", attributes: { title: "Engineer", name: "Dan" } }), "Dan");
  assert.strictEqual(core.resourceLabel({ type: "people", attributes: { email: "a@b.c" } }), "a@b.c");
});

test("handles malformed structures without throwing", function () {
  var weird = [
    null,
    [],
    "string",
    { data: 12 },
    { data: [] },
    { data: {}, included: "no" },
    { data: [{ type: null }] },
    { data: { type: "x", relationships: [] } },
    { data: { type: "x", attributes: 3 } },
    { errors: "no" },
    { included: [null] },
  ];
  weird.forEach(function (doc) {
    assert.doesNotThrow(function () {
      core.validate(doc);
      core.buildModel(doc);
    });
  });
});

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

var failed = results.filter(function (result) {
  return !result.ok;
});

results.forEach(function (result) {
  console.log((result.ok ? "PASS" : "FAIL") + "  " + result.name);
  if (!result.ok) console.log(result.error && result.error.stack);
});

console.log("\n" + (results.length - failed.length) + "/" + results.length + " tests passed");
if (failed.length) process.exitCode = 1;
