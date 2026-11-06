// Browser test for webmcp.js. Run from the repo root: node tests/webmcp-smoke.js
// Needs Playwright with Chromium. WebMCP is enabled with a Chromium feature flag.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg' };
const server = http.createServer((req, res) => {
  const name = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(ROOT, name === '/' ? 'index.html' : name);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.statusCode = 404;
    return res.end();
  }
  res.setHeader('content-type', TYPES[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});

const call = (page, name, input) => page.evaluate(async ([toolName, json]) => {
  const tools = await document.modelContext.getTools();
  const tool = tools.find((candidate) => candidate.name === toolName);
  return JSON.parse(await document.modelContext.executeTool(tool, json));
}, [name, JSON.stringify(input)]);

const names = (page) => page.evaluate(async () =>
  (await document.modelContext.getTools()).map((tool) => tool.name).sort());

(async () => {
  await new Promise((resolve) => server.listen(0, 'localhost', resolve));
  const base = `http://localhost:${server.address().port}`;

  // Without WebMCP the site should behave normally and raise no errors.
  const plain = await chromium.launch();
  const plainPage = await plain.newPage();
  const plainErrors = [];
  plainPage.on('pageerror', (error) => plainErrors.push(error.message));
  await plainPage.goto(`${base}/index.html`);
  await plainPage.waitForFunction(() => document.readyState === 'complete');
  assert.strictEqual(await plainPage.evaluate(() => 'modelContext' in document), false);
  assert.deepStrictEqual(plainErrors, []);
  await plain.close();

  const browser = await chromium.launch({ args: ['--enable-features=WebMCPTesting'] });
  const page = await browser.newPage();
  const errors = [];
  const posts = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => { if (request.method() === 'POST') posts.push(request.url()); });
  await page.goto(`${base}/index.html`);

  // Imperative read tools plus the declarative contact form.
  assert.deepStrictEqual(await names(page), ['draft_message', 'get_about', 'list_portfolio']);

  const portfolio = await call(page, 'list_portfolio', {});
  const cards = await page.locator('#work .work-card').count();
  assert.strictEqual(cards, 5);
  assert.strictEqual(portfolio.projects.length, cards);
  assert.ok(portfolio.projects.every((project) => project.title && project.type && project.description));

  const about = await call(page, 'get_about', {});
  assert.strictEqual(about.name, 'Chris Coyoli');
  assert.strictEqual(about.title, 'Founder and Principal, AI Systems and Automation');
  assert.strictEqual(about.location, 'San Francisco Bay Area');
  assert.strictEqual(about.bio.length, 2);
  assert.strictEqual(about.linkedin, 'https://www.linkedin.com/in/chriscoyoli/');
  assert.ok(!JSON.stringify(about).includes('@'));

  // Chrome's suggested limits: names 30, tool descriptions 500, parameter descriptions 150, output 1,500.
  assert.ok(JSON.stringify(portfolio).length <= 1500, 'list_portfolio output is over budget');
  assert.ok(JSON.stringify(about).length <= 1500, 'get_about output is over budget');
  const budget = await page.evaluate(async () => (await document.modelContext.getTools()).map((tool) => ({
    name: tool.name, description: tool.description,
    params: Object.entries(JSON.parse(tool.inputSchema).properties).map(([key, value]) => [key, value.description || '']),
    annotations: tool.annotations
  })));
  for (const tool of budget) {
    assert.ok(tool.name.length <= 30 && tool.description.length <= 500, `${tool.name} is over budget`);
    tool.params.forEach(([key, text]) => assert.ok(key.length <= 30 && text.length <= 150, `${tool.name}.${key} is over budget`));
  }
  assert.ok(budget.filter((tool) => tool.name !== 'draft_message').every((tool) => tool.annotations.readOnlyHint));

  // The honeypot is exposed by the browser, so it tells agents to leave it empty.
  const draftSchema = budget.find((tool) => tool.name === 'draft_message');
  assert.ok(draftSchema.params.find(([key]) => key === '_honey')[1].includes('Leave this empty'));

  // The personal email address stays off the page.
  assert.strictEqual(await page.locator('a[href^="mailto:"]').count(), 0);
  assert.ok(!(await page.content()).includes('coyoli.com'));

  // The real contact form is declarative: no toolautosubmit, so the agent fills it and a person sends it.
  const form = page.locator('#contact form');
  assert.strictEqual(await form.getAttribute('toolautosubmit'), null);
  assert.strictEqual(await page.locator('.fc-agent-note').isVisible(), false);
  await page.evaluate(async () => {
    const tool = (await document.modelContext.getTools()).find((candidate) => candidate.name === 'draft_message');
    document.modelContext.executeTool(tool, JSON.stringify({ name: 'Agent Name', email: 'a@example.com', message: 'Hello' })).catch(() => {});
  });
  await page.waitForFunction(() => document.getElementById('msg').value === 'Hello');
  assert.strictEqual(await page.inputValue('#email'), 'a@example.com');
  assert.ok(await form.evaluate((el) => el.matches(':tool-form-active')));
  assert.strictEqual(await page.locator('.fc-agent-note').isVisible(), true);
  await page.waitForTimeout(500);
  assert.deepStrictEqual(posts, []);

  // The explainer page's sample form uses the draft tool and cannot send.
  await page.goto(`${base}/webmcp.html`);
  assert.deepStrictEqual(await names(page), ['draft_inquiry', 'get_about', 'list_portfolio']);

  // Invalid input is rejected by the tool, because the browser lets it through.
  let result = await call(page, 'draft_inquiry', { wrong: 5 });
  assert.deepStrictEqual([result.drafted, result.sent], [false, false]);
  result = await call(page, 'draft_inquiry', { message: 'Hi', email: 'not-an-email' });
  assert.strictEqual(result.drafted, false);
  result = await call(page, 'draft_inquiry', { message: 5 });
  assert.strictEqual(result.drafted, false);
  result = await call(page, 'draft_inquiry', { message: 'x'.repeat(2001) });
  assert.strictEqual(result.drafted, false);
  assert.strictEqual(await page.inputValue('#demo-msg'), '');

  // A visitor's text is kept, markup stays plain text, and nothing is sent.
  await page.fill('#demo-name', 'Typed By Visitor');
  const markup = '<img src=x onerror=alert(1)> Hello';
  result = await call(page, 'draft_inquiry', { name: 'Agent Name', email: 'a@example.com', message: markup });
  assert.strictEqual(result.drafted, true);
  assert.strictEqual(result.sent, false);
  assert.deepStrictEqual(result.keptVisitorText, ['name']);
  assert.strictEqual(await page.inputValue('#demo-name'), 'Typed By Visitor');
  assert.strictEqual(await page.inputValue('#demo-email'), 'a@example.com');
  assert.strictEqual(await page.inputValue('#demo-msg'), markup);
  assert.strictEqual(await page.locator('.fc-agent-note').count(), 1);
  assert.strictEqual(await page.locator('form[data-webmcp-demo] img').count(), 0);
  await page.waitForTimeout(300);
  assert.deepStrictEqual(posts, []);

  // The page's own buttons run the same tools.
  await page.goto(`${base}/webmcp.html`);
  await page.waitForFunction(() => document.getElementById('status').classList.contains('on'));
  await page.click('text=Show the selected work');
  await page.waitForFunction(() => document.getElementById('output').textContent.includes('Bookings'));
  await page.click('text=Show about Chris');
  await page.waitForFunction(() => document.getElementById('output').textContent.includes('linkedin.com'));
  await page.click('#run-draft');
  await page.waitForSelector('form[data-webmcp-demo] .fc-agent-note');
  assert.strictEqual(await page.inputValue('#demo-email'), 'sample@example.com');
  assert.strictEqual(await page.locator('form[data-webmcp-demo] button[type=submit]').isDisabled(), true);
  await page.click('#clear-draft');
  assert.strictEqual(await page.inputValue('#demo-email'), '');
  assert.strictEqual(await page.locator('form[data-webmcp-demo] .fc-agent-note').count(), 0);
  await page.waitForTimeout(300);
  assert.deepStrictEqual(posts, []);
  assert.deepStrictEqual(errors, []);

  // Simulate newer Chrome, where executeTool takes an object and rejects a string.
  const newer = await browser.newPage();
  await newer.addInitScript(() => {
    const original = ModelContext.prototype.executeTool;
    ModelContext.prototype.executeTool = async function (tool, input) {
      if (typeof input === 'string') {
        throw new TypeError("Failed to execute 'executeTool' on 'ModelContext': invalid input object: value is not an object");
      }
      return JSON.parse(await original.call(this, tool, JSON.stringify(input)));
    };
  });
  await newer.goto(`${base}/webmcp.html`);
  await newer.waitForFunction(() => document.getElementById('status').classList.contains('on'));
  await newer.click('text=Show the selected work');
  await newer.waitForFunction(() => document.getElementById('output').textContent.includes('Bookings'));
  await newer.click('#run-draft');
  await newer.waitForSelector('form[data-webmcp-demo] .fc-agent-note');
  assert.strictEqual(await newer.inputValue('#demo-email'), 'sample@example.com');

  await browser.close();
  server.close();
  console.log('All WebMCP checks passed.');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
