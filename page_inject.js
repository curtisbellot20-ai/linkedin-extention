// page_inject.js — Runs in the PAGE world (world: MAIN)
// Intercepts LinkedIn's fetch API to catch notification data
(function () {
  'use strict';
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const url = (args[0]?.url || args[0] || '').toString();
    const response = await originalFetch.apply(this, args);
    if (url.includes('voyager/api') && url.toLowerCase().includes('notif')) {
      response.clone().text().then((text) => {
        const found = new Set();
        (text.match(/\/posts\/[a-zA-Z0-9_%-]{8,}/g) || []).forEach(m => found.add(m));
        (text.match(/\/feed\/update\/urn[^"'\\\s]{5,}/g) || []).forEach(m => found.add(m));
        if (found.size > 0) {
          window.postMessage({ source: 'linkedin-ai-ext', type: 'NOTIF_API_DATA', urls: [...found] }, '*');
        }
      }).catch(() => {});
    }
    return response;
  };
})();
