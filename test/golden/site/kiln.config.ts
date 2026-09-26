/**
 * Golden-site config (T033). `node --test` treats every `.ts` file under
 * `test/` as a test file, so this module is loaded by the runner too: it
 * must stay a pure default-export object with no side effects and no tests.
 * This is the only fixture `.ts` file allowed under `test/golden/`.
 */
export default {
  site: {
    title: "Golden site",
    url: "https://golden.example.com",
  },
  features: {
    pagination: { pageSize: 2 },
    toc: { depth: 3 },
    feed: { limit: 10 },
  },
};
