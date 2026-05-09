// content.js — Runs on linkedin.com
(function () {
  'use strict';

  const LOG = (...a) => console.log('[LinkedIn AI]', ...a);
  LOG('Script loaded on', location.href);

  // ─── Visual proof-of-life indicator ────────────────────────────────────────────
  // A small dot in the corner proves the script is running
  const dot = document.createElement('div');
  dot.id = 'lai-dot';
  dot.title = 'LinkedIn AI Assistant active';
  dot.style.cssText = 'position:fixed;bottom:12px;left:12px;width:12px;height:12px;border-radius:50%;background:#0077B5;z-index:999999;box-shadow:0 0 0 2px #fff;';
  document.body.appendChild(dot);

  // ─── URL polling (most reliable SPA navigation detection) ─────────────────

  let lastUrl       = location.href;
  let overlayShown  = false;
  let pendingRequestId = null;

  // Check if already on a post page when script first loads
  if (isPostUrl(location.href)) {
    LOG('Already on post page, triggering in 2s');
    setTimeout(() => onPostPage(location.href), 2000);
  }

  // Poll every 500ms for URL changes (LinkedIn SPA)
  setInterval(() => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    LOG('URL changed to', location.href);
    overlayShown = false; // reset on navigation
    if (isPostUrl(location.href)) {
      LOG('Post page detected! Triggering in 2s...');
      dot.style.background = '#ff9900'; // turns orange while processing
      setTimeout(() => onPostPage(location.href), 2000);
    }
  }, 500);

  // ─── When we land on a post page ──────────────────────────────────────────

  function onPostPage(url) {
    if (overlayShown) return;
    const content = getPostContent();
    LOG('Post content:', content.substring(0, 120));

    // Show overlay immediately with "Generating..." while we wait for AI
    showOverlay('Generating AI comment…', '__pending__');

    chrome.runtime.sendMessage({
      type:      'NEW_POST_NOTIFICATION',
      postUrl:   url,
      notifText: content,
      notifId:   url.split('?')[0],
    }, (response) => {
      LOG('Background acknowledged:', response);
    });
  }

  // Poll for the generated comment from background
  const commentPollInterval = setInterval(() => {
    if (!document.getElementById('lai-overlay')) return; // overlay not showing
    chrome.runtime.sendMessage({ type: 'GET_PENDING' }, (requests) => {
      if (chrome.runtime.lastError || !requests) return;
      const entries = Object.values(requests);
      if (entries.length === 0) return;
      const req = entries[entries.length - 1]; // most recent
      if (req.comment && req.comment !== 'Generating AI comment…') {
        LOG('Comment ready, updating overlay:', req.comment.substring(0, 60));
        const ta = document.getElementById('lai-text');
        if (ta) ta.value = req.comment;
        pendingRequestId = req.requestId;
        dot.style.background = '#00b050'; // green = ready
      }
    });
  }, 1500);

  // ─── Bell badge watcher (non-post pages) ────────────────────────────────

  let bellWasShowing = false;
  setInterval(() => {
    const badge = document.querySelector('.notification-badge--show');
    if (badge && !bellWasShowing) {
      bellWasShowing = true;
      LOG('Bell badge detected — opening scan tab');
      chrome.runtime.sendMessage({ type: 'BELL_BADGE_CHANGED', count: 1 });
    } else if (!badge) { bellWasShowing = false; }
  }, 4000);

  // ─── Post content reader ───────────────────────────────────────────────────

  function getPostContent() {
    const main = document.querySelector('[role="main"]');
    if (!main) return document.body.innerText.substring(0, 2000);
    const spans = [...main.querySelectorAll('span[dir]')]
      .map(s => s.innerText.trim()).filter(t => t.length > 20);
    return (spans.length ? spans.slice(0, 6).join(' ') : main.innerText).substring(0, 2000);
  }

  // ─── Like action ────────────────────────────────────────────────────────────────

  async function doLike() {
    const btn = document.querySelector('button[aria-label*="Like"][aria-pressed="false"],button[aria-label="Like"]');
    if (btn) { btn.click(); await sleep(400 + rand(300)); return true; }
    return false;
  }

  // ─── Comment action ─────────────────────────────────────────────────────────────

  async function doComment(text) {
    const openBtn = document.querySelector('button[aria-label*="comment" i]');
    if (openBtn) { openBtn.click(); await sleep(1000 + rand(500)); }
    const editor = document.querySelector('[contenteditable="true"][aria-label*="comment" i],[contenteditable="true"][aria-placeholder*="comment" i],.ql-editor[contenteditable="true"],[contenteditable="true"]');
    if (!editor) return false;
    editor.focus(); await sleep(200);
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);
    for (const ch of text) { document.execCommand('insertText', false, ch); await sleep(35 + rand(65)); }
    await sleep(700);
    const submit = document.querySelector('button[aria-label*="submit" i]:not([disabled]),button[type="submit"]:not([disabled])');
    if (submit) { submit.click(); return true; }
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true, ctrlKey: true }));
    return true;
  }

  // ─── Overlay ────────────────────────────────────────────────────────────────────

  function showOverlay(comment, requestId) {
    if (overlayShown) {
      // Just update the textarea if already shown
      const ta = document.getElementById('lai-text');
      if (ta) ta.value = comment;
      return;
    }
    overlayShown = true;
    pendingRequestId = requestId;

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

    div.addEventListener('click', async (e) => {
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (!action) return;
      const rid = pendingRequestId;
      if (action === 'approve') {
        const text = document.getElementById('lai-text')?.value?.trim();
        if (!text || text === 'Generating AI comment…') return;
        div.remove(); overlayShown = false;
        dot.style.background = '#0077B5';
        await doLike(); await sleep(600 + rand(400)); await doComment(text);
        chrome.runtime.sendMessage({ type: 'ENGAGEMENT_DONE', requestId: rid }).catch(() => {});
      } else {
        div.remove(); overlayShown = false;
        dot.style.background = '#0077B5';
        chrome.runtime.sendMessage({ type: 'ENGAGEMENT_SKIPPED', requestId: rid }).catch(() => {});
      }
    });
  }

  // ─── Messages from background ───────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'SHOW_OVERLAY') {
      showOverlay(msg.comment, msg.requestId);
      pendingRequestId = msg.requestId;
      dot.style.background = '#00b050';
      sendResponse({ ok: true });
    }
    if (msg.type === 'DO_ENGAGE') {
      (async () => {
        await doLike(); await sleep(700 + rand(500)); await doComment(msg.comment);
        sendResponse({ ok: true });
      })();
      return true;
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

})();
