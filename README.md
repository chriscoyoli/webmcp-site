# WebMCP on a live site

Source for the [WebMCP](https://developer.chrome.com/docs/ai/webmcp) work on [carmelvalleytechnologies.com](https://carmelvalleytechnologies.com). WebMCP is a proposed web standard that lets a site offer structured tools to browser agents.

For the plain-language write-up, test results, and technical feedback, see [How this site works with AI agents](https://carmelvalleytechnologies.com/webmcp.html).

## Tools

| Tool | What it does | Built with | Safeguard |
|---|---|---|---|
| `list_portfolio` | Returns the selected work from the homepage | Imperative API | `readOnlyHint` |
| `get_about` | Returns the short profile from the homepage | Imperative API | `readOnlyHint` |
| `draft_message` | Fills in the contact form on the homepage | Declarative API | No `toolautosubmit`, so a person presses Send |
| `draft_inquiry` | Fills in the sample form on `webmcp.html` | Imperative API | Checks its own input, and Send is turned off |

The rule behind all four: an agent can read public content and fill in a form, but only a person can send a message.

## Files

- `webmcp.js`: the imperative tools
- `index.html`: the homepage, including the declarative contact form
- `webmcp.html`: the write-up, with a sample form and buttons that run the tools
- `llms.txt`: a short guide to the site for agents
- `tests/webmcp-smoke.js`: browser test

Images and other site files are not included, so pages opened from this repo will show missing images.

## Run the test

The test needs Node.js, Playwright, and Chromium. It turns on WebMCP with a Chromium feature flag and serves the pages locally.

```
npm install playwright
npx playwright install chromium
node tests/webmcp-smoke.js
```

It checks the tools, their output against the homepage, Chrome's suggested size limits, and that nothing is ever sent.

## How this was built

I chose the use case and the safety rule, and reviewed the results. An AI coding agent wrote the code.
