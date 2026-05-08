// content.js — Runs only on linkedin.com
(function () {
  'use strict';

  const knownNotifIds = new Set();
  let activeOverlay = null;

  // ─── Notification Detection ───────────────────────────────────────────────

  function initNotificationWatcher() {
    if (window.location.pathname.startsWith('/notifications')) {
      waitForEl(
        '.scaffold-finite-scroll__content, [data-finite-scroll-hotspot-top], main',
        (el) => {
          scanNotifications();
          new MutationObserver(scanNotifications).observe(el, { childList: true, subtree: true });
        }
      );
    } else {
      // Watch notification bell badge on all LinkedIn pages
      watchBellBadge();
    }
  }

  function scanNotifications() {
    const items = document.querySelectorAll(
      '[data-urn*="urn:li:notification"], .nt-card, .notification-item, .artdeco-list__item'
    );

    items.forEach((item) => {
      const urn =
        item.dataset.urn ||
        item.querySelector('[data-urn]')?.dataset.urn ||
        item.id ||
        null;

      const notifId = urn || hashEl(item);
      if (knownNotifIds.has(notifId)) return;

      // Only care about post-related notifications
      const link = item.querySelector(
        'a[href*="/posts/"], a[href*="ugcPost"], a[href*="/feed/update/"], a[href*="activity"]'
      );
      if (!link) return;

      knownNotifIds.add(notifId);

      const textEl = item.querySelector('.nt-card__text, .notification-card__text, p, span');
      const notifText = textEl?.innerText?.trim()?.substring(0, 800) || '';

      chrome.runtime.sendMessage({
        type: 'NEW_POST_NOTIFICATION',
        postUrl: link.href,
        notifText,
        notifId,
      });
    });
  }

  function watchBellBadge() {
    let lastCount = 0;

    function checkBadge() {
      const badge = document.querySelector(
        '.notification-badge__count, [data-test-notification-count], .nav-item__badge-count'
      );
      const count = parseInt(badge?.textContent?.trim() || '0', 10);
      if (count > lastCount) {
        lastCount = count;
        // Navigate to notifications page to process them
        if (!window.location.pathname.startsWith('/notifications')) {
          // Open notifications in current tab context — just signal background
          chrome.runtime.sendMessage({ type: 'UNREAD_NOTIFICATIONS_DETECTED' });
        }
      }
    }

    waitForEl('header, #global-nav', (el) => {
      new MutationObserver(checkBadge).observe(el, { childList: true, subtree: true, characterData: true });
      checkBadge();
    });
  }

  // ─── Post Content Reading ─────────────────────────────────────────────────

  function getPostContent() {
    const selectors = [
      '.feed-shared-update-v2__description .break-words span[dir]',
      '.update-components-text .break-words span[dir]',
      '.feed-shared-text span[dir]',
      '.update-components-text span',
      '[data-test-id="main-feed-activity-card"] .break-words',
      '.feed-shared-update-v2__description',
      'article .break-words',
    ];

    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el?.innerText?.trim()) return el.innerText.trim().substring(0, 2000);
    }

    return document.querySelector('main')?.innerText?.substring(0, 2000) || '';
  }

  // ─── Engagement Actions ───────────────────────────────────────────────────

  async function doLike() {
    const selectors = [
      'button.react-button__trigger[aria-label*="Like"]',
      '.reactions-react-button button',
      'button[aria-label="Like"]',
      'button[data-control-name="like_toggle"]',
    ];

    for (const sel of selectors) {
      const btn = document.querySelector(sel);
      if (!btn) continue;
      const liked = btn.getAttribute('aria-pressed') === 'true' || btn.classList.contains('--active');
      if (!liked) {
        btn.click();
        await sleep(400 + rand(300));
      }
      return true;
    }
    return false;
  }

  async function doComment(text) {
    // Open comment editor
    const commentBtnSels = [
      'button[aria-label*="comment" i]',
      'button.comment-button',
      '[data-control-name="comment"]',
      '.social-actions button:nth-child(2)',
    ];

    for (const sel of commentBtnSels) {
      const btn = document.querySelector(sel);
      if (btn) {
        btn.click();
        await sleep(1000 + rand(500));
        break;
      }
    }

    // Find the contenteditable editor
    const editorSels = [
      '.ql-editor[contenteditable="true"]',
      '.comments-comment-box__editor [contenteditable="true"]',
      '[data-placeholder*="comment" i][contenteditable="true"]',
      '.comment-field [contenteditable="true"]',
    ];

    let editor = null;
    for (const sel of editorSels) {
      editor = document.querySelector(sel);
      if (editor) break;
    }

    if (!editor) return false;

    editor.focus();
    await sleep(200 + rand(200));

    // Clear and type with human-like per-character delay
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);

    for (const ch of text) {
      document.execCommand('insertText', false, ch);
      await sleep(30 + rand(70));
    }

    await sleep(600 + rand(600));

    // Submit
    const submitSels = [
      '.comments-comment-box__submit-button:not([disabled])',
      'button[data-control-name="submit_comment"]',
      'button.comment-submit',
    ];

    for (const sel of submitSels) {
      const btn = document.querySelector(sel);
      if (btn) {
        btn.click();
        await sleep(500);
        return true;
      }
    }

    // Last resort: Enter key
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true, ctrlKey: true }));
    return true;
  }

  // ─── Overlay UI ───────────────────────────────────────────────────────────

  function showOverlay({ comment, requestId, postUrl }) {
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

  function removeOverlay() {
    activeOverlay?.remove();
    activeOverlay = null;
  }

  // ─── Message Handler ──────────────────────────────────────────────────────

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
  function rand(n) { return Math.floor(Math.random() * n); }
  function esc(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function hashEl(el) { return btoa(el.textContent?.substring(0, 60) || String(Date.now())).slice(0, 16); }

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

  // ─── Init ─────────────────────────────────────────────────────────────────
  initNotificationWatcher();

})();
