/* DJ IT – YouTube DJ Mode : dual-deck crossfade engine
 * MV3-compliant: no remote code. Talks to YouTube embeds via the
 * postMessage protocol directly (the same protocol the IFrame API wraps).
 */
"use strict";

const ORIGIN = typeof location !== "undefined" ? location.origin : "";

/* ---------------- utilities ---------------- */
function parseVideoId(input) {
  if (!input) return null;
  input = input.trim();
  if (/^[\w-]{11}$/.test(input)) return input;
  let m = input.match(/[?&]v=([\w-]{11})/) ||
          input.match(/youtu\.be\/([\w-]{11})/) ||
          input.match(/\/embed\/([\w-]{11})/) ||
          input.match(/\/shorts\/([\w-]{11})/);
  return m ? m[1] : null;
}
function fmtTime(s) {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return m + ":" + String(sec).padStart(2, "0");
}
function log(msg) {
  const el = document.getElementById("logText");
  const line = "[" + new Date().toLocaleTimeString() + "] " + msg;
  if (el) el.textContent = (line + "\n" + el.textContent).slice(0, 4000);
  console.log("[DJ IT]", msg);
}

/* ---------------- YouTube embed wrapper (postMessage) ---------------- */
class YTFrame {
  constructor(mountEl, opts = {}) {
    this.mount = mountEl;
    this.on = opts;
    this.iframe = null;
    this.ready = false;
    this.info = { currentTime: 0, duration: 0, videoData: {}, playlist: null, playerState: -1 };
    this._listenTimer = null;
    window.addEventListener("message", (e) => this._onMessage(e));
  }
  load(videoId, { autoplay = false, list = null, controls = 1 } = {}) {
    const p = new URLSearchParams({
      enablejsapi: "1",
      autoplay: autoplay ? "1" : "0",
      controls: String(controls),
      rel: "0",
      playsinline: "1",
      origin: ORIGIN,
    });
    if (list) { p.set("list", list); p.set("listType", "playlist"); }
    const src = "https://www.youtube.com/embed/" + (videoId || "") + "?" + p.toString();
    if (!this.iframe) {
      this.iframe = document.createElement("iframe");
      this.iframe.allow = "autoplay; encrypted-media";
      this.iframe.setAttribute("allowfullscreen", "");
      this.mount.appendChild(this.iframe);
      this.iframe.addEventListener("load", () => this._startListening());
    }
    this.ready = false;
    this.iframe.src = src;
  }
  _startListening() {
    // Ask the player to start streaming events back to us.
    let n = 0;
    clearInterval(this._listenTimer);
    this._listenTimer = setInterval(() => {
      this._post({ event: "listening", id: 1, channel: "widget" });
      if (++n > 20) clearInterval(this._listenTimer);
    }, 250);
  }
  _post(obj) {
    try { this.iframe && this.iframe.contentWindow &&
      this.iframe.contentWindow.postMessage(JSON.stringify(obj), "*"); } catch (_) {}
  }
  cmd(func, args = []) { this._post({ event: "command", func, args }); }

  play() { this.cmd("playVideo"); }
  pause() { this.cmd("pauseVideo"); }
  mute() { this.cmd("mute"); }
  unmute() { this.cmd("unMute"); }
  setVolume(v) { this.cmd("setVolume", [Math.max(0, Math.min(100, Math.round(v)))]); }
  loadVideoById(id, autoplay = true) {
    this.cmd(autoplay ? "loadVideoById" : "cueVideoById", [id]);
  }
  next() { this.cmd("nextVideo"); }

  _onMessage(e) {
    if (!this.iframe || e.source !== this.iframe.contentWindow) return;
    let d = e.data;
    if (typeof d === "string") { try { d = JSON.parse(d); } catch (_) { return; } }
    if (!d || typeof d !== "object") return;
    switch (d.event) {
      case "onReady":
        this.ready = true; this.on.onReady && this.on.onReady(this); break;
      case "initialDelivery":
      case "infoDelivery":
      case "apiInfoDelivery": {
        const info = d.info || {};
        Object.assign(this.info, info);
        this.on.onInfo && this.on.onInfo(this, this.info); break;
      }
      case "onStateChange":
        this.info.playerState = d.info;
        this.on.onState && this.on.onState(this, d.info); break;
      case "onError":
        this.on.onError && this.on.onError(this, d.info); break;
    }
  }
}

/* ---------------- Deck engine ---------------- */
const YT_STATE = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 };

const engine = {
  deckA: null, deckB: null, radio: null,
  active: null,            // active YTFrame
  radioList: [],           // array of video ids (YouTube Mix)
  radioIdx: 0,             // pointer to NEXT unused id in radioList
  manualQueue: [],         // [{videoId,title}]
  currentId: null,
  seedId: null,
  master: 100,             // 0..100 master volume
  chA: 1, chB: 1,          // 0..1 per-deck channel gain (faders)
  xfPos: 0,                // 0 = full deck A, 1 = full deck B
  xfade: 8,
  autoMix: true,
  running: false,
  autoStartPending: false,  // auto-start the DJ as soon as deck A is ready
  muted: false,             // true while auto-started muted, awaiting a gesture to enable sound
  crossfading: false,
  errStreak: 0,             // consecutive playback errors (embed-disabled videos)
  nativeRadio: false,       // fallback: let YouTube's own radio auto-advance one deck
  titleCache: new Map(),
  reseedInFlight: false,
  _radioResolve: null,
};

function setStatus(txt, live) {
  const s = document.getElementById("status");
  s.textContent = txt;
  s.classList.toggle("live", !!live);
}
function markActiveDeck() {
  const a = document.getElementById("deckWrapA"), b = document.getElementById("deckWrapB");
  if (a) a.classList.toggle("active", engine.active === engine.deckA);
  if (b) b.classList.toggle("active", engine.active === engine.deckB);
  updateMixerUI();
}

function setVU(id, vol, playing) {
  const el = document.getElementById(id);
  if (!el) return;
  let level = Math.max(0, Math.min(100, vol));
  if (playing && level > 0) level = Math.min(100, level * (0.78 + Math.random() * 0.34));
  el.style.height = level + "%";
}

/* Reflect the mixer state onto the booth controls (faders, crossfader, meters). */
function updateMixerUI() {
  const p = engine.xfPos;
  const volA = engine.master * engine.chA * (1 - p);
  const volB = engine.master * engine.chB * p;
  const playingA = engine.running && (engine.active === engine.deckA || engine.crossfading);
  const playingB = engine.running && (engine.active === engine.deckB || engine.crossfading);
  setVU("vuA", volA, playingA);
  setVU("vuB", volB, playingB);

  const chanA = document.getElementById("chanA"), chanB = document.getElementById("chanB");
  if (chanA) chanA.classList.toggle("live", playingA && volA > 1);
  if (chanB) chanB.classList.toggle("live", playingB && volB > 1);

  const xf = document.getElementById("crossfader");
  if (xf && document.activeElement !== xf) xf.value = String(Math.round(p * 100));
  const mOut = document.getElementById("masterVal");
  if (mOut) mOut.textContent = String(Math.round(engine.master));
}

async function fetchTitle(id) {
  if (engine.titleCache.has(id)) return engine.titleCache.get(id);
  try {
    const r = await fetch("https://www.youtube.com/oembed?format=json&url=https://youtu.be/" + id);
    if (r.ok) { const j = await r.json(); engine.titleCache.set(id, j.title); return j.title; }
  } catch (_) {}
  engine.titleCache.set(id, id);
  return id;
}

/* Extract similar-track video IDs from a fetched YouTube watch/mix page.
 * YouTube Mixes (RD…) generally do NOT expose their list via the IFrame API,
 * so we read it from the page's embedded JSON instead. */
function extractMixIds(html, seedId) {
  const out = [], seen = new Set();
  const push = (id) => { if (/^[\w-]{11}$/.test(id) && !seen.has(id)) { seen.add(id); out.push(id); } };
  let m, re;
  // 1) the Mix / playlist panel (ordered "up next" of the radio)
  re = /"playlistPanelVideoRenderer":\{"videoId":"([\w-]{11})"/g;
  while ((m = re.exec(html))) push(m[1]);
  if (out.length > 1) return out;
  // 2) fallback: related / up-next videos (similar-ish)
  re = /"compactVideoRenderer":\{"videoId":"([\w-]{11})"/g;
  while ((m = re.exec(html))) push(m[1]);
  return out;
}

/* Primary "similar tracks" source: scrape the Mix page (readable + ordered,
 * which enables real crossfades, the queue view and reliable skipping). */
async function fetchMixList(seedId) {
  const urls = [
    "https://www.youtube.com/watch?v=" + seedId + "&list=RD" + seedId + "&hl=en&gl=US",
    "https://www.youtube.com/watch?v=" + seedId + "&hl=en&gl=US",
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url, { credentials: "omit" });
      if (!res.ok) continue;
      const html = await res.text();
      const ids = extractMixIds(html, seedId);
      if (ids.length > 1) {
        if (ids[0] !== seedId) ids.unshift(seedId); // attempt the requested song first
        return ids;
      }
    } catch (_) {}
  }
  return [];
}

/* Secondary source: postMessage radio player (rarely populated for mixes). */
function loadRadioViaPlayer(seedId) {
  return new Promise((resolve) => {
    let done = false;
    engine._radioResolve = (list) => {
      if (done) return; done = true;
      resolve(Array.isArray(list) && list.length ? list.slice() : [seedId]);
    };
    if (!engine.radio) {
      engine.radio = new YTFrame(document.getElementById("radioMount"), {
        onReady: (f) => { f.mute(); f.play(); },
        onInfo: (f, info) => {
          if (Array.isArray(info.playlist) && info.playlist.length) {
            f.pause();
            engine._radioResolve && engine._radioResolve(info.playlist);
          }
        },
      });
    }
    engine.radio.load(seedId, { autoplay: true, list: "RD" + seedId, controls: 0 });
    engine.radio.mute();
    setTimeout(() => engine._radioResolve && engine._radioResolve(engine.radio.info.playlist), 7000);
  });
}

/* Build the "similar tracks" list: fetch-scrape first, player API as fallback. */
async function loadRadio(seedId) {
  const fetched = await fetchMixList(seedId);
  if (fetched.length > 1) { log("Mixを取得: " + fetched.length + " 曲 (fetch)"); return fetched; }
  log("fetchでMix取得できず → プレイヤーAPIを試行");
  return loadRadioViaPlayer(seedId);
}

async function reseed(fromId) {
  if (engine.reseedInFlight) return;
  engine.reseedInFlight = true;
  log("選曲を延長中… (種: " + fromId + ")");
  const list = await loadRadio(fromId);
  const known = new Set(engine.radioList);
  let added = 0;
  for (const id of list) if (!known.has(id)) { engine.radioList.push(id); known.add(id); added++; }
  log("似た曲を " + added + " 曲追加 (合計 " + engine.radioList.length + ")");
  engine.reseedInFlight = false;
  renderQueue();
}

function peekNextId() {
  if (engine.manualQueue.length) return engine.manualQueue[0].videoId;
  if (engine.radioIdx < engine.radioList.length) return engine.radioList[engine.radioIdx];
  return null;
}
function consumeNext() {
  if (engine.manualQueue.length) return engine.manualQueue.shift();
  if (engine.radioIdx < engine.radioList.length) return { videoId: engine.radioList[engine.radioIdx++] };
  return null;
}

/* ---------------- mixer ---------------- */
function sideXf(deck) { return deck === engine.deckB ? 1 : 0; }

/* Single source of truth for both decks' volume:
 * vol = master * channelGain * (crossfader position for that side). */
function applyMix() {
  const p = engine.xfPos;
  if (engine.deckA) engine.deckA.setVolume(engine.master * engine.chA * (1 - p));
  if (engine.deckB) engine.deckB.setVolume(engine.master * engine.chB * p);
  updateMixerUI();
}

/* ---------------- crossfade ---------------- */
function crossfadeTo(nextId, seconds) {
  if (engine.crossfading || !nextId) return;
  engine.crossfading = true;
  const from = engine.active;
  const to = (engine.active === engine.deckA) ? engine.deckB : engine.deckA;
  log("クロスフェード → " + nextId + " (" + seconds + "s)");

  to.loadVideoById(nextId, true);
  to.unmute();

  const startPos = engine.xfPos;
  const endPos = sideXf(to);
  const steps = Math.max(1, Math.round(seconds * 10));
  let i = 0;
  const timer = setInterval(() => {
    i++;
    const t = i / steps;           // 0..1
    engine.xfPos = startPos + (endPos - startPos) * t;
    applyMix();
    if (i >= steps) {
      clearInterval(timer);
      engine.xfPos = endPos;
      from.pause();
      engine.active = to;
      engine.currentId = nextId;
      applyMix();
      // consume the item we just played
      consumeNext();
      markActiveDeck();
      engine.crossfading = false;
      // extend the mix when running low
      if (engine.manualQueue.length === 0 &&
          engine.radioIdx >= engine.radioList.length - 2) reseed(nextId);
      renderQueue();
      refreshNowPlaying();
    }
  }, 100);
}

function goNextNow(seconds) {
  if (engine.nativeRadio) {
    if (engine.manualQueue.length) {
      const item = engine.manualQueue.shift();
      engine.active.loadVideoById(item.videoId, true);
      engine.currentId = item.videoId;
      renderQueue();
    } else {
      engine.active.next();
    }
    return;
  }
  const nextId = peekNextId();
  if (!nextId) { log("次の曲がありません。選曲を作り直します。"); reseed(engine.currentId); return; }
  crossfadeTo(nextId, seconds);
}

/* ---------------- info handling per active deck ---------------- */
function onDeckInfo(frame, info) {
  // Kick off the auto-DJ the moment deck A is live (muted; a click enables sound).
  if (engine.autoStartPending && frame === engine.deckA && !engine.running) {
    engine.autoStartPending = false;
    startMuted();
  }
  if (frame !== engine.active || engine.crossfading || !engine.running) { refreshNowPlaying(); return; }
  const dur = info.duration || 0, cur = info.currentTime || 0;
  if (cur > 0.8) engine.errStreak = 0; // a track is actually playing
  refreshNowPlaying();
  if (engine.nativeRadio) return; // no manual crossfade in native-radio fallback
  if (engine.autoMix && dur > 0) {
    const remaining = dur - cur;
    if (remaining <= engine.xfade && remaining > 0 && peekNextId()) {
      crossfadeTo(peekNextId(), Math.min(engine.xfade, Math.max(2, remaining)));
    }
  }
}
function onDeckState(frame, state) {
  if (frame !== engine.active) return;
  if (engine.nativeRadio) return; // YouTube advances the radio itself
  if (state === YT_STATE.ENDED && !engine.crossfading && engine.running) {
    // short track or autoMix off: hard-ish cut
    goNextNow(engine.autoMix ? Math.min(engine.xfade, 4) : 1);
  }
}
function onDeckError(frame, code) {
  // 101/150/153 = the video owner disabled embedded playback.
  log("再生エラー(code " + code + ") スキップします");
  if (frame !== engine.active || !engine.running || engine.crossfading) return;
  engine.errStreak++;
  if (engine.errStreak > 8) {
    log("埋め込み再生できない動画が続いたため停止しました。別の曲を種にお試しください。");
    pause();
    engine.errStreak = 0;
    return;
  }
  goNextNow(1);
}

/* ---------------- UI refresh ---------------- */
function deckLcd(deck, titleId, subId) {
  const vd = deck && deck.info && deck.info.videoData ? deck.info.videoData : {};
  const tEl = document.getElementById(titleId), sEl = document.getElementById(subId);
  if (tEl) tEl.textContent = vd.title || "—";
  if (sEl) sEl.textContent = vd.author || "";
}
function refreshNowPlaying() {
  const info = engine.active ? engine.active.info : null;
  const vd = info && info.videoData ? info.videoData : {};
  const npTitle = document.getElementById("npTitle");
  if (npTitle) npTitle.textContent =
    vd.title || (engine.currentId ? "読み込み中…" : "— 種になる曲を読み込んでください —");
  const npSub = document.getElementById("npSub");
  if (npSub) npSub.textContent = vd.author || "";
  const dur = info ? info.duration || 0 : 0, cur = info ? info.currentTime || 0 : 0;
  const bar = document.getElementById("progBar");
  if (bar) bar.style.width = dur ? (cur / dur * 100) + "%" : "0%";
  const c = document.getElementById("npCur"), d = document.getElementById("npDur");
  if (c) c.textContent = fmtTime(cur);
  if (d) d.textContent = fmtTime(dur);
  deckLcd(engine.deckA, "lcdA", "lcdASub");
  deckLcd(engine.deckB, "lcdB", "lcdBSub");
}

async function renderQueue() {
  const ol = document.getElementById("qlist");
  const upcoming = [];
  for (const m of engine.manualQueue) upcoming.push({ id: m.videoId, req: true });
  if (!engine.nativeRadio)
    for (let i = engine.radioIdx; i < engine.radioList.length && upcoming.length < 12; i++)
      upcoming.push({ id: engine.radioList[i], req: false });
  ol.innerHTML = "";
  if (engine.nativeRadio && !engine.manualQueue.length) {
    ol.innerHTML = '<li><span class="t">YouTubeラジオが似た曲調を自動再生します（次曲リストは非表示）</span></li>';
    return;
  }
  upcoming.forEach((u, i) => {
    const li = document.createElement("li");
    li.innerHTML =
      '<span class="idx">' + (i + 1) + "</span>" +
      '<span class="t">' + (engine.titleCache.get(u.id) || u.id) + "</span>" +
      (u.req ? ' <span class="req">REQ</span>' : "");
    ol.appendChild(li);
  });
  // lazily fill in titles
  for (const u of upcoming) if (!engine.titleCache.has(u.id)) {
    fetchTitle(u.id).then(() => renderQueueTitlesOnly());
  }
}
function renderQueueTitlesOnly() {
  const items = document.querySelectorAll("#qlist li .t");
  const upIds = [];
  for (const m of engine.manualQueue) upIds.push(m.videoId);
  if (!engine.nativeRadio)
    for (let i = engine.radioIdx; i < engine.radioList.length && upIds.length < 12; i++) upIds.push(engine.radioList[i]);
  items.forEach((el, i) => { if (upIds[i]) el.textContent = engine.titleCache.get(upIds[i]) || upIds[i]; });
}

/* ---------------- lifecycle ---------------- */
function ensureDecks() {
  if (engine.deckA) return;
  const cb = { onInfo: onDeckInfo, onState: onDeckState, onError: onDeckError };
  engine.deckA = new YTFrame(document.getElementById("frameA"), cb);
  engine.deckB = new YTFrame(document.getElementById("frameB"), cb);
}

async function prepare(seedId) {
  ensureDecks();
  engine.seedId = seedId;
  setStatus("選曲を準備中…");
  log("種の曲: " + seedId + " → YouTube Mix を生成");
  const list = await loadRadio(seedId);
  engine.radioList = list;
  engine.radioIdx = 0;
  engine.active = engine.deckA;
  markActiveDeck();

  if (engine.radioList.length <= 1) {
    // Fallback: couldn't read the Mix track-list, so let YouTube's own radio
    // auto-advance on deck A. Similar-track chaining still works (hard cuts).
    engine.nativeRadio = true;
    engine.currentId = seedId;
    engine.deckA.load(seedId, { autoplay: false, list: "RD" + seedId });
    engine.deckA.mute();
    log("Mixリストを取得できず → YouTubeネイティブラジオで自動再生します");
  } else {
    engine.nativeRadio = false;
    // first track = seed (radioList[0])
    engine.currentId = engine.radioList[engine.radioIdx++];
    engine.deckA.load(engine.currentId, { autoplay: false });
    engine.deckA.mute();
    log("準備完了: " + engine.radioList.length + " 曲の似た曲調プレイリスト");
  }
  renderQueue();
  refreshNowPlaying();
  // The DJ runs on its own: begin as soon as deck A is ready (muted); one click
  // enables sound. onDeckInfo triggers this; keep a fallback in case info is slow.
  engine.autoStartPending = true;
  setTimeout(() => { if (engine.autoStartPending) { engine.autoStartPending = false; startMuted(); } }, 3000);
}

/* Auto-start immediately, muted (allowed without a gesture). The DJ selects and
 * mixes on its own; a single click anywhere enables sound after that. */
function startMuted() {
  if (!engine.currentId) return;
  ensureDecks();
  engine.running = true;
  engine.muted = true;
  engine.xfPos = sideXf(engine.active);
  engine.deckA && engine.deckA.mute();
  engine.deckB && engine.deckB.mute();
  applyMix();
  engine.active.play();
  setStatus("🔇 自動再生中 – クリックで音を出す", true);
  setPlayButton(true);
  showUnmute(true);
}
function unmuteAll() {
  if (!engine.running) { start(); return; }
  engine.muted = false;
  engine.deckA && engine.deckA.unmute();
  engine.deckB && engine.deckB.unmute();
  applyMix();
  showUnmute(false);
  setStatus("▶ 再生中 (自動DJ)", true);
  log("サウンド ON");
}
function start() {
  if (!engine.currentId) { log("先に種の曲を読み込んでください"); return; }
  ensureDecks();
  engine.running = true;
  engine.muted = false;
  engine.xfPos = sideXf(engine.active);
  engine.deckA && engine.deckA.unmute();
  engine.deckB && engine.deckB.unmute();
  applyMix();
  engine.active.play();
  setStatus("▶ 再生中 (自動DJ)", true);
  setPlayButton(true);
  showUnmute(false);
}
function pause() {
  engine.running = false;
  engine.active && engine.active.pause();
  setStatus("一時停止");
  setPlayButton(false);
}
function showUnmute(on) {
  const bar = document.getElementById("unmuteBar");
  if (bar) bar.classList.toggle("show", !!on);
}
function setPlayButton(playing) {
  const b = document.getElementById("btnPlay");
  if (b) { b.textContent = playing ? "⏸" : "▶"; b.classList.toggle("on", playing); }
}

/* ---------------- pop-out booth window / focus mode ---------------- */
function popOut() {
  try {
    if (chrome && chrome.tabs && chrome.tabs.getCurrent) {
      chrome.tabs.getCurrent((tab) => {
        if (!tab) { log("ブース窓化に失敗しました"); return; }
        chrome.windows.create({ tabId: tab.id, type: "popup", width: 560, height: 760 });
      });
    } else { log("この環境ではブース窓化できません"); }
  } catch (_) { log("ブース窓化に失敗しました"); }
}
function setCompact(on) {
  document.body.classList.toggle("compact", on);
  try { localStorage.setItem("djit_compact", on ? "1" : "0"); } catch (_) {}
  const b = document.getElementById("btnCompact");
  if (b) { b.classList.toggle("on", on); b.title = on ? "モニターを表示" : "モニターを隠して集中モード"; }
}

/* ---------------- wire up UI ---------------- */
function bindFader(id, onVal) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener("input", () => onVal(+el.value));
}
function bindUI() {
  document.getElementById("btnPlay").addEventListener("click", () => {
    if (!engine.running) start();
    else if (engine.muted) unmuteAll();  // auto-started muted → enable sound
    else pause();
  });

  const unmuteBtn = document.getElementById("btnUnmute");
  if (unmuteBtn) unmuteBtn.addEventListener("click", unmuteAll);

  // Any interaction anywhere enables sound once (browser autoplay policy).
  const onFirstGesture = () => {
    if (engine.running && engine.muted) unmuteAll();
  };
  window.addEventListener("pointerdown", onFirstGesture);
  window.addEventListener("keydown", onFirstGesture);
  document.getElementById("btnSkip").addEventListener("click", () => {
    if (!engine.running) start();
    goNextNow(engine.xfade);
  });
  document.getElementById("btnReseed").addEventListener("click", () => {
    engine.radioList = engine.radioList.slice(0, engine.radioIdx); // drop stale upcoming
    reseed(engine.currentId || engine.seedId);
  });

  // vertical faders + master
  bindFader("master", (v) => { engine.master = v; applyMix(); });
  bindFader("faderA", (v) => { engine.chA = v / 100; applyMix(); });
  bindFader("faderB", (v) => { engine.chB = v / 100; applyMix(); });
  // crossfader (manual A<->B blend)
  bindFader("crossfader", (v) => { engine.xfPos = v / 100; applyMix(); });

  const xf = document.getElementById("xfade"), xfVal = document.getElementById("xfVal");
  xf.addEventListener("input", () => { engine.xfade = +xf.value; xfVal.textContent = xf.value; });

  document.getElementById("autoMix").addEventListener("change", (e) => {
    engine.autoMix = e.target.checked;
    log("自動ミックス: " + (engine.autoMix ? "ON" : "OFF"));
  });

  const compactBtn = document.getElementById("btnCompact");
  if (compactBtn) compactBtn.addEventListener("click", () =>
    setCompact(!document.body.classList.contains("compact")));
  const popBtn = document.getElementById("btnPop");
  if (popBtn) popBtn.addEventListener("click", popOut);

  document.getElementById("addForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const inp = document.getElementById("addUrl");
    const id = parseVideoId(inp.value);
    if (!id) { alert("YouTube URL が不正です"); return; }
    inp.value = "";
    if (!engine.currentId && !engine.seedId) {
      // nothing loaded yet: use this as the seed and auto-start the DJ
      log("種として読み込み: " + id);
      prepare(id);
      return;
    }
    engine.manualQueue.push({ videoId: id });
    fetchTitle(id).then(renderQueueTitlesOnly);
    log("リクエスト追加: " + id);
    renderQueue();
  });
}

/* ---------------- boot ---------------- */
function boot() {
  // hidden mount for the radio (ordering) player
  const rm = document.createElement("div");
  rm.id = "radioMount";
  rm.style.cssText = "position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;left:-9999px;top:0;";
  document.body.appendChild(rm);

  bindUI();
  updateMixerUI();

  const params = new URLSearchParams(location.search);
  let compact = false;
  try { compact = localStorage.getItem("djit_compact") === "1"; } catch (_) {}
  if (params.get("compact") === "1") compact = true;
  setCompact(compact);

  const seed = parseVideoId(params.get("v"));
  if (seed) prepare(seed);
  else setStatus("URLを貼るか、YouTubeから「DJ IT で開始」してください");
}

if (typeof document !== "undefined" && document.getElementById) {
  boot();
}
/* Exported for unit tests (no-op in the browser). */
if (typeof module !== "undefined" && module.exports) {
  module.exports = { parseVideoId, fmtTime, engine, peekNextId, consumeNext, extractMixIds };
}
