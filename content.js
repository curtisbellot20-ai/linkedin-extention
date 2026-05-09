// content.js — Runs only on linkedin.com
(function () {
  'use strict';

  const knownPostUrls = new Set();
  let activeOverlay   = null;
  const isNotifPage   = window.location.pathname.startsWith('/notifications');

  const LOG = (...args) => console.log('[LinkedIn AI]', ...args);

  function init() {
    LOG('Content script loaded on', window.location.pathname);
    if (isNotifPage) {
      LOG('On notifications page — starting scanner');
      startNotificationScanning();
    } else {
      LOG('Not on notifications page — watching bell badge');
      watchBellBadge();
    }
  }

  // ─── Notification page scanning ──────────────────────────────────────────────

  function startNotificationScanning() {
    scanNotifications();
    setInterval(scanNotifications, 2000);

    const obs = new MutationObserver(() => scanNotifications());
    function attachObs() {
      const root = document.querySelector('[role="main"]') || document.body;
      LOG('Attaching MutationObserver to', root.tagName, root.getAttribute('role') || '');
      obs.observe(root, { childList: true, subtree: true });
    }
    attachObs();
    setTimeout(attachObs, 2000);
  }

  function scanNotifications() {
    const root = document.querySelector('[role="main"]') || document.body;

    // Collect candidate URLs from multiple attribute sources
    const candidates = [];

    // 1. Standard <a href> tags
    root.querySelectorAll('a[href]').forEach(a => {
      candidates.push({ url: a.href, el: a });
    });

    // 2. Elements with data-href (LinkedIn sometimes uses this)
    root.querySelectorAll('[data-href]').forEach(el => {
      const url = el.dataset.href;
      if (url) candidates.push({ url, el });
    });

    // Log all post-like URLs found (helps diagnose)
    const postCandidates = candidates.filter(c => isPostUrl(c.url));
    if (postCandidates.length > 0) {
      LOG('Found', postCandidates.length, 'post link(s) on page:',
        postCandidates.map(c => c.url.substring(0, 80)));
    } else {
      // Log ALL hrefs so we can see what's actually there
      const allHrefs = candidates.map(c => c.url).filter(u => u && !u.startsWith('javascript'));
      LOG('No post links found. All hrefs on page:', allHrefs.slice(0, 20));
    }

    postCandidates.forEach(({ url, el }) => {
      const postKey = url.split('?')[0];
      if (knownPostUrls.has(postKey)) return;

      const card =
        el.closest('[role="listitem"]') ||
        el.closest('[role="article"]')  ||
        el.closest('li')               ||
        el.closest('[data-urn]')        ||
        el.parentElement;

      const cardText = (card || el).innerText?.trim() || '';

      if (/daily rundown|weekly rundown|newsletter|promoted|advertisement/i.test(cardText)) {
        LOG('Skipping digest/promo notification');
        return;
      }

      knownPostUrls.add(postKey);
      LOG('Sending notification to background:', postKey);

      chrome.runtime.sendMessage({
        type:      'NEW_POST_NOTIFICATION',
        postUrl:   url,
        notifText: cardText.substring(0, 800),
        notifId:   postKey,
      });
    });
  }

  function isPostUrl(url) {
    if (!url) return false;
    return (
      url.includes('/posts/')           ||
      url.includes('ugcPost')           ||
      url.includes('/feed/update/')     ||
      url.includes('urn%3Ali%3Aactivity') ||
      url.includes('urn:li:activity')
    );
  }

  // ─── Bell badge watcher (non-notification pages) ───────────────────────────

  function watchBellBadge() {
    let lastCount = 0;
    function checkBadge() {
      const badge = document.querySelector(
        '.notification-badge__count, .nav-item__badge-count, [data-test-notification-count]'
      );
      const count = parseInt((badge?.textContent?.trim() || '0').replace(/[^0-9]/g, ''), 10);
      if (count > 0 && count !== lastCount) {
        lastCount = count;
        LOG('Bell badge changed to', count, '— opening background scan tab');
        chrome.runtime.sendMessage({ type: 'BELL_BADGE_CHANGED', count });
      }
    }
    const target = document.querySelector('[role="navigation"], header') || document.body;
    new MutationObserver(checkBadge).observe(target, { childList: true, subtree: true, characterData: true });
    setInterval(checkBadge, 5000);
    checkBadge();
  }

  // ─── Post content reader ───────────────────────────────────────────────────────

  function getPostContent() {
    const main = document.querySelector('[role="main"]');
    if (main) {
      const spans = main.querySelectorAll('span[dir="ltr"], span[dir="rtl"]');
      const texts = Array.from(spans).map(s => s.innerText.trim()).filter(t => t.length > 30);
      if (texts.length) return texts.slice(0, 5).join(' ').substring(0, 2000);
      return main.innerText.substring(0, 2000);
    }
    return '';
  }

  // ─── Like ───────────────────────────────────────────────────────────────────

  async function doLike() {
    const btn = document.querySelector(
      'button[aria-label*="Like"][aria-pressed="false"], button[aria-label="Like"], button[aria-label*="React"]'
    );
    if (btn) { btn.click(); await sleep(400 + rand(300)); return true; }
    return false;
  }

  // ─── Comment ───────────────────────────────────────────────────────────────────

  async function doComment(text) {
    const openBtn = document.querySelector('button[aria-label*="comment" i], button[aria-label*="Comment" i]');
    if (openBtn) { openBtn.click(); await sleep(1000 + rand(500)); }

    const editor = document.querySelector(
      '[contenteditable="true"][aria-label*="comment" i], ' +
      '[contenteditable="true"][aria-placeholder*="comment" i], ' +
      '.ql-editor[contenteditable="true"], ' +
      '[contenteditable="true"]'
    );
    if (!editor) return false;

    editor.focus();
    await sleep(200 + rand(200));
    document.execCommand('selectAll', false, null);
    document.execCommand('delete',    false, null);
    for (const ch of text) {
      document.execCommand('insertText', false, ch);
      await sleep(30 + rand(70));
    }
    await sleep(600 + rand(600));

    const submitBtn = document.querySelector(
      'button[aria-label*="submit" i]:not([disabled]), ' +
      'button[aria-label*="post comment" i]:not([disabled]), ' +
      'button[type="submit"]:not([disabled])'
    );
    if (submitBtn) { submitBtn.click(); await sleep(500); return true; }
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
        <button class="lai-btn lai-skip"    data-action="skip">Skip</button>
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
      case 'GET_POST_CONTENT':
        sendResponse({ content: getPostContent() });
        break;
      case 'SHOW_OVERLAY':
        showOverlay(msg); sendResponse({ ok: true });
        break;
      case 'DO_ENGAGE':
        (async () => {
          await doLike();
          await sleep(700 + rand(500));
          await doComment(msg.comment);
          sendResponse({ ok: true });
        })();
        return true;
      case 'REMOVE_OVERLAY':
        removeOverlay(); sendResponse({ ok: true });
        break;
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
