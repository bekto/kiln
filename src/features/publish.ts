/**
 * T013 — drafts & scheduled publishing: the build's visibility policy.
 *
 * Driven entirely by CLI flags — there is no config key, and this module
 * never reads `process.argv`; `ctx.flags.drafts` / `ctx.flags.future`
 * (booleans, default `false`) arrive from T012's build command.
 *
 * - `onDocument` runs before any markdown/layout render (T012) and resolves
 *   `data.published` (boolean) for every document. A document is hidden
 *   when `draft: true` and `--drafts` is off, or when its frontmatter
 *   `date` is strictly later than the build start time (UTC) and `--future`
 *   is off; a date exactly equal to the build time counts as published.
 *   `draft` must be boolean `true` to hide — any other value rejects
 *   through `isDraft` with an error naming the document path and the field.
 *   Raw drafts (frontmatter `draft: true`, whatever the flags say) also
 *   append `"publish-meta.html"` to `data.injectHead`, so a draft previewed
 *   with `--drafts` renders the partial's `<meta name="robots"
 *   content="noindex">` through the base layout's head slot.
 * - `onSite` removes entries with `data.published === false` from
 *   `site.pages` before T012 computes collections — the emitter never
 *   writes their pages, every collection (home, tags, pagination) derives
 *   from the filtered set, and features whose `onSite` sorts after
 *   `publish.ts`, plus every `onBuildEnd` reader (feed, sitemap), observe
 *   only published documents. Pages appended by other features never saw
 *   `onDocument`, carry no `published`, and are kept.
 *
 * Build clock: feature modules stay imported across watch-mode rebuilds
 * while `ctx` is recreated per build, so the first hook call for a fresh
 * context captures `Date.now()` and later calls in the same build reuse
 * it — one start time per build, never one per document.
 */
import { isDraft } from "../content/collections.ts";
import type { Document, Page, Site } from "../content/document.ts";
import type {
  BuildFlags,
  Feature,
  FeatureContext,
} from "../feature.ts";

/** Head partial rendering `<meta name="robots" content="noindex">`. */
const NOINDEX_PARTIAL = "publish-meta.html";

/** The build start time captured for each context (one capture per build). */
let clock: { readonly ctx: FeatureContext; readonly at: number } | undefined;

/** Epoch milliseconds of this build's start: captured once per `ctx`. */
function buildStart(ctx: FeatureContext): number {
  if (clock?.ctx !== ctx) clock = { ctx, at: Date.now() };
  return clock.at;
}

/**
 * The hide rule for one document at build time `now` (epoch ms): raw
 * drafts unless `--drafts`, dates strictly after `now` unless `--future`.
 * Validates `data.draft` through `isDraft`, so a non-boolean `draft`
 * rejects with `<path>: "draft" must be a boolean (got <type>)`.
 */
function isHidden(
  doc: Document,
  flags: BuildFlags,
  now: number,
): boolean {
  // `isDraft` only reads path/data; onDocument receives discovered pages.
  if (isDraft(doc as Page) && !flags.drafts) return true;
  const date = doc.data.date;
  return !flags.future && date instanceof Date && date.getTime() > now;
}

function onDocument(doc: Document, ctx: FeatureContext): void {
  doc.data.published = !isHidden(doc, ctx.flags, buildStart(ctx));
  // Raw drafts get the noindex partial even when --drafts emits them; the
  // boolean check is safe because isHidden just validated `draft`.
  if (doc.data.draft === true) {
    const head = doc.data.injectHead;
    if (head === undefined) {
      doc.data.injectHead = [NOINDEX_PARTIAL];
    } else if (Array.isArray(head) && !head.includes(NOINDEX_PARTIAL)) {
      head.push(NOINDEX_PARTIAL);
    }
  }
}

function onSite(site: Site): void {
  // Exactly what onDocument resolved; documents that never saw onDocument
  // (feature-appended) have no `published` and keep their place.
  site.pages = site.pages.filter((page) => page.data.published !== false);
}

const publish: Feature = { onDocument, onSite };
export default publish;
