# ADO AI Test Runner

Reads your ADO sprint test plan, runs each test automatically using Claude AI + Puppeteer, and writes results back to ADO — no pipeline access required.

## How it works

Each test case is classified into one of three paths:

| Path | Used for | How |
|------|----------|-----|
| **HTTP** | API tests (Brook Becker / Jose Murillo cases) | axios call + Claude evaluates response |
| **Puppeteer** | Studio / browser UI tests | Shared session + Claude agentic loop |
| **Skip** | VM desktop, screen reader, Datadog, external LMS | Marked `NotExecuted` in ADO |

## Quick start

### 1. Clone and install

```bash
git clone https://github.com/YOUR_ORG/ado-ai-test-runner
cd ado-ai-test-runner
npm install
npx puppeteer browsers install chrome
```

### 2. Configure environment

```bash
cp .env.example .env
# Fill in your values
```

### 3. Run locally

```bash
node index.js "Sprint 42" QA
```

## GitHub setup

### Create the repo

```bash
git init
git add .
git commit -m "Initial commit"
gh repo create ado-ai-test-runner --private
git push -u origin main
```

### Add secrets

Go to your repo → **Settings → Secrets and variables → Actions → New repository secret**

Add each value from `.env.example`:

| Secret | Value |
|--------|-------|
| `ADO_ORG` | your ADO org name |
| `ADO_PROJECT` | your ADO project name |
| `AUTH_MODE` | `pat` or `entra` |
| `ADO_PAT` | your PAT token |
| `APP_USERNAME` | test user email |
| `APP_PASSWORD` | test user password |
| `ANTHROPIC_API_KEY` | your Claude API key |

### Run from GitHub UI

1. Go to **Actions** tab
2. Click **ADO AI Test Runner** in the left sidebar
3. Click **Run workflow**
4. Enter sprint name and select environment
5. Click **Run workflow**

That's it — no pipeline access needed.

## Automatic trigger via ADO Service Hook (future upgrade)

When you get ADO Project Settings access, you can make this run automatically after every deployment without touching any pipeline YAML.

### Setup (5 minutes)

1. In ADO, go to **Project Settings → Service Hooks → + Create subscription**
2. Service: **Web Hooks**
3. Trigger: **Run stage state changed**
4. Filters: Stage state = `Succeeded`, Stage name = your deploy stage
5. URL: `https://api.github.com/repos/YOUR_ORG/ado-ai-test-runner/dispatches`
6. HTTP headers:
   ```
   Accept: application/vnd.github+json
   Authorization: Bearer YOUR_GITHUB_PAT
   X-GitHub-Api-Version: 2022-11-28
   ```
7. Body:
   ```json
   {
     "event_type": "run-tests",
     "client_payload": {
       "sprint_name": "Sprint 42",
       "environment": "QA"
     }
   }
   ```

The GitHub PAT needs `repo` scope. Generate it at **GitHub → Settings → Developer settings → Personal access tokens**.

## Project structure

```
ado-ai-test-runner/
├── src/
│   ├── adoClient.js          ADO REST API (read plan, write results)
│   ├── classifier.js         Routes each test to HTTP / Puppeteer / Skip
│   ├── sessionManager.js     Browser launch + single shared login
│   ├── httpExecutor.js       Runs API tests via axios
│   └── puppeteerExecutor.js  Agentic loop: Claude + Puppeteer
├── index.js                  Entry point / orchestrator
├── .github/workflows/
│   └── test-runner.yml       GitHub Actions workflow
└── .env.example              Environment variable template
```

## Troubleshooting

**Login fails**: Check `APP_USERNAME` and `APP_PASSWORD`. The session manager tries common login selector patterns. If your app has an unusual login flow, open `sessionManager.js` and update `_loginWithCredentials()`.

**Tests classified as Skip unexpectedly**: Open `classifier.js` and check if your test's keywords match the skip signals list. You can add keywords to `HTTP_SIGNALS` or `SKIP_SIGNALS` to tune the routing.

**Puppeteer can't find elements**: Claude picks CSS selectors based on what it sees in the screenshot. If an element is dynamically loaded, add a `wait` action to your test case's expected behavior, or increase `ACTION_TIMEOUT` in `puppeteerExecutor.js`.

**GitHub Actions fails with sandbox error**: Make sure `--no-sandbox` is in the Puppeteer launch args in `sessionManager.js`. It is by default — don't remove it.
