// popup.js
'use strict';

let currentMode = 'supervised';

const apiKeyInput    = document.getElementById('api-key');
const btnSupervised  = document.getElementById('btn-supervised');
const btnAuto        = document.getElementById('btn-auto');
const modeDesc       = document.getElementById('mode-desc');
const warningBox     = document.getElementById('warning-box');
const riskConfirm    = document.getElementById('risk-confirm');
const riskCheck      = document.getElementById('risk-check');
const saveBtn        = document.getElementById('save-btn');
const saveMsg        = document.getElementById('save-msg');
const pendingSection = document.getElementById('pending-section');
const pendingList    = document.getElementById('pending-list');
const pendingCount   = document.getElementById('pending-count');

chrome.storage.local.get(['mode', 'apiKey', 'autoConfirmed'], (data) => {
  if (data.apiKey)        apiKeyInput.value = data.apiKey;
  if (data.autoConfirmed) riskCheck.checked = data.autoConfirmed;
  setMode(data.mode || 'supervised');
});

loadPending();
setInterval(loadPending, 3000);

// ─── Mode Toggle ───────────────────────────────────────────────────────

btnSupervised.addEventListener('click', () => setMode('supervised'));
btnAuto.addEventListener('click',       () => setMode('auto'));

function setMode(mode) {
  currentMode = mode;
  btnSupervised.className = 'toggle-btn';
  btnAuto.className       = 'toggle-btn';

  if (mode === 'supervised') {
    btnSupervised.classList.add('active-safe');
    modeDesc.textContent = 'You approve each comment before it posts.';
    warningBox.classList.remove('visible');
    riskConfirm.style.display  = 'none';
    pendingSection.style.display = 'block';
  } else {
    btnAuto.classList.add('active-risky');
    modeDesc.textContent = 'Comments post automatically with a random 1–5 min delay.';
    warningBox.classList.add('visible');
    riskConfirm.style.display  = 'flex';
    pendingSection.style.display = 'none';
  }
}

// ─── Pending Requests ────────────────────────────────────────────────────

function loadPending() {
  chrome.runtime.sendMessage({ type: 'GET_PENDING' }, (requests) => {
    if (chrome.runtime.lastError || !requests) return;
    renderPending(requests);
  });
}

function renderPending(requests) {
  const entries = Object.values(requests);
  const count   = entries.length;

  pendingCount.textContent = count;
  pendingCount.className   = 'badge' + (count === 0 ? ' zero' : '');

  if (count === 0) {
    pendingList.innerHTML = '<div class="empty-state">No pending comments &mdash; watching for notifications&hellip;</div>';
    return;
  }

  pendingList.innerHTML = '';
  entries.forEach((req) => {
    const card = document.createElement('div');
    card.className = 'pending-card';
    card.innerHTML = `
      <div class="pending-card-text">${esc(req.comment)}</div>
      <div class="pending-card-actions">
        <button class="card-btn card-approve" data-id="${req.requestId}">&#x1F44D; Like &amp; Post</button>
        <button class="card-btn card-skip"    data-id="${req.requestId}">Skip</button>
      </div>
    `;
    pendingList.appendChild(card);
  });

  pendingList.querySelectorAll('.card-approve').forEach((btn) => {
    btn.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'POPUP_APPROVE', requestId: btn.dataset.id });
      btn.closest('.pending-card').remove();
      refreshCount();
    });
  });

  pendingList.querySelectorAll('.card-skip').forEach((btn) => {
    btn.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'POPUP_SKIP', requestId: btn.dataset.id });
      btn.closest('.pending-card').remove();
      refreshCount();
    });
  });
}

function refreshCount() {
  const remaining = pendingList.querySelectorAll('.pending-card').length;
  pendingCount.textContent = remaining;
  pendingCount.className   = 'badge' + (remaining === 0 ? ' zero' : '');
  if (remaining === 0)
    pendingList.innerHTML = '<div class="empty-state">No pending comments &mdash; watching for notifications&hellip;</div>';
}

// ─── Save ─────────────────────────────────────────────────────────────

saveBtn.addEventListener('click', () => {
  if (currentMode === 'auto' && !riskCheck.checked) {
    warningBox.classList.add('visible');
    riskCheck.focus();
    return;
  }

  chrome.runtime.sendMessage({
    type: 'SAVE_SETTINGS',
    mode: currentMode,
    apiKey: apiKeyInput.value.trim(),
    autoConfirmed: riskCheck.checked,
  });

  saveMsg.classList.add('visible');
  setTimeout(() => saveMsg.classList.remove('visible'), 2500);
});

// ─── Helpers ────────────────────────────────────────────────────────────

function esc(s) {
  return String(s)
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g, '&quot;');
}
