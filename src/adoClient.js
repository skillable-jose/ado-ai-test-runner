// src/adoClient.js
const axios = require('axios');
const { ConfidentialClientApplication } = require('@azure/msal-node');
const { debug } = require('./log');

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
      let accessToken;
      try {
        ({ accessToken } = await this.msal.acquireTokenByClientCredential({
          scopes: ['499b84ac-1321-427f-aa17-267ca6975798/.default']
        }));
      } catch (err) {
        throw new Error('Entra token acquisition failed: ' + err.message);
      }
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

  // Shared request path — every ADO call goes through here so failures
  // always carry method/URL/status/body instead of a bare axios message.
  async _request(method, url, data) {
    debug(method.toUpperCase() + ' ' + url);
    try {
      const res = await axios({ method, url, data, headers: await this.getHeaders() });
      return res.data;
    } catch (err) {
      const status = err.response ? err.response.status : '(no response)';
      const body   = err.response ? JSON.stringify(err.response.data).slice(0, 500) : err.message;
      throw new Error('ADO request failed: ' + method.toUpperCase() + ' ' + url + ' -> ' + status + ' ' + body);
    }
  }

  async get(path) {
    return this._request('get', this.base + path);
  }

  async getOrg(path) {
    return this._request('get', this.orgBase + path);
  }

  async post(path, body) {
    return this._request('post', this.base + path, body);
  }

  async patch(path, body) {
    return this._request('patch', this.base + path, body);
  }

  // ── Test Plan API ──────────────────────────────────────────────────────────

  async getAllTestPlans() {
    return (await this.get('/_apis/testplan/plans?api-version=7.0')).value;
  }

  async getTestPlanForSprint(sprint) {
    const plans = await this.getAllTestPlans();
    return plans.find(
      p => p.iteration && p.iteration.toLowerCase().includes(sprint.toLowerCase())
    ) || plans[plans.length - 1];
  }

  async getTestPlanById(planId) {
    return this.get('/_apis/testplan/plans/' + planId + '?api-version=7.0');
  }

  async getTestSuites(planId) {
    return (await this.get('/_apis/testplan/plans/' + planId + '/suites?api-version=7.0')).value;
  }

  async getTestPoints(planId, suiteId) {
    return (await this.get(
      '/_apis/testplan/plans/' + planId + '/suites/' + suiteId + '/testpoint?api-version=7.0'
    )).value;
  }

  // ── Work Item API ──────────────────────────────────────────────────────────

  async getWorkItem(id) {
    return this.getOrg('/' + this.project + '/_apis/wit/workitems/' + id + '?$expand=all&api-version=7.0');
  }

  async getTestCaseDetails(id) {
    return this.getWorkItem(id);
  }

  // For a Story/Bug/requirement work item, returns the IDs of test cases
  // linked to it via a "Tested By" relation.
  async getLinkedTestCaseIds(workItemId) {
    const wi = await this.getWorkItem(workItemId);
    return (wi.relations || [])
      .filter(r => r.rel === 'Microsoft.VSTS.Common.TestedBy-Forward')
      .map(r => r.url.split('/').pop());
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
