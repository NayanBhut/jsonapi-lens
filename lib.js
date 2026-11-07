/* Shared DOM + formatting helpers for the JSON:API Lens interface. */
(function () {
  "use strict";

  var Lens = window.Lens || (window.Lens = {});
  var core = window.JsonApiCore;

  function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
  }

  function append(parent, child) {
    if (child === null || child === undefined || child === false || child === true) return;
    if (Array.isArray(child)) {
      child.forEach(function (item) {
        append(parent, item);
      });
      return;
    }
    if (child instanceof Node) {
      parent.appendChild(child);
      return;
    }
    parent.appendChild(document.createTextNode(String(child)));
  }

  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        var value = attrs[key];
        if (value === undefined || value === null || value === false) return;
        if (key === "class") node.className = value;
        else if (key === "text") node.textContent = value;
        else if (key === "dataset") {
          Object.keys(value).forEach(function (name) {
            node.dataset[name] = value[name];
          });
        } else if (key === "style") {
          node.setAttribute("style", value);
        } else if (key === "value") {
          node.value = value;
        } else if (key === "checked") {
          node.checked = !!value;
        } else {
          node.setAttribute(key, value === true ? "" : value);
        }
      });
    }
    for (var i = 2; i < arguments.length; i += 1) append(node, arguments[i]);
    return node;
  }

  var SVG_NS = "http://www.w3.org/2000/svg";

  function svgEl(tag, attrs) {
    var node = document.createElementNS(SVG_NS, tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        var value = attrs[key];
        if (value === undefined || value === null || value === false) return;
        if (key === "class") node.setAttribute("class", value);
        else if (key === "text") node.textContent = value;
        else node.setAttribute(key, value);
      });
    }
    for (var i = 2; i < arguments.length; i += 1) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (child instanceof Node) node.appendChild(child);
      else node.appendChild(document.createTextNode(String(child)));
    }
    return node;
  }

  function hueFor(type) {
    var text = String(type || "");
    var hash = 0;
    for (var i = 0; i < text.length; i += 1) {
      hash = (hash * 31 + text.charCodeAt(i)) % 360;
    }
    return hash;
  }

  function typeBadge(type, extraClass) {
    var badge = el("span", {
      class: "type-badge" + (extraClass ? " " + extraClass : ""),
      title: String(type || "unknown"),
      text: String(type || "unknown")
    });
    badge.style.setProperty("--h", hueFor(type));
    return badge;
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  /**
   * Small, safe JSON syntax highlighter. Every user-controlled slice is
   * escaped before it is inserted, and the only HTML we emit is our own spans.
   */
  function highlightJson(text) {
    var pattern = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
    var html = "";
    var last = 0;
    var match;
    while ((match = pattern.exec(text))) {
      html += escapeHtml(text.slice(last, match.index));
      if (match[1] !== undefined) {
        var isKey = !!match[2];
        html += '<span class="' + (isKey ? "tok-key" : "tok-str") + '">' + escapeHtml(match[1]) + "</span>";
        if (match[2]) html += escapeHtml(match[2]);
      } else if (match[3] !== undefined) {
        html += '<span class="tok-lit">' + escapeHtml(match[3]) + "</span>";
      } else if (match[4] !== undefined) {
        html += '<span class="tok-num">' + escapeHtml(match[4]) + "</span>";
      }
      last = pattern.lastIndex;
    }
    html += escapeHtml(text.slice(last));
    return html;
  }

  function formatBytes(bytes) {
    if (!isFinite(bytes) || bytes < 0) return "0 B";
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) {
      var kb = bytes / 1024;
      return (kb < 10 ? kb.toFixed(1) : Math.round(kb)) + " KB";
    }
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }

  function previewValue(value) {
    if (value === null) return "null";
    if (typeof value === "string") return JSON.stringify(core.truncate(value, 48));
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (Array.isArray(value)) return "[" + value.length + " items]";
    if (isObject(value)) return "{" + Object.keys(value).length + " keys}";
    return String(value);
  }

  function identityText(type, id, lid) {
    if (id !== undefined && id !== null) return String(type) + ":" + String(id);
    if (lid !== undefined && lid !== null) return String(type) + ":lid:" + String(lid);
    return String(type) + ":?";
  }

  function safeHref(value) {
    if (typeof value !== "string") return null;
    var trimmed = value.trim();
    if (!trimmed) return null;
    if (/^(https?:|mailto:|\/|\.\/|\.\.\/|#)/i.test(trimmed)) return trimmed;
    return null;
  }

  function linkHref(link) {
    if (typeof link === "string") return safeHref(link);
    if (isObject(link)) return safeHref(link.href);
    return null;
  }

  var toastTimer = null;
  function toast(message) {
    var node = document.getElementById("toast");
    if (!node) return;
    node.textContent = message;
    node.classList.add("is-visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      node.classList.remove("is-visible");
    }, 2200);
  }

  function copyText(text, label) {
    if (text === undefined || text === null || text === "") return;
    var value = String(text);
    var done = function () {
      toast(label || "Copied to clipboard");
    };
    var fallback = function () {
      var area = document.createElement("textarea");
      area.value = value;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.top = "-1000px";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      try {
        document.execCommand("copy");
        done();
      } catch (error) {
        toast("Could not copy — select the text manually");
      }
      area.remove();
    };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(value).then(done, fallback);
    } else {
      fallback();
    }
  }

  function readStore(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (error) {
      return null;
    }
  }

  function writeStore(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch (error) {
      /* Storage can be full (large documents) or disabled. Ignore. */
    }
  }

  function removeStore(key) {
    try {
      window.localStorage.removeItem(key);
    } catch (error) {
      /* Ignore. */
    }
  }

  Lens.isObject = isObject;
  Lens.hasOwn = hasOwn;
  Lens.append = append;
  Lens.el = el;
  Lens.svgEl = svgEl;
  Lens.hueFor = hueFor;
  Lens.typeBadge = typeBadge;
  Lens.escapeHtml = escapeHtml;
  Lens.highlightJson = highlightJson;
  Lens.formatBytes = formatBytes;
  Lens.previewValue = previewValue;
  Lens.identityText = identityText;
  Lens.safeHref = safeHref;
  Lens.linkHref = linkHref;
  Lens.toast = toast;
  Lens.copyText = copyText;
  Lens.readStore = readStore;
  Lens.writeStore = writeStore;
  Lens.removeStore = removeStore;
})();
