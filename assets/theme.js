/**
 * Kiln theme switcher (T036) — dependency-free browser script, copied
 * byte-for-byte to dist/assets/theme.js by src/features/theme.ts.
 *
 * Wire-up: every `.kiln-theme-toggle` button on the page is bound at load
 * (the partial loads this file with `defer`). The toggle drives the
 * `data-theme` attribute on the document root (`<html data-theme="dark">`),
 * so palettes are plain CSS: style `:root` with the dark-by-default values
 * and override under `:root[data-theme="light"]` (or the reverse when
 * `features.theme.default` is "light" — the partial's `data-default-theme`
 * attribute carries the configured default, falling back to "dark").
 *
 * Persistence: the chosen theme is stored in localStorage under
 * `kiln-theme` and read back on the next page load, where it wins over the
 * configured default. Only the two valid themes are accepted — a tampered
 * or unreadable value falls back to the default. Every storage access is
 * guarded: unavailable or write-blocked storage (private-mode browsers)
 * never throws and never leaves the toggle broken — the choice then simply
 * applies to the current page only.
 *
 * Button state: the theme is mirrored into every bound toggle —
 * `aria-pressed` is "true" while dark is active, and the label names the
 * theme one click away ("Light" in dark, "Dark" in light), replacing the
 * partial's static "Theme" text only after binding. One page-level theme
 * keeps multiple toggles per page in sync. Handlers are guarded — this
 * script never throws.
 */
(function () {
  "use strict";

  var STORAGE_KEY = "kiln-theme";

  /** Stored choice as "dark"/"light"; null when absent or invalid. */
  function storedTheme() {
    try {
      var value = localStorage.getItem(STORAGE_KEY);
      return value === "dark" || value === "light" ? value : null;
    } catch (error) {
      return null; // storage unavailable — fall back to the default
    }
  }

  /** Best-effort persist; the toggle still works when storage is blocked. */
  function storeTheme(theme) {
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch (error) {
      // choice applies to this page only
    }
  }

  /** "Dark" → "Light theme": the label names the theme one click away. */
  function labelFor(theme) {
    return theme === "dark" ? "Light theme" : "Dark theme";
  }

  /**
   * Apply `theme` to the document root and mirror it into every bound
   * toggle button (label + aria-pressed), so multiple toggles per page
   * stay in sync.
   */
  function applyTheme(buttons, theme) {
    document.documentElement.setAttribute("data-theme", theme);
    var pressed = theme === "dark" ? "true" : "false";
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].setAttribute("aria-pressed", pressed);
      buttons[i].textContent = labelFor(theme);
    }
  }

  /** The configured default from the partial; invalid values → "dark". */
  function defaultFor(button) {
    return button.getAttribute("data-default-theme") === "light"
      ? "light"
      : "dark";
  }

  /** The other theme — the toggle has exactly two. */
  function flipped(theme) {
    return theme === "dark" ? "light" : "dark";
  }

  function init() {
    var roots = document.querySelectorAll(".kiln-theme");
    var buttons = [];
    var current = storedTheme(); // null → resolved from the first toggle's default
    for (var i = 0; i < roots.length; i++) {
      if (roots[i].getAttribute("data-theme-bound") !== null) continue;
      roots[i].setAttribute("data-theme-bound", "");
      var button = roots[i].querySelector(".kiln-theme-toggle");
      if (button === null) continue;
      buttons.push(button);
      if (current === null) current = defaultFor(button);
      // No button reference needed in the handler: applyTheme mirrors the
      // theme into every bound toggle, and `current` is page-level.
      button.addEventListener("click", function () {
        current = flipped(current);
        applyTheme(buttons, current);
        storeTheme(current);
      });
    }
    if (buttons.length > 0) applyTheme(buttons, current);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
