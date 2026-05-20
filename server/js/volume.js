'use strict';

const appMixerVolumeTimers = new Map();
const appMixerVolumeQueuedLevels = new Map();
const appMixerVolumeInFlight = new Set();
const mixerIconCache = new Map();
const mixerIconByPidCache = new Map();
const mixerIconByTitleCache = new Map();
const mixerTitleTokenByPidCache = new Map();
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
let speakerSliderInteracting = false;
let micSliderInteracting = false;
let lastSpeakerSliderInputAt = 0;
let lastMicSliderInputAt = 0;
let speakerVolumeLockedLevel = null;
let speakerVolumeLockUntil = 0;
let micVolumeLockedLevel = null;
let micVolumeLockUntil = 0;
let appMixerRenderDeferredTimer = null;
let appMixerRenderPendingApps = null;
let lastAppMixerSliderInputAt = 0;
const appMixerSliderInteractingIds = new Set();
const appMixerLockedVolumes = new Map();
const appMixerLockedMutes = new Map();
const appMixerMuteInFlight = new Set();
const appMixerMuteDesiredStates = new Map();
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
const AUDIO_VU_ACTIVITY_STALE_MS = 220;
const AUDIO_VU_STALE_MS = 420;
const AUDIO_VU_TRIM_MS = 2200;
const AUDIO_VU_SILENCE_FLOOR = 2;
const APP_MIXER_RENDER_DEFER_MS = 140;
const VOLUME_INTERACTION_IDLE_MS = 320;
const VOLUME_LEVEL_LOCK_MS = 1600;
const VOLUME_POST_DEBOUNCE_MS = 55;
const APP_MIXER_VOLUME_LOCK_MS = 1600;
const APP_MIXER_MUTE_LOCK_MS = 5000;

const APP_MUTE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16.5 12A4.5 4.5 0 0 0 14 7.97v2.21l2.45 2.45c.03-.2.05-.41.05-.63Zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71ZM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 0 0 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3ZM12 4 9.91 6.09 12 8.18V4Z"/></svg>';
const APP_UNMUTE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9v6h4l5 5V4L7 9H3Zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02ZM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77 0-4.28-2.99-7.86-7-8.77Z"/></svg>';
const SYSTEM_SOUNDS_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a7 7 0 0 0-7 7v4.2l-1.4 2.1A1 1 0 0 0 4.4 17h15.2a1 1 0 0 0 .8-1.7L19 13.2V9a7 7 0 0 0-7-7Zm0 20a3 3 0 0 0 2.82-2H9.18A3 3 0 0 0 12 22Z"/></svg>';
const WHATSAPP_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="#25D366"/><path fill="#fff" d="M17.2 14.8c-.2-.1-1.4-.7-1.6-.7-.2-.1-.4-.1-.5.1-.2.2-.6.7-.8.8-.1.1-.3.1-.5 0-.2-.1-1-.4-1.9-1.2-.7-.6-1.1-1.3-1.3-1.5-.1-.2 0-.3.1-.4.1-.1.2-.3.3-.4.1-.1.1-.2.2-.4.1-.1 0-.3 0-.4 0-.1-.5-1.3-.7-1.7-.2-.5-.4-.4-.5-.4h-.4c-.1 0-.4.1-.5.3-.2.2-.7.7-.7 1.7s.7 2.1.8 2.2c.1.1 1.4 2.2 3.4 3 .5.2.9.4 1.2.5.5.1 1 .1 1.4.1.4-.1 1.4-.6 1.6-1.2.2-.6.2-1.1.1-1.2-.1 0-.3-.1-.5-.2Z"/></svg>';
const APP_MIXER_SLOT_COUNT = 8;
const MIXER_GENERIC_ICON_TOKENS = new Set(['chrome', 'msedge', 'edge', 'firefox', 'brave', 'opera', 'browser', 'qtwebengineprocess']);
const APP_MIXER_FILTERED_SESSION_RE = /\bqtwebengine(?:process)?(?:\.exe)?\b/i;
const MIXER_ICON_REFRESH_INTERVAL_MS = 2500;
const MIXER_PROCESS_ICON_REFRESH_INTERVAL_MS = 1300;
const MIXER_MEDIA_SERVICE_ICON_BY_TOKEN = Object.freeze({
  jellyfin: 'https://upload.wikimedia.org/wikipedia/commons/4/41/Jellyfin_-_icon-transparent.svg',
  youtube: 'https://www.google.com/s2/favicons?domain=youtube.com&sz=64',
  twitch: 'https://www.google.com/s2/favicons?domain=twitch.tv&sz=64',
  'youtube-music': 'https://www.google.com/s2/favicons?domain=music.youtube.com&sz=64',
});

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

function buildAppVuStateKey(id, pid) {
  const safeId = String(id || '').trim();
  if (safeId) return `id:${safeId}`;
  const safePid = Number.isFinite(Number(pid)) ? Number(pid) : 0;
  if (safePid > 0) return `pid:${safePid}`;
  return '';
}

function readTrackedAppVuRawTarget(id, pid, now) {
  const safeNow = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  let byId = 0;
  const safeId = String(id || '').trim();
  if (safeId) {
    const idSeenAt = Number(appVuSeenAtById.get(safeId) || 0);
    if (idSeenAt > 0) {
      const idAge = safeNow - idSeenAt;
      if (idAge <= AUDIO_VU_STALE_MS) byId = Number(appVuTargets.get(safeId) || 0);
      if (idAge > AUDIO_VU_TRIM_MS) {
        appVuTargets.delete(safeId);
        appVuSeenAtById.delete(safeId);
      }
    }
  }

  let byPid = 0;
  const safePid = Number.isFinite(Number(pid)) ? Number(pid) : 0;
  if (safePid > 0) {
    const pidSeenAt = Number(appVuSeenAtByPid.get(safePid) || 0);
    if (pidSeenAt > 0) {
      const pidAge = safeNow - pidSeenAt;
      if (pidAge <= AUDIO_VU_STALE_MS) byPid = Number(appVuTargetsByPid.get(safePid) || 0);
      if (pidAge > AUDIO_VU_TRIM_MS) {
        appVuTargetsByPid.delete(safePid);
        appVuSeenAtByPid.delete(safePid);
      }
    }
  }

  return Math.max(0, Math.min(100, Math.max(byId, byPid)));
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
  const stale = (now - lastAudioActivityAt) > AUDIO_VU_ACTIVITY_STALE_MS;

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
    const rawTarget = isMuted ? 0 : (stale ? 0 : readTrackedAppVuRawTarget(id, pid, now));
    const target = scaleVuByVolume(rawTarget, appVolume, isMuted);
    const current = Number(item.dataset.vuLevel || 0);
    const smoothed = smoothVuLevelFrame(current, target, dtMs);
    item.dataset.vuLevel = String(smoothed);
    wrap.style.setProperty('--vu-level', String(Math.max(0, Math.min(100, smoothed))));
  });
}

function applyAudioActivity(payload) {
  const speakerActivity = Math.max(0, Math.min(100, Number(payload && payload.speaker) || 0));
  speakerVuTarget = speakerActivity;
  const forceSilentApps = speakerActivity <= AUDIO_VU_SILENCE_FLOOR;
  const now = Date.now();
  const apps = payload && Array.isArray(payload.apps) ? payload.apps : [];
  apps.forEach(item => {
    const id = String(item && item.id || '').trim();
    const pid = Number(item && item.processId);
    const validPid = Number.isFinite(pid) && pid > 0 ? pid : 0;
    if (!id && validPid <= 0) return;
    let activity = Math.max(0, Math.min(100, Number(item && item.activity) || 0));
    if (forceSilentApps) activity = 0;
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
    if ((Date.now() - lastAudioActivityAt) <= AUDIO_VU_ACTIVITY_STALE_MS) return;
    fetchAudioActivity();
  }, 60);
}

function onSliderInput(v) {
  const level = parseInt(v, 10);
  lastSpeakerSliderInputAt = Date.now();
  speakerVolumeLockedLevel = Math.max(0, Math.min(100, Number(level) || 0));
  speakerVolumeLockUntil = lastSpeakerSliderInputAt + VOLUME_LEVEL_LOCK_MS;
  if (volVal) volVal.textContent = level + '%';
  refreshSlider(level);
  speakerVolumePendingLevel = level;
  clearTimeout(speakerVolumeFlushTimer);
  speakerVolumeFlushTimer = setTimeout(flushSpeakerVolumeQueue, VOLUME_POST_DEBOUNCE_MS);
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

function setAppMixerSliderInteracting(id, active) {
  const key = String(id || '').trim();
  if (!key) return;
  if (active) {
    appMixerSliderInteractingIds.add(key);
    lastAppMixerSliderInputAt = Date.now();
    return;
  }
  appMixerSliderInteractingIds.delete(key);
}

function setAppMixerVolumeLock(id, level, lockUntil = 0) {
  const key = String(id || '').trim();
  if (!key) return;
  const safeLevel = clampPercent(level);
  const until = Number(lockUntil) || (Date.now() + APP_MIXER_VOLUME_LOCK_MS);
  appMixerLockedVolumes.set(key, { level: safeLevel, lockUntil: until });
}

function resolveAppMixerVolume(id, incomingLevel, now = Date.now()) {
  const key = String(id || '').trim();
  const incoming = clampPercent(incomingLevel);
  if (!key) return incoming;
  const lock = appMixerLockedVolumes.get(key);
  if (!lock) return incoming;
  if (incoming === clampPercent(lock.level)) {
    appMixerLockedVolumes.delete(key);
    return incoming;
  }
  if (now < Number(lock.lockUntil || 0)) {
    return clampPercent(lock.level);
  }
  appMixerLockedVolumes.delete(key);
  return incoming;
}

function setAppMixerMuteLock(id, muted, lockUntil = 0) {
  const key = String(id || '').trim();
  if (!key) return;
  const until = Number(lockUntil) || (Date.now() + APP_MIXER_MUTE_LOCK_MS);
  appMixerLockedMutes.set(key, { muted: !!muted, lockUntil: until });
}

function clearAppMixerMuteLock(id) {
  const key = String(id || '').trim();
  if (!key) return;
  appMixerLockedMutes.delete(key);
}

function resolveAppMixerMute(id, incomingMuted, now = Date.now()) {
  const key = String(id || '').trim();
  const incoming = !!incomingMuted;
  if (!key) return incoming;
  const lock = appMixerLockedMutes.get(key);
  if (!lock) return incoming;
  if (incoming === !!lock.muted) {
    appMixerLockedMutes.delete(key);
    return incoming;
  }
  if (now < Number(lock.lockUntil || 0)) {
    return !!lock.muted;
  }
  appMixerLockedMutes.delete(key);
  return incoming;
}

function isAppMixerSliderInteracting() {
  if (appMixerSliderInteractingIds.size > 0) return true;
  return (Date.now() - Number(lastAppMixerSliderInputAt || 0)) <= VOLUME_INTERACTION_IDLE_MS;
}

function isAnyVolumeSliderInteracting() {
  const now = Date.now();
  const active = document.activeElement;
  return !!(
    speakerSliderInteracting
    || micSliderInteracting
    || isAppMixerSliderInteracting()
    || ((now - Number(lastSpeakerSliderInputAt || 0)) <= VOLUME_INTERACTION_IDLE_MS)
    || ((now - Number(lastMicSliderInputAt || 0)) <= VOLUME_INTERACTION_IDLE_MS)
    || (volSlider && active === volSlider)
    || (micVolSlider && active === micVolSlider)
    || (active && active.classList && active.classList.contains('app-mixer-slider'))
  );
}

function scheduleDeferredAppMixerRender(apps) {
  appMixerRenderPendingApps = apps;
  if (appMixerRenderDeferredTimer) {
    clearTimeout(appMixerRenderDeferredTimer);
  }
  appMixerRenderDeferredTimer = setTimeout(() => {
    appMixerRenderDeferredTimer = null;
    if (isAnyVolumeSliderInteracting()) {
      scheduleDeferredAppMixerRender(appMixerRenderPendingApps);
      return;
    }
    const pending = appMixerRenderPendingApps;
    appMixerRenderPendingApps = null;
    renderAppMixer(pending);
  }, APP_MIXER_RENDER_DEFER_MS);
}

function normalizeAudioApps(data) {
  if (!Array.isArray(data)) return [];
  return data
    .filter(item => item && item.id)
    .filter(item => {
      const merged = `${String(item.id || '')} ${String(item.label || '')} ${String(item.name || '')} ${String(item.title || '')}`;
      return !APP_MIXER_FILTERED_SESSION_RE.test(merged);
    })
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
  if (key.includes('twitch')) return 'TV';
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

function normalizeMixerHostToken(value) {
  const token = canonicalMixerToken(value);
  if (token === 'googlechrome') return 'chrome';
  if (token === 'microsoftedge' || token === 'edge') return 'msedge';
  return token;
}

function detectMediaServiceTokenFromText(value) {
  const merged = String(value || '').toLowerCase();
  if (!merged) return '';
  if (/\bjellyfin\b|jellyfin\.local/.test(merged)) return 'jellyfin';
  if (/youtube\s*music|music\.youtube\.com|ytmusic|cinhimbn[a-z]*ghhklpknlkffjgod/.test(merged)) return 'youtube-music';
  if (/youtube/.test(merged)) return 'youtube';
  if (/twitch|twitch\.tv/.test(merged)) return 'twitch';
  return '';
}

function detectMediaServiceTokenForApp(app, presentation) {
  const token = String(presentation && presentation.iconToken || '').toLowerCase();
  if (!MIXER_GENERIC_ICON_TOKENS.has(token)) return '';
  const isQtWebEngineHost = token === 'qtwebengineprocess';

  if (mediaData && mediaData.active) {
    const mediaSourceToken = normalizeMixerHostToken(mediaData.source || mediaData.app || '');
    const allowCrossSourceService = isQtWebEngineHost && mediaSourceToken === 'jellyfin';
    if (!mediaSourceToken || mediaSourceToken === token || allowCrossSourceService) {
      const byMedia = detectMediaServiceTokenFromText(
        `${String(mediaData.app || '')} ${String(mediaData.source || '')} ${String(mediaData.title || '')}`,
      );
      if (byMedia) return byMedia;
    }
  }

  const fromAppTitle = detectMediaServiceTokenFromText(String(app && app.title || ''));
  if (fromAppTitle) return fromAppTitle;

  const appPid = Number(app && app.processId);
  if (Number.isFinite(appPid) && appPid > 0) {
    const pidTitleToken = mixerTitleTokenByPidCache.get(appPid) || '';
    const fromPidTitle = detectMediaServiceTokenFromText(pidTitleToken);
    if (fromPidTitle) return fromPidTitle;
  }
  return '';
}

function resolveBrowserMediaContext(app, presentation) {
  const serviceToken = detectMediaServiceTokenForApp(app, presentation);
  if (!serviceToken) return null;

  if (serviceToken === 'jellyfin') {
    return { displayName: 'Jellyfin', iconSrc: MIXER_MEDIA_SERVICE_ICON_BY_TOKEN.jellyfin || '' };
  }
  if (serviceToken === 'youtube-music') {
    return { displayName: 'YouTube Music', iconSrc: MIXER_MEDIA_SERVICE_ICON_BY_TOKEN['youtube-music'] || '' };
  }
  if (serviceToken === 'youtube') {
    return { displayName: 'YouTube', iconSrc: MIXER_MEDIA_SERVICE_ICON_BY_TOKEN.youtube || '' };
  }
  if (serviceToken === 'twitch') {
    return { displayName: 'Twitch TV', iconSrc: MIXER_MEDIA_SERVICE_ICON_BY_TOKEN.twitch || '' };
  }
  return null;
}

function captureMixerIconsFromWindows(data) {
  const windows = data && Array.isArray(data.windows) ? data.windows : [];
  const seenPids = new Set();
  windows.forEach(win => {
    const token = canonicalMixerToken(win && win.app);
    const icon = win && typeof win.icon === 'string' ? win.icon : '';
    const pid = Number(win && win.processId);
    if (Number.isFinite(pid) && pid > 0) seenPids.add(pid);
    if (Number.isFinite(pid) && pid > 0) {
      const titleToken = normalizeTitleToken(win && win.title);
      if (titleToken) mixerTitleTokenByPidCache.set(pid, titleToken);
    }
    if (!icon) return;
    if (token) mixerIconCache.set(token, icon);
    if (Number.isFinite(pid) && pid > 0) mixerIconByPidCache.set(pid, icon);
    const titleToken = normalizeTitleToken(win && win.title);
    if (titleToken) mixerIconByTitleCache.set(titleToken, icon);
  });
  mixerTitleTokenByPidCache.forEach((_, pid) => {
    if (!seenPids.has(pid)) mixerTitleTokenByPidCache.delete(pid);
  });
}

function captureMixerIconsFromProcessList(data) {
  const icons = data && Array.isArray(data.icons) ? data.icons : [];
  icons.forEach(item => {
    const pid = Number(item && item.processId);
    const icon = item && typeof item.icon === 'string' ? item.icon : '';
    if (!icon) return;
    if (Number.isFinite(pid) && pid > 0) {
      mixerIconByPidCache.set(pid, icon);
    }
  });
}

function ensureMixerIcons(force = false) {
  const age = Date.now() - mixerIconLastFetchAt;
  if (!force && (mixerIconFetchInFlight || age < MIXER_ICON_REFRESH_INTERVAL_MS)) return;
  mixerIconFetchInFlight = fetch(SERVER + '/windows', { cache: 'no-store' })
    .then(res => (res.ok ? res.json() : null))
    .then(data => {
      if (data) captureMixerIconsFromWindows(data);
    })
    .catch(() => {})
    .finally(() => {
      mixerIconLastFetchAt = Date.now();
      mixerIconFetchInFlight = null;
      if (audioData && audioData.apps) {
        if (isAnyVolumeSliderInteracting()) scheduleDeferredAppMixerRender(audioData.apps);
        else renderAppMixer(audioData.apps);
      }
    });
}

function ensureMixerProcessIcons(processIds, force = false) {
  const ids = Array.isArray(processIds)
    ? processIds.map(value => Number(value)).filter(value => Number.isFinite(value) && value > 0)
    : [];
  const unresolved = ids.filter(pid => !mixerIconByPidCache.has(pid));
  if (!unresolved.length) return;

  const age = Date.now() - mixerProcessIconLastFetchAt;
  if (!force && (mixerProcessIconFetchInFlight || age < MIXER_PROCESS_ICON_REFRESH_INTERVAL_MS)) return;

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
      if (audioData && audioData.apps) {
        if (isAnyVolumeSliderInteracting()) scheduleDeferredAppMixerRender(audioData.apps);
        else renderAppMixer(audioData.apps);
      }
    });
}

function setAppMuteVisual(button, item, muted) {
  button.classList.toggle('muted', !!muted);
  button.innerHTML = muted ? APP_MUTE_ICON : APP_UNMUTE_ICON;
  if (item) item.dataset.muted = muted ? 'true' : 'false';
}

function findAppMixerItemById(id) {
  if (!appMixerList) return null;
  const key = String(id || '').trim();
  if (!key) return null;
  const items = appMixerList.querySelectorAll('.app-mixer-item[data-app-id]');
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (String(item.dataset.appId || '') === key) return item;
  }
  return null;
}

function updateAppMuteVisualById(id, muted) {
  const item = findAppMixerItemById(id);
  if (!item) return;
  const button = item.querySelector('.app-mixer-mute');
  if (!button) return;
  setAppMuteVisual(button, item, muted);
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
    const payload = await res.json().catch(() => null);
    setOnline();
    return { ok: true, payload };
  } catch {
    setOffline();
    return { ok: false, payload: null };
  }
}

async function flushAppMuteQueue(id) {
  const key = String(id || '').trim();
  if (!key) return;
  if (appMixerMuteInFlight.has(key)) return;
  if (!appMixerMuteDesiredStates.has(key)) return;

  const desired = !!appMixerMuteDesiredStates.get(key);
  appMixerMuteInFlight.add(key);
  const result = await sendAppMute(key, desired);
  appMixerMuteInFlight.delete(key);

  if (!result.ok) {
    clearAppMixerMuteLock(key);
    appMixerMuteDesiredStates.delete(key);
    fetchAudio();
    return;
  }

  const confirmed = result.payload && typeof result.payload.muted === 'boolean'
    ? !!result.payload.muted
    : desired;
  setAppMixerMuteLock(key, confirmed, Date.now() + APP_MIXER_MUTE_LOCK_MS);
  updateAppMuteVisualById(key, confirmed);

  const latestDesired = appMixerMuteDesiredStates.get(key);
  if (typeof latestDesired === 'undefined') return;
  if (!!latestDesired !== desired) {
    // User clicked again while request was in flight; send the newest intent immediately.
    flushAppMuteQueue(key);
    return;
  }

  appMixerMuteDesiredStates.delete(key);
  fetchAudio();
}

function queueAppMuteUpdate(id, muted) {
  const key = String(id || '').trim();
  if (!key) return;
  appMixerMuteDesiredStates.set(key, !!muted);
  flushAppMuteQueue(key);
}

function queueAppVolumeUpdate(id, level) {
  const key = String(id);
  appMixerVolumeQueuedLevels.set(key, level);
  clearTimeout(appMixerVolumeTimers.get(key));
  const timer = setTimeout(() => {
    appMixerVolumeTimers.delete(key);
    flushAppVolumeQueue(key);
  }, VOLUME_POST_DEBOUNCE_MS);
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
  const previousVuByKey = new Map();
  appMixerList.querySelectorAll('.app-mixer-item[data-app-id]').forEach(item => {
    const id = String(item.dataset.appId || '').trim();
    const pid = Number(item.dataset.appPid || 0);
    const key = buildAppVuStateKey(id, pid);
    if (!key) return;
    const level = Number(item.dataset.vuLevel || 0);
    if (!Number.isFinite(level)) return;
    previousVuByKey.set(key, clampPercent(level));
  });

  const now = Date.now();
  const activityStale = (now - lastAudioActivityAt) > AUDIO_VU_ACTIVITY_STALE_MS;
  const apps = normalizeAudioApps(rawApps)
    .map(app => ({ app, presentation: resolveMixerPresentation(app) }))
    .sort(mixerSortComparator)
    .slice(0, APP_MIXER_SLOT_COUNT);
  const liveAppIds = new Set(apps.map(entry => String(entry.app && entry.app.id || '').trim()).filter(Boolean));
  appMixerSliderInteractingIds.forEach(id => {
    if (!liveAppIds.has(id)) appMixerSliderInteractingIds.delete(id);
  });
  appMixerLockedVolumes.forEach((_, id) => {
    if (!liveAppIds.has(id)) appMixerLockedVolumes.delete(id);
  });
  appMixerLockedMutes.forEach((_, id) => {
    if (!liveAppIds.has(id)) appMixerLockedMutes.delete(id);
  });
  appMixerMuteInFlight.forEach(id => {
    if (!liveAppIds.has(id)) appMixerMuteInFlight.delete(id);
  });
  appMixerMuteDesiredStates.forEach((_, id) => {
    if (!liveAppIds.has(id)) appMixerMuteDesiredStates.delete(id);
  });

  appMixerShell.dataset.empty = 'false';
  if (appMixerEmpty) appMixerEmpty.hidden = true;

  const fragment = document.createDocumentFragment();
  apps.forEach(entry => {
    const app = entry.app;
    const appId = String(app.id || '').trim();
    const presentation = entry.presentation;
    const browserMediaContext = resolveBrowserMediaContext(app, presentation);
    const presentationDisplayName = browserMediaContext && browserMediaContext.displayName
      ? browserMediaContext.displayName
      : presentation.displayName;
    const resolvedAppVolume = resolveAppMixerVolume(appId, app.volume, now);
    const resolvedAppMuted = resolveAppMixerMute(appId, app.muted, now);
    const item = document.createElement('div');
    item.className = 'app-mixer-item';
    item.dataset.muted = resolvedAppMuted ? 'true' : 'false';
    item.dataset.appId = appId;
    item.dataset.appPid = app.processId > 0 ? String(app.processId) : '';
    item.dataset.volume = String(clampPercent(resolvedAppVolume));
    item.title = app.title || app.name;

    const muteBtn = document.createElement('button');
    muteBtn.type = 'button';
    muteBtn.className = 'app-mixer-mute';
    setAppMuteVisual(muteBtn, item, resolvedAppMuted);
    muteBtn.addEventListener('click', eventObject => {
      eventObject.preventDefault();
      const next = !(item.dataset.muted === 'true');
      setAppMixerMuteLock(appId, next, Date.now() + APP_MIXER_MUTE_LOCK_MS);
      setAppMuteVisual(muteBtn, item, next);
      queueAppMuteUpdate(app.id, next);
    });

    const sliderWrap = document.createElement('div');
    sliderWrap.className = 'app-mixer-slider-wrap';
    const vuKey = buildAppVuStateKey(appId, app.processId);
    const previousVu = vuKey ? previousVuByKey.get(vuKey) : undefined;
    const trackedRawVu = activityStale ? 0 : readTrackedAppVuRawTarget(appId, app.processId, now);
    const snapshotRawVu = activityStale ? 0 : clampPercent(Number(app.activity) || 0);
    const initialRawVu = Math.max(trackedRawVu, snapshotRawVu);
    const seededVu = scaleVuByVolume(initialRawVu, resolvedAppVolume, resolvedAppMuted);
    const initialVu = Number.isFinite(previousVu) ? previousVu : seededVu;
    item.dataset.vuLevel = String(initialVu);
    sliderWrap.style.setProperty('--vu-level', String(initialVu));

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.className = 'app-mixer-slider';
    slider.min = '0';
    slider.max = '100';
    slider.value = String(resolvedAppVolume);
    slider.setAttribute('aria-label', app.name);

    const value = document.createElement('div');
    value.className = 'app-mixer-volume';
    value.textContent = `${Math.round(resolvedAppVolume)}%`;
    const applyMixerFill = amount => {
      const safeAmount = Math.max(0, Math.min(100, Number(amount) || 0));
      sliderWrap.style.setProperty('--slider-level', String(safeAmount));
    };
    applyMixerFill(resolvedAppVolume);

    const beginInteraction = () => setAppMixerSliderInteracting(appId, true);
    const endInteraction = () => {
      setAppMixerSliderInteracting(appId, false);
      if (appMixerRenderPendingApps !== null) scheduleDeferredAppMixerRender(appMixerRenderPendingApps);
    };

    slider.addEventListener('input', () => {
      beginInteraction();
      const level = Math.max(0, Math.min(100, Number(slider.value) || 0));
      lastAppMixerSliderInputAt = Date.now();
      setAppMixerVolumeLock(appId, level, lastAppMixerSliderInputAt + APP_MIXER_VOLUME_LOCK_MS);
      value.textContent = `${Math.round(level)}%`;
      applyMixerFill(level);
      item.dataset.volume = String(level);
      queueAppVolumeUpdate(appId, level);
    });
    slider.addEventListener('pointerdown', beginInteraction);
    slider.addEventListener('pointerup', endInteraction);
    slider.addEventListener('pointercancel', endInteraction);
    slider.addEventListener('change', endInteraction);
    slider.addEventListener('blur', endInteraction);
    slider.addEventListener('keydown', beginInteraction);
    slider.addEventListener('keyup', endInteraction);

    sliderWrap.appendChild(slider);

    const icon = document.createElement('div');
    icon.className = 'app-mixer-appicon';
    icon.title = presentationDisplayName;
    if (presentation.iconToken === 'whatsapp') {
      icon.innerHTML = WHATSAPP_ICON;
      item.append(value, muteBtn, sliderWrap, icon);
      fragment.appendChild(item);
      return;
    }
    const iconByPid = app.processId > 0 ? (mixerIconByPidCache.get(app.processId) || '') : '';
    const canUseTokenIcon = !!(presentation.iconToken && !MIXER_GENERIC_ICON_TOKENS.has(String(presentation.iconToken).toLowerCase()));
    const iconByToken = canUseTokenIcon ? (mixerIconCache.get(presentation.iconToken) || '') : '';
    const titleToken = normalizeTitleToken(app.title);
    const iconByTitle = titleToken ? (mixerIconByTitleCache.get(titleToken) || '') : '';
    const isGenericBrowserHost = MIXER_GENERIC_ICON_TOKENS.has(String(presentation.iconToken || '').toLowerCase());
    const iconByMediaContext = browserMediaContext && browserMediaContext.iconSrc ? browserMediaContext.iconSrc : '';
    const iconSrc = isGenericBrowserHost
      ? (iconByMediaContext || iconByTitle || iconByPid || iconByToken)
      : (iconByTitle || iconByPid || iconByToken);
    if (iconSrc) {
      const image = document.createElement('img');
      image.src = iconSrc;
      image.alt = '';
      image.loading = 'lazy';
      image.onerror = () => {
        image.onerror = null;
        if (iconByTitle && image.src !== iconByTitle) {
          image.src = iconByTitle;
          return;
        }
        if (iconByPid && image.src !== iconByPid) {
          image.src = iconByPid;
          return;
        }
        if (iconByToken && image.src !== iconByToken) {
          image.src = iconByToken;
          return;
        }
        image.remove();
      };
      icon.appendChild(image);
    } else if (isSystemSoundsToken(presentation.baseToken)) {
      icon.innerHTML = SYSTEM_SOUNDS_ICON;
    } else {
      missingIcon = true;
      if (app.processId > 0) unresolvedIconPids.push(app.processId);
      icon.textContent = mixerIconToken(presentationDisplayName);
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
  const sliderInteracting = isAnyVolumeSliderInteracting();
  if (normalizedData && normalizedData.speaker) {
    const speaker = normalizedData.speaker.name || normalizedData.speaker.label;
    if (spkName) spkName.textContent = speaker;
    const incomingVolume = Math.max(0, Math.min(100, Number(normalizedData.speaker.volume) || 0));
    const now = Date.now();
    let resolvedVolume = incomingVolume;
    if (speakerVolumeLockedLevel !== null) {
      const locked = Math.max(0, Math.min(100, Number(speakerVolumeLockedLevel) || 0));
      if (incomingVolume === locked) {
        speakerVolumeLockedLevel = null;
        speakerVolumeLockUntil = 0;
      } else if (now < speakerVolumeLockUntil) {
        resolvedVolume = locked;
      } else {
        speakerVolumeLockedLevel = null;
        speakerVolumeLockUntil = 0;
      }
    }
    if (!sliderInteracting) {
      if (volSlider) volSlider.value = resolvedVolume;
      if (volVal) volVal.textContent = resolvedVolume + '%';
      refreshSlider(resolvedVolume);
    }
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
    const incomingMicVolume = Math.max(0, Math.min(100, Number(normalizedData.mic.volume) || 0));
    const now = Date.now();
    let resolvedMicVolume = incomingMicVolume;
    if (micVolumeLockedLevel !== null) {
      const lockedMic = Math.max(0, Math.min(100, Number(micVolumeLockedLevel) || 0));
      if (incomingMicVolume === lockedMic) {
        micVolumeLockedLevel = null;
        micVolumeLockUntil = 0;
      } else if (now < micVolumeLockUntil) {
        resolvedMicVolume = lockedMic;
      } else {
        micVolumeLockedLevel = null;
        micVolumeLockUntil = 0;
      }
    }
    if (micVolSlider && !sliderInteracting) {
      micVolSlider.value = resolvedMicVolume;
      if (micVolVal) micVolVal.textContent = resolvedMicVolume + '%';
    }
    if (micVolVal && sliderInteracting) micVolVal.textContent = `${resolvedMicVolume}%`;
    if (micVolSlider) micVolSlider.classList.toggle('muted', !!normalizedData.mic.muted);
    if (micVolSlider && !sliderInteracting) refreshMicSlider(micVolSlider.value);
  }

  const apps = normalizedData && normalizedData.apps;
  if (sliderInteracting) {
    scheduleDeferredAppMixerRender(apps);
  } else {
    if (appMixerRenderDeferredTimer) {
      clearTimeout(appMixerRenderDeferredTimer);
      appMixerRenderDeferredTimer = null;
    }
    appMixerRenderPendingApps = null;
    renderAppMixer(apps);
  }
  if (typeof syncQuickShortcutButton === 'function') syncQuickShortcutButton();
  if ($('settings-overlay') && !$('settings-overlay').hidden && typeof renderQuickOutputSwitchControls === 'function') {
    renderQuickOutputSwitchControls();
  }
}

function onMicVolumeInput(v) {
  const level = parseInt(v, 10);
  lastMicSliderInputAt = Date.now();
  micVolumeLockedLevel = Math.max(0, Math.min(100, Number(level) || 0));
  micVolumeLockUntil = lastMicSliderInputAt + VOLUME_LEVEL_LOCK_MS;
  if (micVolVal) micVolVal.textContent = level + '%';
  refreshMicSlider(level);
  micVolumePendingLevel = level;
  clearTimeout(micVolumeFlushTimer);
  micVolumeFlushTimer = setTimeout(flushMicVolumeQueue, VOLUME_POST_DEBOUNCE_MS);
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

function bindVolumeInteractionSignals(slider, setInteracting) {
  if (!slider || typeof setInteracting !== 'function') return;
  const begin = () => setInteracting(true);
  const end = () => {
    setInteracting(false);
    if (appMixerRenderPendingApps !== null) scheduleDeferredAppMixerRender(appMixerRenderPendingApps);
  };
  slider.addEventListener('pointerdown', begin);
  slider.addEventListener('pointerup', end);
  slider.addEventListener('pointercancel', end);
  slider.addEventListener('change', end);
  slider.addEventListener('blur', end);
  slider.addEventListener('keydown', begin);
  slider.addEventListener('keyup', end);
}

bindVolumeInteractionSignals(volSlider, next => { speakerSliderInteracting = !!next; });
bindVolumeInteractionSignals(micVolSlider, next => { micSliderInteracting = !!next; });
