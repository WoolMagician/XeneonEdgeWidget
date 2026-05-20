'use strict';

// ── Panel routing ─────────────────────────────────────────────
const panelParam = (new URLSearchParams(window.location.search).get('panel') || '').toLowerCase();
const VALID_PANELS = ['media', 'mic', 'tasks', 'system', 'audio'];
const activePanel = VALID_PANELS.includes(panelParam) ? panelParam : 'full';
if (activePanel !== 'full') document.body.dataset.panel = activePanel;

// ── Initial render ────────────────────────────────────────────
tickClock();
applyTranslations();
initAllCustomSelects();
if (typeof initDashboardLayout === 'function') initDashboardLayout();
refreshSlider(50);
refreshMicSlider(50);

// ── Per-panel data needs ──────────────────────────────────────
const need = {
  status: ['full', 'mic', 'media'].includes(activePanel),
  audio:  ['full', 'audio', 'mic', 'system'].includes(activePanel),
  media:  ['full', 'media'].includes(activePanel),
  system: ['full', 'system'].includes(activePanel),
  events: ['full', 'media'].includes(activePanel),
  tasks:  ['full', 'media', 'tasks'].includes(activePanel),
  counter: ['full'].includes(activePanel),
};

setInterval(tickClock, 1000);

// Weather and events always use polling (long intervals, no benefit from SSE).
if (need.system) { fetchWeather(); setInterval(fetchWeather, 30 * 60 * 1000); }
if (need.events) { loadCalendarEvents(); setInterval(checkReminders, 15000); }
if (need.tasks)  { loadTasks(); }
if (need.counter && typeof initHourCounter === 'function') initHourCounter();

// Real-time data (status, media, system, audio) uses Server-Sent Events.
// Falls back to conventional polling if EventSource is unavailable or the
// connection fails (e.g. older server build without /sse support).
(function initDataStream() {
  if (typeof EventSource === 'undefined') {
    startPollingFallback();
    return;
  }

  let es = null;
  let pollFallbackStatusTimer = null;
  let pollFallbackAudioTimer = null;
  let pollFallbackMediaTimer = null;
  let pollFallbackSystemTimer = null;
  let reconnectDelay = 2000;
  let reconnectTimer = null;
  let sseHealthTimer = null;
  let lastSseEventAt = 0;
  let connectAttempt = 0;

  function closeEventSource() {
    if (!es) return;
    try { es.onopen = null; } catch {}
    try { es.onerror = null; } catch {}
    try { es.close(); } catch {}
    es = null;
  }

  function diagClientLog(level, message, details = null) {
    try {
      fetch('/diag/log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: 'main.sse',
          level,
          message,
          details: details || {},
        }),
        keepalive: true,
      }).catch(() => {});
    } catch {}
  }

  function scheduleReconnect(reason, details = null) {
    if (reconnectTimer) return;
    const readyState = es ? es.readyState : null;
    startPollingFallback();
    closeEventSource();
    diagClientLog('WARN', 'sse reconnect scheduled', {
      reason,
      reconnectDelay,
      readyState,
      ...(details && typeof details === 'object' ? details : {}),
    });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      stopPollFallback();
      connect();
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  }

  function markSseEvent(channel) {
    lastSseEventAt = Date.now();
    if (channel === 'status' && typeof setOnline === 'function') setOnline();
  }

  function ensureSseHealthWatch() {
    if (sseHealthTimer) return;
    sseHealthTimer = setInterval(() => {
      if (!es) return;
      const ageMs = Date.now() - Number(lastSseEventAt || 0);
      if (es.readyState === EventSource.CONNECTING && ageMs >= 7000) {
        scheduleReconnect('connecting-timeout', { ageMs });
        return;
      }
      if (es.readyState === EventSource.OPEN && ageMs >= 15000) {
        scheduleReconnect('event-stall', { ageMs });
      }
    }, 2500);
  }

  function stopPollFallback() {
    if (pollFallbackStatusTimer) { clearInterval(pollFallbackStatusTimer); pollFallbackStatusTimer = null; }
    if (pollFallbackAudioTimer) { clearInterval(pollFallbackAudioTimer); pollFallbackAudioTimer = null; }
    if (pollFallbackMediaTimer) { clearInterval(pollFallbackMediaTimer); pollFallbackMediaTimer = null; }
    if (pollFallbackSystemTimer) { clearInterval(pollFallbackSystemTimer); pollFallbackSystemTimer = null; }
  }

  function startPollingFallback() {
    if (need.status && !pollFallbackStatusTimer) {
      pollStatus();
      pollFallbackStatusTimer = setInterval(pollStatus, 3000);
    }
    if (need.audio && !pollFallbackAudioTimer) {
      fetchAudio();
      pollFallbackAudioTimer = setInterval(fetchAudio, 1200);
    }
    if (need.media && !pollFallbackMediaTimer) {
      fetchMedia();
      pollFallbackMediaTimer = setInterval(fetchMedia, 2000);
    }
    if (need.system && !pollFallbackSystemTimer) {
      fetchSystem();
      pollFallbackSystemTimer = setInterval(fetchSystem, 7000);
    }
  }

  function connect() {
    connectAttempt += 1;
    const attemptId = connectAttempt;
    closeEventSource();
    const source = new EventSource('/sse');
    es = source;
    lastSseEventAt = Date.now();
    diagClientLog('INFO', 'sse connect attempt', { attemptId });
    ensureSseHealthWatch();

    source.addEventListener('status', e => {
      if (es !== source) return;
      try {
        const data = JSON.parse(e.data);
        // applyUI is the mic.js function for mic mute state; setOnline marks connectivity.
        if (typeof applyUI === 'function') { applyUI(data.muted); }
        markSseEvent('status');
      } catch {}
    });
    source.addEventListener('media', e => {
      if (es !== source) return;
      try {
        applyMedia(JSON.parse(e.data));
        markSseEvent('media');
      } catch {}
    });
    source.addEventListener('system', e => {
      if (es !== source) return;
      try {
        applySystem(JSON.parse(e.data));
        markSseEvent('system');
      } catch {}
    });
    source.addEventListener('audio', e => {
      if (es !== source) return;
      try {
        applyAudio(JSON.parse(e.data));
        markSseEvent('audio');
      } catch {}
    });
    source.addEventListener('audio-activity', e => {
      if (es !== source) return;
      try {
        if (need.audio && typeof applyAudioActivity === 'function') {
          applyAudioActivity(JSON.parse(e.data));
        }
        markSseEvent('audio-activity');
      } catch {}
    });

    source.onopen = () => {
      if (es !== source) return;
      reconnectDelay = 2000;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      stopPollFallback();
      lastSseEventAt = Date.now();
      diagClientLog('INFO', 'sse open', { attemptId });
    };

    source.onerror = () => {
      if (es !== source) return;
      // On error EventSource auto-reconnects, but if we get repeated failures
      // fall back to polling so the UI never stays stale.
      if (source.readyState === EventSource.CLOSED) {
        scheduleReconnect('closed-error');
        return;
      }
      if (source.readyState === EventSource.CONNECTING) {
        startPollingFallback();
        diagClientLog('WARN', 'sse error while connecting', { attemptId });
      }
    };
  }

  // Trigger an immediate fetch for each needed data type so the UI is populated
  // before the first SSE push arrives.
  if (need.status) pollStatus();
  if (need.audio)  fetchAudio();
  if (need.media)  fetchMedia();
  if (need.system) fetchSystem();

  connect();
}());

// ── Init app favorites buttons ───────────────────────────────
renderAppFavorites();
if (typeof initNewsTicker === 'function') initNewsTicker();

// ── Keyboard listener (Escape) ────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (document.body.classList.contains('layout-editing') && typeof setDashboardLayoutEditMode === 'function') {
      e.preventDefault();
      setDashboardLayoutEditMode(false);
      return;
    }
    const mediaApps = document.getElementById('media-apps-overlay');
    if (mediaApps && !mediaApps.hidden && typeof closeMediaAppsOverlay === 'function') {
      e.preventDefault();
      closeMediaAppsOverlay();
      return;
    }
    const mediaMode = document.getElementById('media-mode-overlay');
    if (mediaMode && mediaMode.classList.contains('active')) {
      e.preventDefault();
      closeMediaMode();
      return;
    }
    const calendarOverlay = document.getElementById('calendar-overlay');
    if (calendarOverlay && !calendarOverlay.hidden) {
      e.preventDefault();
      closeCalendarOverlay();
      return;
    }
    const counterOverlay = document.getElementById('counter-overlay');
    if (counterOverlay && !counterOverlay.hidden) {
      e.preventDefault();
      closeHourCounterOverlay();
      return;
    }
    const weatherOverlay = document.getElementById('weather-overlay');
    if (weatherOverlay && !weatherOverlay.hidden) {
      e.preventDefault();
      closeWeatherDetails();
      return;
    }
    const settingsOverlay = document.getElementById('settings-overlay');
    if (settingsOverlay && !settingsOverlay.hidden) {
      e.preventDefault();
      closeSettings();
      return;
    }
    const appSwitcher = document.getElementById('app-switcher');
    if (appSwitcher && !appSwitcher.hidden) {
      e.preventDefault();
      closeAppSwitcher();
      return;
    }
  }
}, true);

// ── Sync language across iframes via storage event ────────────
window.addEventListener('storage', e => {
  if (e.key === 'uiLang' && e.newValue && e.newValue !== lang && i18n[e.newValue]) {
    lang = e.newValue;
    applyTranslations();
  }
  if (e.key === 'appFavorites') {
    appFavorites = parseAppFavorites(e.newValue || '[]');
    renderAppFavorites();
    if ($('app-switcher') && !$('app-switcher').hidden) renderAppWindows();
  }
  if (e.key === window.SETTINGS_STORAGE_KEY) {
    reloadHubSettingsFromStorage();
    syncQuickShortcutButton();
  }
});

// ── Quick-action buttons ──────────────────────────────────────
const QUICK_OUTPUT_PROFILE_HEADSET = 'headset';
const QUICK_OUTPUT_PROFILE_SPEAKER = 'speaker';
const QUICK_SHORTCUT_ICON_SPEAKER = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 10v4h4l5 4V6L7 10H3Zm13.5 2A4.5 4.5 0 0 0 14 7.97v8.05A4.5 4.5 0 0 0 16.5 12ZM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77Z"/></svg>';
const QUICK_SHORTCUT_ICON_HEADSET = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 1a9 9 0 0 0-9 9v7a3 3 0 0 0 3 3h2v-8H5v-2a7 7 0 0 1 14 0v2h-3v8h2a3 3 0 0 0 3-3v-7a9 9 0 0 0-9-9Z"/></svg>';
const HEADSET_OUTPUT_TOKEN_RE = /\b(headset|headphone|headphones|earphone|earphones|earbud|earbuds|cuffia|cuffie|auricolare|auricolari|handsfree|airpods)\b/i;
const QUICK_OUTPUT_SWITCH_LOCK_MS = 1800;
let quickShortcutSwitchBusy = false;
let quickOutputSwitchLockedTargetId = '';
let quickOutputSwitchLockUntil = 0;

function setQuickOutputSwitchLock(targetId, ttlMs = QUICK_OUTPUT_SWITCH_LOCK_MS) {
  const safeId = String(targetId || '').trim();
  if (!safeId) return;
  quickOutputSwitchLockedTargetId = safeId;
  quickOutputSwitchLockUntil = Date.now() + Math.max(400, Number(ttlMs) || QUICK_OUTPUT_SWITCH_LOCK_MS);
}

function clearQuickOutputSwitchLock() {
  quickOutputSwitchLockedTargetId = '';
  quickOutputSwitchLockUntil = 0;
}

function isQuickOutputSwitchLockActive() {
  if (!quickOutputSwitchLockedTargetId) return false;
  if (Date.now() <= quickOutputSwitchLockUntil) return true;
  clearQuickOutputSwitchLock();
  return false;
}

function reconcileQuickOutputAudioSnapshot(data) {
  if (!data || !isQuickOutputSwitchLockActive()) return data;
  const speakers = Array.isArray(data.speakers) ? data.speakers : [];
  if (!speakers.length) return data;

  const targetId = quickOutputSwitchLockedTargetId;
  const target = speakers.find(device => String(device && device.id || '') === targetId);
  if (!target) return data;

  const serverActive = (() => {
    if (data.speaker && data.speaker.id) return String(data.speaker.id);
    const byDefault = speakers.find(device => device && device.isDefault);
    return byDefault && byDefault.id ? String(byDefault.id) : '';
  })();
  if (serverActive === targetId) {
    clearQuickOutputSwitchLock();
    return data;
  }

  const patched = { ...data };
  patched.speakers = speakers.map(device => ({
    ...device,
    isDefault: String(device && device.id || '') === targetId,
  }));
  const active = patched.speakers.find(device => String(device && device.id || '') === targetId);
  if (active) patched.speaker = { ...(patched.speaker || {}), ...active };
  return patched;
}

function normalizeAudioOutputLabel(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function classifyOutputProfile(device) {
  const source = `${device && device.name ? device.name : ''} ${device && device.label ? device.label : ''}`;
  const normalized = normalizeAudioOutputLabel(source);
  if (normalized && HEADSET_OUTPUT_TOKEN_RE.test(normalized)) return QUICK_OUTPUT_PROFILE_HEADSET;
  return QUICK_OUTPUT_PROFILE_SPEAKER;
}

function getConfiguredQuickOutputSwitchIds() {
  const config = hubSettings && hubSettings.quickOutputSwitch && typeof hubSettings.quickOutputSwitch === 'object'
    ? hubSettings.quickOutputSwitch
    : {};
  const deviceAId = String(config.deviceAId || '').trim();
  const deviceBId = String(config.deviceBId || '').trim();
  return { deviceAId, deviceBId };
}

function getQuickOutputSwitchState() {
  const speakers = audioData && Array.isArray(audioData.speakers)
    ? audioData.speakers.filter(item => item && item.id)
    : [];

  if (!speakers.length) {
    return {
      active: null,
      profile: QUICK_OUTPUT_PROFILE_SPEAKER,
      target: null,
    };
  }

  const preferredId = audioData && audioData.speaker && audioData.speaker.id ? String(audioData.speaker.id) : '';
  let active = speakers.find(item => String(item.id) === preferredId)
    || speakers.find(item => item.isDefault)
    || speakers[0];
  if (!active && audioData && audioData.speaker && audioData.speaker.id) active = audioData.speaker;

  const profile = classifyOutputProfile(active);
  const activeId = active && active.id ? String(active.id) : '';
  const configured = getConfiguredQuickOutputSwitchIds();
  const speakerByConfiguredId = configuredId => {
    const key = String(configuredId || '').trim();
    if (!key) return null;
    return speakers.find(device =>
      String(device.endpointId || '').trim() === key
      || String(device.id || '').trim() === key,
    ) || null;
  };
  const firstDevice = speakerByConfiguredId(configured.deviceAId);
  const secondDevice = speakerByConfiguredId(configured.deviceBId);
  const hasConfiguredPair = !!(firstDevice && secondDevice && String(firstDevice.id) !== String(secondDevice.id));
  const firstId = hasConfiguredPair ? String(firstDevice.id) : '';
  const secondId = hasConfiguredPair ? String(secondDevice.id) : '';
  const firstEndpointId = hasConfiguredPair ? String(firstDevice.endpointId || '').trim() : '';
  const secondEndpointId = hasConfiguredPair ? String(secondDevice.endpointId || '').trim() : '';
  const target = hasConfiguredPair
    ? (
      activeId === firstId
        ? (speakers.find(item => String(item.id) === secondId) || null)
        : activeId === secondId
          ? (speakers.find(item => String(item.id) === firstId) || null)
          : (speakers.find(item => String(item.id) === firstId) || speakers.find(item => String(item.id) === secondId) || null)
    )
    : null;

  return {
    active,
    profile,
    target,
    hasConfiguredPair,
    pairFirstId: hasConfiguredPair ? firstId : '',
    pairSecondId: hasConfiguredPair ? secondId : '',
    pairFirstEndpointId: hasConfiguredPair ? firstEndpointId : '',
    pairSecondEndpointId: hasConfiguredPair ? secondEndpointId : '',
  };
}

function applyQuickOutputOptimisticSelection(targetId) {
  if (!audioData || !targetId) return;
  const speakers = Array.isArray(audioData.speakers) ? audioData.speakers : [];
  const normalizedTargetId = String(targetId);
  let matched = null;
  speakers.forEach(device => {
    const isTarget = String(device.id) === normalizedTargetId;
    device.isDefault = isTarget;
    if (isTarget) matched = device;
  });
  if (matched) {
    audioData.speaker = { ...audioData.speaker, ...matched };
    // Refresh speaker UI immediately from target device snapshot while the
    // backend switch finalizes.
    if (typeof spkName !== 'undefined' && spkName) spkName.textContent = matched.name || matched.label || '--';
    if (typeof volSlider !== 'undefined' && volSlider) volSlider.value = Math.max(0, Math.min(100, Number(matched.volume) || 0));
    if (typeof volVal !== 'undefined' && volVal) volVal.textContent = `${Math.max(0, Math.min(100, Number(matched.volume) || 0))}%`;
    if (typeof refreshSlider === 'function') refreshSlider(Number(matched.volume) || 0);
    if (typeof applySpeakerMute === 'function') applySpeakerMute(!!matched.muted);
  }
}

function syncQuickShortcutButton() {
  const btn = document.getElementById('quick-shortcut-btn');
  if (!btn) return;

  const tile = btn.closest('.shortcut-action-tile');
  const panel = btn.closest('.shortcut-panel');
  const label = document.getElementById('shortcut-keys-display');
  const state = getQuickOutputSwitchState();
  const profile = state.profile === QUICK_OUTPUT_PROFILE_HEADSET
    ? QUICK_OUTPUT_PROFILE_HEADSET
    : QUICK_OUTPUT_PROFILE_SPEAKER;

  if (tile) tile.dataset.outputProfile = profile;
  btn.innerHTML = profile === QUICK_OUTPUT_PROFILE_HEADSET
    ? QUICK_SHORTCUT_ICON_HEADSET
    : QUICK_SHORTCUT_ICON_SPEAKER;
  btn.disabled = quickShortcutSwitchBusy || !state.hasConfiguredPair || !state.target || !state.target.id;

  if (panel) panel.dataset.shortcutReady = btn.disabled ? 'false' : 'true';
  if (label) {
    label.textContent = state.active ? (state.active.name || state.active.label || '--') : '--';
    label.classList.toggle('empty', !state.active);
  }
}

async function triggerQuickShortcut() {
  if (quickShortcutSwitchBusy) return;
  const state = getQuickOutputSwitchState();
  const target = state.target;
  if (!target || !target.id) return;

  quickShortcutSwitchBusy = true;
  setQuickOutputSwitchLock(target.id);
  applyQuickOutputOptimisticSelection(target.id);
  syncQuickShortcutButton();
  try {
    const endpoint = state.hasConfiguredPair ? '/speaker/switch' : '/speaker/set';
    const payload = state.hasConfiguredPair
      ? {
        firstId: state.pairFirstId,
        secondId: state.pairSecondId,
        firstEndpointId: state.pairFirstEndpointId,
        secondEndpointId: state.pairSecondEndpointId,
      }
      : { id: target.id, endpointId: target.endpointId || '' };
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error('Output switch failed');
    if (typeof setOnline === 'function') setOnline();
    if (typeof fetchAudio === 'function') {
      fetchAudio();
      setTimeout(fetchAudio, 90);
      setTimeout(fetchAudio, 220);
      setTimeout(fetchAudio, 420);
    }
  } catch {
    clearQuickOutputSwitchLock();
    if (typeof fetchAudio === 'function') fetchAudio();
    if (typeof setOffline === 'function') setOffline();
  } finally {
    quickShortcutSwitchBusy = false;
    syncQuickShortcutButton();
  }
}

// Call once after quick-shortcut constants/functions are initialized.
syncQuickShortcutButton();
