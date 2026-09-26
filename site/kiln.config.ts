// Kiln example site (T034) — configured for Wave-3 features only.
// Directory keys stay at their defaults so everything resolves inside
// site/ when the build runs with site/ as cwd; output lands in site/dist/.
export default {
  site: {
    title: 'Kiln example site',
    url: 'https://example.com',
    description: 'A demo site built with Kiln — posts, tags, feeds, search, and everything Wave 3 ships.',
  },
  features: {
    highlight: { theme: 'github-dark' },   // T016
    toc: { depth: 3 },                     // T017
    feed: { limit: 10 },                   // T018
    pagination: { pageSize: 3 },           // T015 — 8 posts → 3 list pages
    excerpt: { length: 200 },              // T020
    readingTime: { wordsPerMinute: 200 },  // T021
    related: { limit: 3 },                 // T022
    search: { indexPath: 'search-index.json' }, // T023
  },
};
