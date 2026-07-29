// src/httpExecutor.js
// Handles pure REST API test cases.
// Extracts the endpoint from the test steps, makes the call,
// and asks Claude to evaluate whether the response matches expectations.

const axios  = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const { debug } = require('./log');

class HttpExecutor {
  constructor() {
    this.claude = new Anthropic();
  }

  // Parse ADO XML steps into plain objects (lightweight version — no xml2js)
  _parseStepsFromXml(xml) {
    if (!xml) return [];
    const steps  = [];
    const stepRx = /<step[^>]*>([\s\S]*?)<\/step>/g;
    const textRx = /<parameterizedString[^>]*>([\s\S]*?)<\/parameterizedString>/g;
    let stepMatch;

    while ((stepMatch = stepRx.exec(xml)) !== null) {
      const parts = [];
      let textMatch;
      textRx.lastIndex = 0;
      const chunk = stepMatch[1];
      while ((textMatch = textRx.exec(chunk)) !== null) {
        parts.push(textMatch[1].replace(/<[^>]+>/g, '').trim());
      }
      steps.push({ action: parts[0] || '', expected: parts[1] || '' });
    }

    return steps;
  }

  // Pull a URL and HTTP method from the step text
  _extractCall(steps) {
    const allText = steps.map(s => s.action + ' ' + s.expected).join('\n');

    const methodMatch = allText.match(/\b(GET|POST|PATCH|DELETE|PUT)\b/);
    const urlMatch    = allText.match(/https?:\/\/[^\s\n"'<>]+/);

    return {
      method: methodMatch ? methodMatch[1] : 'GET',
      url:    urlMatch    ? urlMatch[1].replace(/[.,;)]+$/, '') : null
    };
  }

  // Pull JSON body from step text if present
  _extractBody(steps) {
    const allText = steps.map(s => s.action + ' ' + s.expected).join('\n');
    const bodyMatch = allText.match(/\{[\s\S]*\}/);
    if (!bodyMatch) return null;
    try { return JSON.parse(bodyMatch[0]); } catch { return null; }
  }

  async execute(testCase, authHeaders) {
    const t0     = Date.now();
    const fields = testCase.fields || {};
    const title  = fields['System.Title'] || 'Untitled';
    const steps  = this._parseStepsFromXml(fields['Microsoft.VSTS.TCM.Steps']);

    try {
      const { method, url } = this._extractCall(steps);

      if (!url) {
        debug('No URL extracted from steps for "' + title + '":', JSON.stringify(steps));
        return {
          outcome: 'Blocked',
          reason:  'Could not extract an API URL from the test steps',
          ms:      Date.now() - t0
        };
      }

      const body = ['POST', 'PATCH', 'PUT'].includes(method) ? this._extractBody(steps) : undefined;
      debug(method + ' ' + url + (body ? ' body=' + JSON.stringify(body) : ''));

      // Make the HTTP call — never throw on non-2xx
      let response;
      try {
        response = await axios({
          method,
          url,
          headers:        authHeaders,
          data:           body,
          validateStatus: () => true,
          timeout:        15000
        });
        debug('Response ' + response.status + ' for ' + url);
      } catch (err) {
        return { outcome: 'Failed', reason: 'HTTP request failed: ' + err.message, ms: Date.now() - t0 };
      }

      // Collect expected outcomes from all steps
      const expectations = steps
        .filter(s => s.expected && s.expected.trim())
        .map(s => s.expected.trim())
        .join('\n');

      // Ask Claude to decide pass / fail
      const responseSnippet = JSON.stringify(response.data).slice(0, 1500);

      const { content } = await this.claude.messages.create({
        model:      'claude-sonnet-4-6',
        max_tokens: 400,
        messages: [{
          role: 'user',
          content: [
            'You are a QA engineer evaluating an API test result.',
            '',
            'Test: "' + title + '"',
            'Expected (from test steps):',
            expectations || '(no explicit expected value — check for a successful response)',
            '',
            'Actual HTTP status: ' + response.status,
            'Actual response body (first 1500 chars):',
            responseSnippet,
            '',
            'Did this test PASS or FAIL?',
            '',
            'Reply ONLY with valid JSON — no markdown fences:',
            '{"outcome":"Passed"|"Failed"|"Blocked","reason":"one sentence explaining the result"}'
          ].join('\n')
        }]
      });

      const raw = content[0].text.replace(/```[\s\S]*?```/g, '').trim();
      let result;
      try {
        result = JSON.parse(raw);
      } catch (err) {
        debug('Claude returned non-JSON for "' + title + '":', raw);
        throw err;
      }
      return { ...result, ms: Date.now() - t0 };

    } catch (err) {
      return { outcome: 'Failed', reason: 'Executor error: ' + err.message, ms: Date.now() - t0 };
    }
  }
}

module.exports = HttpExecutor;
