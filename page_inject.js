// page_inject.js — Runs in the PAGE'S JavaScript world (world: MAIN)
// This lets us intercept LinkedIn's own fetch() calls to get notification data
// before it's ever rendered to the DOM — immune to class name changes.
(function () {
  'use strict';

  const originalFetch = window.fetch;

  window.fetch = async function (...args) {
    const url = (args[0]?.url || args[0] || '').toString();
    const response = await originalFetch.apply(this, args);

    // Only care about LinkedIn's internal notification API calls
    if (url.includes('voyager/api') &&
        (url.includes('notification') || url.includes('Notification'))) {

      response.clone().text().then((text) => {
        const postUrls = extractPostUrls(text);
        if (postUrls.length > 0) {
          // Communicate to the isolated-world content script via window.postMessage
          window.postMessage({
            source: 'linkedin-ai-ext',
            type:   'NOTIF_API_DATA',
            urls:   postUrls,
            raw:    text.substring(0, 500), // small sample for debug
          }, '*');
        }
      }).catch(() => {});
    }

    return response;
  };

  function extractPostUrls(text) {
    const found = new Set();
    const patterns = [
      /\/posts\/[a-zA-Z0-9_%-]{8,}/g,
      /\/feed\/update\/urn[^"'\\\s]{5,}/g,
      /ugcPost:[0-9]+/g,
      /urn:li:activity:[0-9]+/g,
    ];
    patterns.forEach((re) => {
      (text.match(re) || []).forEach((m) => found.add(m));
    });
    return [...found];
  }

})();
