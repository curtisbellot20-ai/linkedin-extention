// content.js — Isolated world, runs on linkedin.com
(function () {
  'use strict';

  const knownPostUrls = new Set();
  let activeOverlay   = null;
  const isNotifPage   = window.location.pathname.startsWith('/notifications');

  const LOG = (...args) => console.log('[LinkedIn AI]', ...args);

  // ─── Init ─────────────────────────────────────────────────────────────────

  function init() {
    LOG('Content script loaded on', window.location.pathname);

    // Primary method: listen for data from page_inject.js (API interception)
    window.addEventListener('message', onPageMessage);
    LOG('Listening for LinkedIn API interception messages');

    // Secondary method: DOM scan as fallback (runs on notifications page)
    if (isNotifPage) {
      LOG('Also running DOM scanner as fallback');
      startDomScanner();
    } else {
      watchBellBadge();
    }
  }

  // ─── Primary: API interception listener ─────────────────────────────────────

  function onPageMessage(event) {
    if (event.source !== window) return;
    if (event.data?.source !== 'linkedin-ai-ext') return;

    if (event.data.type === 'NOTIF_API_DATA') {
      LOG('API intercept caught notification data. URLs:', event.data.urls);
      event.data.urls.forEach((path) => {
        let fullUrl = path.startsWith('http') ? path : 'https://www.linkedin.com' + path;
        fullUrl = fullUrl.replace(/\\/g, ''); // unescape any JSON backslashes
        processNotifUrl(fullUrl, '');
      });
    }
  }

  // ─── Secondary: DOM scanner fallback ───────────────────────────────────────────

  function startDomScanner() {
    scanDom();
    setInterval(scanDom, 3000);
    const obs = new MutationObserver(scanDom);
    const attach = () => {
      const root = document.querySelector('[role="main"]') || document.body;
      obs.observe(root, { childList: true, subtree: true });
    };
    attach();
    setTimeout(attach, 2000);
  }

  function scanDom() {
    const root  = document.querySelector('[role="main"]') || document.body;
    const links = [...root.querySelectorAll('a[href]'), ...root.querySelectorAll('[data-href]')];
    const all   = links.map(el => ({ url: el.href || el.dataset.href || '', el }));
    const posts = all.filter(c => isPostUrl(c.url));

    if (posts.length) {
      LOG('DOM scanner found', posts.length, 'post link(s)');
    } else {
      LOG('DOM scanner: no post links yet. Sample hrefs:', all.slice(0, 8).map(c => c.url));
    }

    posts.forEach(({ url, el }) => {
      const card = el.closest('[role="listitem"]') || el.closest('[role="article"]') ||
                   el.closest('li') || el.closest('[data-urn]') || el.parentElement;
      const text = (card || el).innerText?.trim() || '';
      if (/daily rundown|weekly rundown|newsletter|promoted/i.test(text)) return;
      processNotifUrl(url, text);
    });
  }

  // ─── Shared: process a discovered post URL ─────────────────────────────────────

  function processNotifUrl(url, notifText) {
    const key = url.split('?')[0];
    if (knownPostUrls.has(key)) return;
    knownPostUrls.add(key);
    LOG('New post notification → background:', key);
    chrome.runtime.sendMessage({
      type:      'NEW_POST_NOTIFICATION',
      postUrl:   url,
      notifText: notifText.substring(0, 800),
      notifId:   key,
    });
  }

  function isPostUrl(url) {
    if (!url) return false;
    return url.includes('/posts/') || url.includes('ugcPost') ||
           url.includes('/feed/update/') || url.includes('urn%3Ali%3Aactivity') ||
           url.includes('urn:li:activity');
  }

  // ─── Bell badge watcher (non-notification pages) ───────────────────────────

  function watchBellBadge() {
    let wasShowing = false;
    function check() {
      // .notification-badge--show confirmed from DOM inspection
      const badge = document.querySelector('.notification-badge--show');
      if (badge && !wasShowing) {
        wasShowing = true;
        LOG('Bell badge appeared — opening background scan');
        chrome.runtime.sendMessage({ type: 'BELL_BADGE_CHANGED', count: 1 });
      } else if (!badge) {
        wasShowing = false;
      }
    }
    const nav = document.querySelector('.global-nav__primary-link-notif, [role="navigation"], header') || document.body;
    new MutationObserver(check).observe(nav, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    setInterval(check, 5000);
    check();
  }

  // ─── Post content reader ───────────────────────────────────────────────────────

  function getPostContent() {
    const main = document.querySelector('[role="main"]');
    if (main) {
      const spans = [...main.querySelectorAll('span[dir="ltr"],span[dir="rtl"]')]
        .map(s => s.innerText.trim()).filter(t => t.length > 30);
      if (spans.length) return spans.slice(0, 5).join(' ').substring(0, 2000);
      return main.innerText.substring(0, 2000);
    }
    return '';
  }

  // ─── Like ───────────────────────────────────────────────────────────────────

  async function doLike() {
    const btn = document.querySelector(
      'button[aria-label*="Like"][aria-pressed="false"], button[aria-label="Like"]'
    );
    if (btn) { btn.click(); await sleep(400 + rand(300)); return true; }
    return false;
  }

  // ─── Comment ───────────────────────────────────────────────────────────────────

  async function doComment(text) {
    const openBtn = document.querySelector('button[aria-label*="comment" i]');
    if (openBtn) { openBtn.click(); await sleep(1000 + rand(500)); }

    const editor = document.querySelector(
      '[contenteditable="true"][aria-label*="comment" i], ' +
      '[contenteditable="true"][aria-placeholder*="comment" i], ' +
      '.ql-editor[contenteditable="true"], [contenteditable="true"]'
    );
    if (!editor) return false;

    editor.focus();
    await sleep(200 + rand(200));
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);
    for (const ch of text) {
      document.execCommand('insertText', false, ch);
      await sleep(30 + rand(70));
    }
    await sleep(600 + rand(600));

    const submit = document.querySelector(
      'button[aria-label*="submit" i]:not([disabled]), button[type="submit"]:not([disabled])'
    );
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
        await doLike();
        await sleep(600 + rand(400));
        await doComment(text);
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
        (async () => {
          await doLike();
          await sleep(700 + rand(500));
          await doComment(msg.comment);
          sendResponse({ ok: true });
        })();
        return true;
      case 'REMOVE_OVERLAY': removeOverlay(); sendResponse({ ok: true }); break;
    }
  });

  // ─── Helpers ──────────────────────────────────────────────────────────────

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  function rand(n)   { return Math.floor(Math.random() * n); }
  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  init();

})();
