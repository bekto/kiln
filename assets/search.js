/**
 * Kiln client-side search (T023) — dependency-free browser script,
 * copied byte-for-byte to dist/assets/search.js by src/features/search.ts.
 *
 * Wire-up: every `.kiln-search` root on the page is bound at load (the
 * partial loads this file with `defer`). The index URL comes from the
 * root's `data-index` attribute and falls back to `/search-index.json`;
 * the index is fetched lazily on the first non-empty query and cached for
 * the lifetime of the page (failures cache too, as "no index").
 *
 * Matching: the query splits on whitespace; an entry matches only when
 * every token is a case-insensitive substring of its title, of at least
 * one of its tags, or of its excerpt. Per token the best field scores 3
 * (title), 2 (tag), 1 (excerpt); scores sum, results sort by score
 * descending then title ascending — deterministic either way.
 *
 * Failure posture: zero matches, an empty index, or a failed fetch all
 * show the partial's "No results" element; an empty query clears the
 * list. Every handler is guarded — this script never throws and never
 * leaves a blank results panel after a query.
 */
(function () {
  "use strict";

  var DEFAULT_INDEX = "/search-index.json";
  /** Page-wide lazy index cache — untouched until the first query. */
  var indexRequest = null;

  function loadIndex(url) {
    if (indexRequest === null) {
      indexRequest = fetch(url)
        .then(function (response) {
          if (!response.ok) {
            throw new Error("index fetch failed: " + response.status);
          }
          return response.json();
        })
        .then(function (data) {
          return prepare(Array.isArray(data) ? data : []);
        })
        .catch(function () {
          // Failed fetch or unparsable payload → null → "No results",
          // cached so a broken index is not hammered on every keystroke.
          return null;
        });
    }
    return indexRequest;
  }

  /** Keep display fields as-is; pre-lowercase everything matching reads. */
  function prepare(entries) {
    var out = [];
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i] || {};
      var title = String(entry.title == null ? "" : entry.title);
      var excerpt = String(entry.excerpt == null ? "" : entry.excerpt);
      var rawTags = Array.isArray(entry.tags) ? entry.tags : [];
      var lowerTags = [];
      for (var j = 0; j < rawTags.length; j++) {
        lowerTags.push(String(rawTags[j]).toLowerCase());
      }
      out.push({
        title: title,
        url: String(entry.url == null ? "" : entry.url),
        lowerTitle: title.toLowerCase(),
        lowerExcerpt: excerpt.toLowerCase(),
        lowerTags: lowerTags,
      });
    }
    return out;
  }

  /** Query → case-folded non-empty tokens; empty for a blank query. */
  function tokensOf(query) {
    var parts = String(query).toLowerCase().split(/\s+/);
    var tokens = [];
    for (var i = 0; i < parts.length; i++) {
      if (parts[i] !== "") tokens.push(parts[i]);
    }
    return tokens;
  }

  function tagHits(tags, token) {
    for (var i = 0; i < tags.length; i++) {
      if (tags[i].indexOf(token) !== -1) return true;
    }
    return false;
  }

  /** Sum of each token's best field score; 0 = the entry misses a token. */
  function scoreOf(entry, tokens) {
    var total = 0;
    for (var i = 0; i < tokens.length; i++) {
      var token = tokens[i];
      var best;
      if (entry.lowerTitle.indexOf(token) !== -1) {
        best = 3;
      } else if (tagHits(entry.lowerTags, token)) {
        best = 2;
      } else if (entry.lowerExcerpt.indexOf(token) !== -1) {
        best = 1;
      } else {
        return 0;
      }
      total += best;
    }
    return total;
  }

  /**
   * Ranked hits for `query`, or `null` when the query has no tokens
   * (the caller clears the results). Score descending, title ascending.
   */
  function search(index, query) {
    var tokens = tokensOf(query);
    if (tokens.length === 0) return null;
    var hits = [];
    for (var i = 0; i < index.length; i++) {
      var score = scoreOf(index[i], tokens);
      if (score > 0) hits.push({ entry: index[i], score: score });
    }
    hits.sort(function (a, b) {
      if (a.score !== b.score) return b.score - a.score;
      if (a.entry.title < b.entry.title) return -1;
      if (a.entry.title > b.entry.title) return 1;
      return 0;
    });
    var ranked = [];
    for (var j = 0; j < hits.length; j++) ranked.push(hits[j].entry);
    return ranked;
  }

  function bind(root) {
    // A page that includes the partial twice also loads this script twice;
    // binding once per root keeps a single listener per input.
    if (root.getAttribute("data-search-bound") !== null) return;
    root.setAttribute("data-search-bound", "");
    var input = root.querySelector(".kiln-search-input");
    var list = root.querySelector(".kiln-search-results");
    var empty = root.querySelector(".kiln-search-empty");
    if (input === null || list === null || empty === null) return;
    var indexUrl = root.getAttribute("data-index") || DEFAULT_INDEX;
    // Bumped on every keystroke so a slow response never overwrites the
    // results of a newer query.
    var sequence = 0;

    function clear() {
      list.textContent = "";
      list.hidden = true;
      empty.hidden = true;
    }

    function showEmpty() {
      list.textContent = "";
      list.hidden = true;
      empty.hidden = false;
    }

    function showResults(results) {
      if (results.length === 0) {
        showEmpty();
        return;
      }
      list.textContent = "";
      for (var i = 0; i < results.length; i++) {
        var item = document.createElement("li");
        var link = document.createElement("a");
        link.setAttribute("href", results[i].url);
        link.textContent = results[i].title;
        item.appendChild(link);
        list.appendChild(item);
      }
      list.hidden = false;
      empty.hidden = true;
    }

    function update() {
      var mine = ++sequence;
      var query = input.value;
      try {
        if (tokensOf(query).length === 0) {
          clear();
          return;
        }
        loadIndex(indexUrl).then(function (index) {
          if (mine !== sequence) return; // a newer query owns the panel
          try {
            showResults(index === null ? [] : search(index, query));
          } catch (error) {
            showEmpty();
          }
        });
      } catch (error) {
        showEmpty();
      }
    }

    input.addEventListener("input", update);
  }

  function init() {
    var roots = document.querySelectorAll(".kiln-search");
    for (var i = 0; i < roots.length; i++) bind(roots[i]);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
