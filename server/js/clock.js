'use strict';

function fitSingleLineText(el, container, minScale = 0.5, reservePx = 0, clampWidth = true) {
  if (!el || !container) return;
  el.style.fontSize = '';
  el.style.maxWidth = 'none';
  const SAFETY_PX = 8;

  const style = window.getComputedStyle(container);
  const padLeft = Number.parseFloat(style.paddingLeft) || 0;
  const padRight = Number.parseFloat(style.paddingRight) || 0;
  const available = Math.max(12, Math.floor(container.clientWidth - padLeft - padRight - reservePx - 16));
  const target = Math.max(8, available - SAFETY_PX);

  const textStyle = window.getComputedStyle(el);
  const base = Number.parseFloat(textStyle.fontSize) || 20;
  const min = Math.max(7, base * minScale);
  let low = min;
  let high = base;
  let best = min;

  // Binary search on intrinsic text width (scrollWidth), not clipped rendered width.
  for (let i = 0; i < 20; i += 1) {
    const mid = (low + high) / 2;
    el.style.fontSize = `${mid}px`;
    if (el.scrollWidth <= target) {
      best = mid;
      low = mid + 0.05;
    } else {
      high = mid - 0.05;
    }
  }

  el.style.fontSize = `${best}px`;
  el.style.maxWidth = clampWidth ? `${target}px` : 'none';

  // Safety pass to avoid right-edge crop from subpixel rounding.
  while (
    (el.scrollWidth > target || el.getBoundingClientRect().width > target)
    && Number.parseFloat(el.style.fontSize) > 7
  ) {
    const next = Number.parseFloat(el.style.fontSize) - 0.2;
    el.style.fontSize = `${next}px`;
  }
}

function fitClockText() {
  fitSingleLineText($('clock-ny'), $('clock-main'), 0.5, 0);
}

let centerSecondsMarkerFrame = 0;
const CENTER_SECONDS_MARKER_ONE_WAY_MS = 1000;

function applyCenterSecondsMarker(timestamp) {
  const marker = $('center-time-seconds-marker');
  if (!marker) return;
  const dot = marker.querySelector('.center-time-seconds-dot');
  const trail = marker.querySelector('.center-time-seconds-trail');
  if (!dot || !trail) return;

  const trackWidth = marker.clientWidth;
  if (trackWidth <= 2) return;

  const styles = window.getComputedStyle(marker);
  const dotSize = Math.max(4, Number.parseFloat(styles.getPropertyValue('--marker-dot-size')) || 10);
  const trailMax = Math.max(0, Number.parseFloat(styles.getPropertyValue('--marker-trail-max')) || 34);

  const cycleMs = CENTER_SECONDS_MARKER_ONE_WAY_MS * 2;
  const local = timestamp % cycleMs;
  const goingRight = local < CENTER_SECONDS_MARKER_ONE_WAY_MS;
  const phase = local / CENTER_SECONDS_MARKER_ONE_WAY_MS; // 0..2
  const progress = goingRight ? phase : (2 - phase); // 0..1..0

  const minCenter = dotSize / 2;
  const maxCenter = Math.max(minCenter, trackWidth - dotSize / 2);
  const centerX = minCenter + (maxCenter - minCenter) * Math.max(0, Math.min(1, progress));

  const leftRoom = Math.max(0, centerX - minCenter);
  const rightRoom = Math.max(0, maxCenter - centerX);
  const trailLen = Math.min(trailMax, goingRight ? leftRoom : rightRoom);

  dot.style.left = `${centerX}px`;
  trail.style.width = `${trailLen}px`;
  if (goingRight) {
    marker.classList.add('dir-right');
    marker.classList.remove('dir-left');
    trail.style.left = `${centerX - trailLen}px`;
  } else {
    marker.classList.add('dir-left');
    marker.classList.remove('dir-right');
    trail.style.left = `${centerX}px`;
  }
}

function loopCenterSecondsMarker(timestamp) {
  applyCenterSecondsMarker(timestamp);
  centerSecondsMarkerFrame = window.requestAnimationFrame(loopCenterSecondsMarker);
}

function ensureCenterSecondsMarkerLoop() {
  if (centerSecondsMarkerFrame) return;
  centerSecondsMarkerFrame = window.requestAnimationFrame(loopCenterSecondsMarker);
}

function getClockParts(date, is12h) {
  const h24 = date.getHours();
  const mins = date.getMinutes();
  const secs = date.getSeconds();

  if (is12h) {
    const h12 = h24 % 12 || 12;
    return {
      h: String(h12).padStart(2, '0'),
      m: String(mins).padStart(2, '0'),
      s: String(secs).padStart(2, '0'),
      ampm: h24 < 12 ? 'AM' : 'PM',
    };
  }

  return {
    h: String(h24).padStart(2, '0'),
    m: String(mins).padStart(2, '0'),
    s: String(secs).padStart(2, '0'),
    ampm: '',
  };
}

function tickClock() {
  const now = new Date();
  const locale = t('locale');
  const is12h = String(locale || '').toLowerCase().startsWith('en');
  const main = getClockParts(now, is12h);

  $('clock-h').textContent = main.h;
  $('clock-m').textContent = main.m;
  const secEl = $('clock-s');
  if (secEl) secEl.textContent = main.s;
  const ampmEl = $('clock-ampm');
  if (ampmEl) ampmEl.textContent = main.ampm;

  const nyEl = $('clock-ny');
  $('clock-date').textContent = new Intl.DateTimeFormat('it-IT', {
    day: '2-digit', month: '2-digit', year: 'numeric'
  }).format(now);
  if (nyEl) {
    const nyTime = new Intl.DateTimeFormat(locale, {
      hour: '2-digit',
      minute: '2-digit',
      hour12: is12h,
      timeZone: 'Etc/GMT+4',
    }).format(now);
    nyEl.textContent = nyTime;

    const centerSub = $('center-clock-sub');
    if (centerSub) centerSub.textContent = `NY ${nyTime}`;
  }

  const centerMain = $('center-clock-main');
  if (centerMain) {
    centerMain.textContent = `${main.h}:${main.m}`;
  }

  const centerMonth = $('center-date-month');
  const centerDay = $('center-date-day');
  if (centerMonth) {
    const monthLocale = is12h ? 'en-US' : 'it-IT';
    const shortMonth = new Intl.DateTimeFormat(monthLocale, { month: 'short' })
      .format(now)
      .replace(/\./g, '')
      .replace(/\s+/g, '')
      .slice(0, 3)
      .toUpperCase();
    centerMonth.textContent = shortMonth;
  }
  if (centerDay) {
    centerDay.textContent = String(now.getDate());
  }

  fitClockText();
}

window.addEventListener('resize', fitClockText);
ensureCenterSecondsMarkerLoop();
