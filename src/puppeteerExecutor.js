// src/puppeteerExecutor.js
// The agentic loop: for each Puppeteer test case,
//   1. Take a screenshot of the current page
//   2. Show Claude the screenshot + test steps + what's been done so far
//   3. Claude returns ONE action to take
//   4. Puppeteer executes it
//   5. Repeat until Claude says done / fail, or MAX_STEPS is reached

const Anthropic = require('@anthropic-ai/sdk');

const MAX_STEPS = 25;       // Safety guard — prevents infinite loops
const ACTION_TIMEOUT = 8000; // ms to wait for elements / navigation

class PuppeteerExecutor {
  constructor({ env } = {}) {
    this.claude = new Anthropic();
    this.env    = (env || 'QA').toUpperCase();
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  async _parseSteps(xml) {
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
      steps.push({ n: steps.length + 1, action: parts[0] || '', expected: parts[1] || '' });
    }
    return steps;
  }

  // Extract the URL for the target ENV from step 1.
  // Test cases embed QA/UAT/PROD URLs like:
  //   QA: https://admin.qa.skillable.com/LabProfile/123
  //   UAT: https://uat.labondemand.com/LabProfile/456
  _extractEnvUrl(steps) {
    if (!steps.length) return null;

    const step1Lines = (steps[0].action || '').split('\n');
    const envPattern = new RegExp('^' + this.env + '[:\\s-]', 'i');

    for (const line of step1Lines) {
      if (envPattern.test(line.trim())) {
        const urlMatch = line.match(/https?:\/\/[^\s]+/);
        if (urlMatch) return urlMatch[0].replace(/[.,;)]+$/, '');
      }
    }

    // Fallback — first URL anywhere in step 1
    const fallbackMatch = steps[0].action.match(/https?:\/\/[^\s\n]+/);
    return fallbackMatch ? fallbackMatch[0].replace(/[.,;)]+$/, '') : null;
  }

  _buildPrompt(title, steps, currentUrl, history) {
    const stepList = steps.map(s =>
      '  ' + s.n + '. Do: ' + s.action +
      (s.expected ? '\n     Expect: ' + s.expected : '')
    ).join('\n');

    const historyText = history.length
      ? 'Actions already taken:\n' + history.map((h, i) =>
          '  ' + (i + 1) + '. ' + h.action + ': ' + (h.target || '') +
          (h.value ? ' → "' + h.value + '"' : '') +
          ' (' + h.reason + ')'
        ).join('\n')
      : 'No actions taken yet — this is the first step.';

    return [
      'You are a QA automation expert executing a test case step by step.',
      '',
      'Test: "' + title + '"',
      '',
      'All test steps:',
      stepList,
      '',
      'Current URL: ' + currentUrl,
      '',
      historyText,
      '',
      'Look at the screenshot and decide the NEXT SINGLE action to move the test forward.',
      '',
      'Rules:',
      '- Return "done" only when ALL steps are complete and all expectations are met.',
      '- Return "fail" only when a step has clearly failed (e.g. expected modal did not appear,',
      '  error message shown, wrong page loaded).',
      '- Return "click" with the most specific CSS selector you can identify for the element.',
      '- Return "navigate" with a full URL if you need to go to a different page.',
      '- Return "type" with the selector and the text to enter.',
      '- Return "wait" if the page is still loading (value = milliseconds to wait).',
      '',
      'Reply ONLY with valid JSON — no markdown, no explanation outside the JSON:',
      '{',
      '  "action": "navigate" | "click" | "type" | "wait" | "done" | "fail",',
      '  "target": "CSS selector, URL, or visible button text",',
      '  "value":  "text to type (only for action=type) or ms (only for action=wait)",',
      '  "reason": "one sentence — what you see and why you chose this action",',
      '  "failedStep": "description of the step that failed (only for action=fail)"',
      '}'
    ].join('\n');
  }

  // ── Action execution ───────────────────────────────────────────────────────

  async _executeAction(page, action) {
    switch (action.action) {

      case 'navigate':
        await page.goto(action.target, { waitUntil: 'networkidle2', timeout: 30000 });
        break;

      case 'click': {
        // Try CSS selector first, then fall back to visible text matching
        let el = null;

        try {
          await page.waitForSelector(action.target, { timeout: ACTION_TIMEOUT });
          el = await page.$(action.target);
        } catch (_) {}

        if (!el) {
          // Try matching by visible text (button text, link text, label)
          el = await page.evaluateHandle((text) => {
            const all = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="submit"]'));
            return all.find(el => el.textContent.trim().toLowerCase().includes(text.toLowerCase())) || null;
          }, action.target);
          if (el && (await el.asElement()) === null) el = null;
        }

        if (!el) throw new Error('Element not found: ' + action.target);

        await el.click();
        await page.waitForNetworkIdle({ idleTime: 500, timeout: 5000 }).catch(() => {});
        break;
      }

      case 'type': {
        let el = null;
        try {
          await page.waitForSelector(action.target, { timeout: ACTION_TIMEOUT });
          el = await page.$(action.target);
        } catch (_) {}

        if (!el) throw new Error('Input element not found: ' + action.target);

        await el.click({ clickCount: 3 }); // select all existing text
        await el.type(action.value || '');
        break;
      }

      case 'wait':
        await new Promise(r => setTimeout(r, parseInt(action.value) || 2000));
        break;

      default:
        throw new Error('Unknown action: ' + action.action);
    }
  }

  // ── Main execute ───────────────────────────────────────────────────────────

  async execute(testCase, page) {
    const t0     = Date.now();
    const fields = testCase.fields || {};
    const title  = fields['System.Title'] || 'Untitled';
    const steps  = await this._parseSteps(fields['Microsoft.VSTS.TCM.Steps']);

    // Navigate to the test's starting URL for the target environment
    const startUrl = this._extractEnvUrl(steps);
    if (!startUrl) {
      return {
        outcome: 'Blocked',
        reason:  'Could not extract ' + this.env + ' URL from step 1',
        ms:      Date.now() - t0
      };
    }

    try {
      await page.goto(startUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    } catch (err) {
      return { outcome: 'Blocked', reason: 'Could not navigate to ' + startUrl + ': ' + err.message, ms: Date.now() - t0 };
    }

    const history = [];

    for (let loop = 0; loop < MAX_STEPS; loop++) {
      // Capture current state
      let screenshot;
      try {
        screenshot = await page.screenshot({ type: 'jpeg', quality: 55 });
      } catch (err) {
        return { outcome: 'Failed', reason: 'Screenshot failed: ' + err.message, ms: Date.now() - t0 };
      }

      const currentUrl = page.url();
      const prompt     = this._buildPrompt(title, steps, currentUrl, history);

      // Ask Claude for the next action
      let decision;
      try {
        const { content } = await this.claude.messages.create({
          model:      'claude-sonnet-4-6',
          max_tokens: 500,
          messages: [{
            role: 'user',
            content: [
              {
                type:   'image',
                source: { type: 'base64', media_type: 'image/jpeg', data: screenshot.toString('base64') }
              },
              { type: 'text', text: prompt }
            ]
          }]
        });

        const raw = content[0].text.replace(/```[\s\S]*?```/g, '').trim();
        decision  = JSON.parse(raw);
      } catch (err) {
        return { outcome: 'Failed', reason: 'Claude decision error: ' + err.message, ms: Date.now() - t0 };
      }

      // Terminal states
      if (decision.action === 'done') {
        return { outcome: 'Passed', reason: decision.reason, ms: Date.now() - t0 };
      }

      if (decision.action === 'fail') {
        return {
          outcome:     'Failed',
          reason:      decision.reason,
          failedStep:  decision.failedStep || null,
          ms:          Date.now() - t0
        };
      }

      // Record what we're about to do
      history.push({ action: decision.action, target: decision.target, value: decision.value, reason: decision.reason });

      // Execute the action
      try {
        await this._executeAction(page, decision);
      } catch (err) {
        return {
          outcome: 'Failed',
          reason:  'Action "' + decision.action + '" on "' + decision.target + '" failed: ' + err.message,
          ms:      Date.now() - t0
        };
      }
    }

    return {
      outcome: 'Failed',
      reason:  'Reached maximum of ' + MAX_STEPS + ' steps without completing the test',
      ms:      Date.now() - t0
    };
  }
}

module.exports = PuppeteerExecutor;
