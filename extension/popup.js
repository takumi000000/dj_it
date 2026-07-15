"use strict";

function parseVideoId(input) {
  if (!input) return null;
  input = input.trim();
  if (/^[\w-]{11}$/.test(input)) return input;
  const m = input.match(/[?&]v=([\w-]{11})/) ||
            input.match(/youtu\.be\/([\w-]{11})/) ||
            input.match(/\/shorts\/([\w-]{11})/);
  return m ? m[1] : null;
}
function openDeck(videoId) {
  chrome.runtime.sendMessage({ type: "openDeck", videoId: videoId || "" });
  window.close();
}

document.getElementById("fromCurrent").addEventListener("click", () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const url = tabs[0] && tabs[0].url;
    const id = parseVideoId(url || "");
    if (!id) { alert("YouTubeの動画ページで実行してください。"); return; }
    openDeck(id);
  });
});
document.getElementById("fromUrl").addEventListener("click", () => {
  const id = parseVideoId(document.getElementById("url").value);
  if (!id) { alert("YouTube URL が不正です。"); return; }
  openDeck(id);
});
document.getElementById("empty").addEventListener("click", () => openDeck(""));
