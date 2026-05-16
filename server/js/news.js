'use strict';

const NEWS_MIN_REFRESH_MINUTES = 1;
const NEWS_MAX_REFRESH_MINUTES = 120;
const NEWS_DEFAULT_REFRESH_MINUTES = 10;
const NEWS_MIN_RESULTS = 1;
const NEWS_MAX_RESULTS = 50;
const NEWS_DEFAULT_RESULTS = 10;
let newsItems = [];
let newsRefreshTimer = null;
let configuredNewsRefreshMs = NEWS_DEFAULT_REFRESH_MINUTES * 60 * 1000;

function sanitizeNewsDomain(value) {
  const raw = String(value || '')
    .toLowerCase()
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./, '')
    .split('/')[0]
    .split('?')[0]
    .split('#')[0]
    .trim();
  const cleaned = raw.replace(/[^a-z0-9.-]/g, '').replace(/\.\.+/g, '.').replace(/^-+|-+$/g, '');
  if (!cleaned || !cleaned.includes('.')) return '';
  return cleaned.slice(0, 120);
}

function getConfiguredNewsRefreshMinutes() {
  const source = hubSettings && hubSettings.news && Number(hubSettings.news.refreshMinutes);
  if (!Number.isFinite(source)) return NEWS_DEFAULT_REFRESH_MINUTES;
  return Math.max(NEWS_MIN_REFRESH_MINUTES, Math.min(NEWS_MAX_REFRESH_MINUTES, Math.round(source)));
}

function getConfiguredNewsMaxResults() {
  const source = hubSettings && hubSettings.news && Number(hubSettings.news.maxResults);
  if (!Number.isFinite(source)) return NEWS_DEFAULT_RESULTS;
  return Math.max(NEWS_MIN_RESULTS, Math.min(NEWS_MAX_RESULTS, Math.round(source)));
}

function scheduleNewsTickerRefresh() {
  const nextMs = getConfiguredNewsRefreshMinutes() * 60 * 1000;
  configuredNewsRefreshMs = nextMs;
  if (newsRefreshTimer) clearInterval(newsRefreshTimer);
  newsRefreshTimer = setInterval(() => refreshNewsTicker(true), configuredNewsRefreshMs);
}

function sanitizeNewsItem(rawItem) {
  if (!rawItem || typeof rawItem !== 'object') return null;
  const title = String(rawItem.title || '').replace(/\s+/g, ' ').trim().slice(0, 220);
  const source = String(rawItem.source || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const sourceDomain = sanitizeNewsDomain(rawItem.sourceDomain || rawItem.sourceUrl || '');
  const link = String(rawItem.link || '').trim().slice(0, 2048);
  if (!title || !/^https?:\/\//i.test(link)) return null;
  return { title, source, sourceDomain, link };
}

function createNewsTickerSegment(items) {
  const fragment = document.createDocumentFragment();
  items.forEach((item, index) => {
    const link = document.createElement('a');
    link.className = 'news-item';
    link.href = item.link;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    if (item.sourceDomain) {
      const icon = document.createElement('img');
      icon.className = 'news-source-icon';
      icon.src = `https://www.google.com/s2/favicons?sz=32&domain=${encodeURIComponent(item.sourceDomain)}`;
      icon.alt = item.source || item.sourceDomain;
      icon.loading = 'lazy';
      icon.decoding = 'async';
      icon.referrerPolicy = 'no-referrer';
      icon.onerror = () => { icon.remove(); };
      link.appendChild(icon);
    }
    const titleEl = document.createElement('span');
    titleEl.className = 'news-title';
    titleEl.textContent = item.title;
    link.appendChild(titleEl);
    link.title = item.title;
    fragment.appendChild(link);
    if (index !== items.length - 1) {
      const separator = document.createElement('span');
      separator.className = 'news-sep';
      separator.textContent = '•';
      fragment.appendChild(separator);
    }
  });
  return fragment;
}

function renderNewsTicker() {
  const ticker = $('news-ticker');
  const track = $('news-ticker-track');
  if (!ticker || !track) return;

  track.classList.remove('running');
  track.innerHTML = '';

  if (!newsItems.length) {
    ticker.dataset.state = 'empty';
    const empty = document.createElement('span');
    empty.className = 'news-empty';
    empty.textContent = t('news_unavailable');
    track.appendChild(empty);
    return;
  }

  ticker.dataset.state = 'ready';
  track.appendChild(createNewsTickerSegment(newsItems));
  track.appendChild(createNewsTickerSegment(newsItems));

  // Keep ticker speed readable but not glacial as result count increases.
  // Distance is one segment width because animation runs from 0 to -50%.
  const segmentDistancePx = Math.max(1200, Math.round(track.scrollWidth / 2));
  const speedPxPerSec = 55;
  const duration = Math.max(36, Math.min(120, Math.round(segmentDistancePx / speedPxPerSec)));
  track.style.setProperty('--news-ticker-duration', `${duration}s`);
  track.classList.add('running');
}

async function fetchNewsTicker(forceRefresh = false) {
  const params = forceRefresh ? '?refresh=1' : '';
  const res = await fetch(`/news${params}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`news ${res.status}`);
  const data = await res.json().catch(() => ({}));
  const list = Array.isArray(data.items) ? data.items : [];
  const sanitized = list.map(sanitizeNewsItem).filter(Boolean).slice(0, getConfiguredNewsMaxResults());
  return sanitized;
}

async function refreshNewsTicker(forceRefresh = false) {
  const ticker = $('news-ticker');
  if (!ticker) return;
  ticker.dataset.state = 'loading';
  if (!newsItems.length) {
    const track = $('news-ticker-track');
    if (track) {
      track.classList.remove('running');
      track.innerHTML = `<span class="news-empty">${escHtml(t('news_loading'))}</span>`;
    }
  }
  try {
    newsItems = await fetchNewsTicker(forceRefresh);
  } catch {
    if (!newsItems.length) newsItems = [];
  }
  renderNewsTicker();
}

function initNewsTicker() {
  if (!$('news-ticker')) return;
  scheduleNewsTickerRefresh();
  refreshNewsTicker(false);
}

function refreshNewsTickerFromSettings(options = {}) {
  if (!$('news-ticker')) return;
  if (options && options.reflowOnly) {
    if (Array.isArray(newsItems) && newsItems.length) {
      newsItems = newsItems.slice(0, getConfiguredNewsMaxResults());
      renderNewsTicker();
    }
    return;
  }
  const previous = configuredNewsRefreshMs;
  scheduleNewsTickerRefresh();
  if (options && options.forceRefresh) {
    refreshNewsTicker(true);
    return;
  }
  if (previous !== configuredNewsRefreshMs) refreshNewsTicker(true);
}
