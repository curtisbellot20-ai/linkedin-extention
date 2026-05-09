// background.js — Service Worker (LinkedIn AI Engagement Assistant)
'use strict';

const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL   = 'claude-sonnet-4-6';

// Tracks background scan tabs so we can close them after scanning
const scanTabs = new Set();

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({
    mode:            'supervised',
    apiKey:          '',
    pendingRequests: {},
    processedNotifs: [],
    autoConfirmed:   false,
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {

    case 'BELL_BADGE_CHANGED':
      // User's bell badge went up on any LinkedIn page — open a background
      // notifications tab to scan for new post notifications
      openNotificationsScanTab();
      break;

    case 'NEW_POST_NOTIFICATION':
      handleNewNotification(msg, sender.tab);
      // If this message came from a background scan tab, schedule its closure
      if (sender.tab && scanTabs.has(sender.tab.id)) {
        setTimeout(() => {
          chrome.tabs.remove(sender.tab.id).catch(() => {});
          scanTabs.delete(sender.tab.id);
        }, 3000);
      }
      break;

    case 'ENGAGEMENT_DONE':
    case 'ENGAGEMENT_SKIPPED':
      handleEngagementDone(msg.requestId);
      break;

    case 'POPUP_APPROVE':
      handlePopupApprove(msg.requestId);
      break;

    case 'POPUP_SKIP':
      handleEngagementDone(msg.requestId);
      break;

    case 'GET_PENDING':
      getPendingRequests().then(sendResponse);
      return true;

    case 'SAVE_SETTINGS':
      chrome.storage.local.set({
        mode:          msg.mode,
        apiKey:        msg.apiKey,
        autoConfirmed: msg.autoConfirmed,
      });
      break;
  }
});

// ─── Background notification scan tab ────────────────────────────────────────

async function openNotificationsScanTab() {
  // If a scan tab is already open, just reload it
  for (const tabId of scanTabs) {
    try {
      await chrome.tabs.reload(tabId);
      return;
    } catch {
      scanTabs.delete(tabId);
    }
  }

  // Check if user already has notifications page open — use that instead
  const existing = await chrome.tabs.query({ url: 'https://www.linkedin.com/notifications/*' });
  if (existing.length > 0) {
    chrome.tabs.reload(existing[0].id);
    return;
  }

  // Open a new background tab to scan notifications
  const tab = await chrome.tabs.create({
    url:    'https://www.linkedin.com/notifications/',
    active: false,
  });
  scanTabs.add(tab.id);

  // Safety: close scan tab after 15 s even if no notifications found
  setTimeout(() => {
    if (scanTabs.has(tab.id)) {
      chrome.tabs.remove(tab.id).catch(() => {});
      scanTabs.delete(tab.id);
    }
  }, 15000);
}

// Clean up scan tab tracking when any tab closes
chrome.tabs.onRemoved.addListener((tabId) => scanTabs.delete(tabId));

// ─── Auto-mode alarm ──────────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm.name.startsWith('engage_')) return;
  const requestId = alarm.name.replace('engage_', '');
  const { pendingRequests } = await chrome.storage.local.get('pendingRequests');
  const req = pendingRequests?.[requestId];
  if (req) await executeEngagement(req);
});

// ─── Desktop notification buttons ─────────────────────────────────────────────

chrome.notifications.onButtonClicked.addListener(async (notifId, btnIndex) => {
  const requestId = notifId.replace('req_', '');
  if (btnIndex === 0) await handlePopupApprove(requestId);
  else               await handleEngagementDone(requestId);
  chrome.notifications.clear(notifId);
});

chrome.notifications.onClicked.addListener((notifId) => {
  // Focus an existing LinkedIn tab, or open one
  chrome.tabs.query({ url: 'https://www.linkedin.com/*' }, (tabs) => {
    if (tabs.length > 0) chrome.tabs.update(tabs[0].id, { active: true });
    else chrome.tabs.create({ url: 'https://www.linkedin.com/notifications/' });
  });
  chrome.notifications.clear(notifId);
});

// ─── Core notification handler ────────────────────────────────────────────────

async function handleNewNotification(msg, senderTab) {
  const { processedNotifs, apiKey, mode, autoConfirmed } =
    await chrome.storage.local.get(['processedNotifs', 'apiKey', 'mode', 'autoConfirmed']);

  if (processedNotifs?.includes(msg.notifId)) return;

  if (!apiKey) {
    setBadge('!', '#ff4444');
    return;
  }

  // Mark as seen
  const updated = [...(processedNotifs || []).slice(-199), msg.notifId];
  await chrome.storage.local.set({ processedNotifs: updated });

  // Generate comment
  let comment;
  try {
    comment = await generateComment(msg.notifText || 'a LinkedIn post', apiKey);
  } catch (e) {
    console.error('[LinkedIn AI] Comment generation failed:', e);
    setBadge('!', '#ff4444');
    return;
  }

  const requestId = Date.now().toString(36) + Math.random().toString(36).slice(2);
  const request   = {
    requestId,
    postUrl:   msg.postUrl,
    comment,
    notifText: msg.notifText,
    status:    'pending',
    createdAt: Date.now(),
  };

  const { pendingRequests = {} } = await chrome.storage.local.get('pendingRequests');
  pendingRequests[requestId]    = request;
  await chrome.storage.local.set({ pendingRequests });
  updateBadgeCount(pendingRequests);

  if (mode === 'supervised') {
    // Desktop notification so user can approve from anywhere
    chrome.notifications.create(`req_${requestId}`, {
      type:             'basic',
      title:            '💼 LinkedIn AI — Comment Ready',
      message:          `"${comment.substring(0, 100)}..." — Click to approve`,
      buttons:          [{ title: '✅ Approve & Post' }, { title: '❌ Skip' }],
      requireInteraction: true,
    });

    // Also show overlay if a visible LinkedIn tab exists
    const visibleTabs = await chrome.tabs.query({
      url:    'https://www.linkedin.com/*',
      active: true,
    });
    if (visibleTabs.length > 0) {
      chrome.tabs.sendMessage(visibleTabs[0].id, {
        type: 'SHOW_OVERLAY', comment, requestId, postUrl: msg.postUrl,
      }).catch(() => {});
    }

  } else if (mode === 'auto' && autoConfirmed) {
    // Schedule random 1–5 min delay
    const delayMinutes = 1 + Math.random() * 4;
    chrome.alarms.create(`engage_${requestId}`, { delayInMinutes: delayMinutes });
  }
}

// ─── Engagement execution ─────────────────────────────────────────────────────

async function executeEngagement(req) {
  // Prefer a tab already on the post URL
  const allTabs = await chrome.tabs.query({ url: 'https://www.linkedin.com/*' });
  let target    = allTabs.find(t => t.url?.includes(req.postUrl));

  if (!target && allTabs.length > 0) {
    // Navigate an existing LinkedIn tab to the post
    await chrome.tabs.update(allTabs[0].id, { url: req.postUrl });
    target = allTabs[0];
    await sleep(4000);
  } else if (!target) {
    // Open in background
    target = await chrome.tabs.create({ url: req.postUrl, active: false });
    await sleep(4500);
  }

  try {
    await chrome.tabs.sendMessage(target.id, {
      type: 'DO_ENGAGE', comment: req.comment, postUrl: req.postUrl,
    });
  } catch (e) {
    console.error('[LinkedIn AI] Engagement failed:', e);
  }

  await handleEngagementDone(req.requestId);
}

async function handleEngagementDone(requestId) {
  const { pendingRequests = {} } = await chrome.storage.local.get('pendingRequests');
  delete pendingRequests[requestId];
  await chrome.storage.local.set({ pendingRequests });
  updateBadgeCount(pendingRequests);
}

async function handlePopupApprove(requestId) {
  const { pendingRequests = {} } = await chrome.storage.local.get('pendingRequests');
  const req = pendingRequests[requestId];
  if (req) await executeEngagement(req);
}

async function getPendingRequests() {
  const { pendingRequests = {} } = await chrome.storage.local.get('pendingRequests');
  return pendingRequests;
}

// ─── Claude API ───────────────────────────────────────────────────────────────

async function generateComment(postContent, apiKey) {
  const res = await fetch(CLAUDE_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:      CLAUDE_MODEL,
      max_tokens: 150,
      system:
        'You are a professional LinkedIn engagement assistant. Write a brief (1–3 sentences, ' +
        'under 50 words) genuine comment for the LinkedIn post below.\n\nRules:\n' +
        '- Sound natural and human, not robotic\n' +
        '- Be specific to the post content\n' +
        '- Professional, business-focused tone\n' +
        '- Add a thought, insight, or thoughtful question\n' +
        '- Never start with "Great post!", "Amazing!", or generic openers\n' +
        '- No hashtags\n- No excessive exclamation marks\n\n' +
        'Respond with ONLY the comment text.',
      messages: [{
        role:    'user',
        content: `Post content:\n\n${postContent.substring(0, 1500)}`,
      }],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Claude API ${res.status}: ${body}`);
  }
  const data = await res.json();
  return data.content[0].text.trim();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function updateBadgeCount(pendingRequests) {
  const count = Object.keys(pendingRequests).length;
  setBadge(count > 0 ? String(count) : '', '#0077B5');
}

function setBadge(text, color) {
  chrome.action.setBadgeText({ text });
  if (color) chrome.action.setBadgeBackgroundColor({ color });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
