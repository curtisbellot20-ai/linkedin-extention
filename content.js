// content.js — Runs only on linkedin.com
(function () {
  'use strict';

  const knownPostUrls = new Set();
  let activeOverlay   = null;
  const isNotifPage   = window.location.pathname.startsWith('/notifications');

  // ─── Entry point ──────────────────────────────────────────────────────────

  function init() {
    if (isNotifPage) {
      startNotificationScanning();
    } else {
      watchBellBadge();
    }
  }

  // ─── Notification page scanning ──────────────────────────────────────────────

  function startNotificationScanning() {
    scanNotifications();
    setInterval(scanNotifications, 2000);

    // Watch the DOM for dynamically loaded notification cards
    const obs = new MutationObserver(scanNotifications);
    function attachObs() {
      // Use stable ARIA role — LinkedIn always includes role="main"
      const root = document.querySelector('[role="main"]') || document.body;
      obs.observe(root, { childList: true, subtree: true });
    }
    attachObs();
    setTimeout(attachObs, 1500);
    setTimeout(attachObs, 5000);
  }

  function scanNotifications() {
    // Root: prefer [role="main"], fall back to body
    const root = document.querySelector('[role="main"]') || document.body;

    // Grab EVERY anchor in the notifications area
    const allLinks = root.querySelectorAll('a[href]');

    allLinks.forEach((link) => {
      const href = link.href || '';

      // Accept any link that points to a LinkedIn post (direct or encoded)
      const isPostLink =
        href.includes('/posts/')          ||
        href.includes('ugcPost')          ||
        href.includes('/feed/update/')    ||
        href.includes('urn%3Ali%3Aactivity') ||
        href.includes('urn:li:activity');

      if (!isPostLink) return;

      const postKey = href.split('?')[0]; // strip tracking params
      if (knownPostUrls.has(postKey)) return;

      // Walk up to a notification card using stable ARIA roles or li
      const card =
        link.closest('[role="listitem"]') ||
        link.closest('[role="article"]')  ||
        link.closest('li')               ||
        link.closest('[data-urn]')        ||
        link.parentElement;

      const cardText = (card || link).innerText?.trim() || '';

      // Skip news digests and promoted posts
      if (/daily rundown|weekly rundown|newsletter|promoted|advertisement/i.test(cardText)) return;

      knownPostUrls.add(postKey);

      chrome.runtime.sendMessage({
        type:      'NEW_POST_NOTIFICATION',
        postUrl:   href,
        notifText: cardText.substring(0, 800),
        notifId:   postKey,
      });
    });
  }

  // ─── Bell badge watcher (non-notification pages) ───────────────────────────

  function watchBellBadge() {
    let lastCount = 0;

    function checkBadge() {
      // Use attribute selector — avoids hashed class names
      const badge = document.querySelector(
        '[aria-label*="notification" i] [aria-label], ' +
        '.notification-badge__count, ' +
        '.nav-item__badge-count'
      );
      const count = parseInt(
        (badge?.textContent?.trim() || '0').replace(/[^0-9]/g, ''), 10
      );
      if (count > 0 && count !== lastCount) {
        lastCount = count;
        chrome.runtime.sendMessage({ type: 'BELL_BADGE_CHANGED', count });
      }
    }

    // Watch header via role="navigation" — always stable
    const target = document.querySelector('[role="navigation"], header') || document.body;
    new MutationObserver(checkBadge).observe(target, {
      childList: true, subtree: true, characterData: true,
    });
    checkBadge();
    setInterval(checkBadge, 5000); // poll as fallback
  }

  // ─── Post content reader ───────────────────────────────────────────────────────

  function getPostContent() {
    // Try known stable attribute patterns first
    const byAttr = document.querySelector(
      '[data-test-id*="post"] [dir], [aria-label*="post content" i]'
    );
    if (byAttr?.innerText?.trim()) return byAttr.innerText.trim().substring(0, 2000);

    // Fall back to any span[dir] inside main (LinkedIn always sets dir on text spans)
    const main = document.querySelector('[role="main"]');
    if (main) {
      const spans = main.querySelectorAll('span[dir="ltr"], span[dir="rtl"]');
      const texts = Array.from(spans).map(s => s.innerText.trim()).filter(t => t.length > 30);
      if (texts.length) return texts.slice(0, 5).join(' ').substring(0, 2000);
      return main.innerText.substring(0, 2000);
    }
    return '';
  }

  // ─── Like action ─────────────────────────────────────────────────────────────────

  async function doLike() {
    // aria-label is stable — LinkedIn has to keep it for accessibility
    const btn = document.querySelector(
      'button[aria-label*="Like"][aria-pressed="false"], ' +
      'button[aria-label="Like"], ' +
      'button[aria-label*="React"]'
    );
    if (btn) {
      btn.click();
      await sleep(400 + rand(300));
      return true;
    }
    return false;
  }

  // ─── Comment action ────────────────────────────────────────────────────────────

  async function doComment(text) {
    // Open comment box via aria-label (stable)
    const openBtn = document.querySelector(
      'button[aria-label*="comment" i], button[aria-label*="Comment" i]'
    );
    if (openBtn) { openBtn.click(); await sleep(1000 + rand(500)); }

    // contenteditable is a standard HTML attribute — always stable
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

    // Submit via aria-label
    const submitBtn = document.querySelector(
      'button[aria-label*="submit" i]:not([disabled]), ' +
      'button[aria-label*="post comment" i]:not([disabled]), ' +
      'button[type="submit"]:not([disabled])'
    );
    if (submitBtn) { submitBtn.click(); await sleep(500); return true; }

    // Fallback: Ctrl+Enter
    editor.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true, ctrlKey: true })
    );
    return true;
  }

  // ─── In-page overlay ───────────────────────────────────────────────────────────

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
  function esc(s) {
    return String(s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  init();

})();
