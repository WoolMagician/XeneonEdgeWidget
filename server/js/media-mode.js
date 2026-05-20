'use strict';

const MEDIA_MODE_APP_STORAGE_KEY = 'xeneonedge.mediaModeApp.v1';
const MEDIA_MODE_APP_IDS = Object.freeze(['jellyfin', 'youtube', 'twitch', 'youtube-music']);
const MEDIA_MODE_APPS = Object.freeze({
  jellyfin: Object.freeze({ id: 'jellyfin', name: 'Jellyfin', settingsUrl: true }),
  youtube: Object.freeze({ id: 'youtube', name: 'YouTube', url: 'https://www.youtube.com/', external: true }),
  twitch: Object.freeze({ id: 'twitch', name: 'Twitch TV', url: 'https://www.twitch.tv/', external: true }),
  'youtube-music': Object.freeze({ id: 'youtube-music', name: 'YouTube Music', url: 'https://music.youtube.com/', external: true }),
});

let mediaModeFrameUrl = '';
let mediaModeLoaded = false;
let mediaModePanelObserver = null;
let mediaModeAppId = getInitialMediaModeAppId();

function getInitialMediaModeAppId() {
  const fromSettings = hubSettings && hubSettings.mediaMode ? hubSettings.mediaMode.appId : '';
  const fromStorage = (() => {
    try {
      return localStorage.getItem(MEDIA_MODE_APP_STORAGE_KEY) || '';
    } catch {
      return '';
    }
  })();
  const id = String(fromSettings || fromStorage || 'jellyfin').trim();
  return MEDIA_MODE_APPS[id] ? id : 'jellyfin';
}

function getMediaModeApp(id = mediaModeAppId) {
  return MEDIA_MODE_APPS[id] || MEDIA_MODE_APPS.jellyfin;
}

function getMediaModeAppName(id = mediaModeAppId) {
  return getMediaModeApp(id).name;
}

function isExternalMediaModeApp(id = mediaModeAppId) {
  return !!getMediaModeApp(id).external;
}

function getJellyfinMediaModeUrl() {
  const url = hubSettings && hubSettings.mediaMode ? hubSettings.mediaMode.url : '';
  return String(url || '').trim();
}

function getMediaModeAppUrl(id = mediaModeAppId) {
  const app = getMediaModeApp(id);
  return app.settingsUrl ? getJellyfinMediaModeUrl() : String(app.url || '').trim();
}

function getMediaModeUrl() {
  return getMediaModeAppUrl(mediaModeAppId);
}

function getMediaModeOverlay() {
  return $('media-mode-overlay');
}

function getMediaAppsOverlay() {
  return $('media-apps-overlay');
}

function getMediaModeFrame() {
  return $('media-mode-frame');
}

function isMediaModeFullscreen() {
  const overlay = getMediaModeOverlay();
  return !!(overlay && overlay.classList.contains('fullscreen'));
}

function isMediaModeDocked() {
  const overlay = getMediaModeOverlay();
  return !!(overlay && overlay.classList.contains('docked'));
}

function isMediaAppsOverlayOpen() {
  const overlay = getMediaAppsOverlay();
  return !!(overlay && !overlay.hidden);
}

function hasMediaModeSession() {
  return !isExternalMediaModeApp() && mediaModeLoaded && !!mediaModeFrameUrl;
}

function normalizeMediaToken(value) {
  return String(value || '').trim().toLowerCase();
}

function mediaModeSessionText(data) {
  if (!data || typeof data !== 'object') return '';
  return [
    data.app,
    data.source,
    data.title,
    data.album,
    data.artist,
  ].map(normalizeMediaToken).join(' ');
}

function isEmbeddedMediaModeSession(data) {
  if (!data || typeof data !== 'object') return false;
  const app = normalizeMediaToken(data.app);
  const source = normalizeMediaToken(data.source);
  const title = normalizeMediaToken(data.title);
  const album = normalizeMediaToken(data.album);
  const artist = normalizeMediaToken(data.artist);
  const icueSource = /\bicue\b/.test(app) || /\bicue\b/.test(source);
  if (!icueSource) return false;
  if (/corsair/.test(title) || /icue-notexisting\.corsair\.com/.test(title) || /corsair/.test(source)) return true;
  return !artist && !album && hasMediaModeSession();
}

function isJellyfinLikeSession(data) {
  const joined = mediaModeSessionText(data);
  if (/\bjellyfin\b/.test(joined)) return true;
  return isEmbeddedMediaModeSession(data);
}

function isMediaModeAppSession(data, id = mediaModeAppId) {
  const joined = mediaModeSessionText(data);
  if (!joined) return false;
  if (id === 'jellyfin') return isJellyfinLikeSession(data);
  if (id === 'youtube-music') return /youtube\s*music|music\.youtube\.com|ytmusic|cinhimbn[a-z]*ghhklpknlkffjgod/.test(joined) || isEmbeddedMediaModeSession(data);
  if (id === 'youtube') return (/\byoutube\b|youtube\.com|youtu\.be/.test(joined) && !/youtube\s*music|music\.youtube\.com|ytmusic/.test(joined)) || isEmbeddedMediaModeSession(data);
  if (id === 'twitch') return /\btwitch\b|twitch\.tv/.test(joined) || isEmbeddedMediaModeSession(data);
  return false;
}

function shouldDockForMedia(data) {
  if (!hasMediaModeSession()) return false;
  const status = normalizeMediaToken(data && data.playbackStatus);
  const isPlaying = status === 'playing';
  const isSelectedApp = isMediaModeAppSession(data);

  if (isSelectedApp) return true;
  if (isPlaying) return false;
  return isMediaModeDocked();
}

function syncMediaAppsSelection() {
  document.querySelectorAll('.media-app-tile[data-media-app]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mediaApp === mediaModeAppId);
  });
}

function setMediaModeToggleState(isOpen) {
  const btn = $('media-mode-toggle');
  if (!btn) return;
  const appsOpen = isMediaAppsOverlayOpen();
  const active = !!isOpen || appsOpen || isMediaModeFullscreen();
  btn.classList.toggle('active', active);
  btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  btn.setAttribute('aria-expanded', appsOpen ? 'true' : 'false');
}

function syncMediaModeOverlayContent() {
  const frame = getMediaModeFrame();
  const empty = $('media-mode-empty');
  if (frame) frame.hidden = !hasMediaModeSession();
  if (empty) empty.hidden = hasMediaModeSession();
}

function syncMediaModeDockBounds() {
  const overlay = getMediaModeOverlay();
  const panel = $('media-panel');
  if (!overlay || !panel || !overlay.classList.contains('docked')) return;
  const rect = panel.getBoundingClientRect();
  overlay.style.right = 'auto';
  overlay.style.bottom = 'auto';
  overlay.style.left = `${Math.round(rect.left)}px`;
  overlay.style.top = `${Math.round(rect.top)}px`;
  overlay.style.width = `${Math.round(rect.width)}px`;
  overlay.style.height = `${Math.round(rect.height)}px`;
}

function persistMediaModeAppSelection(id) {
  try {
    localStorage.setItem(MEDIA_MODE_APP_STORAGE_KEY, id);
  } catch {}

  if (!hubSettings || !hubSettings.mediaMode || typeof normalizeSettings !== 'function') return;
  hubSettings = normalizeSettings({
    ...hubSettings,
    mediaMode: { ...hubSettings.mediaMode, appId: id },
  });
  if (typeof saveHubSettings === 'function') saveHubSettings();
}

function setMediaModeApp(id, options = {}) {
  if (!MEDIA_MODE_APPS[id]) return false;
  mediaModeAppId = id;
  if (options.persist !== false) persistMediaModeAppSelection(id);
  syncMediaAppsSelection();
  return true;
}

function clearMediaModeFrame() {
  const frame = getMediaModeFrame();
  if (frame) frame.removeAttribute('src');
  mediaModeFrameUrl = '';
  mediaModeLoaded = false;
  syncMediaModeOverlayContent();
}

function ensureMediaModeFrameLoaded() {
  const frame = getMediaModeFrame();
  if (!frame) return false;
  if (isExternalMediaModeApp()) {
    clearMediaModeFrame();
    return false;
  }
  const url = getMediaModeUrl();
  frame.title = getMediaModeAppName();
  if (!url) {
    frame.removeAttribute('src');
    mediaModeFrameUrl = '';
    mediaModeLoaded = false;
    syncMediaModeOverlayContent();
    return false;
  }
  if (!mediaModeLoaded || mediaModeFrameUrl !== url) {
    frame.src = url;
    mediaModeFrameUrl = url;
    mediaModeLoaded = true;
  }
  syncMediaModeOverlayContent();
  return true;
}

function closeMediaAppsOverlay() {
  const overlay = getMediaAppsOverlay();
  if (overlay) overlay.hidden = true;
  setMediaModeToggleState(isMediaModeFullscreen());
}

function openMediaAppsOverlay() {
  const overlay = getMediaAppsOverlay();
  if (!overlay) return;
  if (typeof closeWeatherDetails === 'function') closeWeatherDetails();
  if (typeof closeCalendarOverlay === 'function') closeCalendarOverlay(true);
  if (typeof closeSettings === 'function') closeSettings();
  if (typeof closeAppSwitcher === 'function') closeAppSwitcher();
  if (typeof closeTabSwitcher === 'function') closeTabSwitcher();
  syncMediaAppsSelection();
  overlay.hidden = false;
  setMediaModeToggleState(true);
}

function toggleMediaAppsOverlay(forceOpen) {
  const overlay = getMediaAppsOverlay();
  if (!overlay) return;
  const shouldOpen = typeof forceOpen === 'boolean' ? forceOpen : overlay.hidden;
  if (shouldOpen) openMediaAppsOverlay();
  else closeMediaAppsOverlay();
}

function hideMediaModeOverlay() {
  const overlay = getMediaModeOverlay();
  if (!overlay) return;
  const wasDocked = overlay.classList.contains('docked');
  if (wasDocked) {
    // Prevent a docked-to-fullscreen flash while opacity transitions to 0.
    overlay.style.transition = 'none';
  }
  overlay.classList.remove('active', 'fullscreen', 'docked');
  overlay.setAttribute('aria-hidden', 'true');
  overlay.style.removeProperty('right');
  overlay.style.removeProperty('bottom');
  overlay.style.removeProperty('left');
  overlay.style.removeProperty('top');
  overlay.style.removeProperty('width');
  overlay.style.removeProperty('height');
  if (wasDocked) {
    // Force style commit before restoring default transition rules.
    void overlay.offsetWidth;
    overlay.style.removeProperty('transition');
  }
  document.body.classList.remove('media-mode-active');
}

function showMediaModeFullscreen() {
  const overlay = getMediaModeOverlay();
  if (!overlay) return;
  ensureMediaModeFrameLoaded();
  overlay.classList.remove('docked');
  overlay.classList.add('fullscreen', 'active');
  overlay.setAttribute('aria-hidden', 'false');
  overlay.style.removeProperty('right');
  overlay.style.removeProperty('bottom');
  overlay.style.removeProperty('left');
  overlay.style.removeProperty('top');
  overlay.style.removeProperty('width');
  overlay.style.removeProperty('height');
  document.body.classList.add('media-mode-active');
  syncMediaModeOverlayContent();
}

function showMediaModeDocked() {
  const overlay = getMediaModeOverlay();
  if (!overlay) return;
  if (!hasMediaModeSession()) {
    hideMediaModeOverlay();
    return;
  }
  overlay.classList.remove('fullscreen');
  overlay.classList.add('docked');
  overlay.setAttribute('aria-hidden', 'false');
  document.body.classList.remove('media-mode-active');
  syncMediaModeDockBounds();
  overlay.classList.add('active');
  syncMediaModeOverlayContent();
}

function syncMediaModeFromPlayback(data) {
  if (isMediaModeFullscreen()) return;
  if (shouldDockForMedia(data)) {
    showMediaModeDocked();
    return;
  }
  if (isMediaModeDocked()) hideMediaModeOverlay();
}

function toggleMediaMode(forceOpen) {
  const overlay = getMediaModeOverlay();
  if (!overlay) return;
  const shouldOpen = typeof forceOpen === 'boolean' ? forceOpen : !isMediaModeFullscreen();

  if (shouldOpen) {
    closeMediaAppsOverlay();
    if (typeof closeWeatherDetails === 'function') closeWeatherDetails();
    if (typeof closeCalendarOverlay === 'function') closeCalendarOverlay(true);
    if (typeof closeSettings === 'function') closeSettings();
    if (typeof closeAppSwitcher === 'function') closeAppSwitcher();
    if (typeof closeTabSwitcher === 'function') closeTabSwitcher();
    showMediaModeFullscreen();
    setMediaModeToggleState(true);
    return;
  }

  if (isMediaModeDocked()) {
    hideMediaModeOverlay();
  } else if (shouldDockForMedia(typeof mediaData !== 'undefined' ? mediaData : null)) {
    showMediaModeDocked();
  } else {
    hideMediaModeOverlay();
  }
  setMediaModeToggleState(false);
  if (typeof fetchMedia === 'function') {
    fetchMedia();
    setTimeout(fetchMedia, 700);
  }
}

function openMediaModeApp(id) {
  if (!setMediaModeApp(id)) return;
  if (isExternalMediaModeApp(id)) {
    openExternalMediaModeApp(id);
    return;
  }
  toggleMediaMode(true);
}

function openExternalMediaModeApp(id) {
  const url = getMediaModeAppUrl(id);
  if (!url) return;

  closeMediaAppsOverlay();
  hideMediaModeOverlay();
  clearMediaModeFrame();
  setMediaModeToggleState(false);

  let opened = null;
  try {
    opened = window.open(url, '_blank', 'noopener,noreferrer');
  } catch {}

  if (!opened) {
    fetch('/media/open-app', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: id }),
      keepalive: true,
    }).catch(() => {});
  }

  if (typeof fetchMedia === 'function') {
    setTimeout(fetchMedia, 700);
    setTimeout(fetchMedia, 1800);
  }
}

function closeMediaMode() {
  closeMediaAppsOverlay();
  toggleMediaMode(false);
}

function openMediaModeSettings() {
  closeMediaAppsOverlay();
  hideMediaModeOverlay();
  setMediaModeToggleState(false);
  if (typeof toggleSettings === 'function') toggleSettings();
}

function refreshMediaModeFromSettings() {
  const frame = getMediaModeFrame();
  if (!frame) return;

  mediaModeAppId = getInitialMediaModeAppId();
  syncMediaAppsSelection();

  const nextUrl = getMediaModeUrl();
  if (!nextUrl) {
    frame.removeAttribute('src');
    mediaModeFrameUrl = '';
    mediaModeLoaded = false;
    hideMediaModeOverlay();
    setMediaModeToggleState(false);
    syncMediaModeOverlayContent();
    return;
  }

  if (nextUrl !== mediaModeFrameUrl && isMediaModeFullscreen()) {
    ensureMediaModeFrameLoaded();
  } else if (nextUrl !== mediaModeFrameUrl && mediaModeLoaded && !isMediaModeFullscreen()) {
    frame.removeAttribute('src');
    mediaModeFrameUrl = '';
    mediaModeLoaded = false;
    hideMediaModeOverlay();
  }

  syncMediaModeOverlayContent();
  if (isMediaModeDocked()) syncMediaModeDockBounds();
}

function observeMediaModePanelBounds() {
  if (mediaModePanelObserver || typeof ResizeObserver === 'undefined') return;
  const panel = $('media-panel');
  if (!panel) return;
  mediaModePanelObserver = new ResizeObserver(() => syncMediaModeDockBounds());
  mediaModePanelObserver.observe(panel);
}

window.addEventListener('resize', syncMediaModeDockBounds);
observeMediaModePanelBounds();
syncMediaAppsSelection();
setMediaModeToggleState(false);
hideMediaModeOverlay();
syncMediaModeOverlayContent();
