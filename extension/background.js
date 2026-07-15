/* DJ IT – service worker: opens the DJ deck tab */
"use strict";

function openDeck(videoId) {
  let url = chrome.runtime.getURL("deck.html");
  if (videoId) url += "?v=" + encodeURIComponent(videoId);
  chrome.tabs.create({ url });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "openDeck") {
    openDeck(msg.videoId || "");
    sendResponse({ ok: true });
  }
  return true;
});
