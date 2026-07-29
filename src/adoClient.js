// src/adoClient.js
const axios = require('axios');
const { ConfidentialClientApplication } = require('@azure/msal-node');

class ADOClient {
  constructor({ org, project, authMode, pat, tenantId, clientId, clientSecret }) {
    this.org      = org;
    this.project  = project;
    this.base     = 'https://' + org + '.visualstudio.com/' + project;
    this.orgBase  = 'https://' + org + '.visualstudio.com';
    this.authMode = authMode || 'pat';

    if (authMode === 'entra') {
      this.msal = new ConfidentialClientApplication({
        auth: {
          clientId,
          clientSecret,
          authority: 'https://login.microsoftonline.com/' + tenantId
        }
      });
    } else {
      this.pat = pat;
    }
  }

  async getHeaders() {
    if (this.authMode === 'entra') {
      const { accessToken } = await this.msal.acquireTokenByClientCredential({
        scopes: ['499b84ac-1321-427f-aa17-267ca6975798/.default']
      });
      return { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' };
    }
    return {
      Authorization: 'Basic ' + Buffer.from(':' + this.pat).toString('base64'),
      'Content-Type': 'application/json'
    };
  }

  // Returns headers for use by the HTTP executor
  async buildAuthHeaders() {
    return this.getHeaders();
  }

  async get(path) {
    return (await axios.get(this.base + path, { headers: await this.getHeaders() })).data;
  }

  async getOrg(path) {
    return (await axios.get(this.orgBase + path, { headers: await this.getHeaders() })).data;
  }

  async post(path, body) {
    return (await axios.post(this.base + path, body, { headers: await this.getHeaders() })).data;
  }

  async patch(path, body) {
    return (await axios.patch(this.base + path, body, { headers: await this.getHeaders() })).data;
  }

  // ── Test Plan API ──────────────────────────────────────────────────────────

  async getTestPlanForSprint(sprint) {
    const { value } = await this.get('/_apis/testplan/plans?api-version=7.0');
    return value.find(
      p => p.iteration && p.iteration.toLowerCase().includes(sprint.toLowerCase())
    ) || value[value.length - 1];
  }

  async getTestSuites(planId) {
    return (await this.get('/_apis/testplan/plans/' + planId + '/suites?api-version=7.0')).value;
  }

  async getTestPoints(planId, suiteId) {
    return (await this.get(
      '/_apis/testplan/plans/' + planId + '/suites/' + suiteId + '/testpoint?api-version=7.0'
    )).value;
  }

  async getTestCaseDetails(id) {
    return this.getOrg('/' + this.project + '/_apis/wit/workitems/' + id + '?$expand=all&api-version=7.0');
  }

  // ── Test Run API ───────────────────────────────────────────────────────────

  async createTestRun(planId, pointIds, sprint) {
    return this.post('/_apis/test/runs?api-version=7.0', {
      name: 'AI Run - ' + sprint + ' - ' + new Date().toISOString(),
      plan: { id: planId },
      pointIds,
      automated: true
    });
  }

  async updateResults(runId, results) {
    return this.patch('/_apis/test/runs/' + runId + '/results?api-version=7.0', results);
  }

  async completeRun(runId) {
    return this.patch('/_apis/test/runs/' + runId + '?api-version=7.0', { state: 'Completed' });
  }
}

module.exports = ADOClient;
