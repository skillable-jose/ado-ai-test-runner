// index.js — orchestrator
// Reads the ADO test plan, classifies each test case,
// runs HTTP and Puppeteer tests, and writes results back to ADO.

require('dotenv').config();

const ADOClient          = require('./src/adoClient');
const SessionManager     = require('./src/sessionManager');
const HttpExecutor       = require('./src/httpExecutor');
const PuppeteerExecutor  = require('./src/puppeteerExecutor');
const { classifyTestCase } = require('./src/classifier');

async function main() {
  const sprint     = process.env.SPRINT_NAME || process.argv[2];
  const env        = process.env.TARGET_ENV   || process.argv[3] || 'QA';
  const workItemId = process.env.WORK_ITEM_ID  || process.argv[4] || null;

  if (!sprint) {
    console.error('Error: SPRINT_NAME is required.\n');
    console.error('Usage: node index.js "Sprint 42" QA [workItemId]');
    console.error('   or: SPRINT_NAME="Sprint 42" TARGET_ENV=QA WORK_ITEM_ID=12345 node index.js');
    process.exit(1);
  }

  console.log('\n====================================================');
  console.log('  ADO AI Test Runner');
  console.log('  Sprint    : ' + sprint);
  console.log('  ENV       : ' + env);
  console.log('  Work Item : ' + (workItemId || 'ALL (full sprint)'));
  console.log('====================================================\n');

  // ── ADO client ─────────────────────────────────────────────────────────────

  const ado = new ADOClient({
    org:          process.env.ADO_ORG,
    project:      process.env.ADO_PROJECT,
    authMode:     process.env.AUTH_MODE || 'pat',
    pat:          process.env.ADO_PAT,
    tenantId:     process.env.AZURE_TENANT_ID,
    clientId:     process.env.AZURE_CLIENT_ID,
    clientSecret: process.env.AZURE_CLIENT_SECRET
  });

  // ── Executors ──────────────────────────────────────────────────────────────

  const httpExec      = new HttpExecutor();
  const puppeteerExec = new PuppeteerExecutor({ env });
  const session       = new SessionManager({
    studioUrl: process.env.STUDIO_URL || 'https://admin.' + env.toLowerCase() + '.skillable.com',
    authMode:  process.env.APP_AUTH_MODE || 'credentials',
    username:  process.env.APP_USERNAME,
    password:  process.env.APP_PASSWORD
  });

  // ── Fetch test plan ────────────────────────────────────────────────────────

  console.log('Fetching test plan...');
  let plan   = await ado.getTestPlanForSprint(sprint);
  let suites = await ado.getTestSuites(plan.id);
  let points = (await Promise.all(suites.map(s => ado.getTestPoints(plan.id, s.id)))).flat();

  console.log('Plan   : "' + plan.name + '" (ID ' + plan.id + ')');
  console.log('Suites : ' + suites.length);
  console.log('Points : ' + points.length + '\n');

  // ── Optionally narrow by work item ID ───────────────────────────────────────
  // workItemId may refer to: a Test Plan (run it directly), a Test Case
  // (run just that one), or a Story/Bug (run whatever test cases are linked
  // to it via "Tested By").

  if (workItemId) {
    const planById = await ado.getTestPlanById(workItemId).catch(() => null);

    if (planById) {
      plan   = planById;
      suites = await ado.getTestSuites(plan.id);
      points = (await Promise.all(suites.map(s => ado.getTestPoints(plan.id, s.id)))).flat();
      console.log('Using test plan ' + workItemId + ' directly: "' + plan.name + '" (' + points.length + ' points)\n');

    } else {
      const wi   = await ado.getWorkItem(workItemId);
      const type = (wi.fields || {})['System.WorkItemType'] || 'work item';

      const testCaseIds = type === 'Test Case'
        ? [String(workItemId)]
        : await ado.getLinkedTestCaseIds(workItemId);

      if (testCaseIds.length === 0) {
        throw new Error('Work item ' + workItemId + ' (' + type + ') has no linked test cases (no "Tested By" relation).');
      }

      points = points.filter(p => p.testCaseReference && testCaseIds.includes(String(p.testCaseReference.id)));
      if (points.length === 0) {
        throw new Error('No test case linked to work item ' + workItemId + ' (' + type + ') is part of the "' + plan.name + '" test plan for sprint "' + sprint + '".');
      }
      console.log('Filtered to work item ' + workItemId + ' (' + type + '): ' + points.length + ' test point(s)\n');
    }
  }

  // ── Create test run in ADO ─────────────────────────────────────────────────

  const run = await ado.createTestRun(plan.id, points.map(p => p.id), sprint);
  console.log('Test run created (ID: ' + run.id + ')\n');

  // ── Classify all tests upfront so we know if browser is needed ────────────

  const classified = [];
  for (const [i, point] of points.entries()) {
    if (!point.testCaseReference) {
      console.error('Point ' + point.id + ' (index ' + i + ') has no testCaseReference:', JSON.stringify(point));
      throw new Error('Test point ' + point.id + ' is missing testCaseReference');
    }

    process.stdout.write('Classifying ' + (i + 1) + '/' + points.length + ': test case ' + point.testCaseReference.id + '\r');
    const tc       = await ado.getTestCaseDetails(point.testCaseReference.id);
    const category = classifyTestCase(tc);
    classified.push({ point, tc, category });
  }
  process.stdout.write('\n');

  const httpCount      = classified.filter(c => c.category === 'http').length;
  const puppeteerCount = classified.filter(c => c.category === 'puppeteer').length;
  const skipCount      = classified.filter(c => c.category === 'skip').length;

  console.log('Classification:');
  console.log('  HTTP     : ' + httpCount);
  console.log('  Puppeteer: ' + puppeteerCount);
  console.log('  Skip     : ' + skipCount + '\n');

  // ── Initialize browser only if needed ─────────────────────────────────────

  let sessionReady = false;
  if (puppeteerCount > 0) {
    await session.initialize();
    sessionReady = true;
  }

  // ── Execute tests ──────────────────────────────────────────────────────────

  const results = [];

  for (const { point, tc, category } of classified) {
    const title = (tc.fields || {})['System.Title'] || 'Untitled';
    let result;

    if (category === 'http') {
      process.stdout.write('[HTTP    ] ' + title + '\n');
      const authHeaders = await ado.buildAuthHeaders();
      result = await httpExec.execute(tc, authHeaders);

    } else if (category === 'puppeteer') {
      process.stdout.write('[BROWSER ] ' + title + '\n');
      const page = await session.getPage();
      result = await puppeteerExec.execute(tc, page);

    } else {
      process.stdout.write('[SKIP    ] ' + title + '\n');
      result = { outcome: 'NotExecuted', reason: 'Requires manual execution', ms: 0 };
    }

    const icon = {
      Passed:      '✅',
      Failed:      '❌',
      Blocked:     '⚠️',
      NotExecuted: '⏭️'
    }[result.outcome] || '❓';

    console.log('           ' + icon + '  ' + result.reason);
    if (result.failedStep) console.log('              Failed at: ' + result.failedStep);

    results.push({
      id:          point.resultId || 1,
      testCase:    { id: tc.id },
      testPoint:   { id: point.id },
      outcome:     result.outcome,
      state:       'Completed',
      comment:     result.failedStep
                     ? result.reason + ' | Step: ' + result.failedStep
                     : result.reason,
      durationInMs: result.ms || 0
    });
  }

  // ── Close browser ──────────────────────────────────────────────────────────

  if (sessionReady) await session.close();

  // ── Write results to ADO ───────────────────────────────────────────────────

  console.log('\nWriting results to ADO...');
  await ado.updateResults(run.id, results);
  await ado.completeRun(run.id);

  const passed  = results.filter(r => r.outcome === 'Passed').length;
  const failed  = results.filter(r => r.outcome === 'Failed').length;
  const blocked = results.filter(r => r.outcome === 'Blocked').length;
  const skipped = results.filter(r => r.outcome === 'NotExecuted').length;

  console.log('\n====================================================');
  console.log('  ✅  Passed     : ' + passed);
  console.log('  ❌  Failed     : ' + failed);
  console.log('  ⚠️   Blocked    : ' + blocked);
  console.log('  ⏭️   Skipped    : ' + skipped);
  console.log('  Total        : ' + results.length);
  console.log('====================================================\n');

  console.log('ADO run ' + run.id + ' closed. View results in Test Plans.');

  if (failed > 0 || blocked > 0) process.exit(1);
}

main().catch(err => {
  console.error('\nFatal error:', err.message);
  console.error(err.stack);
  process.exit(1);
});
