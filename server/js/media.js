'use strict';

function syncLockMediaPlaybackIcon(playing) {
  const lockPlayIcon = $('lock-media-play');
  const lockPauseIcon = $('lock-media-pause');
  if (lockPlayIcon) {
    lockPlayIcon.hidden = false;
    lockPlayIcon.style.display = playing ? 'none' : '';
  }
  if (lockPauseIcon) {
    lockPauseIcon.hidden = false;
    lockPauseIcon.style.display = playing ? '' : 'none';
  }
}

function preferredMediaView() {
  return typeof getDashboardMediaView === 'function' ? getDashboardMediaView() : 'media';
}

const MEDIA_PROGRESS_MAX = 1000;
let mediaSeekDragging = false;
let mediaSeekInFlight = false;
let mediaSeekQueuedSeconds = null;
let mediaSeekOverrideUntil = 0;
let mediaSeekOverrideSeconds = 0;
let mediaProgressTicker = null;
let mediaTimelineAnchorSeconds = 0;
let mediaTimelineAnchorAt = 0;
let mediaTimelineDuration = 0;
let mediaTimelineStatus = 'Paused';
let mediaTimelineTrackKey = '';

function clampMediaSeconds(seconds, duration) {
  const safeDuration = Math.max(0, Math.floor(Number(duration) || 0));
  const safeSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
  if (safeDuration <= 0) return safeSeconds;
  return Math.min(safeDuration, safeSeconds);
}

function mediaTrackKey(data) {
  if (!data) return '';
  const app = String(data.app || '').trim().toLowerCase();
  const source = String(data.source || '').trim().toLowerCase();
  const title = String(cleanTitle(data.title) || '').trim().toLowerCase();
  const artist = String(data.artist || data.album || '').trim().toLowerCase();
  return `${app}|${source}|${title}|${artist}`;
}

function setMediaTimeline(positionSeconds, durationSeconds, status, trackKey = null) {
  const duration = Math.max(0, Math.floor(Number(durationSeconds) || 0));
  mediaTimelineDuration = duration;
  mediaTimelineStatus = String(status || 'Paused');
  mediaTimelineAnchorSeconds = clampMediaSeconds(positionSeconds, duration);
  mediaTimelineAnchorAt = Date.now();
  if (typeof trackKey === 'string') mediaTimelineTrackKey = trackKey;
}

function getMediaTimelinePosition() {
  const duration = Math.max(0, mediaTimelineDuration);
  const base = clampMediaSeconds(mediaTimelineAnchorSeconds, duration);
  if (mediaTimelineStatus !== 'Playing') return base;
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - mediaTimelineAnchorAt) / 1000));
  return clampMediaSeconds(base + elapsedSeconds, duration);
}

function formatMediaTime(value) {
  const total = Math.max(0, Math.floor(Number(value) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function setMediaProgressFill(slider, ratio) {
  if (!slider) return;
  const safeRatio = Math.max(0, Math.min(1, Number(ratio) || 0));
  const pct = safeRatio * 100;
  const fill = `linear-gradient(to right, var(--accent) 0%, var(--accent) ${pct}%, #171c1c ${pct}%, #171c1c 100%)`;
  slider.style.setProperty('--media-progress-fill', fill);
  slider.style.background = fill;
}

function syncMediaProgress(positionSeconds, durationSeconds, force = false) {
  const block = $('media-progress');
  const slider = $('media-progress-slider');
  const elapsed = $('media-progress-elapsed');
  const total = $('media-progress-total');
  if (!block || !slider || !elapsed || !total) return;

  const duration = Math.max(0, Math.floor(Number(durationSeconds) || 0));
  const hasTimeline = duration > 0;
  block.hidden = !hasTimeline;

  if (!hasTimeline) {
    slider.disabled = true;
    slider.value = '0';
    elapsed.textContent = '0:00';
    total.textContent = '0:00';
    setMediaProgressFill(slider, 0);
    return;
  }

  slider.disabled = false;
  const now = Date.now();
  let position = clampMediaSeconds(positionSeconds, duration);
  if (!force && mediaSeekOverrideUntil > now) {
    position = clampMediaSeconds(mediaSeekOverrideSeconds, duration);
  } else if (mediaSeekOverrideUntil <= now) {
    mediaSeekOverrideUntil = 0;
  }

  total.textContent = formatMediaTime(duration);

  if (mediaSeekDragging && !force) {
    const previewRatio = Math.max(0, Math.min(1, (Number(slider.value) || 0) / MEDIA_PROGRESS_MAX));
    const previewSeconds = clampMediaSeconds(Math.round(duration * previewRatio), duration);
    elapsed.textContent = formatMediaTime(previewSeconds);
    setMediaProgressFill(slider, previewRatio);
    return;
  }

  const ratio = duration > 0 ? position / duration : 0;
  slider.value = String(Math.round(ratio * MEDIA_PROGRESS_MAX));
  elapsed.textContent = formatMediaTime(position);
  setMediaProgressFill(slider, ratio);
}

function ensureMediaProgressTicker() {
  if (mediaProgressTicker) return;
  mediaProgressTicker = setInterval(() => {
    if (!mediaData || !mediaData.active) return;
    if (mediaSeekDragging || mediaSeekInFlight) return;
    const duration = Math.max(0, Math.floor(mediaTimelineDuration || Number(mediaData.duration) || 0));
    if (duration <= 0) return;

    if (mediaSeekOverrideUntil > Date.now()) {
      syncMediaProgress(mediaSeekOverrideSeconds, duration);
      return;
    }
    syncMediaProgress(getMediaTimelinePosition(), duration);
  }, 1000);
}

async function sendMediaSeek(targetSeconds) {
  try {
    const res = await fetch(SERVER + '/media/seek', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ position: targetSeconds }),
    });
    if (!res.ok) throw new Error('Media seek failed');
    setOnline();
    return await res.json().catch(() => ({ ok: true, position: targetSeconds }));
  } catch {
    setOffline();
    return { ok: false };
  }
}

async function flushMediaSeekQueue() {
  if (mediaSeekInFlight || mediaSeekQueuedSeconds === null) return;
  const targetSeconds = mediaSeekQueuedSeconds;
  mediaSeekQueuedSeconds = null;
  mediaSeekInFlight = true;
  const result = await sendMediaSeek(targetSeconds);
  mediaSeekInFlight = false;

  if (result && result.ok) {
    const duration = Math.max(0, Math.floor(Number(mediaData && mediaData.duration) || Number(result.duration) || 0));
    mediaSeekOverrideSeconds = clampMediaSeconds(Number(result.position), duration || Number(result.position));
    mediaSeekOverrideUntil = Date.now() + 4000;
    if (mediaData) {
      mediaData.position = mediaSeekOverrideSeconds;
      if (duration > 0) mediaData.duration = duration;
    }
    setMediaTimeline(
      mediaSeekOverrideSeconds,
      duration || (mediaData && mediaData.duration) || 0,
      mediaData && mediaData.playbackStatus ? mediaData.playbackStatus : mediaTimelineStatus,
      mediaTrackKey(mediaData),
    );
    syncMediaProgress(mediaSeekOverrideSeconds, duration || (mediaData && mediaData.duration) || 0);
    setTimeout(fetchMedia, 200);
  } else {
    setTimeout(fetchMedia, 120);
  }

  if (mediaSeekQueuedSeconds !== null && mediaSeekQueuedSeconds !== targetSeconds) {
    flushMediaSeekQueue();
  }
}

function queueMediaSeek(targetSeconds) {
  mediaSeekQueuedSeconds = Math.max(0, Math.floor(Number(targetSeconds) || 0));
  if (!mediaSeekInFlight) flushMediaSeekQueue();
}

function onMediaSeekInput(rawValue) {
  const slider = $('media-progress-slider');
  if (!slider || !mediaData) return;
  const duration = Math.max(0, Math.floor(Number(mediaData.duration) || 0));
  if (duration <= 0) return;
  mediaSeekDragging = true;
  const ratio = Math.max(0, Math.min(1, (Number(rawValue) || 0) / MEDIA_PROGRESS_MAX));
  const targetSeconds = clampMediaSeconds(Math.round(duration * ratio), duration);
  mediaSeekOverrideSeconds = targetSeconds;
  mediaSeekOverrideUntil = Date.now() + 4000;
  setMediaTimeline(
    targetSeconds,
    duration,
    mediaData && mediaData.playbackStatus ? mediaData.playbackStatus : mediaTimelineStatus,
    mediaTrackKey(mediaData),
  );
  syncMediaProgress(targetSeconds, duration, true);
}

function onMediaSeekCommit(rawValue) {
  const slider = $('media-progress-slider');
  if (!slider || !mediaData) {
    mediaSeekDragging = false;
    return;
  }
  const duration = Math.max(0, Math.floor(Number(mediaData.duration) || 0));
  if (duration <= 0) {
    mediaSeekDragging = false;
    return;
  }
  const ratio = Math.max(0, Math.min(1, (Number(rawValue) || 0) / MEDIA_PROGRESS_MAX));
  const targetSeconds = clampMediaSeconds(Math.round(duration * ratio), duration);
  mediaSeekDragging = false;
  mediaSeekOverrideSeconds = targetSeconds;
  mediaSeekOverrideUntil = Date.now() + 5000;
  setMediaTimeline(
    targetSeconds,
    duration,
    mediaData && mediaData.playbackStatus ? mediaData.playbackStatus : mediaTimelineStatus,
    mediaTrackKey(mediaData),
  );
  syncMediaProgress(targetSeconds, duration, true);
  queueMediaSeek(targetSeconds);
}

function finishMediaSeekDrag() {
  if (!mediaSeekDragging) return;
  const slider = $('media-progress-slider');
  if (!slider) {
    mediaSeekDragging = false;
    return;
  }
  onMediaSeekCommit(slider.value);
}

function applyMedia(data) {
  ensureMediaProgressTicker();
  const previousMedia = mediaData;
  const nextTrackKey = mediaTrackKey(data);
  const previousTrackKey = mediaTrackKey(previousMedia);
  const sameItem = !!(nextTrackKey && previousTrackKey && nextTrackKey === previousTrackKey);
  const duration = Math.max(0, Math.floor(Number(data && data.duration) || Number(previousMedia && previousMedia.duration) || 0));
  let incomingPosition = clampMediaSeconds(Number(data && data.position), duration || Number(data && data.position));
  const playbackStatus = String(data && data.playbackStatus || 'Paused');
  const localPosition = getMediaTimelinePosition();
  const statusChanged = playbackStatus !== mediaTimelineStatus;
  const hasSeekOverride = mediaSeekOverrideUntil > Date.now();
  let resolvedPosition = incomingPosition;
  let shouldResetTimeline = true;

  if (data && previousMedia && data.active && previousMedia.active && sameItem) {
    const delta = incomingPosition - localPosition;
    if (hasSeekOverride) {
      resolvedPosition = clampMediaSeconds(mediaSeekOverrideSeconds, duration || mediaTimelineDuration || incomingPosition);
      shouldResetTimeline = true;
    } else if (statusChanged) {
      // External play/pause changes often arrive with stale position.
      if (delta < -4 && delta > -40) resolvedPosition = localPosition;
      shouldResetTimeline = true;
    } else if (playbackStatus === 'Playing') {
      // While playing, keep local clock unless backend clearly moved.
      if (delta >= 2 || delta <= -25) {
        resolvedPosition = incomingPosition;
        shouldResetTimeline = true;
      } else {
        resolvedPosition = localPosition;
        shouldResetTimeline = false;
      }
    } else {
      // While paused/stopped, follow backend on near/large changes; otherwise keep stable.
      if (Math.abs(delta) <= 8 || Math.abs(delta) >= 25) {
        resolvedPosition = incomingPosition;
        shouldResetTimeline = true;
      } else {
        resolvedPosition = localPosition;
        shouldResetTimeline = false;
      }
    }
  }

  if (data) {
    data.position = resolvedPosition;
    data.duration = duration;
  }
  if (shouldResetTimeline || !sameItem || !data || !data.active) {
    setMediaTimeline(resolvedPosition, duration, playbackStatus, nextTrackKey);
  } else {
    mediaTimelineDuration = duration;
    mediaTimelineStatus = playbackStatus;
    mediaTimelineTrackKey = nextTrackKey;
  }
  mediaData = data;
  if (typeof syncMediaModeFromPlayback === 'function') syncMediaModeFromPlayback(data);
  const panel = $('media-panel');
  const art = $('media-art');
  const bg = $('media-bg');
  panel.classList.remove('spotify', 'youtube');

  const active = data && data.active && (data.title || data.artist || data.app);
  if (!active) {
    refreshMediaEmpty();
    calendarAutoShown = preferredMediaView() !== 'calendar';
    showCalendar(true, true);
    updateCalendarMiniPlayer();
    return;
  }

  if (calendarAutoShown) {
    calendarAutoShown = false;
    showCalendar(preferredMediaView() === 'calendar', true);
  }

  const app = localizeAppName(data.app) || t('media');
  $('media-app').textContent = app;
  $('media-title').textContent = cleanTitle(data.title) || t('media_unknown_title');
  $('media-artist').textContent = data.artist || data.album || '';

  if (/spotify/i.test(app)) panel.classList.add('spotify');
  if (/youtube/i.test(app)) panel.classList.add('youtube');

  if (data.thumbnail) {
    art.classList.add('has-image');
    art.style.backgroundImage = `url("${data.thumbnail}")`;
    panel.classList.add('has-image');
    bg.style.backgroundImage = `url("${data.thumbnail}")`;
  } else {
    art.classList.remove('has-image');
    art.style.backgroundImage = '';
    panel.classList.remove('has-image');
    bg.style.backgroundImage = '';
  }

  const playing = data.playbackStatus === 'Playing';
  $('play-icon').style.display = playing ? 'none' : '';
  $('pause-icon').style.display = playing ? '' : 'none';
  syncMediaProgress(getMediaTimelinePosition(), mediaTimelineDuration || data.duration);
  syncLockMediaPlaybackIcon(playing);
  updateCalendarMiniPlayer();
}

function hasActiveMedia() {
  return !!(mediaData && mediaData.active && (mediaData.title || mediaData.artist || mediaData.app));
}

function updateCalendarMiniPlayer() {
  const mini = $('calendar-mini-player');
  if (!mini) return;
  if (!calendarMode || !hasActiveMedia()) {
    mini.classList.remove('show');
    const cover = $('mini-media-cover');
    if (cover) {
      cover.classList.remove('has-image');
      cover.style.backgroundImage = '';
    }
    return;
  }
  const title = cleanTitle(mediaData.title) || localizeAppName(mediaData.app) || t('now_playing');
  $('mini-media-title').textContent = title;
  $('mini-media-sub').textContent = [mediaData.artist || mediaData.album, localizeAppName(mediaData.app)].filter(Boolean).join(' - ') || t('active_player');
  const cover = $('mini-media-cover');
  if (cover) {
    cover.classList.toggle('has-image', !!mediaData.thumbnail);
    cover.style.backgroundImage = mediaData.thumbnail ? `url("${mediaData.thumbnail}")` : '';
  }
  const playing = mediaData.playbackStatus === 'Playing';
  $('mini-play-icon').style.display = playing ? 'none' : '';
  $('mini-pause-icon').style.display = playing ? '' : 'none';
  syncLockMediaPlaybackIcon(playing);
  mini.classList.add('show');
}

function refreshMediaEmpty() {
  const panel = $('media-panel');
  const art = $('media-art');
  const bg = $('media-bg');
  panel.classList.remove('spotify', 'youtube');
  $('media-app').textContent = t('media');
  $('media-title').textContent = t('media_empty_title');
  $('media-artist').textContent = t('media_empty_sub');
  art.classList.remove('has-image');
  art.style.backgroundImage = '';
  panel.classList.remove('has-image');
  bg.style.backgroundImage = '';
  $('play-icon').style.display = '';
  $('pause-icon').style.display = 'none';
  mediaSeekDragging = false;
  mediaSeekQueuedSeconds = null;
  mediaSeekOverrideUntil = 0;
  mediaSeekOverrideSeconds = 0;
  mediaTimelineAnchorSeconds = 0;
  mediaTimelineAnchorAt = 0;
  mediaTimelineDuration = 0;
  mediaTimelineStatus = 'Paused';
  mediaTimelineTrackKey = '';
  syncMediaProgress(0, 0, true);
  syncLockMediaPlaybackIcon(false);
}

async function mediaAction(action) {
  try {
    if (action === 'playpause' && mediaData) {
      const playing = mediaData.playbackStatus === 'Playing';
      const nextStatus = playing ? 'Paused' : 'Playing';
      const currentPos = getMediaTimelinePosition();
      $('play-icon').style.display = playing ? '' : 'none';
      $('pause-icon').style.display = playing ? 'none' : '';
      mediaData.playbackStatus = nextStatus;
      mediaData.position = currentPos;
      setMediaTimeline(
        currentPos,
        Math.max(0, Math.floor(Number(mediaData.duration) || 0)),
        nextStatus,
        mediaTrackKey(mediaData),
      );
      syncMediaProgress(currentPos, mediaTimelineDuration || mediaData.duration, true);
      updateCalendarMiniPlayer();
      syncLockMediaPlaybackIcon(!playing);
      if (typeof refreshLockScreen === 'function') refreshLockScreen();
    }
    const res = await fetch(SERVER + '/media/' + action, { method: 'POST' });
    if (!res.ok) throw new Error('Media action failed');
    setTimeout(fetchMedia, action === 'playpause' ? 320 : 620);
  } catch { }
}

async function fetchMedia() {
  if (fetchingMedia) return;
  fetchingMedia = true;
  try {
    const res = await fetch(SERVER + '/media');
    if (!res.ok) throw new Error('Media unavailable');
    const data = await res.json();
    applyMedia(data);
  } catch { }
  fetchingMedia = false;
}
