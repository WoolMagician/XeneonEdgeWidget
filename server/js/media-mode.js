'use strict';

let mediaModeFrameUrl = '';
let mediaModeLoaded = false;
let mediaModePanelObserver = null;

function getMediaModeUrl() {
  const url = hubSettings && hubSettings.mediaMode ? hubSettings.mediaMode.url : '';
  return String(url || '').trim();
}

function getMediaModeOverlay() {
  return $('media-mode-overlay');
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

function hasMediaModeSession() {
  return mediaModeLoaded && !!mediaModeFrameUrl;
}

function normalizeMediaToken(value) {
  return String(value || '').trim().toLowerCase();
}

function isJellyfinLikeSession(data) {
  if (!data || typeof data !== 'object') return false;
  const app = normalizeMediaToken(data.app);
  const source = normalizeMediaToken(data.source);
  const title = normalizeMediaToken(data.title);
  const album = normalizeMediaToken(data.album);
  const artist = normalizeMediaToken(data.artist);
  const joined = `${app} ${source} ${title} ${album} ${artist}`;

  if (/\bjellyfin\b/.test(joined)) return true;

  const icueSource = /\bicue\b/.test(app) || /\bicue\b/.test(source);
  if (!icueSource) return false;

  if (/corsair/.test(title) || /icue-notexisting\.corsair\.com/.test(title) || /corsair/.test(source)) return true;
  if (!artist && !album && hasMediaModeSession()) return true;
  return false;
}

function shouldDockForMedia(data) {
  if (!hasMediaModeSession()) return false;
  const status = normalizeMediaToken(data && data.playbackStatus);
  const isPlaying = status === 'playing';
  const isJellyfin = isJellyfinLikeSession(data);

  if (isJellyfin) return true;
  if (isPlaying) return false;
  return isMediaModeDocked();
}

function setMediaModeToggleState(isOpen) {
  const btn = $('media-mode-toggle');
  if (!btn) return;
  btn.classList.toggle('active', !!isOpen);
  btn.setAttribute('aria-pressed', isOpen ? 'true' : 'false');
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

function ensureMediaModeFrameLoaded() {
  const frame = getMediaModeFrame();
  if (!frame) return false;
  const url = getMediaModeUrl();
  if (!url) return false;
  if (!mediaModeLoaded || mediaModeFrameUrl !== url) {
    frame.src = url;
    mediaModeFrameUrl = url;
    mediaModeLoaded = true;
  }
  return true;
}

function hideMediaModeOverlay() {
  const overlay = getMediaModeOverlay();
  if (!overlay) return;
  const wasDocked = overlay.classList.contains('docked');
  if (wasDocked) {
    // Prevent a docked→fullscreen flash while opacity transitions to 0.
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
    if (typeof closeWeatherDetails === 'function') closeWeatherDetails();
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

function closeMediaMode() {
  toggleMediaMode(false);
}

function openMediaModeSettings() {
  hideMediaModeOverlay();
  setMediaModeToggleState(false);
  if (typeof toggleSettings === 'function') toggleSettings();
}

function refreshMediaModeFromSettings() {
  const frame = getMediaModeFrame();
  if (!frame) return;

  const nextUrl = getMediaModeUrl();
  if (!nextUrl) {
    frame.removeAttribute('src');
    mediaModeFrameUrl = '';
    mediaModeLoaded = false;
    hideMediaModeOverlay();
    setMediaModeToggleState(false);
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
setMediaModeToggleState(false);
hideMediaModeOverlay();
syncMediaModeOverlayContent();
