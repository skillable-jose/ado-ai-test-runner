// src/concurrency.js
// Runs `fn` over `items` with at most `limit` calls in flight at once,
// so a large fan-out (e.g. fetching test points for every suite in a
// plan) doesn't open dozens of simultaneous connections to ADO.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;

  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

module.exports = { mapLimit };
