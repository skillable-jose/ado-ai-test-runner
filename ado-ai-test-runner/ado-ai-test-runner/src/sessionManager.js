// src/sessionManager.js
// Launches one browser, logs in once, and shares the session across all tests.
// This is the key performance win — 65 browser tests share one login.

const puppeteer = require('puppeteer');

class SessionManager {
  constructor({ studioUrl, authMode, username, password }) {
    this.studioUrl = studioUrl || 'https://admin.qa.skillable.com';
    this.authMode  = authMode || 'credentials';
    this.username  = username;
    this.password  = password;
    this.browser   = null;
    this.page      = null;
  }

  async initialize() {
    console.log('  Launching browser...');

    this.browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',    // required in Docker / GitHub Actions
        '--disable-gpu',
        '--window-size=1280,900'
      ]
    });

    this.page = await this.browser.newPage();
    await this.page.setViewport({ width: 1280, height: 900 });

    // Suppress console noise from the app
    this.page.on('console', () => {});
    this.page.on('pageerror', () => {});

    await this._login();
    console.log('  Browser session ready.\n');
  }

  async _login() {
    console.log('  Navigating to ' + this.studioUrl + '...');
    await this.page.goto(this.studioUrl, { waitUntil: 'networkidle2', timeout: 30000 });

    const currentUrl = this.page.url();

    // Already authenticated (redirected to the app, not a login page)
    if (!currentUrl.includes('login') && !currentUrl.includes('signin') &&
        !currentUrl.includes('microsoftonline') && !currentUrl.includes('auth')) {
      console.log('  Already authenticated.');
      return;
    }

    if (this.authMode === 'credentials') {
      await this._loginWithCredentials();
    } else {
      // For Entra SSO: the browser will be on the Microsoft login page.
      // Fill in just the email/username — Entra typically redirects to the org page
      // which then may require username + password or an SSO redirect.
      await this._loginWithCredentials();
    }

    await this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
    console.log('  Logged in. Current URL: ' + this.page.url());
  }

  async _loginWithCredentials() {
    // Common selector patterns for username/email fields
    const emailSelectors = [
      'input[name="username"]',
      'input[name="email"]',
      'input[type="email"]',
      'input[id="username"]',
      'input[id="email"]',
      'input[placeholder*="email" i]',
      'input[placeholder*="username" i]'
    ];

    // Common selector patterns for password fields
    const passwordSelectors = [
      'input[type="password"]',
      'input[name="password"]',
      'input[id="password"]'
    ];

    // Fill email / username
    for (const sel of emailSelectors) {
      const el = await this.page.$(sel);
      if (el) {
        await el.click({ clickCount: 3 });
        await el.type(this.username);
        break;
      }
    }

    // Some flows (e.g. Microsoft) require clicking Next before showing password
    const nextButton = await this.page.$('input[type="submit"]') ||
                       await this.page.$('button[type="submit"]');
    if (nextButton) {
      await nextButton.click();
      await this.page.waitForNetworkIdle({ idleTime: 500, timeout: 5000 }).catch(() => {});
    }

    // Fill password
    for (const sel of passwordSelectors) {
      const el = await this.page.$(sel);
      if (el) {
        await el.click({ clickCount: 3 });
        await el.type(this.password);
        break;
      }
    }

    // Submit
    await this.page.keyboard.press('Enter');
  }

  async getPage() {
    if (!this.page) throw new Error('Session not initialized — call initialize() first');
    return this.page;
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.page    = null;
    }
  }
}

module.exports = SessionManager;
