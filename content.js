// content.js — Runs only on linkedin.com
(function () {
  'use strict';

  const knownNotifIds = new Set();
  let activeOverlay = null;
  const isNotifPage = window.location.pathname.startsWith('/notifications');

  // ─── Entry point ──────────────────────────────────────────────────────────

  function init() {
    if (isNotifPage) {
      // On the notifications page: scan immediately and watch for new items
      waitForEl('main, [role="main"]', (el) => {
        scanNotifications();
        new MutationObserver(scanNotifications).observe(el, { childList: true, subtree: true });
      });
    } else {
      // On any other LinkedIn page: watch the bell badge count
      watchBellBadge();
    }
  }

  // ─── Bell badge watcher (all LinkedIn pages) ──────────────────────────────

  function watchBellBadge() {
    let lastCount = 0;

    function checkBadge() {
      const badge = document.querySelector(
        '.notification-badge__count, .nav-item__badge-count, [data-test-notification-count]'
      );
      const raw   = badge?.textContent?.trim().replace(/[^0-9]/g, '') || '0';
      const count = parseInt(raw, 10);

      if (count > 0 && count !== lastCount) {
        lastCount = count;
        // Tell background: new notifications exist — open a background scan tab
        chrome.runtime.sendMessage({ type: 'BELL_BADGE_CHANGED', count });
      }
    }

    waitForEl('header, #global-nav', (el) => {
      new MutationObserver(checkBadge).observe(el, {
        childList: true, subtree: true, characterData: true,
      });
      checkBadge();
    });
  }

  // ─── Notification page scanner ────────────────────────────────────────────

  function scanNotifications() {
    // LinkedIn uses several class/attribute patterns — cover them all
    const items = document.querySelectorAll(
      '[data-urn*="urn:li:notification"], .nt-card, .notification-item, ' +
      '.artdeco-list__item, [data-finite-scroll-hotspot-top] li'
    );

    items.forEach((item) => {
      // Build a stable ID for deduplication
      const urn     = item.dataset.urn || item.querySelector('[data-urn]')?.dataset.urn;
      const notifId = urn || hashEl(item);
      if (knownNotifIds.has(notifId)) return;

      // Only care about notifications that link to a post
      const link = item.querySelector(
        'a[href*="/posts/"], a[href*="ugcPost"], a[href*="/feed/update/"], a[href*="activity"]'
      );
      if (!link) return;

      // Only care about "X posted" or "X shared" style notifications
      const text = item.innerText || '';
      const isPostNotif = /posted|shared a post|shared an article|published/i.test(text);
      if (!isPostNotif) return;

      knownNotifIds.add(notifId);

      chrome.runtime.sendMessage({
        type:      'NEW_POST_NOTIFICATION',
        postUrl:   link.href,
        notifText: text.trim().substring(0, 800),
        notifId,
      });
    });
  }

  // ─── Post content reader (called when on an actual post page) ────────────

  function getPostContent() {
    const sels = [
      '.feed-shared-update-v2__description .break-words span[dir]',
      '.update-components-text .break-words span[dir]',
      '.feed-shared-text span[dir]',
      '.update-components-text span',
      '.feed-shared-update-v2__description',
      'article .break-words',
    ];
    for (const s of sels) {
      const el = document.querySelector(s);
      if (el?.innerText?.trim()) return el.innerText.trim().substring(0, 2000);
    }
    return document.querySelector('main')?.innerText?.substring(0, 2000) || '';
  }

  // ─── Engagement actions ───────────────────────────────────────────────────

  async function doLike() {
    const sels = [
      'button.react-button__trigger[aria-label*="Like"]',
      '.reactions-react-button button',
      'button[aria-label="Like"]',
      'button[data-control-name="like_toggle"]',
    ];
    for (const s of sels) {
      const btn = document.querySelector(s);
      if (!btn) continue;
      const alreadyLiked =
        btn.getAttribute('aria-pressed') === 'true' ||
        btn.classList.contains('--active');
      if (!alreadyLiked) {
        btn.click();
        await sleep(400 + rand(300));
      }
      return true;
    }
    return false;
  }

  async function doComment(text) {
    // Open the comment editor
    const openSels = [
      'button[aria-label*="comment" i]',
      'button.comment-button',
      '[data-control-name="comment"]',
    ];
    for (const s of openSels) {
      const btn = document.querySelector(s);
      if (btn) { btn.click(); await sleep(1000 + rand(500)); break; }
    }

    // Find the contenteditable box
    const editorSels = [
      '.ql-editor[contenteditable="true"]',
      '.comments-comment-box__editor [contenteditable="true"]',
      '[data-placeholder*="comment" i][contenteditable="true"]',
    ];
    let editor = null;
    for (const s of editorSels) { editor = document.querySelector(s); if (editor) break; }
    if (!editor) return false;

    editor.focus();
    await sleep(200 + rand(200));
    document.execCommand('selectAll', false, null);
    document.execCommand('delete',    false, null);

    // Type with human-like per-character delay
    for (const ch of text) {
      document.execCommand('insertText', false, ch);
      await sleep(30 + rand(70));
    }
    await sleep(600 + rand(600));

    // Submit
    const submitSels = [
      '.comments-comment-box__submit-button:not([disabled])',
      'button[data-control-name="submit_comment"]',
    ];
    for (const s of submitSels) {
      const btn = document.querySelector(s);
      if (btn) { btn.click(); await sleep(500); return true; }
    }
    // Fallback: Ctrl+Enter
    editor.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true, ctrlKey: true })
    );
    return true;
  }

  // ─── In-page overlay (supervised mode) ───────────────────────────────────

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

  // ─── Message handler ──────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg.type) {
      case 'GET_POST_CONTENT':
        sendResponse({ content: getPostContent() });
        break;
      case 'SHOW_OVERLAY':
        showOverlay(msg);
        sendResponse({ ok: true });
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
        removeOverlay();
        sendResponse({ ok: true });
        break;
    }
  });

  // ─── Helpers ──────────────────────────────────────────────────────────────

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  function rand(n)   { return Math.floor(Math.random() * n); }
  function esc(s)    {
    return String(s)
      .replace(/&/g,  '&amp;').replace(/</g, '&lt;')
      .replace(/>/g,  '&gt;').replace(/"/g,  '&quot;');
  }
  function hashEl(el) {
    return btoa(unescape(encodeURIComponent(
      el.textContent?.substring(0, 60) || String(Date.now())
    ))).slice(0, 16);
  }
  function waitForEl(selector, cb, maxWait = 15000) {
    const el = document.querySelector(selector);
    if (el) { cb(el); return; }
    const start = Date.now();
    const obs = new MutationObserver(() => {
      const found = document.querySelector(selector);
      if (found) { obs.disconnect(); cb(found); }
      else if (Date.now() - start > maxWait) obs.disconnect();
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  init();

})();
