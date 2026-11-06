/*
  WebMCP tools for carmelvalleytechnologies.com.

  WebMCP is a proposed web standard that lets a page offer named tools to an AI
  agent in the browser. It is experimental, so this file does nothing unless the
  browser exposes document.modelContext.

  The safety rule: an agent can read public site content and fill in a form. Only
  the visitor can send it. No tool here submits a form.

  This file holds the imperative tools. The declarative tool, draft_message, is set
  up with toolname and tooldescription attributes on the homepage contact form and
  on a sample form in webmcp.html.

  Read tools pull from the homepage markup, so the answers cannot drift from what
  the site shows. Chrome does not validate input against inputSchema before it
  calls execute, so draft_inquiry validates its own input.
*/
(function () {
  'use strict';
  if (!('modelContext' in document)) return;

  var modelContext = document.modelContext;

  function text(root, selector) {
    var el = root.querySelector(selector);
    return el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
  }

  function homepage() {
    if (document.getElementById('work')) return Promise.resolve(document);
    return fetch('index.html').then(function (response) {
      if (!response.ok) throw new Error('Could not load the homepage (' + response.status + ')');
      return response.text();
    }).then(function (html) {
      return new DOMParser().parseFromString(html, 'text/html');
    });
  }

  function register(tool) {
    modelContext.registerTool(tool).catch(function (error) {
      console.warn('WebMCP: could not register ' + tool.name + ': ' + error.name);
    });
  }

  register({
    name: 'list_portfolio',
    title: 'List selected work',
    description: 'Lists selected work by Chris Coyoli, with the type of project and a short description of each. Use when someone asks what he has built.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    execute: function () {
      return homepage().then(function (home) {
        var projects = Array.prototype.map.call(home.querySelectorAll('#work .work-card'), function (card) {
          return { title: text(card, '.ttl'), type: text(card, '.tag'), description: text(card, '.dsc') };
        });
        return { projects: projects };
      });
    }
  });

  register({
    name: 'get_about',
    title: 'About Chris Coyoli',
    description: 'Returns the short profile shown on the homepage for Chris Coyoli: title, location, background, and where to reach him. Use when someone asks who runs this site.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    execute: function () {
      return homepage().then(function (home) {
        var linkedin = home.querySelector('#contact a[href*="linkedin.com"]');
        return {
          name: text(home, '#about .nm'),
          title: text(home, '[data-about="title"]'),
          location: text(home, '#contact [data-about="location"]'),
          bio: Array.prototype.map.call(home.querySelectorAll('#about .bio'), function (el) {
            return el.textContent.replace(/\s+/g, ' ').trim();
          }),
          previously: Array.prototype.map.call(home.querySelectorAll('#about .prev-cos span'), function (el) {
            return el.textContent.trim();
          }),
          linkedin: linkedin ? linkedin.getAttribute('href') : ''
        };
      });
    }
  });

  // The explainer page's sample form uses an imperative tool, so the page can show
  // each step. That form has no way to send anything.
  var form = document.querySelector('form[data-webmcp-demo]');
  if (!form) return;

  var LIMITS = { name: 120, email: 254, organization: 160, message: 2000 };
  var EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function clean(value, limit) {
    if (value === undefined || value === null) return { value: '' };
    if (typeof value !== 'string') return { error: 'must be text' };
    var cleaned = value.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '').trim();
    if (cleaned.length > limit) return { error: 'must be ' + limit + ' characters or fewer' };
    return { value: cleaned };
  }

  function showNotice() {
    var notice = form.querySelector('.fc-agent-note');
    if (!notice) {
      notice = document.createElement('p');
      notice.className = 'fc-agent-note';
      notice.setAttribute('role', 'status');
      form.querySelector('button[type="submit"]').insertAdjacentElement('beforebegin', notice);
    }
    notice.textContent = 'An AI agent drafted this. Nothing was sent. On the real contact form, you would review it and decide whether to press Send.';
  }

  register({
    name: 'draft_inquiry',
    title: 'Draft a sample message',
    description: 'Fills in the sample form on this page so the visitor can review it. Fields the visitor already typed are kept. Use when someone wants to try a draft.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the person sending the inquiry' },
        email: { type: 'string', description: 'Email address for the reply' },
        organization: { type: 'string', description: 'Company or organization' },
        message: { type: 'string', description: 'The message' }
      },
      required: ['message']
    },
    execute: function (input) {
      var args = input && typeof input === 'object' ? input : {};
      var values = {};
      var problems = [];

      Object.keys(LIMITS).forEach(function (field) {
        var result = clean(args[field], LIMITS[field]);
        if (result.error) problems.push(field + ' ' + result.error);
        else values[field] = result.value;
      });
      if (!problems.length && !values.message) problems.push('message is required');
      if (values.email && !EMAIL.test(values.email)) problems.push('email is not a valid address');
      if (problems.length) return { drafted: false, sent: false, problems: problems };

      var filled = [];
      var kept = [];
      Object.keys(LIMITS).forEach(function (field) {
        var control = form.elements[field];
        if (!control || !values[field]) return;
        if (control.value.trim() && control.value.trim() !== values[field]) {
          kept.push(field);
          return;
        }
        control.value = values[field];
        control.dispatchEvent(new Event('input', { bubbles: true }));
        filled.push(field);
      });

      showNotice();
      var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      form.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
      var firstMissing = Array.prototype.find.call(form.querySelectorAll('[required]'), function (control) {
        return !control.value.trim();
      });
      var submit = form.querySelector('button[type="submit"]');
      var target = firstMissing || (submit.disabled ? form.elements.message : submit);
      target.focus({ preventScroll: true });

      return {
        drafted: true,
        sent: false,
        filled: filled,
        keptVisitorText: kept,
        next: 'This is a sample form, so nothing can be sent. The visitor can review it or clear it.'
      };
    }
  });
})();
