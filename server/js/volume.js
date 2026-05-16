'use strict';

const appMixerVolumeTimers = new Map();
const appMixerVolumeQueuedLevels = new Map();
const appMixerVolumeInFlight = new Set();
const mixerIconCache = new Map();
const mixerIconByPidCache = new Map();
const mixerIconByTitleCache = new Map();
let mixerIconFetchInFlight = null;
let mixerIconLastFetchAt = 0;
let mixerProcessIconFetchInFlight = null;
let mixerProcessIconLastFetchAt = 0;
let speakerVolumePendingLevel = null;
let speakerVolumeFlushTimer = null;
let speakerVolumeInFlight = false;
let speakerMuteRequestInFlight = false;
let speakerMuteLockedValue = null;
let speakerMuteLockUntil = 0;
let micVolumePendingLevel = null;
let micVolumeFlushTimer = null;
let micVolumeInFlight = false;
let audioActivityPollTimer = null;
let audioActivityPollInFlight = false;
let audioActivityAnimFrame = 0;
let audioActivityAnimLastAt = 0;
let lastAudioActivityAt = 0;
let speakerVuLevel = 0;
let speakerVuTarget = 0;
const appVuTargets = new Map();
const appVuTargetsByPid = new Map();
const appVuSeenAtById = new Map();
const appVuSeenAtByPid = new Map();
const AUDIO_VU_STALE_MS = 420;
const AUDIO_VU_TRIM_MS = 2200;

const APP_MUTE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16.5 12A4.5 4.5 0 0 0 14 7.97v2.21l2.45 2.45c.03-.2.05-.41.05-.63Zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71ZM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 0 0 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3ZM12 4 9.91 6.09 12 8.18V4Z"/></svg>';
const APP_UNMUTE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9v6h4l5 5V4L7 9H3Zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02ZM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77 0-4.28-2.99-7.86-7-8.77Z"/></svg>';
const SYSTEM_SOUNDS_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a7 7 0 0 0-7 7v4.2l-1.4 2.1A1 1 0 0 0 4.4 17h15.2a1 1 0 0 0 .8-1.7L19 13.2V9a7 7 0 0 0-7-7Zm0 20a3 3 0 0 0 2.82-2H9.18A3 3 0 0 0 12 22Z"/></svg>';
const WHATSAPP_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="#25D366"/><path fill="#fff" d="M17.2 14.8c-.2-.1-1.4-.7-1.6-.7-.2-.1-.4-.1-.5.1-.2.2-.6.7-.8.8-.1.1-.3.1-.5 0-.2-.1-1-.4-1.9-1.2-.7-.6-1.1-1.3-1.3-1.5-.1-.2 0-.3.1-.4.1-.1.2-.3.3-.4.1-.1.1-.2.2-.4.1-.1 0-.3 0-.4 0-.1-.5-1.3-.7-1.7-.2-.5-.4-.4-.5-.4h-.4c-.1 0-.4.1-.5.3-.2.2-.7.7-.7 1.7s.7 2.1.8 2.2c.1.1 1.4 2.2 3.4 3 .5.2.9.4 1.2.5.5.1 1 .1 1.4.1.4-.1 1.4-.6 1.6-1.2.2-.6.2-1.1.1-1.2-.1 0-.3-.1-.5-.2Z"/></svg>';
const APP_MIXER_SLOT_COUNT = 8;

function refreshSlider(v) {
  if (!volSlider) return;
  const safe = Math.max(0, Math.min(100, Number(v) || 0));
  const wrap = volSlider.closest('.global-vol-slider-wrap');
  if (wrap) wrap.style.setProperty('--slider-level', String(safe));
}

function refreshMicSlider(v) {
  if (!micVolSlider) return;
  const safe = Math.max(0, Math.min(100, Number(v) || 0));
  const isMuted = micVolSlider.classList.contains('muted');
  if (micVolTrack) {
    micVolTrack.style.setProperty('--mic-level', safe + '%');
    micVolTrack.classList.toggle('muted', isMuted);
  }
  micVolSlider.style.background = 'transparent';
}

function smoothVuLevelFrame(previous, target, dtMs) {
  const prev = Math.max(0, Math.min(100, Number(previous) || 0));
  const next = Math.max(0, Math.min(100, Number(target) || 0));
  if (next >= prev) return next;
  const dt = Math.max(1, Math.min(120, Number(dtMs) || 16));
  const fallTauMs = 24;
  const tau = fallTauMs;
  const alpha = 1 - Math.exp(-dt / tau);
  const smoothed = prev + ((next - prev) * alpha);
  if (Math.abs(smoothed - next) < 0.05) return next;
  return Math.max(0, Math.min(100, smoothed));
}

function clampPercent(value) {
  return Math.max(0, Math.min(100, Number(value) || 0));
}

function scaleVuByVolume(activityLevel, volumeLevel, muted = false) {
  if (muted) return 0;
  const activity = clampPercent(activityLevel);
  const volume = clampPercent(volumeLevel);
  return (activity * volume) / 100;
}

function renderGlobalVuLevel() {
  const wrap = volSlider ? volSlider.closest('.global-vol-slider-wrap') : null;
  if (!wrap) return;
  wrap.style.setProperty('--vu-level', String(Math.max(0, Math.min(100, speakerVuLevel))));
}

function animateAudioActivityFrame(nowMs) {
  audioActivityAnimFrame = requestAnimationFrame(animateAudioActivityFrame);
  const now = Number(nowMs) || Date.now();
  const last = audioActivityAnimLastAt || now;
  const dtMs = Math.max(1, Math.min(80, now - last));
  audioActivityAnimLastAt = now;
  const stale = (now - lastAudioActivityAt) > 220;

  const currentSpeakerVolume = clampPercent(volSlider ? Number(volSlider.value) : (audioData && audioData.speaker ? audioData.speaker.volume : 0));
  const globalRawTarget = speakerMuted ? 0 : (stale ? 0 : speakerVuTarget);
  const globalTarget = scaleVuByVolume(globalRawTarget, currentSpeakerVolume, speakerMuted);
  speakerVuLevel = smoothVuLevelFrame(speakerVuLevel, globalTarget, dtMs);
  renderGlobalVuLevel();

  if (!appMixerList) return;
  const items = appMixerList.querySelectorAll('.app-mixer-item[data-app-id]');
  items.forEach(item => {
    const id = String(item.dataset.appId || '');
    const pid = Number(item.dataset.appPid || 0);
    const wrap = item.querySelector('.app-mixer-slider-wrap');
    if (!id || !wrap) return;
    const isMuted = item.dataset.muted === 'true';
    const appVolume = clampPercent(Number(item.dataset.volume || 0));
    let byId = 0;
    const idSeenAt = Number(appVuSeenAtById.get(id) || 0);
    if (idSeenAt > 0) {
      const idAge = now - idSeenAt;
      if (idAge <= AUDIO_VU_STALE_MS) byId = Number(appVuTargets.get(id) || 0);
      if (idAge > AUDIO_VU_TRIM_MS) {
        appVuTargets.delete(id);
        appVuSeenAtById.delete(id);
      }
    }
    let byPid = 0;
    if (Number.isFinite(pid) && pid > 0) {
      const pidSeenAt = Number(appVuSeenAtByPid.get(pid) || 0);
      if (pidSeenAt > 0) {
        const pidAge = now - pidSeenAt;
        if (pidAge <= AUDIO_VU_STALE_MS) byPid = Number(appVuTargetsByPid.get(pid) || 0);
        if (pidAge > AUDIO_VU_TRIM_MS) {
          appVuTargetsByPid.delete(pid);
          appVuSeenAtByPid.delete(pid);
        }
      }
    }
    const rawTarget = isMuted ? 0 : (stale ? 0 : Math.max(byId, byPid));
    const target = scaleVuByVolume(rawTarget, appVolume, isMuted);
    const current = Number(item.dataset.vuLevel || 0);
    const smoothed = smoothVuLevelFrame(current, target, dtMs);
    item.dataset.vuLevel = String(smoothed);
    wrap.style.setProperty('--vu-level', String(Math.max(0, Math.min(100, smoothed))));
  });
}

function applyAudioActivity(payload) {
  speakerVuTarget = Math.max(0, Math.min(100, Number(payload && payload.speaker) || 0));
  const now = Date.now();
  const apps = payload && Array.isArray(payload.apps) ? payload.apps : [];
  apps.forEach(item => {
    const id = String(item && item.id || '').trim();
    const pid = Number(item && item.processId);
    const validPid = Number.isFinite(pid) && pid > 0 ? pid : 0;
    if (!id && validPid <= 0) return;
    const activity = Math.max(0, Math.min(100, Number(item && item.activity) || 0));
    if (id) {
      appVuTargets.set(id, activity);
      appVuSeenAtById.set(id, now);
    }
    if (validPid > 0) {
      appVuTargetsByPid.set(validPid, activity);
      appVuSeenAtByPid.set(validPid, now);
    }
  });
  lastAudioActivityAt = now;
}

async function fetchAudioActivity() {
  if (audioActivityPollInFlight) return;
  audioActivityPollInFlight = true;
  try {
    const res = await fetch(SERVER + '/audio/activity', { cache: 'no-store' });
    if (!res.ok) throw new Error('Audio activity failed');
    const data = await res.json();
    applyAudioActivity(data);
  } catch {
    // Keep the last targets and let the frame decay handle brief transport hiccups.
  } finally {
    audioActivityPollInFlight = false;
  }
}

function ensureAudioActivityPolling() {
  if (!audioActivityAnimFrame) {
    audioActivityAnimFrame = requestAnimationFrame(animateAudioActivityFrame);
  }
  if (audioActivityPollTimer) return;
  lastAudioActivityAt = Date.now();
  fetchAudioActivity();
  // Fallback polling only when push updates are stale.
  audioActivityPollTimer = setInterval(() => {
    if ((Date.now() - lastAudioActivityAt) <= 220) return;
    fetchAudioActivity();
  }, 60);
}

function onSliderInput(v) {
  const level = parseInt(v, 10);
  if (volVal) volVal.textContent = level + '%';
  refreshSlider(level);
  speakerVolumePendingLevel = level;
  clearTimeout(speakerVolumeFlushTimer);
  speakerVolumeFlushTimer = setTimeout(flushSpeakerVolumeQueue, 35);
}

async function flushSpeakerVolumeQueue() {
  speakerVolumeFlushTimer = null;
  if (speakerVolumeInFlight) return;
  if (speakerVolumePendingLevel === null) return;
  const level = speakerVolumePendingLevel;
  speakerVolumePendingLevel = null;
  speakerVolumeInFlight = true;
  try {
    await sendVolume(level);
  } finally {
    speakerVolumeInFlight = false;
    if (speakerVolumePendingLevel !== null && speakerVolumePendingLevel !== level) {
      flushSpeakerVolumeQueue();
    }
  }
}

async function sendVolume(level) {
  try {
    const res = await fetch(SERVER + '/volume/set', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level }),
    });
    if (!res.ok) throw new Error('Volume failed');
    setOnline();
  } catch { setOffline(); }
}

async function toggleSpeakerMute() {
  if (speakerMuteRequestInFlight) return;
  const previous = speakerMuted;
  const next = !speakerMuted;
  speakerMuteRequestInFlight = true;
  speakerMuteLockedValue = next;
  speakerMuteLockUntil = Date.now() + 5000;
  applySpeakerMute(next);
  try {
    const res = await fetch(SERVER + '/speaker/mute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mute: next }),
    });
    if (!res.ok) throw new Error('Speaker mute failed');
    const payload = await res.json().catch(() => null);
    if (payload && typeof payload.muted === 'boolean') {
      speakerMuteLockedValue = payload.muted;
      speakerMuteLockUntil = Date.now() + 5000;
      applySpeakerMute(payload.muted);
    }
    setOnline();
    // Pull authoritative state immediately instead of waiting for the next SSE tick.
    fetchAudio();
  } catch {
    applySpeakerMute(previous);
    speakerMuteLockedValue = null;
    speakerMuteLockUntil = 0;
    setOffline();
  } finally {
    speakerMuteRequestInFlight = false;
  }
}

function applySpeakerMute(m) {
  speakerMuted = !!m;
  if (volMuteBtn) volMuteBtn.classList.toggle('speaker-muted', speakerMuted);
  const wrap = volSlider ? volSlider.closest('.global-vol-slider-wrap') : null;
  if (wrap) wrap.classList.toggle('speaker-muted', speakerMuted);
  if (speakerMuted && wrap) {
    speakerVuLevel = 0;
    speakerVuTarget = 0;
    wrap.style.setProperty('--vu-level', '0');
  }
  if (spkIconOn) spkIconOn.style.display = speakerMuted ? 'none' : '';
  if (spkIconOff) spkIconOff.style.display = speakerMuted ? '' : 'none';
}

function normalizeAudioApps(data) {
  if (!Array.isArray(data)) return [];
  return data
    .filter(item => item && item.id)
    .filter(item => !/qtwebengineprocess(?:\.exe)?/i.test(String(item.id || item.label || item.name || '')))
    .map(item => ({
      id: String(item.id),
      name: String(item.name || item.label || item.title || 'App').trim() || 'App',
      label: String(item.label || '').trim(),
      title: String(item.title || '').trim(),
      processId: Number.isFinite(Number(item.processId)) ? Number(item.processId) : 0,
      volume: Math.max(0, Math.min(100, Number(item.volume) || 0)),
      muted: !!item.muted,
      activity: Math.max(0, Math.min(100, Number(item.activity) || 0)),
    }));
}

function canonicalMixerToken(value) {
  const raw = String(value || '').trim().toLowerCase().replace(/\.exe$/i, '');
  if (!raw) return '';
  if (raw.includes('system sounds') || raw.includes('audiosrv.dll')) return 'systemsounds';
  let token = raw.replace(/[^a-z0-9]+/g, '');
  if (token.includes('audiosrvdll')) return 'systemsounds';
  if (token === 'googlechrome') token = 'chrome';
  if (token === 'microsoftedgewebview2') token = 'msedge';
  if (token === 'msedgewebview2') token = 'msedge';
  if (token === 'whatsapproot') token = 'whatsapp';
  return token;
}

function mixerAppToken(app) {
  return canonicalMixerToken(app.label) || canonicalMixerToken(app.name) || canonicalMixerToken(app.id);
}

function isSystemSoundsToken(token) {
  return token === 'systemsounds' || token === 'audiosrvdll';
}

function resolveMixerPresentation(app) {
  const rawName = String(app.name || 'App').trim() || 'App';
  const baseToken = mixerAppToken(app);
  let displayName = rawName;
  let iconToken = baseToken;

  const sourceLabel = `${app.label || ''} ${app.name || ''}`.toLowerCase();

  if (isSystemSoundsToken(baseToken)) {
    displayName = 'System Sounds';
  } else if (baseToken === 'msedge' && sourceLabel.includes('webview2')) {
    iconToken = 'whatsapp';
  }

  return { displayName, iconToken, baseToken };
}

function mixerSortComparator(left, right) {
  const leftSystem = isSystemSoundsToken(left.presentation.baseToken);
  const rightSystem = isSystemSoundsToken(right.presentation.baseToken);
  if (leftSystem && !rightSystem) return -1;
  if (!leftSystem && rightSystem) return 1;
  return left.presentation.displayName.localeCompare(right.presentation.displayName, undefined, { sensitivity: 'base', numeric: true });
}

function mixerIconToken(name) {
  const key = String(name || '').trim().toLowerCase();
  if (!key) return 'A';
  if (key.includes('whatsapp')) return 'WA';
  if (key.includes('youtube')) return 'YT';
  if (key.includes('spotify')) return 'SP';
  if (key.includes('chrome')) return 'CH';
  if (key.includes('discord')) return 'DC';
  if (key.includes('jellyfin')) return 'JF';
  if (key.includes('system sounds')) return 'SS';
  const clean = key.replace(/[^a-z0-9]+/g, ' ').trim();
  const parts = clean.split(/\s+/).filter(Boolean);
  if (!parts.length) return 'A';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function normalizeTitleToken(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function captureMixerIconsFromWindows(data) {
  const windows = data && Array.isArray(data.windows) ? data.windows : [];
  windows.forEach(win => {
    const token = canonicalMixerToken(win && win.app);
    const icon = win && typeof win.icon === 'string' ? win.icon : '';
    if (!icon) return;
    if (token && !mixerIconCache.has(token)) mixerIconCache.set(token, icon);
    const pid = Number(win && win.processId);
    if (Number.isFinite(pid) && pid > 0) {
      mixerIconByPidCache.set(pid, icon);
    }
    const titleToken = normalizeTitleToken(win && win.title);
    if (titleToken && !mixerIconByTitleCache.has(titleToken)) {
      mixerIconByTitleCache.set(titleToken, icon);
    }
  });
}

function captureMixerIconsFromProcessList(data) {
  const icons = data && Array.isArray(data.icons) ? data.icons : [];
  icons.forEach(item => {
    const pid = Number(item && item.processId);
    const icon = item && typeof item.icon === 'string' ? item.icon : '';
    if (!icon) return;
    if (Number.isFinite(pid) && pid > 0 && !mixerIconByPidCache.has(pid)) {
      mixerIconByPidCache.set(pid, icon);
    }
  });
}

function ensureMixerIcons(force = false) {
  const age = Date.now() - mixerIconLastFetchAt;
  if (!force && (mixerIconFetchInFlight || age < 20000)) return;
  mixerIconFetchInFlight = fetch(SERVER + '/windows', { cache: 'no-store' })
    .then(res => (res.ok ? res.json() : null))
    .then(data => {
      if (data) captureMixerIconsFromWindows(data);
    })
    .catch(() => {})
    .finally(() => {
      mixerIconLastFetchAt = Date.now();
      mixerIconFetchInFlight = null;
      if (audioData && audioData.apps) renderAppMixer(audioData.apps);
    });
}

function ensureMixerProcessIcons(processIds, force = false) {
  const ids = Array.isArray(processIds)
    ? processIds.map(value => Number(value)).filter(value => Number.isFinite(value) && value > 0)
    : [];
  const unresolved = ids.filter(pid => !mixerIconByPidCache.has(pid));
  if (!unresolved.length) return;

  const age = Date.now() - mixerProcessIconLastFetchAt;
  if (!force && (mixerProcessIconFetchInFlight || age < 7000)) return;

  const query = encodeURIComponent(unresolved.slice(0, 64).join(','));
  mixerProcessIconFetchInFlight = fetch(`${SERVER}/windows?icons=1&pids=${query}`, { cache: 'no-store' })
    .then(res => (res.ok ? res.json() : null))
    .then(data => {
      if (data) captureMixerIconsFromProcessList(data);
    })
    .catch(() => {})
    .finally(() => {
      mixerProcessIconLastFetchAt = Date.now();
      mixerProcessIconFetchInFlight = null;
      if (audioData && audioData.apps) renderAppMixer(audioData.apps);
    });
}

function setAppMuteVisual(button, item, muted) {
  button.classList.toggle('muted', !!muted);
  button.innerHTML = muted ? APP_MUTE_ICON : APP_UNMUTE_ICON;
  if (item) item.dataset.muted = muted ? 'true' : 'false';
}

async function sendAppVolume(id, level) {
  const safeLevel = Math.max(0, Math.min(100, Number(level) || 0));
  try {
    const res = await fetch(SERVER + '/audio/app/volume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, level: safeLevel }),
    });
    if (!res.ok) throw new Error('App volume failed');
    setOnline();
  } catch { setOffline(); }
}

async function sendAppMute(id, mute) {
  try {
    const res = await fetch(SERVER + '/audio/app/mute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, mute: !!mute }),
    });
    if (!res.ok) throw new Error('App mute failed');
    setOnline();
    return true;
  } catch {
    setOffline();
    return false;
  }
}

function queueAppVolumeUpdate(id, level) {
  const key = String(id);
  appMixerVolumeQueuedLevels.set(key, level);
  clearTimeout(appMixerVolumeTimers.get(key));
  const timer = setTimeout(() => {
    appMixerVolumeTimers.delete(key);
    flushAppVolumeQueue(key);
  }, 35);
  appMixerVolumeTimers.set(key, timer);
}

async function flushAppVolumeQueue(key) {
  if (appMixerVolumeInFlight.has(key)) return;
  if (!appMixerVolumeQueuedLevels.has(key)) return;
  const level = appMixerVolumeQueuedLevels.get(key);
  appMixerVolumeQueuedLevels.delete(key);
  appMixerVolumeInFlight.add(key);
  try {
    await sendAppVolume(key, level);
  } finally {
    appMixerVolumeInFlight.delete(key);
    if (appMixerVolumeQueuedLevels.has(key)) flushAppVolumeQueue(key);
  }
}

function renderAppMixer(rawApps) {
  if (!appMixerList || !appMixerShell) return;
  let missingIcon = false;
  const unresolvedIconPids = [];
  const apps = normalizeAudioApps(rawApps)
    .map(app => ({ app, presentation: resolveMixerPresentation(app) }))
    .sort(mixerSortComparator)
    .slice(0, APP_MIXER_SLOT_COUNT);

  appMixerShell.dataset.empty = 'false';
  if (appMixerEmpty) appMixerEmpty.hidden = true;

  const fragment = document.createDocumentFragment();
  apps.forEach(entry => {
    const app = entry.app;
    const presentation = entry.presentation;
    const item = document.createElement('div');
    item.className = 'app-mixer-item';
    item.dataset.muted = app.muted ? 'true' : 'false';
    item.dataset.appId = app.id;
    item.dataset.appPid = app.processId > 0 ? String(app.processId) : '';
    item.dataset.volume = String(clampPercent(app.volume));
    item.title = app.title || app.name;

    const muteBtn = document.createElement('button');
    muteBtn.type = 'button';
    muteBtn.className = 'app-mixer-mute';
    setAppMuteVisual(muteBtn, item, app.muted);
    muteBtn.addEventListener('click', async eventObject => {
      eventObject.preventDefault();
      const previous = item.dataset.muted === 'true';
      const next = !previous;
      setAppMuteVisual(muteBtn, item, next);
      const ok = await sendAppMute(app.id, next);
      if (!ok) setAppMuteVisual(muteBtn, item, previous);
    });

    const sliderWrap = document.createElement('div');
    sliderWrap.className = 'app-mixer-slider-wrap';
    const vuById = Number(appVuTargets.get(app.id) || 0);
    const vuByPid = app.processId > 0 ? Number(appVuTargetsByPid.get(app.processId) || 0) : 0;
    const initialRawVu = Math.max(vuById, vuByPid, Math.max(0, Math.min(100, Number(app.activity) || 0)));
    const initialVu = scaleVuByVolume(initialRawVu, app.volume, app.muted);
    item.dataset.vuLevel = String(initialVu);
    sliderWrap.style.setProperty('--vu-level', String(initialVu));

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.className = 'app-mixer-slider';
    slider.min = '0';
    slider.max = '100';
    slider.value = String(app.volume);
    slider.setAttribute('aria-label', app.name);

    const value = document.createElement('div');
    value.className = 'app-mixer-volume';
    value.textContent = `${Math.round(app.volume)}%`;
    const applyMixerFill = amount => {
      const safeAmount = Math.max(0, Math.min(100, Number(amount) || 0));
      sliderWrap.style.setProperty('--slider-level', String(safeAmount));
    };
    applyMixerFill(app.volume);

    slider.addEventListener('input', () => {
      const level = Math.max(0, Math.min(100, Number(slider.value) || 0));
      value.textContent = `${Math.round(level)}%`;
      applyMixerFill(level);
      item.dataset.volume = String(level);
      queueAppVolumeUpdate(app.id, level);
    });

    sliderWrap.appendChild(slider);

    const icon = document.createElement('div');
    icon.className = 'app-mixer-appicon';
    icon.title = presentation.displayName;
    if (presentation.iconToken === 'whatsapp') {
      icon.innerHTML = WHATSAPP_ICON;
      item.append(value, muteBtn, sliderWrap, icon);
      fragment.appendChild(item);
      return;
    }
    const iconByPid = app.processId > 0 ? (mixerIconByPidCache.get(app.processId) || '') : '';
    const iconByToken = presentation.iconToken ? (mixerIconCache.get(presentation.iconToken) || '') : '';
    const iconByTitle = normalizeTitleToken(app.title) ? (mixerIconByTitleCache.get(normalizeTitleToken(app.title)) || '') : '';
    const iconSrc = iconByTitle || iconByPid || iconByToken;
    if (iconSrc) {
      const image = document.createElement('img');
      image.src = iconSrc;
      image.alt = '';
      image.loading = 'lazy';
      icon.appendChild(image);
    } else if (isSystemSoundsToken(presentation.baseToken)) {
      icon.innerHTML = SYSTEM_SOUNDS_ICON;
    } else {
      missingIcon = true;
      if (app.processId > 0) unresolvedIconPids.push(app.processId);
      icon.textContent = mixerIconToken(presentation.displayName);
    }

    item.append(value, muteBtn, sliderWrap, icon);
    fragment.appendChild(item);
  });

  for (let index = apps.length; index < APP_MIXER_SLOT_COUNT; index += 1) {
    const item = document.createElement('div');
    item.className = 'app-mixer-item slot-empty';
    item.dataset.muted = 'false';

    const value = document.createElement('div');
    value.className = 'app-mixer-volume';
    value.textContent = '--%';

    const muteBtn = document.createElement('button');
    muteBtn.type = 'button';
    muteBtn.className = 'app-mixer-mute';
    muteBtn.innerHTML = APP_UNMUTE_ICON;
    muteBtn.disabled = true;
    muteBtn.tabIndex = -1;
    muteBtn.setAttribute('aria-hidden', 'true');

    const sliderWrap = document.createElement('div');
    sliderWrap.className = 'app-mixer-slider-wrap';
    sliderWrap.style.setProperty('--slider-level', '0');
    sliderWrap.style.setProperty('--vu-level', '0');
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.className = 'app-mixer-slider';
    slider.min = '0';
    slider.max = '100';
    slider.value = '0';
    slider.disabled = true;
    slider.tabIndex = -1;
    slider.setAttribute('aria-hidden', 'true');
    sliderWrap.appendChild(slider);

    const icon = document.createElement('div');
    icon.className = 'app-mixer-appicon';

    item.append(value, muteBtn, sliderWrap, icon);
    fragment.appendChild(item);
  }

  appMixerList.replaceChildren(fragment);
  ensureMixerIcons(missingIcon);
  ensureMixerProcessIcons(unresolvedIconPids, missingIcon);
  ensureAudioActivityPolling();
}

function applyAudio(data) {
  ensureAudioActivityPolling();
  const normalizedData = typeof reconcileQuickOutputAudioSnapshot === 'function'
    ? reconcileQuickOutputAudioSnapshot(data || null)
    : (data || null);
  audioData = normalizedData;
  if (normalizedData && normalizedData.speaker) {
    const speaker = normalizedData.speaker.name || normalizedData.speaker.label;
    if (spkName) spkName.textContent = speaker;
    const vol = normalizedData.speaker.volume;
    if (volSlider && document.activeElement !== volSlider) volSlider.value = vol;
    if (volVal) volVal.textContent = vol + '%';
    refreshSlider(vol);
    const serverMuted = !!normalizedData.speaker.muted;
    if (speakerMuteLockedValue !== null) {
      if (serverMuted === speakerMuteLockedValue) {
        applySpeakerMute(serverMuted);
        speakerMuteLockedValue = null;
        speakerMuteLockUntil = 0;
      } else if (Date.now() < speakerMuteLockUntil) {
        // Ignore one stale update during the post-toggle settle window.
        applySpeakerMute(speakerMuteLockedValue);
      } else {
        applySpeakerMute(serverMuted);
        speakerMuteLockedValue = null;
        speakerMuteLockUntil = 0;
      }
    } else {
      applySpeakerMute(serverMuted);
    }
  }
  if (normalizedData && normalizedData.mic) {
    const mic = normalizedData.mic.name || normalizedData.mic.label;
    if (micName) micName.textContent = mic;
    if (micContext) micContext.textContent = mic;
    const mv = Number(normalizedData.mic.volume);
    if (Number.isFinite(mv) && micVolSlider && document.activeElement !== micVolSlider) {
      micVolSlider.value = mv;
      if (micVolVal) micVolVal.textContent = mv + '%';
    }
    if (micVolSlider) micVolSlider.classList.toggle('muted', !!normalizedData.mic.muted);
    if (micVolSlider) refreshMicSlider(micVolSlider.value);
  }

  renderAppMixer(normalizedData && normalizedData.apps);
  if (typeof syncQuickShortcutButton === 'function') syncQuickShortcutButton();
  if ($('settings-overlay') && !$('settings-overlay').hidden && typeof renderQuickOutputSwitchControls === 'function') {
    renderQuickOutputSwitchControls();
  }
}

function onMicVolumeInput(v) {
  const level = parseInt(v, 10);
  if (micVolVal) micVolVal.textContent = level + '%';
  refreshMicSlider(level);
  micVolumePendingLevel = level;
  clearTimeout(micVolumeFlushTimer);
  micVolumeFlushTimer = setTimeout(flushMicVolumeQueue, 35);
}

async function flushMicVolumeQueue() {
  micVolumeFlushTimer = null;
  if (micVolumeInFlight) return;
  if (micVolumePendingLevel === null) return;
  const level = micVolumePendingLevel;
  micVolumePendingLevel = null;
  micVolumeInFlight = true;
  try {
    await sendMicVolume(level);
  } finally {
    micVolumeInFlight = false;
    if (micVolumePendingLevel !== null && micVolumePendingLevel !== level) {
      flushMicVolumeQueue();
    }
  }
}

async function sendMicVolume(level) {
  try {
    const res = await fetch(SERVER + '/mic/volume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level }),
    });
    if (!res.ok) throw new Error('Mic volume failed');
    setOnline();
  } catch { setOffline(); }
}

async function fetchAudio() {
  if (fetchingAudio) return;
  fetchingAudio = true;
  try {
    const res = await fetch(SERVER + '/audio');
    const data = await res.json();
    applyAudio(data);
    setOnline();
  } catch { setOffline(); }
  fetchingAudio = false;
}
