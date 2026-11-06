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
  page.on('request', (request) => { if (request.method() === 'POST' && !request.url().includes('api.web3forms.com')) posts.push(request.url()); });
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
  // The personal email address stays off the page.
  assert.strictEqual(await page.locator('a[href^="mailto:"]').count(), 0);
  assert.ok(!(await page.content()).includes('coyoli.com'));

  // The real contact form is declarative: no toolautosubmit, so the agent fills it and a person sends it.
  const sends = [];
  let formServiceWorks = true;
  await page.route('https://api.web3forms.com/submit', async (route) => {
    sends.push(JSON.parse(route.request().postData()));
    if (!formServiceWorks) return route.abort();
    return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ success: true }) });
  });
  const contactForm = page.locator('#contact-form');
  assert.strictEqual(await contactForm.getAttribute('toolautosubmit'), null);
  assert.strictEqual(await page.locator('.fc-agent-note').isVisible(), false);
  const homeSchema = await page.evaluate(async () => JSON.parse((await document.modelContext.getTools()).find((tool) => tool.name === 'draft_message').inputSchema));
  assert.ok(homeSchema.properties.botcheck.description.includes('Leave this unchecked'));
  assert.ok(!('access_key' in homeSchema.properties));
  await page.evaluate(async () => {
    const tool = (await document.modelContext.getTools()).find((candidate) => candidate.name === 'draft_message');
    window.toolResult = 'pending';
    document.modelContext.executeTool(tool, JSON.stringify({ name: 'Agent Name', email: 'a@example.com', message: 'Hello' }))
      .then((value) => { window.toolResult = value; }, (error) => { window.toolResult = `error: ${error.message}`; });
  });
  await page.waitForFunction(() => document.getElementById('msg').value === 'Hello');
  assert.ok(await contactForm.evaluate((el) => el.matches(':tool-form-active')));
  assert.strictEqual(await page.locator('.fc-agent-note').isVisible(), true);
  await page.waitForTimeout(400);
  assert.strictEqual(sends.length, 0);

  // Failure: the visitor stays on the page, keeps their text, and is pointed to LinkedIn.
  formServiceWorks = false;
  await contactForm.locator('button[type=submit]').click();
  await page.waitForFunction(() => !document.getElementById('form-status').hidden);
  assert.ok((await page.textContent('#form-status')).includes('LinkedIn'));
  assert.strictEqual(await page.inputValue('#msg'), 'Hello');
  assert.ok(page.url().startsWith(base));

  // Success: the message goes out once and the form clears.
  formServiceWorks = true;
  await page.waitForFunction(() => !document.querySelector('#contact-form button[type=submit]').disabled);
  await contactForm.locator('button[type=submit]').click();
  await page.waitForFunction(() => document.getElementById('form-status').textContent.includes('was sent'));
  assert.strictEqual(sends[sends.length - 1].message, 'Hello');
  assert.strictEqual(await page.inputValue('#msg'), '');
  assert.ok((await page.evaluate(() => window.toolResult)).includes('"sent":false'));
  assert.strictEqual(await page.locator('a[href^="mailto:"]').count(), 0);

  // The explainer page has both sample forms.
  await page.goto(`${base}/webmcp.html`);
  assert.deepStrictEqual(await names(page), ['draft_inquiry', 'draft_message', 'get_about', 'list_portfolio']);

  // Chrome's suggested limits: names 30, tool descriptions 500, parameter descriptions 150.
  const budget = await page.evaluate(async () => (await document.modelContext.getTools()).map((tool) => ({
    name: tool.name, description: tool.description,
    params: Object.entries(JSON.parse(tool.inputSchema).properties).map(([key, value]) => [key, value.description || '']),
    annotations: tool.annotations
  })));
  for (const tool of budget) {
    assert.ok(tool.name.length <= 30 && tool.description.length <= 500, `${tool.name} is over budget`);
    tool.params.forEach(([key, text]) => assert.ok(key.length <= 30 && text.length <= 150, `${tool.name}.${key} is over budget`));
  }
  assert.ok(budget.filter((tool) => !tool.name.startsWith('draft_')).every((tool) => tool.annotations.readOnlyHint));

  // The declarative tool fills its sample form, and no toolautosubmit means it cannot submit.
  const declarative = page.locator('#declarative-demo');
  assert.strictEqual(await declarative.getAttribute('toolautosubmit'), null);
  assert.strictEqual(await page.locator('.decl-note').isVisible(), false);
  await page.waitForFunction(() => !document.getElementById('run-declarative').disabled);
  await page.click('#run-declarative');
  await page.waitForFunction(() => document.getElementById('decl-email').value === 'sample@example.com');
  assert.ok(await declarative.evaluate((el) => el.matches(':tool-form-active')));
  assert.strictEqual(await page.locator('.decl-note').isVisible(), true);
  await declarative.locator('button[type=submit]').click();
  assert.strictEqual(page.url().endsWith('/webmcp.html'), true);
  assert.deepStrictEqual(posts, []);
  await page.goto(`${base}/webmcp.html`);
  await page.waitForFunction(() => !document.getElementById('run-declarative').disabled);
  await page.click('#run-declarative');
  await page.waitForFunction(() => document.getElementById('decl-email').value === 'sample@example.com');
  await page.click('#clear-declarative');
  assert.strictEqual(await page.inputValue('#decl-email'), '');
  assert.strictEqual(await page.locator('.decl-note').isVisible(), false);
  await page.click('#run-declarative');
  await page.waitForFunction(() => document.getElementById('decl-email').value === 'sample@example.com');
  assert.strictEqual(await page.locator('.decl-note').isVisible(), true);
  assert.deepStrictEqual(posts, []);

  // The imperative sample form uses the draft tool and cannot send.
  await page.goto(`${base}/webmcp.html`);

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
