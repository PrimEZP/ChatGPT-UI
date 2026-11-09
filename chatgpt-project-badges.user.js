// ==UserScript==
// @name         ChatGPT — project badges on chats
// @namespace    local.chatgpt.projectbadges
// @version      1.0
// @description  Shows which project each ChatGPT conversation belongs to, inline in the sidebar, search results, and anywhere else a chat is linked.
// @homepageURL  https://github.com/PrimEZP/ChatGPT-UI
// @supportURL   https://github.com/PrimEZP/ChatGPT-UI/issues
// @downloadURL  https://raw.githubusercontent.com/PrimEZP/ChatGPT-UI/main/chatgpt-project-badges.user.js
// @updateURL    https://raw.githubusercontent.com/PrimEZP/ChatGPT-UI/main/chatgpt-project-badges.user.js
// @license      MIT
// @match        https://chatgpt.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const VERSION = '1.0';
  const CFG = {
    refreshMs: 5 * 60 * 1000,   // re-pull projects and their chats this often
    maxPagesPerProject: 25,     // cap on pages fetched per project
    concurrency: 4,             // projects fetched in parallel
    missGraceMs: 20 * 1000,     // min gap between "I saw an unknown project" refetches
    showUnfiled: false,         // set true to badge chats with no project too
    hideOnOwnProject: true,     // skip the badge when you're already looking at that project
    debug: false,               // set true for an on-page panel showing what was found
  };

  const state = {
    token: null,
    projects: new Map(),        // project id -> { name, color }
    convos: new Map(),          // conversation id -> project id
    loaded: false,              // true once a refresh has succeeded
    lastMiss: 0,
    loading: null,
    error: null,
    stats: {},
  };

  // ---------- styling ----------
  // Quiet pill tinted by the project's hue, so each project is recognisable at
  // a glance. ChatGPT sets its theme as data-theme on <html>, which can differ
  // from the OS setting, so dark styles key off that first.
  const DARK = `
      color: hsl(var(--cgb-h) 70% 75%);
      background: hsl(var(--cgb-h) 55% 60% / .18);
      border-color: hsl(var(--cgb-h) 55% 60% / .3);`;
  const style = document.createElement('style');
  style.id = 'cgb-style';
  style.textContent = `
    .cgb-badge {
      display: inline;
      flex: none;
      align-self: center;
      margin-right: .45em;
      padding: .1em .45em;
      border-radius: .4em;
      font-size: .72em;
      font-weight: 500;
      letter-spacing: .01em;
      white-space: nowrap;
      vertical-align: baseline;
      background: hsl(var(--cgb-h) 55% 50% / .16);
      color: hsl(var(--cgb-h) 60% 36%);
      border: 1px solid hsl(var(--cgb-h) 55% 50% / .25);
    }
    html[data-theme="dark"] .cgb-badge, html.dark .cgb-badge {${DARK}
    }
    @media (prefers-color-scheme: dark) {
      html:not([data-theme]):not(.light) .cgb-badge {${DARK}
      }
    }
    .cgb-badge--none { --cgb-h: 0; filter: saturate(0); opacity: .6; }
    #cgb-debug {
      position: fixed; right: 12px; bottom: 12px; z-index: 99999;
      max-width: 34em; max-height: 50vh; overflow: auto;
      padding: .75em .9em; border-radius: .5em;
      background: #111; color: #eee; border: 1px solid #444;
      font: 12px/1.5 ui-monospace, Menlo, Consolas, monospace;
      white-space: pre-wrap;
    }
  `;
  const ensureStyle = () => { if (!style.isConnected) document.head.appendChild(style); };
  ensureStyle();

  const hashHue = (s) => {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
    return h;
  };

  // ChatGPT lets you give a project a colour. When it comes back as a hex
  // value, use its hue so the badge matches the project icon.
  const hexHue = (hex) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return null;
    const n = parseInt(m[1], 16);
    const r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    if (d < 0.08) return null; // greys carry no usable hue
    let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return Math.round((h * 60 + 360) % 360);
  };

  // ---------- api ----------
  // The backend API wants the short-lived access token from the session
  // endpoint, not just cookies. Team and Enterprise workspaces also need the
  // workspace id, which the app keeps in the _account cookie.
  const getToken = async (force) => {
    if (state.token && !force) return state.token;
    const r = await fetch('/api/auth/session', { credentials: 'include' });
    if (!r.ok) throw new Error(`session → ${r.status}`);
    const s = await r.json();
    if (!s?.accessToken) throw new Error('not signed in');
    return (state.token = s.accessToken);
  };

  const workspaceId = () => {
    const m = document.cookie.match(/(?:^|;\s*)_account=([^;]+)/);
    const v = m && decodeURIComponent(m[1]);
    return v && /^[0-9a-f-]{36}$/i.test(v) ? v : null;
  };

  const api = async (path, retried = false) => {
    const headers = { accept: 'application/json', authorization: `Bearer ${await getToken()}` };
    const ws = workspaceId();
    if (ws) headers['chatgpt-account-id'] = ws;
    const r = await fetch(path, { credentials: 'include', headers });
    if (r.status === 401 && !retried) { state.token = null; return api(path, true); }
    if (!r.ok) throw new Error(`${path.split('?')[0]} → ${r.status}`);
    return r.json();
  };

  // Projects are "snorlax" gizmos internally. Accept a couple of nestings
  // because the response shape has shifted between releases.
  const loadProjects = async () => {
    const projects = new Map();
    let cursor = null;
    for (let page = 0; page < 20; page++) {
      // owned_only=false includes projects other people have shared with you.
      const q = new URLSearchParams({ conversations_per_gizmo: '0', limit: '20', owned_only: 'false' });
      if (cursor) q.set('cursor', cursor);
      const res = await api(`/backend-api/gizmos/snorlax/sidebar?${q}`);
      for (const it of res?.items || []) {
        const g = it?.gizmo?.gizmo || it?.gizmo || it;
        if (!g?.id) continue;
        const d = g.display || {};
        const name = d.name || g.name || 'Untitled project';
        projects.set(g.id, {
          name: d.emoji ? `${d.emoji} ${name}` : name,
          rawName: name,
          color: hexHue(d.theme?.hex || d.theme || d.profile_picture_color || d.color),
        });
      }
      cursor = res?.cursor;
      if (!cursor) break;
    }
    return projects;
  };

  const loadProjectConvos = async (pid, into) => {
    let cursor = '0';
    for (let page = 0; page < CFG.maxPagesPerProject; page++) {
      const res = await api(`/backend-api/gizmos/${pid}/conversations?cursor=${encodeURIComponent(cursor)}`);
      const items = res?.items || [];
      for (const c of items) if (c?.id) into.set(c.id, pid);
      cursor = res?.cursor;
      if (!items.length || cursor == null || cursor === '') break;
    }
  };

  const refresh = async () => {
    if (state.loading) return state.loading;
    state.loading = (async () => {
      try {
        const projects = await loadProjects();
        const convos = new Map();
        const queue = [...projects.keys()];
        const worker = async () => { while (queue.length) await loadProjectConvos(queue.shift(), convos); };
        await Promise.all(Array.from({ length: CFG.concurrency }, worker));
        // Swap in complete maps so a paint mid-load never sees a half-empty list.
        state.projects = projects;
        state.convos = convos;
        state.loaded = true;
        state.error = null;
        paint();
      } catch (e) {
        state.error = e.message;
        console.warn('[project badges] could not load project data:', e.message);
      } finally {
        state.loading = null;
        if (CFG.debug) showDebug();
      }
    })();
    return state.loading;
  };

  // ---------- reading links ----------
  const CONV = /\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
  // Project chats live at /g/g-p-<32 hex>-<name-slug>/c/<uuid>, so the URL
  // alone often says which project a chat belongs to.
  const PROJ = /\/g\/(g-p-[0-9a-f]{32})(?:-([^/?#]+))?/i;

  const unslug = (s) => {
    try { return decodeURIComponent(s).replace(/[-_]+/g, ' ').trim(); } catch { return null; }
  };

  // Returns { pid, name } for a project chat, { pid: null } for a confirmed
  // non-project chat, or null when we can't tell yet.
  const resolve = (href) => {
    const c = href.match(CONV);
    if (!c) return undefined;
    const conv = c[1].toLowerCase();
    const p = href.match(PROJ);
    const pid = p ? p[1].toLowerCase() : state.convos.get(conv);

    if (pid) {
      const proj = state.projects.get(pid);
      return {
        conv, pid,
        name: proj?.name || (p?.[2] && unslug(p[2])) || 'Project',
        rawName: proj?.rawName,
        color: proj?.color,
        newProject: !proj,
      };
    }

    // A plain /c/<id> link that isn't in any project's list is a chat outside
    // projects. New project chats are linked under /g/g-p-…, so the URL above
    // catches them without waiting for the next refresh.
    return state.loaded ? { conv, pid: null } : null;
  };

  // ---------- finding where the title sits ----------
  // ChatGPT puts the title first in every row: before the preview snippet on
  // project pages and in search, and before the date. So the title starts at
  // the first run of real text; the badge's own text is skipped.
  const firstTextNode = (root) => {
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) =>
        n.textContent.trim().length > 1 && !n.parentElement?.closest('.cgb-badge')
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT,
    });
    return walk.nextNode();
  };

  // Links usually wrap their own title. If one ever holds no text (an overlay
  // link stretched over the row), climb to the row and use the title there,
  // stopping before the climb reaches something that holds several chats.
  const titleText = (a) => {
    let el = a;
    for (let depth = 0; depth < 6 && el; depth++) {
      const text = firstTextNode(el);
      if (text) return text;
      el = el.parentElement;
      if (!el || el.querySelectorAll('a[href*="/c/"]').length > 1) return null;
    }
    return null;
  };

  // Where the badge goes: at the start of the element that holds the title
  // line. Climbing out of inline elements keeps it out of search-highlight
  // spans. Sidebar titles sit in a marquee that scrolls long titles on hover,
  // so the badge goes beside the marquee instead and stays put.
  const badgeSlot = (a) => {
    const text = titleText(a);
    if (!text) return null;
    const marquee = text.parentElement.closest('[data-thread-title]');
    if (marquee && a.contains(marquee)) return { parent: marquee.parentElement, before: marquee };
    let el = text.parentElement;
    while (el !== a && el.parentElement && getComputedStyle(el).display.startsWith('inline')) {
      el = el.parentElement;
    }
    return { parent: el, before: el.firstChild };
  };

  // Is this link in a list that's already about this one project? That's an
  // expanded project in the sidebar ("Chats in <name>"), or the chat list on
  // the project's own page.
  const insideOwnProject = (a, info) => {
    const list = a.closest('[role="list"][aria-label]');
    if (list && info.rawName && list.getAttribute('aria-label').includes(info.rawName)) return true;
    return currentProject() === info.pid && !!a.closest('main');
  };

  // ---------- painting ----------
  const badge = (info) => {
    const el = document.createElement('span');
    el.className = 'cgb-badge' + (info.pid ? '' : ' cgb-badge--none');
    el.textContent = info.pid ? info.name : 'no project';
    el.title = info.pid ? `Project: ${info.name}` : 'Not in a project';
    el.dataset.cgbKey = info.pid ? `${info.pid}|${info.name}` : '∅';
    if (info.pid) el.style.setProperty('--cgb-h', info.color ?? hashHue(info.name));
    return el;
  };

  const currentProject = () => (location.pathname.match(PROJ)?.[1] || '').toLowerCase();

  const paint = () => {
    ensureStyle();
    let sawNewProject = false;
    const stats = { links: 0, badged: 0, noTitle: 0, unknown: 0, skipped: 0 };

    for (const a of document.querySelectorAll('a[href*="/c/"]')) {
      const info = resolve(a.getAttribute('href') || '');
      if (info === undefined) continue;
      stats.links++;

      if (info === null) { stats.unknown++; continue; }
      if (info.newProject) sawNewProject = true;
      if (!info.pid && !CFG.showUnfiled) continue;

      const slot = badgeSlot(a);
      if (!slot) { stats.noTitle++; continue; }
      const existing = slot.parent.querySelector(':scope > .cgb-badge');

      if (CFG.hideOnOwnProject && info.pid && insideOwnProject(a, info)) {
        existing?.remove();
        stats.skipped++;
        continue;
      }

      // Check the badge itself rather than remembering we added one: the app
      // re-renders rows and throws our span away, and it has to come back.
      const key = info.pid ? `${info.pid}|${info.name}` : '∅';
      if (existing?.dataset.cgbKey === key) { stats.badged++; continue; }
      existing?.remove();
      slot.parent.insertBefore(badge(info), slot.before);
      stats.badged++;
    }

    state.stats = { ...stats, projects: state.projects.size, projectChats: state.convos.size };
    if (CFG.debug) showDebug();

    // A project we don't know yet was created after the last pull. Fetch its
    // name, but no more than once per grace period.
    if (sawNewProject && state.loaded && Date.now() - state.lastMiss > CFG.missGraceMs) {
      state.lastMiss = Date.now();
      refresh();
    }
  };

  // ---------- on-page diagnostics (no devtools needed) ----------
  let debugBox = null;
  const showDebug = () => {
    if (!debugBox?.isConnected) {
      debugBox = document.createElement('div');
      debugBox.id = 'cgb-debug';
      document.body.appendChild(debugBox);
    }
    const links = [...document.querySelectorAll('a[href*="/c/"]')];
    const sample = links.find((x) => !x.closest('nav')) || links[0];
    const chain = [];
    for (let el = sample, i = 0; i < 4 && el; i++, el = el.parentElement) {
      chain.push(`${i} <${el.tagName.toLowerCase()} class="${(el.className || '').toString().slice(0, 50)}">  text: ${JSON.stringify((el.textContent || '').trim().slice(0, 45))}`);
    }
    const text =
      `project badges v${VERSION}\n` +
      Object.entries({ ...state.stats, error: state.error, loading: !!state.loading })
        .map(([k, v]) => `${k}: ${v}`).join('\n') +
      `\n\nsample href: ${sample?.getAttribute('href') || '(none)'}\n` +
      chain.join('\n');
    // Only touch the box when the text changes; every write is a DOM mutation
    // that would otherwise wake the observer and repaint forever.
    if (debugBox.textContent !== text) debugBox.textContent = text;
  };

  // ---------- wiring ----------
  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; paint(); });
  };

  // Ignore mutations we caused ourselves (badges, the debug panel), so
  // painting doesn't trigger another paint.
  const ours = (n) => n.nodeType === 1 && (n.classList?.contains('cgb-badge') || n.id === 'cgb-debug');
  new MutationObserver((records) => {
    for (const r of records) {
      if (debugBox && debugBox.contains(r.target)) continue;
      if ([...r.addedNodes, ...r.removedNodes].every(ours)) continue;
      return schedule();
    }
  }).observe(document.body, { childList: true, subtree: true });

  window.addEventListener('focus', schedule);
  setInterval(refresh, CFG.refreshMs);

  refresh();
})();
