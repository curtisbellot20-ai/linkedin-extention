// background.js — Service Worker
'use strict';

const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL   = 'claude-sonnet-4-6';
const scanTabs       = new Set();

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ mode: 'supervised', apiKey: '', pendingRequests: {}, processedNotifs: [], autoConfirmed: false });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case 'BELL_BADGE_CHANGED':     openNotificationsScanTab(); break;
    case 'NEW_POST_NOTIFICATION':  handleNewNotification(msg, sender.tab); break;
    case 'ENGAGEMENT_DONE':
    case 'ENGAGEMENT_SKIPPED':     handleEngagementDone(msg.requestId); break;
    case 'POPUP_APPROVE':          handlePopupApprove(msg.requestId); break;
    case 'POPUP_SKIP':             handleEngagementDone(msg.requestId); break;
    case 'GET_PENDING':            getPendingRequests().then(sendResponse); return true;
    case 'SAVE_SETTINGS':
      chrome.storage.local.set({ mode: msg.mode, apiKey: msg.apiKey, autoConfirmed: msg.autoConfirmed }); break;
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm.name.startsWith('engage_')) return;
  const { pendingRequests } = await chrome.storage.local.get('pendingRequests');
  const req = pendingRequests?.[alarm.name.replace('engage_', '')];
  if (req) await executeEngagement(req);
});

chrome.notifications.onButtonClicked.addListener(async (notifId, btnIndex) => {
  const requestId = notifId.replace('req_', '');
  if (btnIndex === 0) await handlePopupApprove(requestId);
  else               await handleEngagementDone(requestId);
  chrome.notifications.clear(notifId);
});

chrome.notifications.onClicked.addListener((notifId) => {
  chrome.tabs.query({ url: 'https://www.linkedin.com/*' }, (tabs) => {
    if (tabs.length > 0) chrome.tabs.update(tabs[0].id, { active: true });
    else chrome.tabs.create({ url: 'https://www.linkedin.com/notifications/' });
  });
  chrome.notifications.clear(notifId);
});

chrome.tabs.onRemoved.addListener((tabId) => scanTabs.delete(tabId));

async function openNotificationsScanTab() {
  for (const tabId of scanTabs) {
    try { await chrome.tabs.reload(tabId); return; } catch { scanTabs.delete(tabId); }
  }
  const existing = await chrome.tabs.query({ url: 'https://www.linkedin.com/notifications/*' });
  if (existing.length > 0) { chrome.tabs.reload(existing[0].id); return; }
  const tab = await chrome.tabs.create({ url: 'https://www.linkedin.com/notifications/', active: false });
  scanTabs.add(tab.id);
  setTimeout(() => { if (scanTabs.has(tab.id)) { chrome.tabs.remove(tab.id).catch(() => {}); scanTabs.delete(tab.id); } }, 15000);
}

async function handleNewNotification(msg, senderTab) {
  const { processedNotifs, apiKey, mode, autoConfirmed } =
    await chrome.storage.local.get(['processedNotifs', 'apiKey', 'mode', 'autoConfirmed']);

  if (processedNotifs?.includes(msg.notifId)) return;
  if (!apiKey) { setBadge('!', '#ff4444'); return; }

  const updated = [...(processedNotifs || []).slice(-199), msg.notifId];
  await chrome.storage.local.set({ processedNotifs: updated });

  let comment;
  try {
    comment = await generateComment(msg.notifText || msg.postUrl, apiKey);
  } catch (e) {
    console.error('[LinkedIn AI] API error:', e);
    setBadge('!', '#ff4444');
    return;
  }

  const requestId = Date.now().toString(36) + Math.random().toString(36).slice(2);
  const request   = { requestId, postUrl: msg.postUrl, comment, notifText: msg.notifText, status: 'pending', createdAt: Date.now() };

  const { pendingRequests = {} } = await chrome.storage.local.get('pendingRequests');
  pendingRequests[requestId] = request;
  await chrome.storage.local.set({ pendingRequests });
  updateBadgeCount(pendingRequests);

  if (mode === 'supervised') {
    chrome.notifications.create(`req_${requestId}`, {
      type: 'basic',
      title: '💼 LinkedIn AI — Comment Ready',
      message: `"${comment.substring(0, 100)}" — Click to approve`,
      buttons: [{ title: '✅ Approve & Post' }, { title: '❌ Skip' }],
      requireInteraction: true,
    });
    // Show overlay on the active LinkedIn tab
    if (senderTab?.url?.includes('linkedin.com')) {
      chrome.tabs.sendMessage(senderTab.id, { type: 'SHOW_OVERLAY', comment, requestId, postUrl: msg.postUrl }).catch(() => {});
    } else {
      const activeTabs = await chrome.tabs.query({ url: 'https://www.linkedin.com/*', active: true });
      if (activeTabs.length > 0) {
        chrome.tabs.sendMessage(activeTabs[0].id, { type: 'SHOW_OVERLAY', comment, requestId, postUrl: msg.postUrl }).catch(() => {});
      }
    }
  } else if (mode === 'auto' && autoConfirmed) {
    chrome.alarms.create(`engage_${requestId}`, { delayInMinutes: 1 + Math.random() * 4 });
  }
}

async function executeEngagement(req) {
  const allTabs = await chrome.tabs.query({ url: 'https://www.linkedin.com/*' });
  let target    = allTabs.find(t => t.url?.includes(req.postUrl));
  if (!target && allTabs.length > 0) {
    await chrome.tabs.update(allTabs[0].id, { url: req.postUrl });
    target = allTabs[0]; await sleep(4000);
  } else if (!target) {
    target = await chrome.tabs.create({ url: req.postUrl, active: false }); await sleep(4500);
  }
  chrome.tabs.sendMessage(target.id, { type: 'DO_ENGAGE', comment: req.comment }).catch(() => {});
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

async function generateComment(postContent, apiKey) {
  const res = await fetch(CLAUDE_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: CLAUDE_MODEL, max_tokens: 150,
      system: 'You are a professional LinkedIn engagement assistant. Write a brief (1-3 sentences, under 50 words) genuine comment for the LinkedIn post below.\n\nRules:\n- Sound natural and human\n- Be specific to the post\n- Professional and business-focused\n- No hashtags, no excessive exclamation marks\n- Never start with "Great post!" or "Amazing!"\n\nRespond with ONLY the comment text.',
      messages: [{ role: 'user', content: `Post content:\n\n${String(postContent).substring(0, 1500)}` }],
    }),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${await res.text()}`);
  return (await res.json()).content[0].text.trim();
}

function updateBadgeCount(p) { setBadge(Object.keys(p).length > 0 ? String(Object.keys(p).length) : '', '#0077B5'); }
function setBadge(text, color) { chrome.action.setBadgeText({ text }); if (color) chrome.action.setBadgeBackgroundColor({ color }); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
