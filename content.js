// content.js — Isolated world, runs on linkedin.com
(function () {
  'use strict';

  const knownPostUrls = new Set();
  let activeOverlay   = null;
  let lastUrl         = location.href;

  const LOG = (...args) => console.log('[LinkedIn AI]', ...args);

  // ─── Init ──────────────────────────────────────────────────────────────

  function init() {
    LOG('Loaded on', location.pathname);

    // METHOD 1: Watch for navigation to a post page (most reliable)
    // When user clicks any notification and lands on a post, we trigger automatically
    watchUrlChanges();

    // If already on a post page when script loads
    if (isPostUrl(location.href)) {
      LOG('Already on a post page — triggering in 2s');
      setTimeout(() => onArrivedAtPost(location.href), 2000);
    }

    // METHOD 2: Intercept LinkedIn's fetch API (catches notifications before user clicks)
    window.addEventListener('message', onPageMessage);

    // METHOD 3: DOM scan on notifications page as last fallback
    if (location.pathname.startsWith('/notifications')) {
      startDomScanner();
    } else {
      watchBellBadge();
    }
  }

  // ─── METHOD 1: URL navigation watcher ─────────────────────────────────────────

  function watchUrlChanges() {
    // LinkedIn is a SPA — watch for URL changes via MutationObserver on the title
    // (title always changes on navigation, even without a page reload)
    new MutationObserver(() => {
      if (location.href !== lastUrl) {
        const prev = lastUrl;
        lastUrl = location.href;
        LOG('URL changed to', location.href);
        if (isPostUrl(location.href)) {
          LOG('Navigated to post page! Triggering engagement flow in 2s');
          setTimeout(() => onArrivedAtPost(location.href), 2000);
        }
      }
    }).observe(document.querySelector('title') || document.head, {
      subtree: true, characterData: true, childList: true,
    });
  }

  function onArrivedAtPost(postUrl) {
    const key = postUrl.split('?')[0];
    if (knownPostUrls.has(key)) return;
    knownPostUrls.add(key);

    const content = getPostContent();
    LOG('Post content read:', content.substring(0, 100));

    chrome.runtime.sendMessage({
      type:      'NEW_POST_NOTIFICATION',
      postUrl:   postUrl,
      notifText: content,
      notifId:   key,
    });
  }

  // ─── METHOD 2: API interception listener ──────────────────────────────────────

  function onPageMessage(event) {
    if (event.source !== window) return;
    if (event.data?.source !== 'linkedin-ai-ext') return;
    if (event.data.type !== 'NOTIF_API_DATA') return;
    LOG('API intercept caught URLs:', event.data.urls);
    event.data.urls.forEach((path) => {
      const fullUrl = path.startsWith('http') ? path : 'https://www.linkedin.com' + path.replace(/\\/g, '');
      const key = fullUrl.split('?')[0];
      if (knownPostUrls.has(key)) return;
      knownPostUrls.add(key);
      chrome.runtime.sendMessage({
        type: 'NEW_POST_NOTIFICATION', postUrl: fullUrl, notifText: '', notifId: key,
      });
    });
  }

  // ─── METHOD 3: DOM scanner (notifications page fallback) ─────────────────────

  function startDomScanner() {
    LOG('Starting DOM scanner on notifications page');
    scanDom();
    setInterval(scanDom, 3000);
    const obs = new MutationObserver(scanDom);
    const attach = () => obs.observe(document.querySelector('[role="main"]') || document.body, { childList: true, subtree: true });
    attach(); setTimeout(attach, 2000);
  }

  function scanDom() {
    const root  = document.querySelector('[role="main"]') || document.body;
    const links = [...root.querySelectorAll('a[href]')];
    const posts = links.filter(a => isPostUrl(a.href));
    if (posts.length) LOG('DOM found', posts.length, 'post links');
    else LOG('DOM scan: sample hrefs =', links.slice(0, 6).map(a => a.href));
    posts.forEach(a => {
      const card = a.closest('[role="listitem"],[role="article"],li,[data-urn]') || a.parentElement;
      const text = (card || a).innerText?.trim() || '';
      if (/daily rundown|newsletter|promoted/i.test(text)) return;
      const key = a.href.split('?')[0];
      if (knownPostUrls.has(key)) return;
      knownPostUrls.add(key);
      chrome.runtime.sendMessage({ type: 'NEW_POST_NOTIFICATION', postUrl: a.href, notifText: text.substring(0, 800), notifId: key });
    });
  }

  // ─── Bell badge watcher ────────────────────────────────────────────────────

  function watchBellBadge() {
    let wasShowing = false;
    function check() {
      const badge = document.querySelector('.notification-badge--show');
      if (badge && !wasShowing) {
        wasShowing = true;
        LOG('Bell badge appeared — opening background scan tab');
        chrome.runtime.sendMessage({ type: 'BELL_BADGE_CHANGED', count: 1 });
      } else if (!badge) { wasShowing = false; }
    }
    const nav = document.querySelector('.global-nav__primary-link-notif,[role="navigation"],header') || document.body;
    new MutationObserver(check).observe(nav, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    setInterval(check, 5000);
    check();
  }

  // ─── Post content reader ──────────────────────────────────────────────────────

  function getPostContent() {
    const main = document.querySelector('[role="main"]');
    if (!main) return document.body.innerText.substring(0, 2000);
    const spans = [...main.querySelectorAll('span[dir]')]
      .map(s => s.innerText.trim()).filter(t => t.length > 20);
    if (spans.length) return spans.slice(0, 6).join(' ').substring(0, 2000);
    return main.innerText.substring(0, 2000);
  }

  // ─── Like ───────────────────────────────────────────────────────────────────

  async function doLike() {
    const btn = document.querySelector('button[aria-label*="Like"][aria-pressed="false"],button[aria-label="Like"]');
    if (btn) { btn.click(); await sleep(400 + rand(300)); return true; }
    return false;
  }

  // ─── Comment ───────────────────────────────────────────────────────────────────

  async function doComment(text) {
    const openBtn = document.querySelector('button[aria-label*="comment" i]');
    if (openBtn) { openBtn.click(); await sleep(1000 + rand(500)); }
    const editor = document.querySelector('[contenteditable="true"][aria-label*="comment" i],[contenteditable="true"][aria-placeholder*="comment" i],.ql-editor[contenteditable="true"],[contenteditable="true"]');
    if (!editor) return false;
    editor.focus(); await sleep(200 + rand(200));
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);
    for (const ch of text) { document.execCommand('insertText', false, ch); await sleep(30 + rand(70)); }
    await sleep(600 + rand(600));
    const submit = document.querySelector('button[aria-label*="submit" i]:not([disabled]),button[type="submit"]:not([disabled])');
    if (submit) { submit.click(); await sleep(500); return true; }
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true, ctrlKey: true }));
    return true;
  }

  // ─── Overlay ────────────────────────────────────────────────────────────────────

  function showOverlay({ comment, requestId }) {
    removeOverlay();
    const div = document.createElement('div');
    div.id = 'lai-overlay';
    div.innerHTML = `
      <div class="lai-header">
        <span class="lai-logo">&#x1F4BC;</span>
        <span class="lai-title">AI Comment Ready</span>
        <button class="lai-x" data-action="skip">&#x2715;</button>
      </div>
      <textarea class="lai-textarea" id="lai-text">${esc(comment)}</textarea>
      <div class="lai-footer">
        <button class="lai-btn lai-approve" data-action="approve">&#x1F44D; Like &amp; Post</button>
        <button class="lai-btn lai-skip" data-action="skip">Skip</button>
      </div>
    `;
    document.body.appendChild(div);
    activeOverlay = div;
    div.addEventListener('click', async (e) => {
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (!action) return;
      if (action === 'approve') {
        const text = div.querySelector('#lai-text').value.trim();
        if (!text) return;
        removeOverlay();
        await doLike(); await sleep(600 + rand(400)); await doComment(text);
        chrome.runtime.sendMessage({ type: 'ENGAGEMENT_DONE', requestId });
      } else {
        removeOverlay();
        chrome.runtime.sendMessage({ type: 'ENGAGEMENT_SKIPPED', requestId });
      }
    });
  }

  function removeOverlay() { activeOverlay?.remove(); activeOverlay = null; }

  // ─── Message handler ───────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg.type) {
      case 'GET_POST_CONTENT': sendResponse({ content: getPostContent() }); break;
      case 'SHOW_OVERLAY':     showOverlay(msg); sendResponse({ ok: true }); break;
      case 'DO_ENGAGE':
        (async () => { await doLike(); await sleep(700 + rand(500)); await doComment(msg.comment); sendResponse({ ok: true }); })();
        return true;
      case 'REMOVE_OVERLAY': removeOverlay(); sendResponse({ ok: true }); break;
    }
  });

  // ─── Helpers ──────────────────────────────────────────────────────────────

  function isPostUrl(url) {
    return url && (url.includes('/posts/') || url.includes('ugcPost') ||
                   url.includes('/feed/update/') || url.includes('urn:li:activity'));
  }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  function rand(n)   { return Math.floor(Math.random() * n); }
  function esc(s)    { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  init();

})();
