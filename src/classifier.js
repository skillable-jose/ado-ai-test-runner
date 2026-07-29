// src/classifier.js
// Routes each test case to one of three execution paths:
//   'http'       → pure REST API call + Claude evaluates response
//   'puppeteer'  → real browser + Claude agentic loop
//   'skip'       → untestable automatically, mark NotExecuted in ADO

// Signals that a test is a pure API call — no browser needed
const HTTP_SIGNALS = [
  'make a call to',
  'api/v3/',
  'api/v4/',
  'GET /',
  'POST /',
  'PATCH /',
  'DELETE /',
  'PUT /',
  'in postman',
  'swagger',
  '/labseries',
  '/labprofile',
  '/labinstance',
  '/catalog',
  '/details?labinstanceid',
  '/stats',
  'labinstance/search',
  'passwordresetaudit/search',
  'billing/contracts',
  'billing/customers',
  'billing/records',
  'billing/events',
  '/v4/labinstances',
  '/v4/labprofiles',
  'getlabinstructions',
  'getevaluationresponses'
];

// Signals that a test requires infrastructure we can't automate
const SKIP_SIGNALS = [
  // VM desktop / RDP — inside a canvas, no tool can reach it
  'create txt on desktop',
  'create a new file on the desktop',
  'log into vm',
  'virtual keyboard',
  'rdp recording',
  'snapshot',
  'lightning bolt',
  'switching vms',
  'switch to 2nd vm',
  'switch to the second vm',
  'vm connects',
  'typetext functionality',
  'save/resume',
  'vm loads',
  'vm connectivity',

  // Screen reader / accessibility testing — requires real JAWS/NVDA
  'jaws',
  'nvda',
  'narrator',
  'screen reader',
  'screen reader should',

  // External portals — we can't authenticate into these
  'datadog',
  'azure portal',
  'app insights',
  'microsoft azure',
  'log explorer | datadog',

  // Datacenter / infrastructure ops
  'datacenter',
  'fileshare',
  'diff disk',
  'life cycle action',
  'ssh session',
  'hub and spoke',
  'dc to',
  'to dc',

  // Third-party LMS / external systems
  'canvas at dashboard',
  'learningmanager.adobe.com',
  'cengage',
  'lti 1.3 monitoring',

  // DevTools Console scripting — requires human typing in browser console
  'devtools console',
  'console, type:',
  'postmessage(',
  'register a listener'
];

// Area paths where the whole suite is untestable via browser automation
const SKIP_AREA_PATHS = [
  'Quality Assurance',   // VM/RDP heavy
  'Infra Dev'            // datacenter level ops
];

function classifyTestCase(testCase) {
  const fields   = testCase.fields || {};
  const title    = (fields['System.Title'] || '').toLowerCase();
  const areaPath = (fields['System.AreaPath'] || '');
  const steps    = extractStepsText(fields['Microsoft.VSTS.TCM.Steps'] || '');
  const allText  = (title + ' ' + steps).toLowerCase();

  // 1. Area path check (fastest, no text scanning needed)
  if (SKIP_AREA_PATHS.some(ap => areaPath.includes(ap))) {
    return 'skip';
  }

  // 2. HTTP signals — must check before skip to avoid false negatives
  //    (some API tests mention "VM" in passing)
  if (HTTP_SIGNALS.some(signal => allText.includes(signal.toLowerCase()))) {
    return 'http';
  }

  // 3. Skip signals
  if (SKIP_SIGNALS.some(signal => allText.includes(signal.toLowerCase()))) {
    return 'skip';
  }

  // 4. Has a navigable Studio / admin URL → Puppeteer
  const hasStudioUrl = allText.includes('admin.qa.skillable.com') ||
                       allText.includes('admin.uat.skillable.com') ||
                       allText.includes('studio.qa.skillable.com') ||
                       allText.includes('studio.uat.skillable.com') ||
                       allText.includes('insights.') ||
                       allText.includes('skillable.com') ||
                       allText.includes('labondemand.com');

  if (hasStudioUrl) return 'puppeteer';

  // 5. Default — when in doubt, don't risk breaking the session
  return 'skip';
}

// Extract raw text from ADO XML step format without full xml2js parse
function extractStepsText(xml) {
  if (!xml) return '';
  return xml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

module.exports = { classifyTestCase };
