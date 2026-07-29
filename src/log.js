// src/log.js
// Verbose tracing, off by default. Enable with DEBUG=1 to see:
//   - every ADO API request/response
//   - HTTP test extraction (method/url/status)
//   - each action Claude takes during the Puppeteer agentic loop
//   - login selector matching in sessionManager
const enabled = process.env.DEBUG === '1' || process.env.DEBUG === 'true';

function debug(...args) {
  if (enabled) console.log('  [debug]', ...args);
}

module.exports = { debug };
