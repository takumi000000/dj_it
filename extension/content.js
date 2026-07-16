/* DJ IT – content script: adds a "🎧 DJ IT で開始" button on YouTube watch pages */
"use strict";

function currentVideoId() {
  const m = location.search.match(/[?&]v=([\w-]{11})/);
  return m ? m[1] : null;
}

function makeButton() {
  const btn = document.createElement("button");
  btn.id = "djit-start-btn";
  btn.type = "button";
  btn.textContent = "🎧 DJ IT で開始";
  btn.title = "この曲を種に、似た曲調で自動DJ (クロスフェード) を開始します";
  btn.addEventListener("click", () => {
    const id = currentVideoId();
    chrome.runtime.sendMessage({ type: "openDeck", videoId: id });
  });
  return btn;
}

function inject() {
  if (document.getElementById("djit-start-btn")) return;
  if (!currentVideoId()) return;
  // Try to sit next to the like/share actions; fall back to a floating button.
  const anchor = document.querySelector("#top-level-buttons-computed") ||
                 document.querySelector("#actions #menu") ||
                 document.querySelector("#owner");
  const btn = makeButton();
  if (anchor) {
    btn.classList.add("djit-inline");
    anchor.parentElement ? anchor.parentElement.insertBefore(btn, anchor) : anchor.appendChild(btn);
  } else {
    btn.classList.add("djit-float");
    document.body.appendChild(btn);
  }
}

// YouTube is a SPA: re-inject on navigation and DOM churn.
const mo = new MutationObserver(() => inject());
mo.observe(document.documentElement, { childList: true, subtree: true });
document.addEventListener("yt-navigate-finish", () => setTimeout(inject, 500));
setTimeout(inject, 1200);
