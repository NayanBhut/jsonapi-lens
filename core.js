/*
 * JSON:API Lens — document model + validator
 *
 * Framework-free, dependency-free helpers shared by the browser app and the
 * Node test suite. Implements the structural rules from the JSON:API 1.1
 * specification (https://jsonapi.org/format/1.1/).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.JsonApiCore = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var SPEC_URL = "https://jsonapi.org/format/1.1/";

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------

  function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function isNonEmptyString(value) {
    return typeof value === "string" && value.length > 0;
  }

  function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
  }

  // A document is JSON:API when it declares one of the three primary members.
  // Everything else is ordinary JSON and is rendered, not validated.
  function isJsonApiDocument(doc) {
    return isObject(doc) && (hasOwn(doc, "data") || hasOwn(doc, "errors") || hasOwn(doc, "meta"));
  }

  /**
   * Stable identity for a resource or resource identifier.
   * Supports both `id` (persisted) and `lid` (local id, JSON:API 1.1).
   */
  function identityKey(identifier) {
    if (!isObject(identifier) || typeof identifier.type !== "string") return null;
    if (identifier.id !== undefined && identifier.id !== null) {
      return identifier.type + ":" + String(identifier.id);
    }
    if (identifier.lid !== undefined && identifier.lid !== null) {
      return identifier.type + ":lid:" + String(identifier.lid);
    }
    return null;
  }

  function displayType(resource) {
    return resource && typeof resource.type === "string" ? resource.type : "unknown";
  }

  /** A readable, short label for a resource based on common attribute names. */
  function resourceLabel(resource) {
    if (!isObject(resource)) return "";
    var attrs = isObject(resource.attributes) ? resource.attributes : {};
    var candidates = ["name", "title", "subject", "label", "slug", "email", "firstname", "firstName"];
    for (var i = 0; i < candidates.length; i++) {
      var value = attrs[candidates[i]];
      if (typeof value === "string" && value.trim()) return value.trim();
      if (typeof value === "number") return String(value);
    }
    return "";
  }

  function truncate(value, max) {
    var text = String(value);
    return text.length > max ? text.slice(0, max - 1) + "…" : text;
  }

  function escapePointerToken(token) {
    return String(token).replace(/~/g, "~0").replace(/\//g, "~1");
  }

  function pointerJoin(base, token) {
    return base + "/" + escapePointerToken(token);
  }

  function lineColumnFromOffset(text, offset) {
    var before = text.slice(0, Math.max(0, offset));
    var lines = before.split("\n");
    return {
      line: lines.length,
      column: lines[lines.length - 1].length + 1,
      offset: offset,
    };
  }

  /**
   * Locate the first syntax problem in a JSON string. V8 does not always
   * report an offset, so we run a tiny structural scanner to find one.
   * Returns null when the text appears to be valid JSON.
   */
  function locateSyntaxError(text) {
    var i = 0;
    var length = text.length;

    function fail(message) {
      throw { pos: i, message: message };
    }
    function whitespace() {
      while (i < length) {
        var c = text.charCodeAt(i);
        if (c === 32 || c === 9 || c === 10 || c === 13) i += 1;
        else return;
      }
    }
    function string() {
      i += 1; // opening quote
      while (i < length) {
        var c = text[i];
        if (c === '"') {
          i += 1;
          return;
        }
        if (c === "\\") {
          i += 1;
          if (i >= length) fail("Unterminated escape sequence");
          var esc = text[i];
          if (esc === "u") {
            for (var n = 1; n <= 4; n += 1) {
              if (!/^[0-9a-fA-F]$/.test(text[i + n] || "")) fail("Invalid unicode escape");
            }
            i += 5;
          } else if ('"\\/bfnrt'.indexOf(esc) !== -1) {
            i += 1;
          } else {
            fail("Invalid escape sequence");
          }
        } else if (c.charCodeAt(0) < 0x20) {
          fail("Unescaped control character in string");
        } else {
          i += 1;
        }
      }
      fail("Unterminated string");
    }
    function number() {
      var match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(i));
      if (!match || !match[0]) fail("Invalid number");
      i += match[0].length;
    }
    function literal(word) {
      if (text.slice(i, i + word.length) !== word) fail("Unexpected token");
      i += word.length;
    }
    function value(depth) {
      if (depth > 512) fail("Maximum nesting depth exceeded");
      whitespace();
      if (i >= length) fail("Unexpected end of input");
      var c = text[i];
      if (c === "{") return object(depth + 1);
      if (c === "[") return array(depth + 1);
      if (c === '"') return string();
      if (c === "-" || (c >= "0" && c <= "9")) return number();
      if (c === "t") return literal("true");
      if (c === "f") return literal("false");
      if (c === "n") return literal("null");
      fail("Unexpected token");
    }
    function object(depth) {
      i += 1;
      whitespace();
      if (text[i] === "}") {
        i += 1;
        return;
      }
      for (;;) {
        whitespace();
        if (text[i] !== '"') fail("Expected a string key");
        string();
        whitespace();
        if (text[i] !== ":") fail("Expected ':'");
        i += 1;
        value(depth);
        whitespace();
        if (text[i] === ",") {
          i += 1;
          continue;
        }
        if (text[i] === "}") {
          i += 1;
          return;
        }
        fail("Expected ',' or '}'");
      }
    }
    function array(depth) {
      i += 1;
      whitespace();
      if (text[i] === "]") {
        i += 1;
        return;
      }
      for (;;) {
        value(depth);
        whitespace();
        if (text[i] === ",") {
          i += 1;
          continue;
        }
        if (text[i] === "]") {
          i += 1;
          return;
        }
        fail("Expected ',' or ']'");
      }
    }

    try {
      value(0);
      whitespace();
      if (i < length) fail("Unexpected trailing characters");
      return null;
    } catch (scanError) {
      if (scanError && typeof scanError.pos === "number") {
        return { offset: scanError.pos, message: scanError.message };
      }
      return null;
    }
  }

  /**
   * Parse JSON and, when it fails, surface a useful line/column.
   * Handles the different error shapes emitted by V8, JavaScriptCore and
   * SpiderMonkey, then falls back to our own scanner for an offset.
   */
  function parseJson(text) {
    if (typeof text !== "string") {
      return { ok: false, error: { message: "Input must be a string.", line: null, column: null, offset: null } };
    }
    if (!text.trim()) {
      return { ok: false, error: { message: "Nothing to parse yet — paste a JSON:API document.", line: null, column: null, offset: null } };
    }
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch (error) {
      var message = error && error.message ? error.message : String(error);
      var line = null;
      var column = null;
      var offset = null;

      var lc = /line\s+(\d+)\s+column\s+(\d+)/i.exec(message);
      if (lc) {
        line = Number(lc[1]);
        column = Number(lc[2]);
      }
      var pos = /position\s+(\d+)/i.exec(message);
      if (pos) {
        offset = Number(pos[1]);
        if (line === null) {
          var computed = lineColumnFromOffset(text, offset);
          line = computed.line;
          column = computed.column;
        }
      }
      if (line === null) {
        var scanned = locateSyntaxError(text);
        if (scanned) {
          offset = scanned.offset;
          var atComputed = lineColumnFromOffset(text, offset);
          line = atComputed.line;
          column = atComputed.column;
        }
      }
      return {
        ok: false,
        error: { message: message, line: line, column: column, offset: offset },
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------

  function makeIssue(severity, code, title, message, pointer) {
    return {
      severity: severity,
      code: code,
      title: title,
      message: message,
      pointer: pointer || "",
      spec: SPEC_URL,
    };
  }

  var RESOURCE_MEMBERS = ["type", "id", "lid", "attributes", "relationships", "links", "meta"];
  var RELATIONSHIP_MEMBERS = ["data", "links", "meta"];
  var IDENTIFIER_MEMBERS = ["type", "id", "lid", "meta"];
  var TOP_LEVEL_MEMBERS = ["data", "errors", "meta", "jsonapi", "links", "included"];

  function validate(doc) {
    var issues = [];
    function add(severity, code, title, message, pointer) {
      issues.push(makeIssue(severity, code, title, message, pointer));
    }

    if (!isJsonApiDocument(doc)) {
      return issues;
    }

    var hasData = hasOwn(doc, "data");
    var hasErrors = hasOwn(doc, "errors");
    var hasMeta = hasOwn(doc, "meta");

    // Top-level member rules -------------------------------------------------
    Object.keys(doc).forEach(function (member) {
      if (TOP_LEVEL_MEMBERS.indexOf(member) === -1) {
        add(
          "warning",
          "UNKNOWN_TOP_LEVEL_MEMBER",
          "Unknown top-level member",
          'The member "' + member + '" is not defined by JSON:API and may be ignored by consumers.',
          pointerJoin("", member)
        );
      }
    });

    // Note: the EMPTY_DOCUMENT rule (a document with none of data, errors or
    // meta) is intentionally not implemented here — such documents are
    // classified as plain JSON by isJsonApiDocument above and never validated.

    if (hasData && hasErrors) {
      add(
        "error",
        "DATA_AND_ERRORS",
        "data and errors cannot coexist",
        "A document MUST NOT contain both a data member and an errors member at the same level.",
        ""
      );
    }

    if (hasOwn(doc, "included") && !hasData) {
      add(
        "error",
        "INCLUDED_WITHOUT_DATA",
        "included requires data",
        "The included member MUST NOT be present when the document has no top-level data member.",
        "/included"
      );
    }

    // jsonapi ----------------------------------------------------------------
    if (hasOwn(doc, "jsonapi")) {
      if (!isObject(doc.jsonapi)) {
        add("error", "JSONAPI_OBJECT", "jsonapi must be an object", "The jsonapi member is a JSON object.", "/jsonapi");
      } else {
        var version = doc.jsonapi.version;
        if (version !== undefined) {
          if (typeof version !== "string") {
            add("error", "JSONAPI_VERSION_TYPE", "jsonapi.version must be a string", "The version member MUST be a string.", "/jsonapi/version");
          } else if (!/^1\.\d+$/.test(version)) {
            add(
              "warning",
              "JSONAPI_VERSION",
              "Unexpected JSON:API version",
              'Found "' + version + '". This viewer implements JSON:API 1.x.',
              "/jsonapi/version"
            );
          } else if (version !== "1.0" && version !== "1.1") {
            add(
              "info",
              "JSONAPI_VERSION_MINOR",
              "Unknown minor version",
              'Found "' + version + '". The validation rules here target 1.0 and 1.1.',
              "/jsonapi/version"
            );
          }
        }
        if (doc.jsonapi.ext !== undefined && !Array.isArray(doc.jsonapi.ext)) {
          add("error", "JSONAPI_EXT", "jsonapi.ext must be an array", "Extension identifiers are listed in an array.", "/jsonapi/ext");
        }
        if (doc.jsonapi.profile !== undefined && !Array.isArray(doc.jsonapi.profile)) {
          add("error", "JSONAPI_PROFILE", "jsonapi.profile must be an array", "Profile identifiers are listed in an array.", "/jsonapi/profile");
        }
      }
    }

    if (hasMeta && !isObject(doc.meta)) {
      add("error", "META_TYPE", "meta must be an object", "The meta member is a JSON object.", "/meta");
    }

    validateLinks(doc.links, "/links", add);

    // Primary data -----------------------------------------------------------
    if (hasData) {
      if (doc.data === null) {
        // null is a valid primary data value.
      } else if (Array.isArray(doc.data)) {
        var seenPrimary = Object.create(null);
        doc.data.forEach(function (resource, index) {
          if (!isObject(resource)) {
            add(
              "error",
              "PRIMARY_RESOURCE_TYPE",
              "Primary resource must be an object",
              "Each element of a resource collection must be a resource object (or null primary data).",
              "/data/" + index
            );
            return;
          }
          var idKey = identityKey(resource);
          if (idKey) {
            if (seenPrimary[idKey]) {
              add(
                "error",
                "DUPLICATE_PRIMARY",
                "Duplicate primary resource",
                'Resource "' + idKey + '" appears more than once in primary data.',
                "/data/" + index
              );
            }
            seenPrimary[idKey] = true;
          }
          validateResource(resource, "/data/" + index, add, "primary");
        });
      } else if (isObject(doc.data)) {
        validateResource(doc.data, "/data", add, "primary");
      } else {
        add(
          "error",
          "DATA_TYPE",
          "Invalid primary data",
          "data must be a resource object, an array of resource objects, or null.",
          "/data"
        );
      }
    }

    // Included ---------------------------------------------------------------
    var included = [];
    if (hasOwn(doc, "included")) {
      if (!Array.isArray(doc.included)) {
        add("error", "INCLUDED_TYPE", "included must be an array", "The included member is an array of resource objects.", "/included");
      } else {
        included = doc.included;
        var seenIncluded = Object.create(null);
        included.forEach(function (resource, index) {
          if (!isObject(resource)) {
            add(
              "error",
              "INCLUDED_RESOURCE_TYPE",
              "Included resource must be an object",
              "Every element of included must be a resource object.",
              "/included/" + index
            );
            return;
          }
          var key = identityKey(resource);
          if (key) {
            if (seenIncluded[key]) {
              add(
                "error",
                "DUPLICATE_INCLUDED",
                "Duplicate included resource",
                'Resource "' + key + '" appears more than once in included. Type/id pairs must be unique across the document.',
                "/included/" + index
              );
            }
            seenIncluded[key] = true;
          }
          validateResource(resource, "/included/" + index, add, "included");
        });

        // Fresh linkage check across primary + included ----------------------
        checkFullLinkage(doc, included, add);
      }
    }

    if (hasErrors) {
      if (!Array.isArray(doc.errors)) {
        add("error", "ERRORS_TYPE", "errors must be an array", "The errors member is an array of error objects.", "/errors");
      } else {
        doc.errors.forEach(function (errorObject, index) {
          validateErrorObject(errorObject, "/errors/" + index, add);
        });
      }
    }

    return issues;
  }

  function validateResource(resource, pointer, add, origin) {
    if (!isObject(resource)) {
      add("error", "RESOURCE_TYPE", "Resource must be an object", "Expected a resource object.", pointer);
      return;
    }

    if (!isNonEmptyString(resource.type)) {
      add(
        "error",
        "RESOURCE_TYPE_MEMBER",
        "Resource is missing type",
        "Every resource object MUST contain a type member, and it must be a non-empty string.",
        pointerJoin(pointer, "type")
      );
    }

    if (resource.id !== undefined) {
      if (typeof resource.id !== "string") {
        add(
          "error",
          "RESOURCE_ID_TYPE",
          "id must be a string",
          "JSON:API requires resource ids to be strings. Number ids are a common source of interoperability bugs.",
          pointerJoin(pointer, "id")
        );
      }
    }

    if (resource.lid !== undefined) {
      if (typeof resource.lid !== "string") {
        add("error", "RESOURCE_LID_TYPE", "lid must be a string", "Local ids must be strings.", pointerJoin(pointer, "lid"));
      }
      if (resource.id !== undefined) {
        add(
          "error",
          "RESOURCE_ID_AND_LID",
          "Resource has both id and lid",
          "A resource object MUST NOT contain both an id and a lid member.",
          pointer
        );
      }
    }

    Object.keys(resource).forEach(function (member) {
      if (RESOURCE_MEMBERS.indexOf(member) === -1) {
        add(
          "warning",
          "UNKNOWN_RESOURCE_MEMBER",
          "Unknown resource member",
          'The member "' + member + '" is not defined on resource objects and will be ignored by JSON:API consumers.',
          pointerJoin(pointer, member)
        );
      }
    });

    var attributeNames = Object.create(null);
    if (resource.attributes !== undefined) {
      if (!isObject(resource.attributes)) {
        add("error", "ATTRIBUTES_TYPE", "attributes must be an object", "The attributes member is a JSON object.", pointerJoin(pointer, "attributes"));
      } else {
        Object.keys(resource.attributes).forEach(function (name) {
          attributeNames[name] = true;
          if (name === "type" || name === "id" || name === "lid") {
            add(
              "error",
              "RESERVED_FIELD_NAME",
              "Reserved attribute name",
              'Attributes cannot be named "' + name + '"; fields share a namespace with type, id and lid.',
              pointerJoin(pointerJoin(pointer, "attributes"), name)
            );
          }
        });
      }
    }

    if (resource.relationships !== undefined) {
      if (!isObject(resource.relationships)) {
        add(
          "error",
          "RELATIONSHIPS_TYPE",
          "relationships must be an object",
          "The relationships member is a JSON object keyed by relationship name.",
          pointerJoin(pointer, "relationships")
        );
      } else {
        Object.keys(resource.relationships).forEach(function (name) {
          var relPointer = pointerJoin(pointerJoin(pointer, "relationships"), name);
          if (name === "type" || name === "id" || name === "lid") {
            add(
              "error",
              "RESERVED_FIELD_NAME",
              "Reserved relationship name",
              'Relationships cannot be named "' + name + '"; fields share a namespace with type, id and lid.',
              relPointer
            );
          }
          if (attributeNames[name]) {
            add(
              "error",
              "FIELD_COLLISION",
              "Attribute and relationship share a name",
              'The field "' + name + '" is declared both as an attribute and a relationship.',
              relPointer
            );
          }
          validateRelationship(resource.relationships[name], relPointer, add);
        });
      }
    }

    validateLinks(resource.links, pointerJoin(pointer, "links"), add);

    if (resource.meta !== undefined && !isObject(resource.meta)) {
      add("error", "RESOURCE_META_TYPE", "meta must be an object", "The meta member is a JSON object.", pointerJoin(pointer, "meta"));
    }
  }

  function validateRelationship(rel, pointer, add) {
    if (!isObject(rel)) {
      add("error", "RELATIONSHIP_TYPE", "Relationship must be an object", "A relationship must be a JSON object.", pointer);
      return;
    }

    var hasMember = RELATIONSHIP_MEMBERS.some(function (member) {
      return hasOwn(rel, member);
    });
    if (!hasMember) {
      add(
        "error",
        "RELATIONSHIP_EMPTY",
        "Relationship has no data, links or meta",
        "A relationship object MUST contain at least one of data, links or meta.",
        pointer
      );
    }

    Object.keys(rel).forEach(function (member) {
      if (RELATIONSHIP_MEMBERS.indexOf(member) === -1) {
        add(
          "warning",
          "UNKNOWN_RELATIONSHIP_MEMBER",
          "Unknown relationship member",
          'The member "' + member + '" is not defined on relationship objects.',
          pointerJoin(pointer, member)
        );
      }
    });

    if (hasOwn(rel, "data")) {
      if (rel.data === null) {
        // Valid: empty to-one relationship.
      } else if (Array.isArray(rel.data)) {
        rel.data.forEach(function (identifier, index) {
          validateIdentifier(identifier, pointer + "/data/" + index, add);
        });
      } else if (isObject(rel.data)) {
        validateIdentifier(rel.data, pointer + "/data", add);
      } else {
        add(
          "error",
          "RELATIONSHIP_DATA_TYPE",
          "Invalid relationship linkage",
          "Relationship data must be null, a resource identifier object, or an array of resource identifiers.",
          pointerJoin(pointer, "data")
        );
      }
    }

    validateLinks(rel.links, pointerJoin(pointer, "links"), add);
    if (rel.meta !== undefined && !isObject(rel.meta)) {
      add("warning", "RELATIONSHIP_META_TYPE", "meta must be an object", "The meta member is a JSON object.", pointerJoin(pointer, "meta"));
    }
  }

  function validateIdentifier(identifier, pointer, add) {
    if (!isObject(identifier)) {
      add(
        "error",
        "IDENTIFIER_TYPE",
        "Resource identifier must be an object",
        "Relationship linkage items are resource identifier objects.",
        pointer
      );
      return;
    }

    Object.keys(identifier).forEach(function (member) {
      if (IDENTIFIER_MEMBERS.indexOf(member) === -1) {
        add(
          "warning",
          "UNKNOWN_IDENTIFIER_MEMBER",
          "Unknown resource identifier member",
          'The member "' + member + '" is not defined on resource identifier objects.',
          pointerJoin(pointer, member)
        );
      }
    });

    if (!isNonEmptyString(identifier.type)) {
      add(
        "error",
        "IDENTIFIER_TYPE_MEMBER",
        "Resource identifier is missing type",
        "Every resource identifier MUST contain a type.",
        pointerJoin(pointer, "type")
      );
    }

    if (identifier.id !== undefined && typeof identifier.id !== "string") {
      add("error", "IDENTIFIER_ID_TYPE", "Resource identifier id must be a string", "JSON:API ids are strings.", pointerJoin(pointer, "id"));
    }
    if (identifier.lid !== undefined && typeof identifier.lid !== "string") {
      add("warning", "IDENTIFIER_LID_TYPE", "Resource identifier lid must be a string", "Local ids are strings.", pointerJoin(pointer, "lid"));
    }
    if (identifier.id === undefined && identifier.lid === undefined) {
      add(
        "error",
        "IDENTIFIER_NO_ID",
        "Resource identifier has no id or lid",
        "A resource identifier must identify a resource by id (or by lid when using local ids).",
        pointer
      );
    }
    if (identifier.id !== undefined && identifier.lid !== undefined) {
      add("error", "IDENTIFIER_ID_AND_LID", "Resource identifier has both id and lid", "A resource identifier cannot contain both.", pointer);
    }
    if (identifier.meta !== undefined && !isObject(identifier.meta)) {
      add("warning", "IDENTIFIER_META_TYPE", "meta must be an object", "The meta member is a JSON object.", pointerJoin(pointer, "meta"));
    }
  }

  function validateLinks(links, pointer, add) {
    if (links === undefined) return;
    if (!isObject(links)) {
      add("error", "LINKS_TYPE", "links must be an object", "The links member is a JSON object.", pointer);
      return;
    }
    Object.keys(links).forEach(function (name) {
      var value = links[name];
      var linkPointer = pointerJoin(pointer, name);
      if (typeof value === "string") return;
      if (isObject(value)) {
        if (!isNonEmptyString(value.href)) {
          add(
            "error",
            "LINK_HREF",
            "Link object is missing href",
            'The link "' + name + '" must contain a string href member (or be provided as a plain string URL).',
            linkPointer
          );
        }
        if (value.meta !== undefined && !isObject(value.meta)) {
          add("warning", "LINK_META_TYPE", "Link meta must be an object", "A link object's meta member is a JSON object.", pointerJoin(linkPointer, "meta"));
        }
        return;
      }
      add(
        "error",
        "LINK_TYPE",
        "Invalid link value",
        'The link "' + name + '" must be a string URL or a link object with an href.',
        linkPointer
      );
    });
  }

  function validateErrorObject(errorObject, pointer, add) {
    if (!isObject(errorObject)) {
      add("error", "ERROR_OBJECT_TYPE", "Error must be an object", "Each element of errors must be an error object.", pointer);
      return;
    }
    var meaningful = ["id", "links", "status", "code", "title", "detail", "source", "meta"];
    var hasContent = meaningful.some(function (member) {
      return hasOwn(errorObject, member);
    });
    if (!hasContent) {
      add(
        "error",
        "ERROR_OBJECT_EMPTY",
        "Error object has no content",
        "An error object MUST contain at least one of id, links, status, code, title, detail, source or meta.",
        pointer
      );
    }
    if (errorObject.id !== undefined && typeof errorObject.id !== "string") {
      add("warning", "ERROR_ID_TYPE", "Error id should be a string", "Error ids are strings.", pointerJoin(pointer, "id"));
    }
    if (errorObject.status !== undefined && typeof errorObject.status !== "string") {
      add("error", "ERROR_STATUS_TYPE", "Error status must be a string", "HTTP status codes in error objects are strings.", pointerJoin(pointer, "status"));
    }
    if (errorObject.title !== undefined && typeof errorObject.title !== "string") {
      add("warning", "ERROR_TITLE_TYPE", "Error title should be a string", "", pointerJoin(pointer, "title"));
    }
    if (errorObject.detail !== undefined && typeof errorObject.detail !== "string") {
      add("warning", "ERROR_DETAIL_TYPE", "Error detail should be a string", "", pointerJoin(pointer, "detail"));
    }
    if (errorObject.code !== undefined && typeof errorObject.code !== "string") {
      add("warning", "ERROR_CODE_TYPE", "Error code should be a string", "", pointerJoin(pointer, "code"));
    }
    if (errorObject.source !== undefined) {
      if (!isObject(errorObject.source)) {
        add("error", "ERROR_SOURCE_TYPE", "Error source must be an object", "", pointerJoin(pointer, "source"));
      } else {
        if (errorObject.source.pointer !== undefined && typeof errorObject.source.pointer !== "string") {
          add("warning", "ERROR_SOURCE_POINTER", "Error source.pointer should be a string", "", pointerJoin(pointerJoin(pointer, "source"), "pointer"));
        }
      }
    }
    validateLinks(errorObject.links, pointerJoin(pointer, "links"), add);
    if (errorObject.meta !== undefined && !isObject(errorObject.meta)) {
      add("warning", "ERROR_META_TYPE", "Error meta must be an object", "", pointerJoin(pointer, "meta"));
    }
  }

  /**
   * Full linkage: every included resource must be reachable from primary data
   * (or from another reachable included resource) through relationship linkage.
   */
  function checkFullLinkage(doc, included, add) {
    if (!isObject(doc) || !Array.isArray(included) || included.length === 0) return;

    var includedByKey = Object.create(null);
    included.forEach(function (resource, index) {
      var key = identityKey(resource);
      if (key && !includedByKey[key]) {
        includedByKey[key] = { resource: resource, index: index };
      }
    });

    var primary = [];
    if (Array.isArray(doc.data)) {
      primary = doc.data.filter(isObject);
    } else if (isObject(doc.data)) {
      primary = [doc.data];
    }

    var reachable = Object.create(null);
    var queue = primary.slice();
    var seenQueue = Object.create(null);
    primary.forEach(function (resource) {
      var key = identityKey(resource);
      if (key) seenQueue[key] = true;
    });

    while (queue.length) {
      var resource = queue.shift();
      if (!isObject(resource) || !isObject(resource.relationships)) continue;
      Object.keys(resource.relationships).forEach(function (name) {
        var rel = resource.relationships[name];
        if (!isObject(rel) || !hasOwn(rel, "data") || rel.data === null) return;
        var identifiers = Array.isArray(rel.data) ? rel.data : [rel.data];
        identifiers.forEach(function (identifier) {
          var key = identityKey(identifier);
          if (!key) return;
          if (includedByKey[key] && !reachable[key]) {
            reachable[key] = true;
            var target = includedByKey[key].resource;
            if (!seenQueue[key]) {
              seenQueue[key] = true;
              queue.push(target);
            }
          }
        });
      });
    }

    included.forEach(function (resource, index) {
      var key = identityKey(resource);
      if (!key) return;
      if (!reachable[key]) {
        add(
          "error",
          "FULL_LINKAGE",
          "Included resource is not linked",
          'Included resource "' + key + '" is not reachable through any relationship from primary data. Every included resource must be identified by at least one resource identifier in the primary data or in another included resource.',
          "/included/" + index
        );
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Model used by the viewer (resolves all relationships in both directions)
  // ---------------------------------------------------------------------------

  function buildModel(doc) {
    var model = {
      doc: doc,
      kind: "invalid",
      primary: [],
      included: [],
      entries: [],
      byKey: new Map(),
      edges: [],
      outgoing: new Map(),
      incoming: new Map(),
      missing: new Map(),
      orphanIncluded: new Set(),
      duplicateIncluded: new Set(),
      stats: {
        primaryCount: 0,
        includedCount: 0,
        typeCount: 0,
        attributeCount: 0,
        relationshipCount: 0,
        edgeCount: 0,
        missingCount: 0,
        nullLinkageCount: 0,
      },
      types: [],
    };

    if (!isJsonApiDocument(doc)) {
      model.kind = "plain";
      return model;
    }

    // Determine document shape ------------------------------------------------
    if (hasOwn(doc, "data")) {
      if (doc.data === null) model.kind = "null";
      else if (Array.isArray(doc.data)) model.kind = "collection";
      else if (isObject(doc.data)) model.kind = "resource";
      else model.kind = "invalid";
    } else if (Array.isArray(doc.errors)) {
      model.kind = "errors";
    } else if (isObject(doc.meta)) {
      model.kind = "meta";
    } else {
      // `errors` or `meta` declared with the wrong type: still JSON:API, but
      // structurally invalid. `plain` must never be reachable from here.
      model.kind = "invalid";
    }

    var entriesByKey = model.byKey;
    var primaryKeys = new Set();

    function register(entry) {
      if (!entry.key) return;
      if (!entriesByKey.has(entry.key)) {
        entriesByKey.set(entry.key, entry);
      }
    }

    // Primary resources -------------------------------------------------------
    if (isObject(doc.data)) {
      model.primary.push(makeEntry(doc.data, "primary", 0, "/data"));
    } else if (Array.isArray(doc.data)) {
      doc.data.forEach(function (resource, index) {
        if (isObject(resource)) {
          model.primary.push(makeEntry(resource, "primary", index, "/data/" + index));
        }
      });
    }
    model.primary.forEach(function (entry) {
      if (entry.key) {
        if (primaryKeys.has(entry.key)) entry.duplicate = true;
        primaryKeys.add(entry.key);
        register(entry);
      }
    });

    // Included resources ------------------------------------------------------
    if (Array.isArray(doc.included)) {
      doc.included.forEach(function (resource, index) {
        if (!isObject(resource)) return;
        var entry = makeEntry(resource, "included", index, "/included/" + index);
        model.included.push(entry);
        if (entry.key) {
          if (primaryKeys.has(entry.key) || entriesByKey.has(entry.key)) {
            entry.duplicate = true;
            model.duplicateIncluded.add(entry.key);
          } else {
            register(entry);
          }
        }
      });
    }

    model.entries = Array.from(entriesByKey.values());

    // Types + counters --------------------------------------------------------
    var typeMap = new Map();
    var attributeCount = 0;
    var relationshipCount = 0;

    function countType(entry) {
      var type = displayType(entry.resource);
      var stat = typeMap.get(type) || { type: type, primary: 0, included: 0, total: 0 };
      stat[entry.origin] += 1;
      stat.total += 1;
      typeMap.set(type, stat);
    }

    model.primary.forEach(countType);
    model.included.forEach(countType);

    model.entries.forEach(function (entry) {
      var resource = entry.resource;
      if (isObject(resource.attributes)) attributeCount += Object.keys(resource.attributes).length;
      if (isObject(resource.relationships)) relationshipCount += Object.keys(resource.relationships).length;
    });

    model.types = Array.from(typeMap.values()).sort(function (a, b) {
      if (a.primary !== b.primary) return b.primary - a.primary;
      if (a.total !== b.total) return b.total - a.total;
      return a.type.localeCompare(b.type);
    });

    // Edges ------------------------------------------------------------------
    model.entries.forEach(function (entry) {
      var resource = entry.resource;
      if (!isObject(resource.relationships)) return;
      Object.keys(resource.relationships).forEach(function (name) {
        var rel = resource.relationships[name];
        if (!isObject(rel) || !hasOwn(rel, "data")) return;
        var relPointer = entry.pointer + "/relationships/" + escapePointerToken(name);

        if (rel.data === null) {
          model.stats.nullLinkageCount += 1;
          return;
        }
        var identifiers = Array.isArray(rel.data) ? rel.data : [rel.data];
        identifiers.forEach(function (identifier, index) {
          if (!isObject(identifier)) return;
          var targetKey = identityKey(identifier);
          var target = targetKey ? entriesByKey.get(targetKey) || null : null;
          var edge = {
            fromKey: entry.key,
            fromEntry: entry,
            rel: name,
            toKey: targetKey,
            toEntry: target,
            linkage: identifier,
            pointer: Array.isArray(rel.data) ? relPointer + "/data/" + index : relPointer + "/data",
          };
          model.edges.push(edge);

          if (entry.key) {
            var list = model.outgoing.get(entry.key) || [];
            list.push(edge);
            model.outgoing.set(entry.key, list);
          }
          if (target) {
            var incomingList = model.incoming.get(target.key) || [];
            incomingList.push(edge);
            model.incoming.set(target.key, incomingList);
          } else if (targetKey) {
            var missing = model.missing.get(targetKey) || {
              key: targetKey,
              type: identifier.type,
              id: identifier.id,
              lid: identifier.lid,
              count: 0,
              refs: [],
            };
            missing.count += 1;
            missing.refs.push({ fromKey: entry.key, fromType: entry.origin, rel: name, pointer: edge.pointer });
            model.missing.set(targetKey, missing);
          }
        });
      });
    });

    // Reachability (which included resources are actually linked) ------------
    var linked = new Set(primaryKeys);
    var queue = model.primary.filter(function (entry) {
      return entry.key;
    });
    while (queue.length) {
      var current = queue.shift();
      var outgoing = model.outgoing.get(current.key) || [];
      outgoing.forEach(function (edge) {
        if (edge.toEntry && !linked.has(edge.toEntry.key)) {
          linked.add(edge.toEntry.key);
          queue.push(edge.toEntry);
        }
      });
    }
    model.included.forEach(function (entry) {
      if (!entry.key || !linked.has(entry.key)) {
        model.orphanIncluded.add(entry.key || "included:" + entry.index);
      }
    });

    model.stats.primaryCount = model.primary.length;
    model.stats.includedCount = model.included.length;
    model.stats.typeCount = model.types.length;
    model.stats.attributeCount = attributeCount;
    model.stats.relationshipCount = relationshipCount;
    model.stats.edgeCount = model.edges.length;
    model.stats.missingCount = model.missing.size;

    return model;
  }

  function makeEntry(resource, origin, index, pointer) {
    return {
      key: identityKey(resource),
      type: displayType(resource),
      id: resource && resource.id !== undefined ? resource.id : null,
      lid: resource && resource.lid !== undefined ? resource.lid : null,
      resource: resource,
      origin: origin,
      index: index,
      pointer: pointer,
      label: resourceLabel(resource),
    };
  }

  // ---------------------------------------------------------------------------
  // Plain JSON projection
  // ---------------------------------------------------------------------------

  // Resolve a resource and its relationships into a plain JSON object:
  // attributes are flattened onto the resource, and relationship names hold the
  // resolved resource(s) instead of JSON:API resource linkage.
  function toPlainResource(entry, model, options) {
    options = options || {};
    var maxDepth = typeof options.maxDepth === "number" ? options.maxDepth : 100;
    var budget = typeof options.budget === "number" ? options.budget : 5000;
    var truncated = false;

    function placeholder(identifier, marker) {
      var out = {};
      if (identifier && identifier.type !== undefined) out.type = identifier.type;
      if (identifier && identifier.id !== undefined) out.id = identifier.id;
      if (identifier && identifier.lid !== undefined) out.lid = identifier.lid;
      out[marker] = true;
      return out;
    }

    function resolveResource(current, ancestors, depth) {
      var resource = isObject(current.resource) ? current.resource : {};
      var out = {};

      if (resource.type !== undefined) out.type = resource.type;
      if (resource.id !== undefined) out.id = resource.id;
      if (resource.lid !== undefined) out.lid = resource.lid;

      if (isObject(resource.attributes)) {
        Object.keys(resource.attributes).forEach(function (name) {
          if (!hasOwn(out, name)) out[name] = resource.attributes[name];
        });
      }

      if (budget <= 0) {
        truncated = true;
        out._truncated = true;
        return out;
      }
      budget -= 1;

      var relationships = isObject(resource.relationships) ? resource.relationships : null;
      if (depth >= maxDepth) {
        if (relationships && Object.keys(relationships).length) out._truncated = true;
        return out;
      }

      var nextAncestors = ancestors;
      if (current.key) {
        nextAncestors = new Set(ancestors);
        nextAncestors.add(current.key);
      }

      if (!relationships) return out;

      Object.keys(relationships).forEach(function (name) {
        var rel = relationships[name];
        if (!isObject(rel) || !hasOwn(rel, "data")) return;

        var value;
        if (rel.data === null) {
          value = null;
        } else {
          var isArray = Array.isArray(rel.data);
          var identifiers = isArray ? rel.data : [rel.data];
          var resolved = identifiers.map(function (identifier) {
            if (!isObject(identifier)) return null;
            var targetKey = identityKey(identifier);
            var target = targetKey ? model.byKey.get(targetKey) : null;
            if (!target) return placeholder(identifier, "_missing");
            if (target.key && nextAncestors.has(target.key)) return placeholder(identifier, "_cycle");
            return resolveResource(target, nextAncestors, depth + 1);
          });
          value = isArray ? resolved : resolved[0] || null;
        }

        if (hasOwn(out, name)) {
          if (!isObject(out._relationships)) out._relationships = {};
          out._relationships[name] = value;
        } else {
          out[name] = value;
        }
      });

      return out;
    }

    if (!entry || !isObject(entry.resource)) return null;
    var result = resolveResource(entry, new Set(), 0);
    if (truncated && !result._truncated) result._truncated = true;
    return result;
  }

  // ---------------------------------------------------------------------------
  // Exports
  // ---------------------------------------------------------------------------

  return {
    SPEC_URL: SPEC_URL,
    isObject: isObject,
    identityKey: identityKey,
    resourceLabel: resourceLabel,
    truncate: truncate,
    pointerJoin: pointerJoin,
    parseJson: parseJson,
    validate: validate,
    buildModel: buildModel,
    toPlainResource: toPlainResource,
  };
});
