const http = require('http');
const { exec, execFile, spawn } = require('child_process');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');

let isMuted = false;
let cachedSpeakerId   = null; // last known default speaker id (SVV or endpoint id)
let cachedMicId       = null; // last known default mic id (SVV or endpoint id)

const SVV = path.join(__dirname, 'soundvolumeview-x64', 'SoundVolumeView.exe');
const AUDIOCTL_PROJECT = path.join(__dirname, 'audioctl', 'AudioCtl.csproj');
const AUDIOCTL_DLL = path.join(__dirname, 'audioctl', 'bin', 'Release', 'net9.0-windows', 'AudioCtl.dll');
const DOTNET_BIN = process.env.XEH_DOTNET || 'dotnet';
const CPU_TEMP_SCRIPT = path.join(__dirname, 'cpu-temp.ps1');
const GPU_SCRIPT = path.join(__dirname, 'gpu.ps1');
const NETWORK_SCRIPT = path.join(__dirname, 'network.ps1');
const WINDOWS_SCRIPT = path.join(__dirname, 'windows.ps1');
const SHORTCUT_SCRIPT = path.join(__dirname, 'shortcut.ps1');
const NOTES_FILE = path.join(__dirname, 'notes.txt');
const EVENTS_FILE = path.join(__dirname, 'events.json');
const TASKS_FILE = path.join(__dirname, 'tasks.json');
const TASKS_MAX = 100;
const SETTINGS_FILE = path.join(__dirname, 'settings.json');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const BACKGROUND_MAX_BYTES = 200 * 1024 * 1024;
const BACKGROUND_TRANSCODE_TIMEOUT_MS = 10 * 60 * 1000;
const SETTINGS_MIN_PANEL_ALPHA = 0.18;
const NEWS_DEFAULT_FEED_URL = 'https://news.google.com/rss/search?q=notizie%20mondo&hl=it-IT&gl=IT&ceid=IT:it&num=10';
const NEWS_MIN_REFRESH_MINUTES = 1;
const NEWS_MAX_REFRESH_MINUTES = 120;
const NEWS_DEFAULT_REFRESH_MINUTES = 10;
const NEWS_MIN_RESULTS = 1;
const NEWS_MAX_RESULTS = 50;
const NEWS_DEFAULT_RESULTS = 10;
const CALENDAR_SYNC_MIN_REFRESH_MINUTES = 1;
const CALENDAR_SYNC_MAX_REFRESH_MINUTES = 360;
const CALENDAR_SYNC_DEFAULT_REFRESH_MINUTES = 10;
const CALENDAR_SYNC_WINDOW_DAYS_PAST = 14;
const CALENDAR_SYNC_WINDOW_DAYS_FUTURE = 365;
const CALENDAR_SYNC_MAX_OCCURRENCES = 2000;
const CALENDAR_HOLIDAY_FEED_URL = 'https://calendar.google.com/calendar/ical/it.italian%23holiday%40group.v.calendar.google.com/public/basic.ics';
const CALENDAR_HOLIDAY_REFRESH_MS = 12 * 60 * 60 * 1000;
const NEWS_SOURCE_DOMAIN_OVERRIDES = new Map([
  ['ansa', 'ansa.it'],
  ['ansait', 'ansa.it'],
  ['skytg24', 'tg24.sky.it'],
  ['skytg24it', 'tg24.sky.it'],
]);
const BACKGROUND_MIME_BY_EXT = new Map([
  ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.png', 'image/png'],
  ['.webp', 'image/webp'], ['.gif', 'image/gif'], ['.mp4', 'video/mp4'], ['.webm', 'video/webm'],
]);
const BACKGROUND_EXT_BY_MIME = new Map([...BACKGROUND_MIME_BY_EXT.entries()].map(([ext, mime]) => [mime, ext]));

// CSV column indices for SoundVolumeView /scomma (no header row)
const F = { NAME: 0, TYPE: 1, DIR: 2, DEVICE_NAME: 3, DEFAULT: 4, STATE: 7, MUTED: 8, VOL_PCT: 10, ITEM_ID: 17, CLI_ID: 18, WINDOW_TITLE: 21 };
let audioCtlReady = fs.existsSync(AUDIOCTL_DLL);
let audioCtlBuildInFlight = null;
const MEDIA_DEBUG_LOGS = parseBooleanConfig(process.env.XEH_MEDIA_DEBUG, true);
const FALLBACKS_DEFAULT_ENABLED = parseBooleanConfig(process.env.XEH_AUDIO_FALLBACKS, false);
let fallbacksEnabled = FALLBACKS_DEFAULT_ENABLED;

function parseJsonOutput(stdout) {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON output');
  return JSON.parse(stdout.slice(start, end + 1));
}

function parseBooleanLike(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (!normalized) return null;
    if (['1', 'true', 'yes', 'on', 'enabled', 'enable'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off', 'disabled', 'disable'].includes(normalized)) return false;
  }
  return null;
}

function parseBooleanConfig(value, defaultValue) {
  const parsed = parseBooleanLike(value);
  return parsed === null ? defaultValue : parsed;
}

function areFallbacksEnabled() {
  return !!fallbacksEnabled;
}

function setFallbacksEnabled(nextValue) {
  fallbacksEnabled = !!nextValue;
  console.log(`[Fallbacks] ${fallbacksEnabled ? 'enabled' : 'disabled'}`);
  return fallbacksEnabled;
}

function sendFallbackDisabled(res, operation) {
  res.writeHead(503, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    ok: false,
    error: 'Fallbacks disabled',
    operation,
    fallbacksEnabled: false,
  }));
}

function runPowerShellScript(script, args = [], timeout = 5000) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], {
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!child.killed && child.exitCode === null) child.kill();
      fn(value);
    };

    const resolveIfJsonReady = () => {
      if (!stdout.trimEnd().endsWith('}')) return;
      try { settle(resolve, parseJsonOutput(stdout)); }
      catch { }
    };

    const timer = setTimeout(() => {
      try { settle(resolve, parseJsonOutput(stdout)); }
      catch { settle(reject, new Error(stderr || `PowerShell timeout: ${path.basename(script)}`)); }
    }, timeout);

    child.stdout.on('data', chunk => { stdout += chunk.toString(); resolveIfJsonReady(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', e => settle(reject, e));
    child.on('close', code => {
      if (settled) return;
      try { settle(resolve, parseJsonOutput(stdout)); }
      catch (e) { settle(reject, new Error(stderr || e.message || `PowerShell exited with ${code}`)); }
    });
  });
}

function runPowerShellCommand(command, timeout = 5000) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
      timeout,
      windowsHide: true,
    }, (err, stdout, stderr) => {
      if (err) { reject(new Error(stderr || err.message)); return; }
      try { resolve(parseJsonOutput(stdout)); }
      catch (e) { reject(e); }
    });
  });
}

function cpuSnapshot() {
  return os.cpus().map(cpu => {
    const times = cpu.times;
    const total = times.user + times.nice + times.sys + times.idle + times.irq;
    return { idle: times.idle, total };
  });
}

let lastCpu = cpuSnapshot();
let cachedCpuUsage = 0;
// Continuous CPU sampler — avoids 0% sampling artifacts when /system is polled less often than CPU times update.
setInterval(() => {
  const now = cpuSnapshot();
  let idle = 0, total = 0;
  now.forEach((cpu, i) => {
    idle  += cpu.idle  - lastCpu[i].idle;
    total += cpu.total - lastCpu[i].total;
  });
  lastCpu = now;
  if (total > 0) {
    const pct = Math.max(0, Math.min(100, Math.round(100 - (idle / total * 100))));
    cachedCpuUsage = pct;
  }
}, 1500).unref();
let gpuCache = { gpu: null, gpuName: null, gpuTemp: null, updatedAt: 0 };
let cpuTempCache = { cpuTemp: null, updatedAt: 0 };
let mediaCache = { data: null, updatedAt: 0 };
let mediaPrimaryRetryNotBefore = 0;
let mediaTimelineState = {
  key: '',
  lastKeyChangedAt: 0,
  duration: 0,
  status: 'Paused',
  anchorPosition: 0,
  anchorAt: 0,
  lastRawPosition: 0,
  pendingStatus: '',
  pendingSince: 0,
  pendingCount: 0,
  playingStallSince: 0,
  playingStallSamples: 0,
};
let weatherCache = { data: null, updatedAt: 0, cacheKey: '' };
let newsCache = { items: [], updatedAt: 0, feedUrl: NEWS_DEFAULT_FEED_URL, maxResults: NEWS_DEFAULT_RESULTS };
let calendarSyncCache = {
  events: [],
  updatedAt: 0,
  feedUrl: '',
  refreshMinutes: CALENDAR_SYNC_DEFAULT_REFRESH_MINUTES,
  sourceName: '',
  error: '',
};
let calendarHolidayCache = {
  events: [],
  updatedAt: 0,
  sourceName: '',
  error: '',
};
let gpuPending = null;
let cpuTempPending = null;
let mediaPending = null;
let weatherPending = null;
let newsPending = null;
let calendarSyncPending = null;
let calendarHolidayPending = null;
let windowAppsPending = null;
let mediaSampleInFlight = false;
let mediaStreamProcess = null;
let mediaStreamStarting = false;
let mediaStreamBuffer = '';
let mediaStreamRestartNotBefore = 0;
let mediaStreamRecycleTimer = null;
let mediaStreamWaiterSeq = 0;
const mediaStreamWaiters = new Map();
let lastMediaRequestAt = 0;
let lastMediaSsePushedAt = 0;
const MEDIA_PRIMARY_RETRY_BACKOFF_MS = 8000;
const WEATHER_CACHE_MS = 10 * 60 * 1000;
const NEWS_CACHE_MS = 5 * 60 * 1000;
const WINDOW_APPS_CACHE_MS = 15 * 1000;
const AUDIO_OVERRIDE_TTL_MS = 6000;
const artworkCache = new Map();
const mediaArtworkLookupInFlight = new Map();
const weatherLocationCache = new Map();
const windowAppsCache = { apps: [], updatedAt: 0 };
let speakerAudioOverride = { volume: null, muted: null, expiresAt: 0 };
let micAudioOverride = { volume: null, muted: null, expiresAt: 0 };
const appAudioOverrides = new Map();
let lastAudioInfoSnapshot = null;
let lastAudioInfoUpdatedAt = 0;
let lastAudioCtlRawSnapshot = null;
let lastAudioCtlRawUpdatedAt = 0;
let audioActivityCache = { speaker: 0, apps: [], updatedAt: 0 };
let audioActivitySampleInFlight = false;
let audioActivityStreamProcess = null;
let audioActivityStreamStarting = false;
let audioActivityStreamBuffer = '';
let audioActivityStreamRestartNotBefore = 0;
let audioActivityStreamWaiterSeq = 0;
let lastAudioActivitySsePushedAt = 0;
const audioActivityStreamWaiters = new Map();
let lastAudioActivityRequestAt = 0;
const AUDIO_ACTIVITY_KEEPALIVE_MS = 8000;
const AUDIO_ACTIVITY_CACHE_FRESH_MS = 320;
const AUDIO_ACTIVITY_CACHE_STALE_MS = 1800;
const AUDIO_ACTIVITY_STREAM_INTERVAL_MS = 18;
const AUDIO_ACTIVITY_STREAM_WAIT_MS = 160;
const AUDIO_ACTIVITY_STREAM_RESTART_BACKOFF_MS = 550;
const AUDIO_ACTIVITY_STREAM_MAX_BUFFER_CHARS = 64 * 1024;
const AUDIO_ACTIVITY_SSE_PUSH_MIN_INTERVAL_MS = 14;
const AUDIO_ACTIVITY_SILENCE_FLOOR = 2;
const MEDIA_STREAM_KEEPALIVE_MS = 10000;
const MEDIA_STREAM_CACHE_FRESH_MS = 320;
const MEDIA_STREAM_CACHE_STALE_MS = 2200;
const MEDIA_STREAM_INTERVAL_MS = 90;
const MEDIA_STREAM_WAIT_MS = 180;
const MEDIA_STREAM_RESTART_BACKOFF_MS = 600;
const MEDIA_STREAM_MAX_BUFFER_CHARS = 128 * 1024;
const MEDIA_SSE_PUSH_MIN_INTERVAL_MS = 90;
const AUDIO_SSE_REFRESH_INTERVAL_MS = 450;
const MEDIA_TRANSIENT_CLOSE_GRACE_MS = 4500;
const MEDIA_PLAYING_STALL_EPSILON_SECONDS = 0.03;
const MEDIA_PLAYING_STALL_FORCE_PAUSED_MS = 1350;
const MEDIA_PLAYING_STALL_MIN_SAMPLES = 4;
const MEDIA_PLAYBACK_RATE_FORCE_PAUSED_MAX = 0.05;
const MEDIA_TRACK_CHANGE_HINT_GRACE_MS = 1700;
const MEDIA_EXPLICIT_CLOSE_GRACE_MS = 0;
let mediaTransientHoldState = { key: '', startedAt: 0 };
const AUDIOCTL_MEDIA_ACTION_MAP = Object.freeze({
  playpause: 'media-playpause',
  next: 'media-next',
  previous: 'media-previous',
  seek: 'media-seek',
});

function withOverride(previous, patch, ttlMs = AUDIO_OVERRIDE_TTL_MS) {
  const now = Date.now();
  return {
    volume: typeof patch.volume === 'number' ? Math.max(0, Math.min(100, Math.round(patch.volume))) : previous.volume,
    muted: typeof patch.muted === 'boolean' ? patch.muted : previous.muted,
    expiresAt: now + Math.max(250, ttlMs),
  };
}

function setSpeakerAudioOverride(patch, ttlMs = AUDIO_OVERRIDE_TTL_MS) {
  speakerAudioOverride = withOverride(speakerAudioOverride, patch, ttlMs);
}

function setMicAudioOverride(patch, ttlMs = AUDIO_OVERRIDE_TTL_MS) {
  micAudioOverride = withOverride(micAudioOverride, patch, ttlMs);
}

function setAppAudioOverride(id, patch, ttlMs = AUDIO_OVERRIDE_TTL_MS) {
  const key = String(id || '').trim();
  if (!key) return;
  const previous = appAudioOverrides.get(key) || { volume: null, muted: null, expiresAt: 0 };
  appAudioOverrides.set(key, withOverride(previous, patch, ttlMs));
}

function applyDeviceAudioOverride(device, overrideState) {
  if (!device || !overrideState) return device;
  if (overrideState.expiresAt <= Date.now()) return device;
  if (typeof overrideState.volume === 'number') device.volume = overrideState.volume;
  if (typeof overrideState.muted === 'boolean') device.muted = overrideState.muted;
  return device;
}

function applyAppAudioOverride(appItem) {
  if (!appItem || !appItem.id) return appItem;
  const override = appAudioOverrides.get(appItem.id);
  if (!override) return appItem;
  if (override.expiresAt <= Date.now()) {
    appAudioOverrides.delete(appItem.id);
    return appItem;
  }
  if (typeof override.volume === 'number') appItem.volume = override.volume;
  if (typeof override.muted === 'boolean') appItem.muted = override.muted;
  return appItem;
}

function makeCsvPath() {
  const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return path.join(os.tmpdir(), `xenonedge-svv-${stamp}.csv`);
}

function readSoundVolumeRows() {
  return new Promise((resolve, reject) => {
    const csv = makeCsvPath();
    execFile(SVV, ['/scomma', csv, '/AvoidPrompts'], err => {
      if (err) return reject(err);
      setTimeout(() => {
        try {
          const rows = fs.readFileSync(csv, 'latin1')
            .split('\n')
            .map(l => l.trim())
            .filter(Boolean)
            .map(parseCsvLine);
          fs.unlink(csv, () => {});
          resolve(rows);
        } catch (e) {
          fs.unlink(csv, () => {});
          reject(e);
        }
      }, 250);
    });
  });
}

function fetchJson(url, timeout = 2500) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout, headers: { 'User-Agent': 'XenonEdgeWidget/1.0' } }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('Artwork lookup timeout')); });
    req.on('error', reject);
  });
}

function fetchText(url, timeout = 3500, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch {
      reject(new Error('Invalid feed URL'));
      return;
    }

    const client = parsedUrl.protocol === 'http:' ? http : https;
    const req = client.get(parsedUrl, {
      timeout,
      headers: {
        'User-Agent': 'XenonEdgeWidget/1.0',
        'Accept': 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8',
      },
    }, res => {
      const status = Number(res.statusCode || 0);
      const location = res.headers && res.headers.location;
      const isRedirect = status >= 300 && status < 400 && !!location;

      if (isRedirect) {
        if (redirectsLeft <= 0) {
          reject(new Error('Feed redirect limit reached'));
          res.resume();
          return;
        }
        const nextUrl = new URL(location, parsedUrl).toString();
        res.resume();
        fetchText(nextUrl, timeout, redirectsLeft - 1).then(resolve, reject);
        return;
      }

      if (status >= 400) {
        reject(new Error(`HTTP ${status}`));
        res.resume();
        return;
      }

      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve(body));
    });
    req.on('timeout', () => { req.destroy(new Error('Feed timeout')); });
    req.on('error', reject);
  });
}

function decodeXmlEntities(value) {
  if (!value) return '';
  const named = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  };
  return String(value)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    })
    .replace(/&([a-z]+);/gi, (match, entity) => named[entity.toLowerCase()] || match);
}

function extractXmlTagData(block, tagName) {
  const match = String(block || '').match(new RegExp(`<${tagName}\\b([^>]*)>([\\s\\S]*?)<\\/${tagName}>`, 'i'));
  if (!match) return { value: '', attrs: '' };
  return {
    value: decodeXmlEntities(match[2]).replace(/\s+/g, ' ').trim(),
    attrs: String(match[1] || ''),
  };
}

function extractXmlTag(block, tagName) {
  return extractXmlTagData(block, tagName).value;
}

function extractXmlAttr(attrs, name) {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i');
  const match = String(attrs || '').match(pattern);
  if (!match) return '';
  return decodeXmlEntities(match[1] || match[2] || '').trim();
}

function sanitizeNewsLink(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (!/^https?:$/.test(parsed.protocol)) return '';
    return parsed.toString();
  } catch {
    return '';
  }
}

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

function normalizeNewsToken(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function normalizeSourceWithNoTld(value) {
  return String(value || '').replace(/\.[a-z]{2,}$/i, '');
}

function stripNewsSourceSuffix(title, source) {
  const rawTitle = String(title || '').trim();
  const rawSource = String(source || '').trim();
  if (!rawTitle || !rawSource) return rawTitle;

  const sourceToken = normalizeNewsToken(rawSource);
  const sourceNoTldToken = normalizeNewsToken(normalizeSourceWithNoTld(rawSource));
  if (!sourceToken) return rawTitle;

  const suffixMatch = rawTitle.match(/^(.*?)(?:\s[-|·–—:]\s)([^-–—|·:]+)$/);
  if (!suffixMatch) return rawTitle;

  const suffix = String(suffixMatch[2] || '').trim();
  const suffixToken = normalizeNewsToken(suffix);
  if (!suffixToken) return rawTitle;

  if (suffixToken === sourceToken || (sourceNoTldToken && suffixToken === sourceNoTldToken)) {
    const trimmed = String(suffixMatch[1] || '').trim();
    return trimmed || rawTitle;
  }

  return rawTitle;
}

function sourceDomainFromName(source) {
  const token = normalizeNewsToken(source);
  if (!token) return '';
  if (NEWS_SOURCE_DOMAIN_OVERRIDES.has(token)) return NEWS_SOURCE_DOMAIN_OVERRIDES.get(token);
  const domainLike = String(source || '').toLowerCase().match(/([a-z0-9-]+(?:\.[a-z0-9-]+)+)/);
  return sanitizeNewsDomain(domainLike ? domainLike[1] : '');
}

function resolveNewsSourceDomain(sourceUrl, sourceName) {
  const safeUrl = sanitizeNewsLink(sourceUrl);
  if (safeUrl) {
    try {
      return sanitizeNewsDomain(new URL(safeUrl).hostname);
    } catch {
      // Fall back to source-name parsing below.
    }
  }
  return sourceDomainFromName(sourceName);
}

function resolveNewsFeedUrl(feedUrl, maxResults) {
  const safeUrl = sanitizeNewsFeedUrl(feedUrl) || NEWS_DEFAULT_FEED_URL;
  try {
    const parsed = new URL(safeUrl);
    const isGoogleNewsRss = /(^|\.)news\.google\.com$/i.test(parsed.hostname) && /\/rss\//i.test(parsed.pathname);
    if (isGoogleNewsRss) {
      parsed.searchParams.set('num', String(Math.max(NEWS_MIN_RESULTS, Math.min(NEWS_MAX_RESULTS, Math.round(Number(maxResults) || NEWS_DEFAULT_RESULTS)))));
      return parsed.toString();
    }
    return safeUrl;
  } catch {
    return safeUrl;
  }
}

function parseNewsRss(xml, maxItems = NEWS_DEFAULT_RESULTS) {
  const limit = Number.isFinite(Number(maxItems))
    ? Math.max(NEWS_MIN_RESULTS, Math.min(NEWS_MAX_RESULTS, Math.round(Number(maxItems))))
    : NEWS_DEFAULT_RESULTS;
  const blocks = String(xml || '').match(/<item\b[\s\S]*?<\/item>/gi) || [];
  const items = [];
  const seen = new Set();

  for (const block of blocks) {
    const sourceTag = extractXmlTagData(block, 'source');
    const source = sourceTag.value.slice(0, 80);
    const sourceUrl = sanitizeNewsLink(extractXmlAttr(sourceTag.attrs, 'url'));
    const sourceDomain = resolveNewsSourceDomain(sourceUrl, source);
    const titleRaw = extractXmlTag(block, 'title').slice(0, 220);
    const title = stripNewsSourceSuffix(titleRaw, source);
    const link = sanitizeNewsLink(extractXmlTag(block, 'link'));
    const pubDateRaw = extractXmlTag(block, 'pubDate');
    const parsedDate = Date.parse(pubDateRaw);
    if (!title || !link) continue;
    const dedupeKey = `${title.toLowerCase()}|${source.toLowerCase()}|${link}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    items.push({
      title,
      link,
      source,
      sourceUrl,
      sourceDomain,
      publishedAt: Number.isFinite(parsedDate) ? parsedDate : null,
    });
    if (items.length >= limit) break;
  }

  return items;
}

async function getNewsHeadlines(forceRefresh = false) {
  const settings = await readHubSettings().catch(() => null);
  const newsSettings = normalizeSettingsNews(settings && settings.news);
  const feedUrl = newsSettings.feedUrl;
  const maxResults = newsSettings.maxResults;
  const resolvedFeedUrl = resolveNewsFeedUrl(feedUrl, maxResults);
  const age = Date.now() - newsCache.updatedAt;
  if (
    !forceRefresh
    && newsCache.items.length
    && newsCache.feedUrl === feedUrl
    && newsCache.maxResults === maxResults
    && age < NEWS_CACHE_MS
  ) {
    return { items: newsCache.items, updatedAt: newsCache.updatedAt };
  }
  if (newsPending && newsPending.feedUrl === feedUrl && newsPending.maxResults === maxResults) return newsPending.promise;

  const pendingPromise = (async () => {
    try {
      const xml = await fetchText(resolvedFeedUrl, 4500);
      const items = parseNewsRss(xml, maxResults);
      if (!items.length) throw new Error('No news items found');
      newsCache = { items, updatedAt: Date.now(), feedUrl, maxResults };
      return { items: newsCache.items, updatedAt: newsCache.updatedAt };
    } catch (error) {
      if (newsCache.items.length && newsCache.feedUrl === feedUrl && newsCache.maxResults === maxResults) {
        return { items: newsCache.items, updatedAt: newsCache.updatedAt, stale: true };
      }
      throw error;
    } finally {
      if (newsPending && newsPending.feedUrl === feedUrl && newsPending.maxResults === maxResults) newsPending = null;
    }
  })();

  newsPending = { feedUrl, maxResults, promise: pendingPromise };
  return pendingPromise;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const ICAL_SPECIAL_DAY_RE = /\b(holidays?|birthday|anniversary|festiv(?:ity|ities)?|festa|compleanno|onomastico|special)\b/i;
const ICAL_WEEKDAY_BY_TOKEN = Object.freeze({
  SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6,
});
const ICAL_TOKEN_BY_WEEKDAY = Object.freeze(['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']);
const icalTimezoneCache = new Map();

function pad2(value) {
  return String(value).padStart(2, '0');
}

function toLocalDateTimeString(date) {
  const d = new Date(date);
  if (!Number.isFinite(d.getTime())) return '';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
    + `T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function toLocalDateKey(date) {
  const d = new Date(date);
  if (!Number.isFinite(d.getTime())) return '';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function startOfLocalDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function addLocalDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + Number(days || 0));
  return d;
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function decodeIcalText(value) {
  return String(value || '')
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}

function unfoldIcalLines(input) {
  const rawLines = String(input || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n');
  const lines = [];
  rawLines.forEach(line => {
    if (!lines.length) {
      lines.push(line);
      return;
    }
    if (/^[ \t]/.test(line)) {
      lines[lines.length - 1] += line.slice(1);
      return;
    }
    lines.push(line);
  });
  return lines;
}

function parseIcalPropertyLine(line) {
  const raw = String(line || '');
  const sep = raw.indexOf(':');
  if (sep <= 0) return null;
  const left = raw.slice(0, sep);
  const value = raw.slice(sep + 1);
  const chunks = left.split(';');
  const name = String(chunks.shift() || '').trim().toUpperCase();
  if (!name) return null;
  const params = {};
  chunks.forEach(chunk => {
    const eq = chunk.indexOf('=');
    if (eq <= 0) return;
    const key = String(chunk.slice(0, eq) || '').trim().toUpperCase();
    if (!key) return;
    let paramValue = String(chunk.slice(eq + 1) || '').trim();
    if (
      paramValue.length >= 2
      && ((paramValue.startsWith('"') && paramValue.endsWith('"')) || (paramValue.startsWith("'") && paramValue.endsWith("'")))
    ) {
      paramValue = paramValue.slice(1, -1);
    }
    params[key] = paramValue;
  });
  return { name, params, value };
}

function isValidIanaTimeZone(timeZone) {
  const safe = String(timeZone || '').trim();
  if (!safe) return false;
  if (icalTimezoneCache.has(safe)) return icalTimezoneCache.get(safe);
  let valid = false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: safe }).format(new Date());
    valid = true;
  } catch {
    valid = false;
  }
  icalTimezoneCache.set(safe, valid);
  return valid;
}

function getTimeZoneOffsetMs(timeZone, date) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const values = {};
  parts.forEach(part => {
    if (part.type !== 'literal') values[part.type] = part.value;
  });
  const asUtc = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
    Number(values.second),
    0,
  );
  return asUtc - date.getTime();
}

function createDateInTimeZone(year, month, day, hour, minute, second, timeZone) {
  if (!isValidIanaTimeZone(timeZone)) {
    return new Date(year, month - 1, day, hour, minute, second, 0);
  }
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second, 0);
  let date = new Date(utcGuess);
  let offset = getTimeZoneOffsetMs(timeZone, date);
  date = new Date(utcGuess - offset);
  const secondOffset = getTimeZoneOffsetMs(timeZone, date);
  if (secondOffset !== offset) {
    date = new Date(utcGuess - secondOffset);
  }
  return date;
}

function parseIcalDateToken(value, params = {}, fallbackTzid = '') {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const valueType = String(params.VALUE || '').trim().toUpperCase();
  const tzidRaw = String(params.TZID || fallbackTzid || '').trim();
  if (valueType === 'DATE' || /^\d{8}$/.test(raw)) {
    const year = Number(raw.slice(0, 4));
    const month = Number(raw.slice(4, 6));
    const day = Number(raw.slice(6, 8));
    if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
    const date = new Date(year, month - 1, day, 0, 0, 0, 0);
    if (!Number.isFinite(date.getTime())) return null;
    return {
      raw,
      year,
      month,
      day,
      hour: 0,
      minute: 0,
      second: 0,
      isAllDay: true,
      isUtc: false,
      tzid: '',
      date,
    };
  }

  const match = raw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/i);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] || '0');
  const isUtc = !!match[7];
  let date;
  if (isUtc) {
    date = new Date(Date.UTC(year, month - 1, day, hour, minute, second, 0));
  } else if (tzidRaw && isValidIanaTimeZone(tzidRaw)) {
    date = createDateInTimeZone(year, month, day, hour, minute, second, tzidRaw);
  } else {
    date = new Date(year, month - 1, day, hour, minute, second, 0);
  }
  if (!Number.isFinite(date.getTime())) return null;
  return {
    raw,
    year,
    month,
    day,
    hour,
    minute,
    second,
    isAllDay: false,
    isUtc,
    tzid: isUtc ? 'UTC' : (tzidRaw && isValidIanaTimeZone(tzidRaw) ? tzidRaw : ''),
    date,
  };
}

function parseIcalDateList(prop, fallbackTzid = '') {
  if (!prop) return [];
  return String(prop.value || '')
    .split(',')
    .map(token => parseIcalDateToken(token, prop.params || {}, fallbackTzid))
    .filter(Boolean);
}

function dayOfWeekFromToken(value) {
  return ICAL_WEEKDAY_BY_TOKEN[String(value || '').trim().toUpperCase()] ?? null;
}

function parseByDayToken(value) {
  const raw = String(value || '').trim().toUpperCase();
  if (!raw) return null;
  const match = raw.match(/^([+-]?\d{1,2})?([A-Z]{2})$/);
  if (!match) return null;
  const weekday = dayOfWeekFromToken(match[2]);
  if (weekday === null) return null;
  let nth = null;
  if (match[1] !== undefined) {
    const parsed = Number(match[1]);
    if (!Number.isFinite(parsed) || !parsed || Math.abs(parsed) > 53) return null;
    nth = parsed;
  }
  return { weekday, nth };
}

function parseRrule(value, context) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const rule = {
    freq: '',
    interval: 1,
    count: null,
    untilMs: null,
    byday: [],
    bymonthday: [],
    bymonth: [],
    wkst: 1,
  };

  raw.split(';').forEach(chunk => {
    const [keyRaw, valueRaw] = chunk.split('=');
    const key = String(keyRaw || '').trim().toUpperCase();
    const token = String(valueRaw || '').trim();
    if (!key || !token) return;
    if (key === 'FREQ') {
      rule.freq = token.toUpperCase();
      return;
    }
    if (key === 'INTERVAL') {
      const parsed = Number(token);
      if (Number.isFinite(parsed) && parsed >= 1) rule.interval = Math.round(parsed);
      return;
    }
    if (key === 'COUNT') {
      const parsed = Number(token);
      if (Number.isFinite(parsed) && parsed >= 1) rule.count = Math.round(parsed);
      return;
    }
    if (key === 'UNTIL') {
      const until = parseIcalDateToken(
        token,
        context && context.isAllDay ? { VALUE: 'DATE' } : { TZID: context && context.tzid ? context.tzid : '' },
        context && context.tzid ? context.tzid : '',
      );
      if (until && until.date) rule.untilMs = until.date.getTime();
      return;
    }
    if (key === 'BYDAY') {
      rule.byday = token.split(',').map(parseByDayToken).filter(Boolean);
      return;
    }
    if (key === 'BYMONTHDAY') {
      rule.bymonthday = token
        .split(',')
        .map(item => Number(item))
        .filter(num => Number.isFinite(num) && num !== 0 && num >= -31 && num <= 31)
        .map(num => Math.round(num));
      return;
    }
    if (key === 'BYMONTH') {
      rule.bymonth = token
        .split(',')
        .map(item => Number(item))
        .filter(num => Number.isFinite(num) && num >= 1 && num <= 12)
        .map(num => Math.round(num));
      return;
    }
    if (key === 'WKST') {
      const wkst = dayOfWeekFromToken(token);
      if (wkst !== null) rule.wkst = wkst;
    }
  });

  if (!rule.freq) return null;
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(rule.freq)) return null;
  return rule;
}

function nthWeekdayOfMonth(year, month, weekday, nth) {
  const total = daysInMonth(year, month);
  const values = [];
  for (let day = 1; day <= total; day++) {
    const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    if (dow === weekday) values.push(day);
  }
  if (!values.length) return null;
  if (nth > 0) return values[nth - 1] || null;
  return values[values.length + nth] || null;
}

function matchesByMonthDay(year, month, day, bymonthday) {
  if (!Array.isArray(bymonthday) || !bymonthday.length) return true;
  const total = daysInMonth(year, month);
  return bymonthday.some(token => {
    if (token > 0) return day === token;
    const normalized = total + 1 + token;
    return day === normalized;
  });
}

function matchesByDay(year, month, day, byday, fallbackWeekday = null) {
  if (!Array.isArray(byday) || !byday.length) {
    if (fallbackWeekday === null) return true;
    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    return weekday === fallbackWeekday;
  }
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return byday.some(token => {
    if (token.weekday !== weekday) return false;
    if (token.nth === null) return true;
    const nthDay = nthWeekdayOfMonth(year, month, token.weekday, token.nth);
    return nthDay === day;
  });
}

function buildOccurrenceKey(date, isAllDay) {
  if (!date || !Number.isFinite(new Date(date).getTime())) return '';
  if (isAllDay) return toLocalDateKey(date);
  return String(new Date(date).getTime());
}

function sanitizeCalendarText(value, maxLen) {
  return decodeIcalText(value)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

function isSpecialCalendarEvent(title, categories, isAllDay, sourceLabel = '') {
  if (!isAllDay) return false;
  const catText = Array.isArray(categories) ? categories.join(' ') : '';
  return ICAL_SPECIAL_DAY_RE.test(`${title || ''} ${catText} ${sourceLabel || ''}`);
}

function parseIcalCalendar(text) {
  const lines = unfoldIcalLines(text);
  const components = [];
  let current = null;
  let calendarName = '';

  lines.forEach(line => {
    const token = String(line || '').trim();
    if (token === 'BEGIN:VEVENT') {
      current = [];
      return;
    }
    if (token === 'END:VEVENT') {
      if (current && current.length) components.push(current);
      current = null;
      return;
    }
    const prop = parseIcalPropertyLine(line);
    if (!prop) return;
    if (!current) {
      if (!calendarName && (prop.name === 'X-WR-CALNAME' || prop.name === 'NAME')) {
        calendarName = sanitizeCalendarText(prop.value, 120);
      }
      return;
    }
    current.push(prop);
  });

  return { components, calendarName };
}

function firstIcalProp(props, name) {
  const target = String(name || '').toUpperCase();
  return props.find(prop => prop.name === target) || null;
}

function allIcalProps(props, name) {
  const target = String(name || '').toUpperCase();
  return props.filter(prop => prop.name === target);
}

function createDateFromTemplate(baseStart, year, month, day, options = {}) {
  const base = baseStart || {};
  const hour = base.hour || 0;
  const minute = base.minute || 0;
  const second = base.second || 0;
  if (base.isAllDay || options.isAllDay) return new Date(year, month - 1, day, 0, 0, 0, 0);
  if (base.isUtc) return new Date(Date.UTC(year, month - 1, day, hour, minute, second, 0));
  if (base.tzid && isValidIanaTimeZone(base.tzid)) {
    return createDateInTimeZone(year, month, day, hour, minute, second, base.tzid);
  }
  return new Date(year, month - 1, day, hour, minute, second, 0);
}

function normalizeIcalComponent(props, sourceName) {
  if (!Array.isArray(props) || !props.length) return null;
  const dtStartProp = firstIcalProp(props, 'DTSTART');
  if (!dtStartProp) return null;
  const start = parseIcalDateToken(dtStartProp.value, dtStartProp.params || {}, '');
  if (!start || !start.date) return null;

  const dtEndProp = firstIcalProp(props, 'DTEND');
  const end = dtEndProp
    ? parseIcalDateToken(dtEndProp.value, dtEndProp.params || {}, start.tzid || '')
    : null;

  const summary = sanitizeCalendarText(firstIcalProp(props, 'SUMMARY') && firstIcalProp(props, 'SUMMARY').value, 160);
  const description = sanitizeCalendarText(firstIcalProp(props, 'DESCRIPTION') && firstIcalProp(props, 'DESCRIPTION').value, 600);
  const location = sanitizeCalendarText(firstIcalProp(props, 'LOCATION') && firstIcalProp(props, 'LOCATION').value, 160);
  const status = sanitizeCalendarText(firstIcalProp(props, 'STATUS') && firstIcalProp(props, 'STATUS').value, 40).toUpperCase();
  const uidRaw = sanitizeCalendarText(firstIcalProp(props, 'UID') && firstIcalProp(props, 'UID').value, 200);
  const uid = (uidRaw || `${start.raw}-${summary || 'event'}`).replace(/[^A-Za-z0-9._@-]/g, '-').slice(0, 180);
  const categoriesRaw = allIcalProps(props, 'CATEGORIES')
    .flatMap(prop => String(prop.value || '').split(','))
    .map(value => sanitizeCalendarText(value, 80))
    .filter(Boolean);
  const categories = Array.from(new Set(categoriesRaw)).slice(0, 12);
  const recurrenceIdProp = firstIcalProp(props, 'RECURRENCE-ID');
  const recurrenceId = recurrenceIdProp
    ? parseIcalDateToken(recurrenceIdProp.value, recurrenceIdProp.params || {}, start.tzid || '')
    : null;
  const recurrenceKey = recurrenceId ? buildOccurrenceKey(recurrenceId.date, recurrenceId.isAllDay) : '';

  const durationMsRaw = end && end.date
    ? Math.max(0, end.date.getTime() - start.date.getTime())
    : (start.isAllDay ? MS_PER_DAY : 60 * 60 * 1000);
  const durationMs = durationMsRaw > 0 ? durationMsRaw : (start.isAllDay ? MS_PER_DAY : 60 * 1000);
  const endExclusive = !!(start.isAllDay && end && end.date);

  const exdateKeys = new Set();
  allIcalProps(props, 'EXDATE').forEach(prop => {
    parseIcalDateList(prop, start.tzid || '').forEach(item => {
      const key = buildOccurrenceKey(item.date, item.isAllDay);
      if (key) exdateKeys.add(key);
    });
  });

  const rruleProp = firstIcalProp(props, 'RRULE');
  const rrule = rruleProp ? parseRrule(rruleProp.value, { isAllDay: start.isAllDay, tzid: start.tzid }) : null;

  return {
    uid,
    title: summary || 'Event',
    notes: description,
    location,
    categories,
    status,
    start,
    durationMs,
    endExclusive,
    rrule,
    exdateKeys,
    recurrenceKey,
    sourceName: sourceName || '',
  };
}

function matchesRecurrenceDay(base, currentDay, rule) {
  const current = startOfLocalDay(currentDay);
  const startDay = startOfLocalDay(base.start.date);
  if (current.getTime() < startDay.getTime()) return false;

  const year = current.getFullYear();
  const month = current.getMonth() + 1;
  const day = current.getDate();
  const weekday = current.getDay();

  if (Array.isArray(rule.bymonth) && rule.bymonth.length && !rule.bymonth.includes(month)) return false;
  if (!matchesByMonthDay(year, month, day, rule.bymonthday)) return false;

  if (rule.freq === 'DAILY') {
    const diffDays = Math.floor((current.getTime() - startDay.getTime()) / MS_PER_DAY);
    if (diffDays % rule.interval !== 0) return false;
    if (!matchesByDay(year, month, day, rule.byday, null)) return false;
    return true;
  }

  if (rule.freq === 'WEEKLY') {
    const baseWeekStart = startOfLocalDay(addLocalDays(startDay, -((startDay.getDay() - rule.wkst + 7) % 7)));
    const currentWeekStart = startOfLocalDay(addLocalDays(current, -((weekday - rule.wkst + 7) % 7)));
    const diffWeeks = Math.floor((currentWeekStart.getTime() - baseWeekStart.getTime()) / (MS_PER_DAY * 7));
    if (diffWeeks < 0 || diffWeeks % rule.interval !== 0) return false;
    const fallback = base.start.date.getDay();
    if (!matchesByDay(year, month, day, rule.byday, fallback)) return false;
    return true;
  }

  if (rule.freq === 'MONTHLY') {
    const monthsDiff = (year - base.start.date.getFullYear()) * 12 + (month - (base.start.date.getMonth() + 1));
    if (monthsDiff < 0 || monthsDiff % rule.interval !== 0) return false;
    const hasByDay = Array.isArray(rule.byday) && rule.byday.length > 0;
    const hasByMonthDay = Array.isArray(rule.bymonthday) && rule.bymonthday.length > 0;
    if (!hasByDay && !hasByMonthDay && day !== base.start.date.getDate()) return false;
    if (!matchesByDay(year, month, day, rule.byday, null)) return false;
    return true;
  }

  if (rule.freq === 'YEARLY') {
    const yearsDiff = year - base.start.date.getFullYear();
    if (yearsDiff < 0 || yearsDiff % rule.interval !== 0) return false;
    const hasByDay = Array.isArray(rule.byday) && rule.byday.length > 0;
    const hasByMonthDay = Array.isArray(rule.bymonthday) && rule.bymonthday.length > 0;
    if (!hasByDay && !hasByMonthDay) {
      if (day !== base.start.date.getDate()) return false;
      if (!(Array.isArray(rule.bymonth) && rule.bymonth.length) && month !== (base.start.date.getMonth() + 1)) return false;
    }
    if (!matchesByDay(year, month, day, rule.byday, null)) return false;
    return true;
  }

  return false;
}

function buildCalendarSyncItem(master, occurrenceStart, occurrenceKey, overrideComponent = null) {
  const source = overrideComponent || master;
  if (!source || !occurrenceStart || !Number.isFinite(new Date(occurrenceStart).getTime())) return null;
  if (String(source.status || '').toUpperCase() === 'CANCELLED') return null;
  const startDate = new Date(occurrenceStart);
  const durationMs = Math.max(0, Number(source.durationMs || master.durationMs || 0)) || (source.start && source.start.isAllDay ? MS_PER_DAY : 60 * 1000);
  const endDate = new Date(startDate.getTime() + durationMs);
  const safeUid = String(master.uid || 'calendar').replace(/[^A-Za-z0-9._@-]/g, '-').slice(0, 120);
  const eventId = `ical-${safeUid}-${String(occurrenceKey || '').replace(/[^A-Za-z0-9._@:-]/g, '').slice(0, 120)}`;
  const title = sanitizeCalendarText(source.title || master.title, 160) || 'Event';
  const notes = sanitizeCalendarText(source.notes || master.notes, 600);
  const location = sanitizeCalendarText(source.location || master.location, 160);
  const categories = Array.from(new Set([...(master.categories || []), ...(source.categories || [])])).slice(0, 12);
  const isAllDay = !!(source.start && source.start.isAllDay);
  return {
    id: eventId,
    uid: safeUid,
    title,
    notes,
    location,
    categories,
    startsAt: toLocalDateTimeString(startDate),
    endsAt: toLocalDateTimeString(endDate),
    endExclusive: !!(source.endExclusive || master.endExclusive),
    isAllDay,
    source: 'ical',
    sourceLabel: master.sourceName || '',
    readOnly: true,
    special: isSpecialCalendarEvent(title, categories, isAllDay, master.sourceName || source.sourceName || ''),
    status: String(source.status || '').toUpperCase(),
  };
}

function eventIntersectsWindow(event, windowStartMs, windowEndMs) {
  const startMs = Date.parse(event && event.startsAt);
  if (!Number.isFinite(startMs)) return false;
  let endMs = Date.parse(event && event.endsAt);
  if (!Number.isFinite(endMs) || endMs <= startMs) {
    endMs = startMs + (event && event.isAllDay ? MS_PER_DAY : 60 * 1000);
  }
  return endMs > windowStartMs && startMs < windowEndMs;
}

function expandRecurringComponent(master, overridesMap, windowStartMs, windowEndMs) {
  const rule = master.rrule;
  if (!rule) return [];
  const occurrences = [];
  const needsCountFromStart = Number.isFinite(rule.count) && rule.count > 0;
  const windowStartDay = startOfLocalDay(new Date(windowStartMs));
  const windowEndDay = startOfLocalDay(new Date(windowEndMs));
  const startDay = startOfLocalDay(master.start.date);
  const scanStart = needsCountFromStart ? startDay : (windowStartDay.getTime() > startDay.getTime() ? windowStartDay : startDay);
  const maxDays = Math.max(5000, CALENDAR_SYNC_WINDOW_DAYS_PAST + CALENDAR_SYNC_WINDOW_DAYS_FUTURE + 120);
  let cursor = new Date(scanStart);
  let recurrenceIndex = 0;
  let guard = 0;

  while (cursor.getTime() <= windowEndDay.getTime() && guard < maxDays && recurrenceIndex < CALENDAR_SYNC_MAX_OCCURRENCES) {
    guard += 1;
    if (matchesRecurrenceDay(master, cursor, rule)) {
      const occurrenceStart = createDateFromTemplate(master.start, cursor.getFullYear(), cursor.getMonth() + 1, cursor.getDate(), { isAllDay: master.start.isAllDay });
      if (rule.untilMs !== null && Number.isFinite(rule.untilMs) && occurrenceStart.getTime() > rule.untilMs) break;
      recurrenceIndex += 1;
      if (Number.isFinite(rule.count) && recurrenceIndex > rule.count) break;
      const occurrenceKey = buildOccurrenceKey(occurrenceStart, master.start.isAllDay);
      if (master.exdateKeys.has(occurrenceKey) && !overridesMap.has(occurrenceKey)) {
        cursor = addLocalDays(cursor, 1);
        continue;
      }
      const override = overridesMap.get(occurrenceKey) || null;
      const item = buildCalendarSyncItem(master, override && override.start && override.start.date ? override.start.date : occurrenceStart, occurrenceKey, override);
      if (item && eventIntersectsWindow(item, windowStartMs, windowEndMs)) occurrences.push(item);
    }
    cursor = addLocalDays(cursor, 1);
  }

  return occurrences;
}

function buildSingleComponentOccurrence(component, windowStartMs, windowEndMs) {
  const occurrenceKey = component.recurrenceKey || buildOccurrenceKey(component.start.date, component.start.isAllDay);
  const item = buildCalendarSyncItem(component, component.start.date, occurrenceKey, null);
  if (!item) return null;
  if (!eventIntersectsWindow(item, windowStartMs, windowEndMs)) return null;
  return item;
}

function normalizeLocalCalendarEvent(event) {
  const source = event && typeof event === 'object' ? event : {};
  const title = String(source.title || '').trim().slice(0, 160);
  const notes = String(source.notes || '').trim().slice(0, 600);
  const startsAt = String(source.startsAt || '').trim();
  const endsAt = String(source.endsAt || '').trim();
  const id = String(source.id || `${Date.now()}-${Math.random().toString(16).slice(2)}`).slice(0, 120);
  return {
    ...source,
    id,
    title,
    notes,
    startsAt,
    endsAt,
    endExclusive: !!source.endExclusive,
    isAllDay: !!source.isAllDay,
    location: String(source.location || '').trim().slice(0, 160),
    categories: Array.isArray(source.categories) ? source.categories.map(item => String(item || '').trim().slice(0, 80)).filter(Boolean).slice(0, 12) : [],
    source: 'local',
    sourceLabel: 'local',
    readOnly: false,
    special: !!source.special,
  };
}

function sortCalendarEvents(events) {
  return [...events].sort((left, right) => {
    const leftStart = Date.parse(left && left.startsAt);
    const rightStart = Date.parse(right && right.startsAt);
    if (Number.isFinite(leftStart) && Number.isFinite(rightStart) && leftStart !== rightStart) return leftStart - rightStart;
    if (Number.isFinite(leftStart) && !Number.isFinite(rightStart)) return -1;
    if (!Number.isFinite(leftStart) && Number.isFinite(rightStart)) return 1;
    return String(left && left.title || '').localeCompare(String(right && right.title || ''), undefined, { sensitivity: 'base' });
  });
}

function parseCalendarSyncFeed(text) {
  const parsed = parseIcalCalendar(text);
  const components = parsed.components
    .map(props => normalizeIcalComponent(props, parsed.calendarName))
    .filter(Boolean);
  const today = startOfLocalDay(new Date());
  const windowStartMs = addLocalDays(today, -CALENDAR_SYNC_WINDOW_DAYS_PAST).getTime();
  const windowEndMs = addLocalDays(today, CALENDAR_SYNC_WINDOW_DAYS_FUTURE + 1).getTime();

  const mastersByUid = new Map();
  const overridesByUid = new Map();
  const singles = [];

  components.forEach(component => {
    if (component.recurrenceKey) {
      const map = overridesByUid.get(component.uid) || new Map();
      map.set(component.recurrenceKey, component);
      overridesByUid.set(component.uid, map);
      return;
    }
    if (component.rrule) {
      mastersByUid.set(component.uid, component);
      return;
    }
    singles.push(component);
  });

  const events = [];
  const seen = new Set();

  singles.forEach(component => {
    if (String(component.status || '').toUpperCase() === 'CANCELLED') return;
    const single = buildSingleComponentOccurrence(component, windowStartMs, windowEndMs);
    if (!single) return;
    if (seen.has(single.id)) return;
    seen.add(single.id);
    events.push(single);
  });

  mastersByUid.forEach((master, uid) => {
    if (String(master.status || '').toUpperCase() === 'CANCELLED') return;
    const overrides = overridesByUid.get(uid) || new Map();
    const occurrences = expandRecurringComponent(master, overrides, windowStartMs, windowEndMs);
    occurrences.forEach(item => {
      if (!item || seen.has(item.id)) return;
      seen.add(item.id);
      events.push(item);
    });
  });

  overridesByUid.forEach((overrides, uid) => {
    if (mastersByUid.has(uid)) return;
    overrides.forEach(component => {
      if (String(component.status || '').toUpperCase() === 'CANCELLED') return;
      const item = buildSingleComponentOccurrence(component, windowStartMs, windowEndMs);
      if (!item || seen.has(item.id)) return;
      seen.add(item.id);
      events.push(item);
    });
  });

  return {
    events: sortCalendarEvents(events).slice(0, CALENDAR_SYNC_MAX_OCCURRENCES),
    sourceName: parsed.calendarName || '',
    windowStartMs,
    windowEndMs,
  };
}

function normalizeHolidayCalendarEvent(event, sourceName = '') {
  const source = event && typeof event === 'object' ? event : {};
  const baseId = String(source.id || `${Date.now()}-${Math.random().toString(16).slice(2)}`).replace(/[^A-Za-z0-9._@:-]/g, '-');
  return {
    ...source,
    id: `holiday-${baseId}`.slice(0, 140),
    title: String(source.title || '').trim().slice(0, 160) || 'Holiday',
    notes: String(source.notes || '').trim().slice(0, 600),
    location: String(source.location || '').trim().slice(0, 160),
    source: 'holiday',
    sourceLabel: sourceName || source.sourceLabel || 'Holidays',
    readOnly: true,
    special: false,
    holiday: true,
  };
}

function dedupeCalendarEvents(events) {
  const seen = new Set();
  const source = Array.isArray(events) ? events : [];
  return source.filter(event => {
    const id = String(event && event.id || '').trim();
    const key = id || `${String(event && event.startsAt || '')}|${String(event && event.title || '')}|${String(event && event.source || '')}`;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function getCalendarHolidayEvents(forceRefresh = false) {
  const baseMeta = {
    enabled: true,
    feedUrl: CALENDAR_HOLIDAY_FEED_URL,
    updatedAt: 0,
    stale: false,
    sourceName: '',
    error: '',
    windowDaysPast: CALENDAR_SYNC_WINDOW_DAYS_PAST,
    windowDaysFuture: CALENDAR_SYNC_WINDOW_DAYS_FUTURE,
  };

  const age = Date.now() - calendarHolidayCache.updatedAt;
  if (!forceRefresh && calendarHolidayCache.updatedAt > 0 && age < CALENDAR_HOLIDAY_REFRESH_MS) {
    return {
      events: calendarHolidayCache.events,
      meta: {
        ...baseMeta,
        updatedAt: calendarHolidayCache.updatedAt,
        sourceName: calendarHolidayCache.sourceName || '',
      },
    };
  }

  if (calendarHolidayPending) return calendarHolidayPending;

  const pendingPromise = (async () => {
    try {
      const ics = await fetchText(CALENDAR_HOLIDAY_FEED_URL, 5500);
      const parsed = parseCalendarSyncFeed(ics);
      const normalized = dedupeCalendarEvents(
        (Array.isArray(parsed.events) ? parsed.events : []).map(event => normalizeHolidayCalendarEvent(event, parsed.sourceName || '')),
      );
      calendarHolidayCache = {
        events: normalized,
        updatedAt: Date.now(),
        sourceName: parsed.sourceName || '',
        error: '',
      };
      return {
        events: normalized,
        meta: {
          ...baseMeta,
          updatedAt: calendarHolidayCache.updatedAt,
          sourceName: calendarHolidayCache.sourceName || '',
          windowStartMs: parsed.windowStartMs,
          windowEndMs: parsed.windowEndMs,
        },
      };
    } catch (error) {
      if (calendarHolidayCache.updatedAt > 0 && Array.isArray(calendarHolidayCache.events)) {
        return {
          events: calendarHolidayCache.events,
          meta: {
            ...baseMeta,
            updatedAt: calendarHolidayCache.updatedAt,
            sourceName: calendarHolidayCache.sourceName || '',
            stale: true,
            error: String(error && error.message || 'Holiday calendar sync failed').slice(0, 240),
          },
        };
      }
      throw error;
    } finally {
      calendarHolidayPending = null;
    }
  })();

  calendarHolidayPending = pendingPromise;
  return pendingPromise;
}

async function getCalendarSyncEvents(forceRefresh = false) {
  const settings = await readHubSettings().catch(() => null);
  const calendarSync = normalizeSettingsCalendarSync(settings && settings.calendarSync);
  const feedUrl = calendarSync.feedUrl;
  const refreshMinutes = calendarSync.refreshMinutes;
  const refreshMs = refreshMinutes * 60 * 1000;

  const baseMeta = {
    enabled: !!feedUrl,
    feedUrl,
    refreshMinutes,
    updatedAt: 0,
    stale: false,
    sourceName: '',
    error: '',
    windowDaysPast: CALENDAR_SYNC_WINDOW_DAYS_PAST,
    windowDaysFuture: CALENDAR_SYNC_WINDOW_DAYS_FUTURE,
  };

  if (!feedUrl) {
    return { events: [], meta: baseMeta };
  }

  const age = Date.now() - calendarSyncCache.updatedAt;
  if (
    !forceRefresh
    && calendarSyncCache.feedUrl === feedUrl
    && calendarSyncCache.refreshMinutes === refreshMinutes
    && age < refreshMs
  ) {
    return {
      events: calendarSyncCache.events,
      meta: {
        ...baseMeta,
        updatedAt: calendarSyncCache.updatedAt,
        sourceName: calendarSyncCache.sourceName || '',
      },
    };
  }

  if (
    calendarSyncPending
    && calendarSyncPending.feedUrl === feedUrl
    && calendarSyncPending.refreshMinutes === refreshMinutes
  ) {
    return calendarSyncPending.promise;
  }

  const pendingPromise = (async () => {
    try {
      const ics = await fetchText(feedUrl, 5500);
      const parsed = parseCalendarSyncFeed(ics);
      calendarSyncCache = {
        events: parsed.events,
        updatedAt: Date.now(),
        feedUrl,
        refreshMinutes,
        sourceName: parsed.sourceName || '',
        error: '',
      };
      return {
        events: parsed.events,
        meta: {
          ...baseMeta,
          updatedAt: calendarSyncCache.updatedAt,
          sourceName: parsed.sourceName || '',
          windowStartMs: parsed.windowStartMs,
          windowEndMs: parsed.windowEndMs,
        },
      };
    } catch (error) {
      if (
        calendarSyncCache.feedUrl === feedUrl
        && calendarSyncCache.refreshMinutes === refreshMinutes
        && Array.isArray(calendarSyncCache.events)
      ) {
        return {
          events: calendarSyncCache.events,
          meta: {
            ...baseMeta,
            updatedAt: calendarSyncCache.updatedAt,
            sourceName: calendarSyncCache.sourceName || '',
            stale: true,
            error: String(error && error.message || 'Calendar sync failed').slice(0, 240),
          },
        };
      }
      throw error;
    } finally {
      if (
        calendarSyncPending
        && calendarSyncPending.feedUrl === feedUrl
        && calendarSyncPending.refreshMinutes === refreshMinutes
      ) {
        calendarSyncPending = null;
      }
    }
  })();

  calendarSyncPending = { feedUrl, refreshMinutes, promise: pendingPromise };
  return pendingPromise;
}

async function getMergedCalendarEvents(forceRefresh = false) {
  const localEvents = (await readEvents()).map(normalizeLocalCalendarEvent);
  const holidaySynced = await getCalendarHolidayEvents(forceRefresh).catch(error => ({
    events: [],
    meta: {
      enabled: true,
      feedUrl: CALENDAR_HOLIDAY_FEED_URL,
      updatedAt: 0,
      stale: false,
      sourceName: '',
      error: String(error && error.message || 'Holiday calendar sync failed').slice(0, 240),
      windowDaysPast: CALENDAR_SYNC_WINDOW_DAYS_PAST,
      windowDaysFuture: CALENDAR_SYNC_WINDOW_DAYS_FUTURE,
    },
  }));
  try {
    const synced = await getCalendarSyncEvents(forceRefresh);
    const syncedRemote = Array.isArray(synced.events) ? synced.events : [];
    const holidayRemote = Array.isArray(holidaySynced.events) ? holidaySynced.events : [];
    const remoteEvents = sortCalendarEvents(dedupeCalendarEvents([...syncedRemote, ...holidayRemote]));
    const merged = sortCalendarEvents(dedupeCalendarEvents([...localEvents, ...remoteEvents]));
    return {
      events: merged,
      localEvents,
      remoteEvents,
      sync: synced.meta,
      holidaySync: holidaySynced.meta,
    };
  } catch (error) {
    const holidayRemote = Array.isArray(holidaySynced.events) ? holidaySynced.events : [];
    const remoteEvents = sortCalendarEvents(dedupeCalendarEvents(holidayRemote));
    return {
      events: sortCalendarEvents(dedupeCalendarEvents([...localEvents, ...remoteEvents])),
      localEvents,
      remoteEvents,
      sync: {
        enabled: true,
        feedUrl: '',
        refreshMinutes: CALENDAR_SYNC_DEFAULT_REFRESH_MINUTES,
        updatedAt: 0,
        stale: false,
        sourceName: '',
        error: String(error && error.message || 'Calendar sync failed').slice(0, 240),
        windowDaysPast: CALENDAR_SYNC_WINDOW_DAYS_PAST,
        windowDaysFuture: CALENDAR_SYNC_WINDOW_DAYS_FUTURE,
      },
      holidaySync: holidaySynced.meta,
    };
  }
}

async function hydrateArtwork(data, options = {}) {
  const forceLookup = !!(options && options.forceLookup);
  if (!data || !data.active) return data;
  if (data.thumbnail && !forceLookup) return data;
  const title = (data.title || '').trim();
  const artist = (data.artist || '').trim();
  if (!title || !artist) return data;

  const key = `${artist}::${title}`.toLowerCase();
  if (artworkCache.has(key)) {
    data.thumbnail = artworkCache.get(key);
    return data;
  }

  try {
    const term = encodeURIComponent(`${artist} ${title}`);
    const result = await fetchJson(`https://itunes.apple.com/search?term=${term}&entity=song&limit=1`, 2500);
    const art = result && result.results && result.results[0] && result.results[0].artworkUrl100;
    const bigArt = art ? art.replace('100x100bb', '600x600bb') : null;
    // LRU eviction: cap cache at 200 entries to prevent unbounded growth.
    if (artworkCache.size >= 200) artworkCache.delete(artworkCache.keys().next().value);
    artworkCache.set(key, bigArt);
    data.thumbnail = bigArt;
  } catch {
    if (artworkCache.size >= 200) artworkCache.delete(artworkCache.keys().next().value);
    artworkCache.set(key, null);
  }

  return data;
}

function firstWeatherValue(value) {
  if (Array.isArray(value) && value[0] && typeof value[0].value === 'string') return value[0].value;
  return '';
}

function normalizeWeatherCode(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.round(numeric) : null;
}

function sanitizeWeatherCity(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f<>`"'\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function normalizeWeatherLocation(value) {
  const source = value && typeof value === 'object' ? value : {};
  const mode = source.mode === 'manual' ? 'manual' : 'auto';
  return {
    mode,
    city: sanitizeWeatherCity(source.city),
  };
}

function resolveWeatherLocation(value) {
  const location = normalizeWeatherLocation(value);
  if (location.mode === 'manual' && location.city) return location;
  return { mode: 'auto', city: '' };
}

function normalizeWeatherCityKey(value) {
  return sanitizeWeatherCity(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function pickWeatherLocationResult(results, requestedCity) {
  if (!Array.isArray(results) || !results.length) return null;
  const requestedKey = normalizeWeatherCityKey(requestedCity);
  return results.find(item => normalizeWeatherCityKey(item && item.name) === requestedKey)
    || results.find(item => requestedKey.startsWith(normalizeWeatherCityKey(item && item.name)))
    || results.find(item => normalizeWeatherCityKey(item && item.name).startsWith(requestedKey))
    || results[0];
}

function splitWeatherDisplayLocation(value) {
  const parts = String(value || '').split(',').map(part => part.trim()).filter(Boolean);
  return {
    location: parts[0] || '',
    region: parts[1] || '',
    country: parts.slice(2).join(', '),
  };
}

async function resolveManualWeatherPlace(city, lang) {
  const requestedCity = sanitizeWeatherCity(city);
  if (!requestedCity) return { placePath: '', resolvedCity: '' };

  const cacheKey = `${lang}|${requestedCity.toLowerCase()}`;
  const cached = weatherLocationCache.get(cacheKey);
  if (cached && (Date.now() - cached.updatedAt) < WEATHER_CACHE_MS) return cached.value;

  let value = {
    placePath: `/${encodeURIComponent(requestedCity)}`,
    resolvedCity: requestedCity,
  };

  try {
    const query = encodeURIComponent(requestedCity);
    const geo = await fetchJson(`https://geocoding-api.open-meteo.com/v1/search?name=${query}&count=10&language=${lang}&format=json`, 3000);
    const match = pickWeatherLocationResult(geo && geo.results, requestedCity);
    const latitude = Number(match && match.latitude);
    const longitude = Number(match && match.longitude);
    if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
      value = {
        placePath: `/${latitude.toFixed(4)},${longitude.toFixed(4)}`,
        resolvedCity: [match.name, match.admin1, match.country].filter(Boolean).join(', ') || requestedCity,
      };
    }
  } catch {
    // Fall back to the raw city name when geocoding is unavailable.
  }

  weatherLocationCache.set(cacheKey, { value, updatedAt: Date.now() });
  return value;
}

function weatherDescription(item, lang) {
  if (!item) return '';
  return firstWeatherValue(item[`lang_${lang}`]) || firstWeatherValue(item.weatherDesc) || '';
}

function normalizeWeatherHour(hour, lang, date) {
  const rawTime = String(hour && hour.time || '0').padStart(4, '0');
  const time = `${rawTime.slice(0, -2).padStart(2, '0')}:${rawTime.slice(-2)}`;
  const tempC = Number(hour && hour.tempC);
  const feelsC = Number(hour && hour.FeelsLikeC);
  const rain = Number(hour && hour.chanceofrain);
  const windKph = Number(hour && hour.windspeedKmph);
  return {
    date,
    time,
    code: normalizeWeatherCode(hour && hour.weatherCode),
    tempC: Number.isFinite(tempC) ? Math.round(tempC) : null,
    feelsC: Number.isFinite(feelsC) ? Math.round(feelsC) : null,
    rain: Number.isFinite(rain) ? Math.round(rain) : null,
    windKph: Number.isFinite(windKph) ? Math.round(windKph) : null,
    condition: weatherDescription(hour, lang),
  };
}

function normalizeWeatherDay(day, lang) {
  const astronomy = day && day.astronomy && day.astronomy[0] || {};
  const noon = day && Array.isArray(day.hourly) ? (day.hourly.find(h => String(h.time) === '1200') || day.hourly[0]) : null;
  return {
    date: String(day && day.date || ''),
    code: normalizeWeatherCode(noon && noon.weatherCode),
    minC: Number.isFinite(Number(day && day.mintempC)) ? Math.round(Number(day.mintempC)) : null,
    maxC: Number.isFinite(Number(day && day.maxtempC)) ? Math.round(Number(day.maxtempC)) : null,
    avgC: Number.isFinite(Number(day && day.avgtempC)) ? Math.round(Number(day.avgtempC)) : null,
    uv: Number.isFinite(Number(day && day.uvIndex)) ? Number(day.uvIndex) : null,
    sunHour: Number.isFinite(Number(day && day.sunHour)) ? Number(day.sunHour) : null,
    sunrise: String(astronomy.sunrise || ''),
    sunset: String(astronomy.sunset || ''),
    moonPhase: String(astronomy.moon_phase || ''),
    condition: weatherDescription(noon, lang),
  };
}

function normalizeWeather(raw, lang) {
  const current = raw && raw.current_condition && raw.current_condition[0] || {};
  const area = raw && raw.nearest_area && raw.nearest_area[0] || {};
  const tempC = Number(current.temp_C);
  const feelsC = Number(current.FeelsLikeC);
  const humidity = Number(current.humidity);
  const windKph = Number(current.windspeedKmph);
  const pressure = Number(current.pressure);
  const visibility = Number(current.visibility);
  const uv = Number(current.uvIndex);
  const cloudCover = Number(current.cloudcover);
  const precipMM = Number(current.precipMM);
  const condition = weatherDescription(current, lang);
  const location = firstWeatherValue(area.areaName) || firstWeatherValue(area.region) || firstWeatherValue(area.country) || '';
  const region = firstWeatherValue(area.region);
  const country = firstWeatherValue(area.country);
  const days = Array.isArray(raw && raw.weather) ? raw.weather : [];
  const nowHour = new Date().getHours();
  const hourly = days.flatMap(day => (Array.isArray(day.hourly) ? day.hourly : [])
    .map(hour => normalizeWeatherHour(hour, lang, String(day.date || ''))))
    .filter(hour => !hour.date || hour.date !== days[0]?.date || Number(hour.time.slice(0, 2)) >= nowHour)
    .slice(0, 8);

  return {
    ok: Number.isFinite(tempC),
    code: normalizeWeatherCode(current.weatherCode),
    tempC: Number.isFinite(tempC) ? Math.round(tempC) : null,
    feelsC: Number.isFinite(feelsC) ? Math.round(feelsC) : null,
    humidity: Number.isFinite(humidity) ? humidity : null,
    windKph: Number.isFinite(windKph) ? Math.round(windKph) : null,
    windDir: String(current.winddir16Point || ''),
    pressure: Number.isFinite(pressure) ? pressure : null,
    visibility: Number.isFinite(visibility) ? visibility : null,
    uv: Number.isFinite(uv) ? uv : null,
    cloudCover: Number.isFinite(cloudCover) ? cloudCover : null,
    precipMM: Number.isFinite(precipMM) ? precipMM : null,
    condition,
    location,
    region,
    country,
    hourly,
    forecast: days.slice(0, 3).map(day => normalizeWeatherDay(day, lang)),
    updatedAt: Date.now(),
  };
}

async function getWeather(lang = 'it', requestedLocation = null) {
  const safeLang = lang === 'en' ? 'en' : 'it';
  const settings = await readHubSettings().catch(() => null);
  const hasRequestLocation = requestedLocation && (requestedLocation.mode !== undefined || requestedLocation.city !== undefined);
  const location = resolveWeatherLocation(hasRequestLocation ? requestedLocation : settings && settings.weather);
  const cacheKey = `${safeLang}|${location.mode}|${location.city.toLowerCase()}`;
  const age = Date.now() - weatherCache.updatedAt;
  if (weatherCache.data && weatherCache.cacheKey === cacheKey && age < WEATHER_CACHE_MS) return weatherCache.data;
  if (weatherPending && weatherPending.cacheKey === cacheKey) return weatherPending.promise;

  const manualPlace = location.mode === 'manual'
    ? await resolveManualWeatherPlace(location.city, safeLang)
    : { placePath: '', resolvedCity: '' };
  const placePath = manualPlace.placePath;

  const promise = fetchJson(`https://wttr.in${placePath}?format=j1&lang=${safeLang}`, 3500)
    .then(raw => {
      const data = normalizeWeather(raw, safeLang);
      data.locationMode = location.mode;
      data.requestedCity = location.city;
      data.resolvedCity = manualPlace.resolvedCity;
      if (location.mode === 'manual' && manualPlace.resolvedCity) {
        const displayLocation = splitWeatherDisplayLocation(manualPlace.resolvedCity);
        data.location = displayLocation.location || data.location;
        data.region = displayLocation.region || '';
        data.country = displayLocation.country || '';
      }
      weatherCache = { data, updatedAt: Date.now(), cacheKey };
      return data;
    })
    .catch(e => {
      if (weatherCache.data && weatherCache.cacheKey === cacheKey) return { ...weatherCache.data, stale: true };
      throw e;
    })
    .finally(() => {
      if (weatherPending && weatherPending.cacheKey === cacheKey) weatherPending = null;
    });

  weatherPending = { cacheKey, promise };
  return promise;
}

function splitMediaTitle(rawTitle, appName) {
  const title = (rawTitle || '').trim();
  if (!title) return { title: '', artist: '' };
  if (/spotify/i.test(appName) && title.includes(' - ')) {
    const parts = title.split(' - ');
    if (parts.length >= 2) {
      return { artist: parts.shift().trim(), title: parts.join(' - ').trim() };
    }
  }
  return { title, artist: '' };
}

function displayAppName(name) {
  const value = String(name || '');
  if (/jellyfin/i.test(name || '')) return 'Jellyfin';
  if (/spotify/i.test(value)) return 'Spotify';
  if (/youtube\s*music|music\.youtube\.com|ytmusic|cinhimbn[a-z]*ghhklpknlkffjgod/i.test(value)) return 'YouTube Music';
  if (/youtube/i.test(value)) return 'YouTube';
  if (/chrome|msedge|edge|firefox|brave|opera/i.test(value)) return 'YouTube';
  if (/zunemusic|zunevideo|microsoftmediaplayer|windowsmediaplayer/i.test(value)) return 'Lettore Multimediale';
  if (!name) return 'Media';
  // Strip Windows package format: Publisher.Name_hash!AppId → Name
  const pkg = (name || '').match(/^(?:[^.]+\.)+([^._!]+)[_!]/);
  if (pkg) return pkg[1];
  return name;
}

function displayMixerAppName(name, windowTitle = '') {
  const raw = String(name || '').trim();
  const title = String(windowTitle || '').trim();
  if (/jellyfin/i.test(`${raw} ${title}`)) return 'Jellyfin';
  if (!raw) return 'App';
  const base = path.win32.basename(raw).replace(/\.exe$/i, '');
  const key = base.toLowerCase();
  const token = key.replace(/[^a-z0-9]/g, '');
  const known = {
    chrome: 'Chrome',
    msedge: 'Edge',
    edge: 'Edge',
    firefox: 'Firefox',
    brave: 'Brave',
    opera: 'Opera',
    spotify: 'Spotify',
    vlc: 'VLC',
    discord: 'Discord',
    icue: 'iCUE',
    steam: 'Steam',
    obs64: 'OBS',
  };
  if (known[key]) return known[key];
  if (known[token]) return known[token];
  if (!base) return 'App';
  return base.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').replace(/(^|\s)\S/g, s => s.toUpperCase()).trim();
}

function sanitizeMixerWindowTitle(title) {
  return String(title || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

function normalizeMixerAppKey(name) {
  const raw = String(name || '').trim();
  if (!raw) return '';
  const base = path.win32.basename(raw).replace(/\.exe$/i, '');
  return base.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isGenericHostMixerKey(key) {
  const token = String(key || '').toLowerCase();
  return token === 'msedgewebview2'
    || token === 'microsoftedgewebview2'
    || token === 'applicationframehost'
    || token === 'wwahost';
}

function buildAudioCtlMixerAppKey(rawLabel, rawName, fallbackId, windowTitle) {
  const combined = `${rawLabel || ''} ${rawName || ''} ${windowTitle || ''} ${fallbackId || ''}`.toLowerCase();
  if (combined.includes('whatsapp')) return 'whatsapp';

  const base = normalizeMixerAppKey(rawLabel || rawName || fallbackId);
  if (!base) return '';

  // WebView2/UWP hosts can hide the real app name; prefer a non-host name when we have one.
  if (isGenericHostMixerKey(base)) {
    const hinted = normalizeMixerAppKey(rawName || windowTitle || '');
    if (hinted && !isGenericHostMixerKey(hinted)) return hinted;
  }

  return base;
}

function normalizeProcessToken(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\.exe$/i, '')
    .replace(/[^a-z0-9]+/g, '');
}

async function getRunningWindowApps() {
  const age = Date.now() - windowAppsCache.updatedAt;
  if (windowAppsCache.apps.length && age < WINDOW_APPS_CACHE_MS) return windowAppsCache.apps;
  if (windowAppsPending) return windowAppsPending;

  windowAppsPending = (async () => {
    const command = [
      '$apps = @(Get-Process -ErrorAction SilentlyContinue',
      '| Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle }',
      '| Select-Object -First 120 -Property ProcessName,MainWindowTitle)',
      '; [pscustomobject]@{ apps = $apps } | ConvertTo-Json -Depth 4 -Compress',
    ].join(' ');

    try {
      const data = await runPowerShellCommand(command, 6000);
      const source = Array.isArray(data.apps) ? data.apps : (data.apps ? [data.apps] : []);
      const seen = new Set();
      const apps = [];
      source.forEach(item => {
        const processName = String(item.ProcessName || '').trim();
        if (!processName) return;
        const token = normalizeProcessToken(processName);
        if (!token || seen.has(token)) return;
        if (/^(?:audiodg|svchost|shellexperiencehost|systemsettings|applicationframehost)$/.test(token)) return;
        seen.add(token);
        apps.push({
          processName,
          token,
          title: sanitizeMixerWindowTitle(item.MainWindowTitle),
          name: displayMixerAppName(processName, item.MainWindowTitle),
        });
      });
      windowAppsCache.apps = apps;
      windowAppsCache.updatedAt = Date.now();
      return apps;
    } catch {
      return windowAppsCache.apps;
    } finally {
      windowAppsPending = null;
    }
  })();

  return windowAppsPending;
}

function liveMediaSnapshot(data, ageMs) {
  if (!data) return data;
  const snapshot = { ...data };
  if (snapshot.playbackStatus === 'Playing' && snapshot.duration) {
    const position = Number(snapshot.position) || 0;
    const duration = Number(snapshot.duration) || 0;
    snapshot.position = Math.min(duration, position + (Math.max(0, Number(ageMs) || 0) / 1000));
  }
  snapshot.timelineAtMs = Date.now();
  return snapshot;
}

function mediaItemKey(data) {
  if (!data || !data.active) return '';
  const app = String(data.app || '').trim().toLowerCase();
  const source = String(data.source || '').trim().toLowerCase();
  const title = String(data.title || '').trim().toLowerCase();
  const artist = String(data.artist || data.album || '').trim().toLowerCase();
  return `${app}|${source}|${title}|${artist}`;
}

function mediaDriverIdForData(data) {
  const merged = `${String(data && data.app || '')} ${String(data && data.source || '')}`.toLowerCase();
  if (/youtube\s*music|music\.youtube\.com|ytmusic|cinhimbn[a-z]*ghhklpknlkffjgod/.test(merged)) return 'youtube-music';
  if (/youtube/.test(merged)) return 'youtube';
  return 'generic';
}

function mediaDriverOptions(driverId) {
  const id = String(driverId || 'generic');
  if (id === 'youtube') {
    return {
      allowControlPauseOverride: false,
      allowControlPlayPromotion: false,
      immediateRawStatusTransitions: true,
    };
  }
  if (id === 'youtube-music') {
    return {
      allowControlPauseOverride: true,
      allowControlPlayPromotion: true,
      immediateRawStatusTransitions: true,
    };
  }
  return {
    allowControlPauseOverride: true,
    allowControlPlayPromotion: true,
    immediateRawStatusTransitions: false,
  };
}

function clampMediaPosition(position, duration) {
  const safeDuration = Math.max(0, Number(duration) || 0);
  const safePosition = Math.max(0, Number(position) || 0);
  if (safeDuration <= 0) return safePosition;
  return Math.min(safeDuration, safePosition);
}

function setMediaTimelineState(position, duration, status, key, now, rawPosition = position) {
  const safeDuration = Math.max(0, Number(duration) || 0);
  const previousKey = mediaTimelineState.key;
  const nextKey = key || '';
  if (nextKey !== previousKey) {
    mediaTimelineState.lastKeyChangedAt = now;
  }
  mediaTimelineState.key = nextKey;
  mediaTimelineState.duration = safeDuration;
  mediaTimelineState.status = String(status || 'Paused');
  mediaTimelineState.anchorPosition = clampMediaPosition(position, safeDuration);
  mediaTimelineState.anchorAt = now;
  mediaTimelineState.lastRawPosition = clampMediaPosition(rawPosition, safeDuration);
  mediaTimelineState.pendingStatus = '';
  mediaTimelineState.pendingSince = 0;
  mediaTimelineState.pendingCount = 0;
  mediaTimelineState.playingStallSince = 0;
  mediaTimelineState.playingStallSamples = 0;
}

function getMediaTimelineStatePosition(now) {
  const duration = Math.max(0, Number(mediaTimelineState.duration) || 0);
  const base = clampMediaPosition(mediaTimelineState.anchorPosition, duration);
  if (mediaTimelineState.status !== 'Playing') return base;
  const elapsedSeconds = Math.max(0, (now - mediaTimelineState.anchorAt) / 1000);
  return clampMediaPosition(base + elapsedSeconds, duration);
}

function resetMediaPlayingStallState() {
  mediaTimelineState.playingStallSince = 0;
  mediaTimelineState.playingStallSamples = 0;
}

function logMediaDebug(message, details = null) {
  if (!MEDIA_DEBUG_LOGS) return;
  if (details && typeof details === 'object') {
    try {
      console.log(`[media-debug] ${message} ${JSON.stringify(details)}`);
      return;
    } catch { }
  }
  console.log(`[media-debug] ${message}`);
}

function inferPlaybackStatusFromHintsGeneric(rawStatus, data, context = null, options = null) {
  const normalizedRaw = String(rawStatus || 'Paused');
  if (!data || typeof data !== 'object') return normalizedRaw;
  const opts = options && typeof options === 'object' ? options : {};
  const allowControlPauseOverride = opts.allowControlPauseOverride !== false;
  const allowControlPlayPromotion = opts.allowControlPlayPromotion !== false;
  const driverId = String(opts.driverId || 'generic');

  const playbackRate = Number(data.playbackRate);
  const isPlayEnabled = data.isPlayEnabled === true;
  const isPauseEnabled = data.isPauseEnabled === true;
  const controlsHintPlaying = isPauseEnabled && !isPlayEnabled;
  const controlsHintPaused = isPlayEnabled && !isPauseEnabled;
  const sameItem = !!(context && context.sameItem);
  const rawPosition = Number(context && context.rawPosition);
  const lastRawPosition = Number(context && context.lastRawPosition);
  const keyChangedAgoMs = Number(context && context.keyChangedAgoMs);
  const rawDelta = Number.isFinite(rawPosition) && Number.isFinite(lastRawPosition)
    ? (rawPosition - lastRawPosition)
    : 0;

  if (normalizedRaw === 'Paused') {
    if (allowControlPlayPromotion && controlsHintPlaying) {
      logMediaDebug('Promoted to Playing from controls hint', {
        driverId,
        rawStatus: normalizedRaw,
        playbackRate: Number.isFinite(playbackRate) ? playbackRate : null,
        isPlayEnabled,
        isPauseEnabled,
        rawPosition: Number.isFinite(rawPosition) ? rawPosition : null,
        lastRawPosition: Number.isFinite(lastRawPosition) ? lastRawPosition : null,
        sameItem,
      });
      return 'Playing';
    }

    if (Number.isFinite(playbackRate) && playbackRate > MEDIA_PLAYBACK_RATE_FORCE_PAUSED_MAX) {
      logMediaDebug('Promoted to Playing from playbackRate hint', {
        driverId,
        rawStatus: normalizedRaw,
        playbackRate,
        isPlayEnabled,
        isPauseEnabled,
        rawPosition: Number.isFinite(rawPosition) ? rawPosition : null,
        lastRawPosition: Number.isFinite(lastRawPosition) ? lastRawPosition : null,
        sameItem,
      });
      return 'Playing';
    }

    return normalizedRaw;
  }

  if (normalizedRaw !== 'Playing') return normalizedRaw;

  if (allowControlPauseOverride && controlsHintPaused) {
    if (sameItem && Number.isFinite(keyChangedAgoMs) && keyChangedAgoMs <= MEDIA_TRACK_CHANGE_HINT_GRACE_MS) {
      logMediaDebug('Controls suggest paused during track-change grace; keeping Playing', {
        driverId,
        rawStatus: normalizedRaw,
        playbackRate: Number.isFinite(playbackRate) ? playbackRate : null,
        isPlayEnabled,
        isPauseEnabled,
        rawPosition: Number.isFinite(rawPosition) ? rawPosition : null,
        lastRawPosition: Number.isFinite(lastRawPosition) ? lastRawPosition : null,
        rawDelta,
        keyChangedAgoMs,
        sameItem,
      });
      return normalizedRaw;
    }

    logMediaDebug('Forced paused from controls hint while status is Playing', {
      driverId,
      rawStatus: normalizedRaw,
      playbackRate: Number.isFinite(playbackRate) ? playbackRate : null,
      isPlayEnabled,
      isPauseEnabled,
      rawPosition: Number.isFinite(rawPosition) ? rawPosition : null,
      lastRawPosition: Number.isFinite(lastRawPosition) ? lastRawPosition : null,
      rawDelta,
      keyChangedAgoMs: Number.isFinite(keyChangedAgoMs) ? keyChangedAgoMs : null,
      sameItem,
    });
    return 'Paused';
  }

  if (Number.isFinite(playbackRate) && playbackRate <= MEDIA_PLAYBACK_RATE_FORCE_PAUSED_MAX) {
    logMediaDebug('PlaybackRate is 0 while status is Playing; trusting status', {
      driverId,
      rawStatus: normalizedRaw,
      playbackRate,
      isPlayEnabled,
      isPauseEnabled,
      rawPosition: Number.isFinite(rawPosition) ? rawPosition : null,
      lastRawPosition: Number.isFinite(lastRawPosition) ? lastRawPosition : null,
      sameItem,
    });
  }

  return normalizedRaw;
}

function inferPlaybackStatusFromHints(rawStatus, data, context = null) {
  const driverId = mediaDriverIdForData(data);
  const options = mediaDriverOptions(driverId);
  return inferPlaybackStatusFromHintsGeneric(rawStatus, data, context, {
    driverId,
    allowControlPauseOverride: options.allowControlPauseOverride,
    allowControlPlayPromotion: options.allowControlPlayPromotion,
  });
}

function resolveStablePlaybackStatus(rawStatus, sameItem, now, immediate = false) {
  const normalizedRaw = String(rawStatus || 'Paused');
  if (immediate) {
    mediaTimelineState.pendingStatus = '';
    mediaTimelineState.pendingSince = 0;
    mediaTimelineState.pendingCount = 0;
    return normalizedRaw;
  }

  if (!sameItem) {
    mediaTimelineState.pendingStatus = '';
    mediaTimelineState.pendingSince = 0;
    mediaTimelineState.pendingCount = 0;
    return normalizedRaw;
  }

  const stable = String(mediaTimelineState.status || 'Paused');
  if (normalizedRaw === stable) {
    mediaTimelineState.pendingStatus = '';
    mediaTimelineState.pendingSince = 0;
    mediaTimelineState.pendingCount = 0;
    return normalizedRaw;
  }

  if (mediaTimelineState.pendingStatus === normalizedRaw) {
    mediaTimelineState.pendingCount += 1;
  } else {
    mediaTimelineState.pendingStatus = normalizedRaw;
    mediaTimelineState.pendingSince = now;
    mediaTimelineState.pendingCount = 1;
  }

  const stableForMs = Math.max(0, now - Number(mediaTimelineState.pendingSince || now));
  const requiredMs = normalizedRaw === 'Paused' ? 140 : 120;
  if (mediaTimelineState.pendingCount >= 2 || stableForMs >= requiredMs) {
    mediaTimelineState.pendingStatus = '';
    mediaTimelineState.pendingSince = 0;
    mediaTimelineState.pendingCount = 0;
    return normalizedRaw;
  }
  return stable;
}

function stabilizeLiveMediaPosition(nextData) {
  if (!nextData) return nextData;
  const now = Date.now();
  const normalized = { ...nextData };
  const driverId = mediaDriverIdForData(normalized);
  const driverOptions = mediaDriverOptions(driverId);
  normalized.duration = Math.max(0, Number(normalized.duration) || 0);
  normalized.position = clampMediaPosition(normalized.position, normalized.duration);
  const rawPosition = normalized.position;
  const key = mediaItemKey(normalized);
  const rawReportedStatus = String(normalized.playbackStatus || 'Paused');
  const sameItem = key === mediaTimelineState.key;
  const playbackRate = Number(normalized.playbackRate);
  const controlsUnavailable = normalized.isPlayEnabled === false && normalized.isPauseEnabled === false;
  const stalePlayingWithoutControls = rawReportedStatus === 'Playing'
    && controlsUnavailable
    && (!Number.isFinite(playbackRate) || playbackRate <= MEDIA_PLAYBACK_RATE_FORCE_PAUSED_MAX);
  const rawStatus = inferPlaybackStatusFromHints(rawReportedStatus, normalized, {
    sameItem,
    rawPosition,
    lastRawPosition: mediaTimelineState.lastRawPosition,
    keyChangedAgoMs: Math.max(0, now - Number(mediaTimelineState.lastKeyChangedAt || 0)),
  });
  const shouldRecycleForHintMismatch = rawReportedStatus === 'Playing' && rawStatus === 'Paused' && !!normalized.active;
  if (stalePlayingWithoutControls && !sameItem && normalized.active) {
    scheduleMediaStreamRecycle('stale-playing-no-controls');
  }
  const statusFromHints = rawStatus !== rawReportedStatus;
  const immediateStatusFlip = statusFromHints || !!driverOptions.immediateRawStatusTransitions;
  let status = resolveStablePlaybackStatus(rawStatus, sameItem, now, immediateStatusFlip);
  normalized.playbackStatus = status;

  if (!normalized.active || !key) {
    setMediaTimelineState(normalized.position, normalized.duration, status, key, now, normalized.position);
    normalized.timelineAtMs = now;
    return normalized;
  }

  if (!sameItem) {
    setMediaTimelineState(normalized.position, normalized.duration, status, key, now, normalized.position);
    normalized.timelineAtMs = now;
    return normalized;
  }

  const projected = getMediaTimelineStatePosition(now);
  const drift = rawPosition - projected;
  resetMediaPlayingStallState();

  if (status !== mediaTimelineState.status) {
    logMediaDebug('Playback status transition', {
      from: mediaTimelineState.status,
      to: status,
      rawReportedStatus,
      rawStatus,
      driverId,
      key,
      rawPosition,
      projected,
      drift,
    });
    // External transitions can report a stale raw position: keep projected when it
    // is plausibly newer than raw.
    if (status === 'Paused' && drift < -0.35 && drift > -40) {
      normalized.position = clampMediaPosition(projected, normalized.duration);
    } else if (status === 'Playing' && drift < -0.8 && drift > -40) {
      normalized.position = clampMediaPosition(projected, normalized.duration);
    }
    setMediaTimelineState(normalized.position, normalized.duration, status, key, now, rawPosition);
    normalized.timelineAtMs = now;
    if (shouldRecycleForHintMismatch && status === 'Paused') {
      scheduleMediaStreamRecycle('playback-hint-mismatch');
    }
    return normalized;
  }

  if (status === 'Playing' && mediaTimelineState.status === 'Playing') {
    const rawDeltaFromLast = rawPosition - mediaTimelineState.lastRawPosition;
    const likelyManualSeek = Math.abs(rawDeltaFromLast) >= 5 && Math.abs(drift) >= 2;
    if (likelyManualSeek) {
      setMediaTimelineState(rawPosition, normalized.duration, status, key, now, rawPosition);
      normalized.timelineAtMs = now;
      return normalized;
    }

    const rawMovedForward = rawPosition > mediaTimelineState.lastRawPosition;

    if (!rawMovedForward || rawPosition + 1.2 < projected) {
      // Keep a smooth local timeline when SMTC reports a stale browser position.
      normalized.position = clampMediaPosition(Math.max(projected, rawPosition), normalized.duration);
      mediaTimelineState.duration = normalized.duration;
      mediaTimelineState.status = status;
      mediaTimelineState.key = key;
      mediaTimelineState.lastRawPosition = clampMediaPosition(rawPosition, normalized.duration);
      normalized.timelineAtMs = now;
      return normalized;
    }
  }

  if (status === 'Paused' && mediaTimelineState.status === 'Paused') {
    const rawDeltaFromLast = rawPosition - mediaTimelineState.lastRawPosition;
    const likelyManualSeek = Math.abs(rawDeltaFromLast) >= 3;
    if (!likelyManualSeek && rawDeltaFromLast > 0.08) {
      // Some sources report paused while position still advances in tiny steps.
      // Keep paused timeline frozen unless we detect an explicit seek.
      normalized.position = clampMediaPosition(mediaTimelineState.lastRawPosition, normalized.duration);
      mediaTimelineState.duration = normalized.duration;
      mediaTimelineState.status = status;
      mediaTimelineState.key = key;
      mediaTimelineState.lastRawPosition = clampMediaPosition(rawPosition, normalized.duration);
      normalized.timelineAtMs = now;
      return normalized;
    }
    if (!likelyManualSeek && rawPosition + 0.8 < projected) {
      // Some sources briefly report an older paused position after a transition.
      normalized.position = clampMediaPosition(projected, normalized.duration);
      mediaTimelineState.duration = normalized.duration;
      mediaTimelineState.status = status;
      mediaTimelineState.key = key;
      mediaTimelineState.lastRawPosition = clampMediaPosition(rawPosition, normalized.duration);
      normalized.timelineAtMs = now;
      return normalized;
    }
  }

  setMediaTimelineState(normalized.position, normalized.duration, status, key, now, rawPosition);
  normalized.timelineAtMs = now;
  return normalized;
}

function getCpuUsage() {
  return cachedCpuUsage;
}

function getCpuName() {
  try {
    const cpus = os.cpus();
    if (cpus && cpus.length && cpus[0].model) {
      return cpus[0].model.replace(/\s+/g, ' ').replace(/\(R\)|\(TM\)|CPU\s+@.*$/g, '').trim();
    }
  } catch { }
  return null;
}

async function getCpuTemp() {
  const age = Date.now() - cpuTempCache.updatedAt;
  if (age < 5000) return cpuTempCache.cpuTemp;
  if (cpuTempPending) return cpuTempPending;

  cpuTempPending = (async () => {
    try {
      const data = await runPowerShellScript(CPU_TEMP_SCRIPT, [], 10000);
      cpuTempCache = {
        cpuTemp: data.cpuTemp === null || data.cpuTemp === undefined ? null : Number(data.cpuTemp),
        updatedAt: Date.now(),
      };
    } catch {
      cpuTempCache.updatedAt = Date.now();
    }
    cpuTempPending = null;
    return cpuTempCache.cpuTemp;
  })();

  return cpuTempPending;
}

async function getGpuInfo() {
  const age = Date.now() - gpuCache.updatedAt;
  if (age < 5000) return gpuCache;
  if (gpuPending) return gpuPending;
  gpuPending = (async () => {
  try {
    const data = await runPowerShellScript(GPU_SCRIPT, [], 12000);
    gpuCache = {
      gpu: data.gpu === null || data.gpu === undefined ? gpuCache.gpu : data.gpu,
      gpuName: data.gpuName || gpuCache.gpuName || null,
      gpuTemp: (data.gpuTemp === null || data.gpuTemp === undefined) ? gpuCache.gpuTemp : data.gpuTemp,
      updatedAt: Date.now(),
    };
  } catch {
    gpuCache.updatedAt = Date.now();
  }
  gpuPending = null;
  return gpuCache;
  })();
  return gpuPending;
}

let diskDetailsCache = { data: null, updatedAt: 0 };
async function getDiskDetails() {
  if (diskDetailsCache.data && Date.now() - diskDetailsCache.updatedAt < 60000) return diskDetailsCache.data;
  const command = `
    $ErrorActionPreference = 'Stop'
    try {
      $volumes = @(Get-Volume -ErrorAction Stop | Where-Object { $_.DriveLetter } | ForEach-Object {
        [pscustomobject]@{
          drive = ([string]$_.DriveLetter + ':')
          label = ([string]$_.FileSystemLabel).Trim()
          fileSystem = ([string]$_.FileSystem).Trim()
          driveType = ([string]$_.DriveType).Trim()
        }
      })
    } catch {
      $volumes = @(Get-CimInstance Win32_LogicalDisk -ErrorAction Stop | Where-Object { $_.DeviceID } | ForEach-Object {
        [pscustomobject]@{
          drive = ([string]$_.DeviceID).Trim()
          label = ([string]$_.VolumeName).Trim()
          fileSystem = ([string]$_.FileSystem).Trim()
          driveType = ([string]$_.Description).Trim()
        }
      })
    }
    [pscustomobject]@{ volumes = $volumes } | ConvertTo-Json -Depth 4 -Compress
  `;

  try {
    const data = await runPowerShellCommand(command, 5000);
    const map = {};
    const volumes = Array.isArray(data.volumes) ? data.volumes : (data.volumes ? [data.volumes] : []);
    volumes.forEach(volume => {
      if (volume && volume.drive) map[String(volume.drive).toUpperCase()] = volume;
    });
    diskDetailsCache = { data: map, updatedAt: Date.now() };
    return map;
  } catch {
    diskDetailsCache = { data: {}, updatedAt: Date.now() };
    return {};
  }
}

async function getAllDisksInfo() {
  const drives = [];
  const details = await getDiskDetails();
  const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  for (const letter of letters) {
    try {
      if (typeof fs.promises.statfs === 'function') {
        const s = await fs.promises.statfs(letter + ':\\');
        const total = Number(s.blocks) * Number(s.bsize);
        const free = Number(s.bfree) * Number(s.bsize);
        if (total > 0) {
          const drive = letter + ':';
          const detail = details[drive.toUpperCase()] || {};
          drives.push({
            drive,
            total,
            used: total - free,
            free,
            percent: Math.round(((total - free) / total) * 100),
            label: detail.label || '',
            fileSystem: detail.fileSystem || '',
            driveType: detail.driveType || '',
          });
        }
      }
    } catch { }
  }
  return drives.length ? drives : null;
}

let ramInfoCache = null;
async function getRamInfo() {
  if (ramInfoCache) return ramInfoCache;
  const command = `
    $types = @{ 20='DDR'; 21='DDR2'; 22='DDR2 FB'; 24='DDR3'; 26='DDR4'; 34='DDR5' }
    $modules = @(Get-CimInstance Win32_PhysicalMemory -ErrorAction Stop | ForEach-Object {
      $smbios = 0
      try { $smbios = [int]$_.SMBIOSMemoryType } catch { }
      $type = $types[$smbios]
      $speed = 0
      if ($_.ConfiguredClockSpeed) { $speed = [int]$_.ConfiguredClockSpeed }
      elseif ($_.Speed) { $speed = [int]$_.Speed }
      [pscustomobject]@{
        type = $type
        speed = $speed
        capacity = [uint64]$_.Capacity
        manufacturer = ([string]$_.Manufacturer).Trim()
        partNumber = ([string]$_.PartNumber).Trim()
      }
    })
    if ($modules.Count -eq 0) {
      [pscustomobject]@{ ram = $null } | ConvertTo-Json -Depth 4 -Compress
      exit 0
    }
    $type = ($modules | Where-Object { $_.type } | Select-Object -First 1 -ExpandProperty type)
    $speed = ($modules | Measure-Object -Property speed -Maximum).Maximum
    $total = ($modules | Measure-Object -Property capacity -Sum).Sum
    $moduleCount = $modules.Count
    $moduleGb = if ($moduleCount -gt 0 -and $total) { [Math]::Round(($total / $moduleCount) / 1GB, 0) } else { 0 }
    $manufacturer = ($modules | Where-Object { $_.manufacturer -and $_.manufacturer -notmatch '^(Unknown|Undefined|Default|string|To Be Filled)' } | Select-Object -First 1 -ExpandProperty manufacturer)
    $partNumber = ($modules | Where-Object { $_.partNumber -and $_.partNumber -notmatch '^(Unknown|Undefined|Default|string|To Be Filled)' } | Select-Object -First 1 -ExpandProperty partNumber)
    $labelParts = @()
    if ($type) { $labelParts += $type }
    if ($speed) { $labelParts += (([int]$speed).ToString() + ' MHz') }
    $layout = if ($moduleCount -gt 0 -and $moduleGb -gt 0) { $moduleCount.ToString() + 'x' + $moduleGb.ToString() + ' GB' } else { $null }
    $detailParts = @()
    if ($labelParts.Count -gt 0) { $detailParts += ($labelParts -join ' ') }
    if ($layout) { $detailParts += $layout }
    $nameParts = @()
    if ($manufacturer) { $nameParts += $manufacturer }
    if ($partNumber) { $nameParts += $partNumber }
    [pscustomobject]@{
      ram = [pscustomobject]@{
        name = ($labelParts -join ' ')
        detail = ($detailParts -join ' - ')
        moduleName = ($nameParts -join ' ')
        modules = $moduleCount
        speed = $speed
        type = $type
      }
    } | ConvertTo-Json -Depth 4 -Compress
  `;

  try {
    const data = await runPowerShellCommand(command, 5000);
    ramInfoCache = data.ram || null;
  } catch {
    ramInfoCache = null;
  }
  return ramInfoCache;
}

async function getSystemInfo() {
  const [gpu, disks, ramInfo, cpuTemp] = await Promise.all([getGpuInfo(), getAllDisksInfo(), getRamInfo(), getCpuTemp()]);
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;

  return {
    now: new Date().toISOString(),
    hostname: os.hostname(),
    uptime: Math.round(os.uptime()),
    cpu: getCpuUsage(),
    cpuTemp,
    cpuName: getCpuName(),
    memory: {
      used: usedMem,
      total: totalMem,
      percent: Math.round((usedMem / totalMem) * 100),
    },
    ramName: ramInfo && ramInfo.name ? ramInfo.name : null,
    ramDetail: ramInfo,
    gpu: gpu.gpu,
    gpuName: gpu.gpuName,
    gpuTemp: gpu.gpuTemp,
    disks,
  };
}

// --- Network info: bandwidth requires a delta between two readings ---
let _netPrev = null; // { rx, tx, t }
async function getNetworkInfo() {
  const data = await runPowerShellScript(NETWORK_SCRIPT, [], 8000);
  const now = Date.now();
  const rx = Number(data.rxBytes) || 0;
  const tx = Number(data.txBytes) || 0;

  let downBps = null, upBps = null;
  if (_netPrev && now > _netPrev.t) {
    const dt = (now - _netPrev.t) / 1000; // seconds
    const dRx = rx - _netPrev.rx;
    const dTx = tx - _netPrev.tx;
    if (dt > 0 && dRx >= 0 && dTx >= 0) {
      downBps = Math.round(dRx / dt);
      upBps   = Math.round(dTx / dt);
    }
  }
  _netPrev = { rx, tx, t: now };

  return {
    ping: data.ping ?? null,
    latency: data.latency ?? null,
    fps: data.fps ?? null,
    gpuLatency: data.gpuLatency ?? null,
    downloadBps: downBps,
    uploadBps: upBps,
  };
}

function resolveMediaStreamWaiters(hasSample) {
  if (!mediaStreamWaiters.size) return;
  const waiters = Array.from(mediaStreamWaiters.values());
  mediaStreamWaiters.clear();
  waiters.forEach(resolve => {
    try { resolve(!!hasSample); } catch {}
  });
}

function mergeMediaArtworkFromCache(nextData) {
  if (!nextData || nextData.thumbnail) return nextData;
  const cached = mediaCache.data;
  if (!cached || !cached.thumbnail || !cached.active || !nextData.active) return nextData;
  if (mediaItemKey(cached) !== mediaItemKey(nextData)) return nextData;
  return { ...nextData, thumbnail: cached.thumbnail };
}

function isWeakMediaSnapshot(data) {
  if (!data || !data.active) return true;
  const title = String(data.title || '').trim().toLowerCase();
  const artist = String(data.artist || '').trim();
  const duration = Math.max(0, Number(data.duration) || 0);
  const genericTitle = !title || /^(chrome|google chrome|msedge|edge|browser|youtube|jellyfin|spotify)$/i.test(title);
  return genericTitle && !artist && duration <= 0;
}

function parseBase64ByteLength(base64) {
  const text = String(base64 || '');
  if (!text) return 0;
  const padding = text.endsWith('==') ? 2 : (text.endsWith('=') ? 1 : 0);
  return Math.max(0, Math.floor((text.length * 3) / 4) - padding);
}

function parseDataImageMeta(dataUrl) {
  const value = String(dataUrl || '').trim();
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/i.exec(value);
  if (!match) return null;

  const mime = String(match[1] || '').trim().toLowerCase();
  const base64 = String(match[2] || '').trim();
  const bytes = parseBase64ByteLength(base64);
  let width = 0;
  let height = 0;

  if (mime === 'image/png') {
    try {
      const head = Buffer.from(base64.slice(0, 128), 'base64');
      if (
        head.length >= 24
        && head[0] === 0x89
        && head[1] === 0x50
        && head[2] === 0x4e
        && head[3] === 0x47
      ) {
        width = head.readUInt32BE(16);
        height = head.readUInt32BE(20);
      }
    } catch {}
  }

  return { mime, bytes, width, height };
}

function isLikelyAppIconThumbnail(value) {
  const meta = parseDataImageMeta(value);
  if (!meta) return false;
  const bytes = Number(meta.bytes) || 0;
  const width = Number(meta.width) || 0;
  const height = Number(meta.height) || 0;
  if (meta.mime !== 'image/png') return false;

  // Typical app icons from SMTC are square PNGs with relatively small payloads,
  // often 128/256 px with very low bytes-per-pixel.
  if (width > 0 && height > 0) {
    const square = width === height && width >= 48 && width <= 256;
    const area = width * height;
    const bytesPerPixel = area > 0 ? (bytes / area) : 0;
    const compact = bytes > 0 && bytes <= 45000;
    const flatLike = bytesPerPixel > 0 && bytesPerPixel <= 0.45;
    if (square && compact && flatLike) return true;
  }

  // Fallback for unknown dimensions.
  return bytes > 0 && bytes <= 12000;
}

function isBrowserMediaSource(data) {
  const family = `${data && data.app || ''} ${data && data.source || ''}`.toLowerCase();
  return /youtube|jellyfin|spotify|chrome|msedge|edge|firefox|brave|opera|browser/.test(family);
}

function isGenericTrackTitle(value) {
  const title = String(value || '').trim().toLowerCase();
  if (!title) return true;
  return /^(chrome|google chrome|msedge|edge|browser|youtube|jellyfin|spotify|music|media|player)$/i.test(title);
}

function mediaArtworkLookupKey(data) {
  const title = String(data && data.title || '').trim();
  const artist = String(data && data.artist || '').trim();
  if (!title || !artist) return '';
  return `${artist}::${title}`.toLowerCase();
}

function canLookupTrackArtwork(data) {
  if (!data || !data.active) return false;
  if (!isBrowserMediaSource(data)) return false;
  if (isGenericTrackTitle(data.title)) return false;
  const key = mediaArtworkLookupKey(data);
  return !!key;
}

function applyExternalArtworkToCurrentTrack(lookupKey, thumbnail) {
  const thumb = String(thumbnail || '').trim();
  if (!lookupKey || !thumb) return false;
  const current = mediaCache.data;
  if (!current || !current.active) return false;
  if (mediaArtworkLookupKey(current) !== lookupKey) return false;
  if (current.thumbnail === thumb) return false;

  const updated = stabilizeLiveMediaPosition({ ...current, thumbnail: thumb });
  mediaCache = { data: updated, updatedAt: Date.now() };
  const now = Date.now();
  if (sseClients.size > 0 && (now - lastMediaSsePushedAt) >= MEDIA_SSE_PUSH_MIN_INTERVAL_MS) {
    lastMediaSsePushedAt = now;
    broadcastSSE('media', updated);
  }
  return true;
}

function queueMediaArtworkHydration(data) {
  if (!canLookupTrackArtwork(data)) return;
  const lookupKey = mediaArtworkLookupKey(data);
  if (!lookupKey) return;
  if (mediaArtworkLookupInFlight.has(lookupKey)) return;

  if (artworkCache.has(lookupKey)) {
    const cached = artworkCache.get(lookupKey);
    if (cached) applyExternalArtworkToCurrentTrack(lookupKey, cached);
    return;
  }

  const lookupData = { ...data, thumbnail: null };
  const promise = hydrateArtwork(lookupData, { forceLookup: true })
    .then(result => {
      const fetched = result && result.thumbnail ? result.thumbnail : null;
      if (fetched) applyExternalArtworkToCurrentTrack(lookupKey, fetched);
    })
    .catch(() => {})
    .finally(() => {
      mediaArtworkLookupInFlight.delete(lookupKey);
    });
  mediaArtworkLookupInFlight.set(lookupKey, promise);
}

function shouldSuppressTransientThumbnailSwap(nextData, previousData, previousAgeMs) {
  if (!nextData || !previousData) return false;
  if ((Number(previousAgeMs) || 0) > MEDIA_TRANSIENT_CLOSE_GRACE_MS) return false;

  const nextThumb = nextData.thumbnail || null;
  const previousThumb = previousData.thumbnail || null;
  if (!nextThumb || !previousThumb) return false;
  if (nextThumb === previousThumb) return false;

  if (!isLikelyAppIconThumbnail(nextThumb)) return false;
  if (isLikelyAppIconThumbnail(previousThumb)) return false;

  if (!isBrowserMediaSource(nextData)) return false;

  return true;
}

function clearMediaTransientHoldState() {
  mediaTransientHoldState.key = '';
  mediaTransientHoldState.startedAt = 0;
}

function mediaTransientHoldKey(data) {
  if (!data) return '';
  const trackKey = mediaItemKey(data);
  if (trackKey) return `track:${trackKey}`;
  const app = String(data.app || '').trim().toLowerCase();
  const source = String(data.source || '').trim().toLowerCase();
  if (!app && !source) return '';
  return `app:${app}|${source}`;
}

function withinMediaTransientHoldWindow(previousData, now = Date.now(), maxHoldMs = MEDIA_TRANSIENT_CLOSE_GRACE_MS) {
  const holdKey = mediaTransientHoldKey(previousData);
  if (!holdKey) return false;

  if (mediaTransientHoldState.key !== holdKey || !mediaTransientHoldState.startedAt) {
    mediaTransientHoldState.key = holdKey;
    mediaTransientHoldState.startedAt = now;
  }

  const heldForMs = Math.max(0, now - Number(mediaTransientHoldState.startedAt || now));
  return heldForMs <= Math.max(0, Number(maxHoldMs) || 0);
}

function shouldHoldPreviousMediaSnapshot(nextData, previousData, previousAgeMs) {
  if (!previousData || !previousData.active) {
    clearMediaTransientHoldState();
    return false;
  }
  if ((Number(previousAgeMs) || 0) > MEDIA_TRANSIENT_CLOSE_GRACE_MS) {
    clearMediaTransientHoldState();
    return false;
  }
  const previousRenderable = !!(previousData.title || previousData.artist || previousData.app);
  if (!previousRenderable) {
    clearMediaTransientHoldState();
    return false;
  }

  const nextStatus = String(nextData && nextData.playbackStatus || '').trim().toLowerCase();
  let shouldHold = false;
  let holdWindowMs = MEDIA_TRANSIENT_CLOSE_GRACE_MS;
  if (!nextData || !nextData.active || nextStatus === 'closed' || nextStatus === 'unavailable') {
    shouldHold = true;
    holdWindowMs = MEDIA_EXPLICIT_CLOSE_GRACE_MS;
  } else {
    const previousFamily = `${previousData.app || ''} ${previousData.source || ''}`.toLowerCase();
    const nextFamily = `${nextData.app || ''} ${nextData.source || ''}`.toLowerCase();
    const bothBrowserLike = /youtube|jellyfin|spotify|chrome|msedge|edge|firefox|brave|opera|browser/.test(previousFamily)
      && /youtube|jellyfin|spotify|chrome|msedge|edge|firefox|brave|opera|browser/.test(nextFamily);
    const sameApp = String(previousData.app || '').trim().toLowerCase() === String(nextData.app || '').trim().toLowerCase();

    if ((sameApp || bothBrowserLike) && isWeakMediaSnapshot(nextData)) shouldHold = true;
  }

  if (!shouldHold) {
    clearMediaTransientHoldState();
    return false;
  }

  return withinMediaTransientHoldWindow(previousData, Date.now(), holdWindowMs);
}

function blendHeldMediaSnapshot(nextData, previousData) {
  const previousStatus = String(previousData && previousData.playbackStatus || '').trim();
  const nextStatus = String(nextData && nextData.playbackStatus || '').trim();
  const keepPreviousStatus = !nextStatus || /^(closed|unavailable|unknown)$/i.test(nextStatus);
  const nextWeak = isWeakMediaSnapshot(nextData);
  const nextTitle = String(nextData && nextData.title || '').trim();
  const nextArtist = String(nextData && nextData.artist || '').trim();
  const nextAlbum = String(nextData && nextData.album || '').trim();
  const nextApp = String(nextData && nextData.app || '').trim();
  const nextSource = String(nextData && nextData.source || '').trim();
  const previousTitle = String(previousData && previousData.title || '').trim();
  const previousArtist = String(previousData && previousData.artist || '').trim();
  const previousAlbum = String(previousData && previousData.album || '').trim();
  const previousApp = String(previousData && previousData.app || '').trim();
  const previousSource = String(previousData && previousData.source || '').trim();

  return {
    ...previousData,
    ...nextData,
    active: true,
    app: (!nextWeak && nextApp) ? nextApp : (previousApp || nextApp),
    source: (!nextWeak && nextSource) ? nextSource : (previousSource || nextSource),
    title: (!nextWeak && nextTitle) ? nextTitle : (previousTitle || nextTitle),
    artist: (!nextWeak && nextArtist) ? nextArtist : (previousArtist || nextArtist),
    album: (!nextWeak && nextAlbum) ? nextAlbum : (previousAlbum || nextAlbum),
    thumbnail: (() => {
      const previousThumb = previousData && previousData.thumbnail ? previousData.thumbnail : null;
      const nextThumb = nextData && nextData.thumbnail ? nextData.thumbnail : null;
      if (nextWeak) return previousThumb || nextThumb || null;
      return nextThumb || previousThumb || null;
    })(),
    playbackStatus: keepPreviousStatus ? (previousStatus || 'Paused') : nextStatus,
    duration: Math.max(
      0,
      Number(nextData && nextData.duration) || 0,
      Number(previousData && previousData.duration) || 0,
    ),
    position: (() => {
      const nextPosition = Number(nextData && nextData.position);
      if (Number.isFinite(nextPosition) && nextPosition > 0) return nextPosition;
      const previousPosition = Number(previousData && previousData.position);
      return Number.isFinite(previousPosition) ? previousPosition : 0;
    })(),
  };
}

function updateMediaCacheFromStream(raw) {
  if (!raw || typeof raw !== 'object') return;
  const previousData = mediaCache.data;
  const previousAgeMs = Date.now() - Number(mediaCache.updatedAt || 0);
  let enriched = mergeMediaArtworkFromCache(raw);

  // For browser-based media sessions prefer stable external artwork over app icons.
  if (isBrowserMediaSource(enriched) && isLikelyAppIconThumbnail(enriched.thumbnail)) {
    const previousThumb = previousData && previousData.thumbnail ? previousData.thumbnail : null;
    if (previousThumb && !isLikelyAppIconThumbnail(previousThumb)) {
      enriched = { ...enriched, thumbnail: previousThumb };
    } else {
      enriched = { ...enriched, thumbnail: null };
    }
  }

  if (shouldSuppressTransientThumbnailSwap(enriched, previousData, previousAgeMs)) {
    enriched = { ...enriched, thumbnail: previousData.thumbnail };
  }
  let stabilized = stabilizeLiveMediaPosition(enriched);
  if (shouldHoldPreviousMediaSnapshot(stabilized, previousData, previousAgeMs)) {
    stabilized = stabilizeLiveMediaPosition(blendHeldMediaSnapshot(stabilized, previousData));
  }
  mediaCache = { data: stabilized, updatedAt: Date.now() };
  queueMediaArtworkHydration(stabilized);
  mediaPrimaryRetryNotBefore = 0;
  const now = Date.now();
  if (sseClients.size > 0 && (now - lastMediaSsePushedAt) >= MEDIA_SSE_PUSH_MIN_INTERVAL_MS) {
    lastMediaSsePushedAt = now;
    broadcastSSE('media', stabilized);
  }
  resolveMediaStreamWaiters(true);
}

function processMediaStreamChunk(chunk) {
  if (!chunk) return;
  mediaStreamBuffer += String(chunk);
  if (mediaStreamBuffer.length > MEDIA_STREAM_MAX_BUFFER_CHARS) {
    mediaStreamBuffer = mediaStreamBuffer.slice(-MEDIA_STREAM_MAX_BUFFER_CHARS);
  }
  while (true) {
    const newlineIndex = mediaStreamBuffer.indexOf('\n');
    if (newlineIndex < 0) break;
    const line = mediaStreamBuffer.slice(0, newlineIndex).trim();
    mediaStreamBuffer = mediaStreamBuffer.slice(newlineIndex + 1);
    if (!line) continue;
    try {
      updateMediaCacheFromStream(JSON.parse(line));
    } catch {
      // Ignore malformed or partial lines.
    }
  }
}

function waitForMediaStreamSample(timeoutMs = MEDIA_STREAM_WAIT_MS) {
  const ageMs = Date.now() - Number(mediaCache.updatedAt || 0);
  if (mediaCache.updatedAt && ageMs <= MEDIA_STREAM_CACHE_STALE_MS) return Promise.resolve(true);
  return new Promise(resolve => {
    const waiterId = ++mediaStreamWaiterSeq;
    const timer = setTimeout(() => {
      if (!mediaStreamWaiters.has(waiterId)) return;
      mediaStreamWaiters.delete(waiterId);
      resolve(false);
    }, Math.max(40, Number(timeoutMs) || MEDIA_STREAM_WAIT_MS));
    mediaStreamWaiters.set(waiterId, hasSample => {
      clearTimeout(timer);
      resolve(!!hasSample);
    });
  });
}

function stopMediaStream() {
  if (mediaStreamRecycleTimer) {
    clearTimeout(mediaStreamRecycleTimer);
    mediaStreamRecycleTimer = null;
  }
  const proc = mediaStreamProcess;
  mediaStreamProcess = null;
  mediaStreamStarting = false;
  mediaStreamBuffer = '';
  resolveMediaStreamWaiters(false);
  if (proc && !proc.killed) {
    try { proc.kill(); } catch {}
  }
}

function scheduleMediaStreamRecycle(reason = 'manual') {
  if (mediaStreamRecycleTimer) return;
  mediaStreamRecycleTimer = setTimeout(() => {
    mediaStreamRecycleTimer = null;
    stopMediaStream();
    mediaStreamRestartNotBefore = Date.now() + 80;
    ensureMediaStreamRunning();
  }, 140);
  if (typeof mediaStreamRecycleTimer.unref === 'function') mediaStreamRecycleTimer.unref();
}

function ensureMediaStreamRunning() {
  if (mediaStreamProcess || mediaStreamStarting) return;
  if (Date.now() < mediaStreamRestartNotBefore) return;
  if (!fs.existsSync(AUDIOCTL_DLL)) return;

  mediaStreamStarting = true;
  mediaStreamBuffer = '';
  const child = spawn(DOTNET_BIN, [AUDIOCTL_DLL, 'media-stream', String(MEDIA_STREAM_INTERVAL_MS), String(process.pid)], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  mediaStreamProcess = child;

  if (child.stdout) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', processMediaStreamChunk);
  }

  if (child.stderr) {
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', () => {});
  }

  child.on('spawn', () => {
    mediaStreamStarting = false;
    mediaStreamRestartNotBefore = 0;
  });

  child.on('error', () => {
    mediaStreamStarting = false;
    mediaStreamRestartNotBefore = Date.now() + MEDIA_STREAM_RESTART_BACKOFF_MS;
    if (mediaStreamProcess === child) mediaStreamProcess = null;
  });

  child.on('close', () => {
    if (mediaStreamProcess === child) mediaStreamProcess = null;
    mediaStreamStarting = false;
    mediaStreamRestartNotBefore = Date.now() + MEDIA_STREAM_RESTART_BACKOFF_MS;
  });
}

async function getMediaInfo(force = false) {
  lastMediaRequestAt = Date.now();
  ensureMediaStreamRunning();

  const cacheAgeMs = Date.now() - Number(mediaCache.updatedAt || 0);
  if (!force && mediaCache.data && cacheAgeMs <= MEDIA_STREAM_CACHE_FRESH_MS) {
    return liveMediaSnapshot(mediaCache.data, cacheAgeMs);
  }

  if (!force && mediaCache.data && cacheAgeMs < MEDIA_STREAM_CACHE_STALE_MS) {
    waitForMediaStreamSample(MEDIA_STREAM_WAIT_MS).catch(() => {});
    return liveMediaSnapshot(mediaCache.data, cacheAgeMs);
  }

  if (mediaPending) return mediaPending;
  mediaPending = (async () => {
    const streamed = await waitForMediaStreamSample(force ? (MEDIA_STREAM_WAIT_MS + 80) : MEDIA_STREAM_WAIT_MS);
    if (streamed && mediaCache.data) {
      const age = Date.now() - Number(mediaCache.updatedAt || 0);
      return liveMediaSnapshot(mediaCache.data, age);
    }

    const now = Date.now();
    if (!force && now < mediaPrimaryRetryNotBefore) {
      const previousData = mediaCache.data;
      const previousAgeMs = Date.now() - Number(mediaCache.updatedAt || 0);
      const cachedAudioFallback = buildMediaFallbackFromAudioApps(
        lastAudioInfoSnapshot && lastAudioInfoSnapshot.apps,
        'Media session temporarily unavailable',
        windowAppsCache && Array.isArray(windowAppsCache.apps) ? windowAppsCache.apps : [],
      );
      const cachedWindowFallback = buildMediaFallbackFromWindowApps(
        windowAppsCache && Array.isArray(windowAppsCache.apps) ? windowAppsCache.apps : [],
        'Media session temporarily unavailable',
      );
      const fastFallback = cachedAudioFallback
        || cachedWindowFallback
        || mediaCache.data
        || unavailableMediaFallback('Media session temporarily unavailable');
      const hydratedFastFallback = await hydrateArtwork(fastFallback);
      let resolvedFastFallback = stabilizeLiveMediaPosition(hydratedFastFallback);
      if (shouldHoldPreviousMediaSnapshot(resolvedFastFallback, previousData, previousAgeMs)) {
        resolvedFastFallback = stabilizeLiveMediaPosition(blendHeldMediaSnapshot(resolvedFastFallback, previousData));
      }
      mediaCache = { data: resolvedFastFallback, updatedAt: Date.now() };
      return resolvedFastFallback;
    }

    try {
      const sampled = await sampleMediaCache(true);
      if (sampled && mediaCache.data) {
        const age = Date.now() - Number(mediaCache.updatedAt || 0);
        return liveMediaSnapshot(mediaCache.data, age);
      }
      throw new Error('Media sample unavailable');
    } catch (e) {
      const message = String(e && e.message || '');
      mediaPrimaryRetryNotBefore = Date.now() + MEDIA_PRIMARY_RETRY_BACKOFF_MS;
      const cached = mediaCache.data;
      const cachedUnavailable = !cached || String(cached.playbackStatus || '').toLowerCase() === 'unavailable';
      if (cached && !cachedUnavailable) {
        const age = Date.now() - Number(mediaCache.updatedAt || 0);
        return liveMediaSnapshot(cached, age);
      }
      const fallback = await getMediaFallback(message);
      const hydratedFallback = await hydrateArtwork(fallback);
      const previousData = mediaCache.data;
      const previousAgeMs = Date.now() - Number(mediaCache.updatedAt || 0);
      let resolvedFallback = stabilizeLiveMediaPosition(hydratedFallback);
      if (shouldHoldPreviousMediaSnapshot(resolvedFallback, previousData, previousAgeMs)) {
        resolvedFallback = stabilizeLiveMediaPosition(blendHeldMediaSnapshot(resolvedFallback, previousData));
      }
      mediaCache = { data: resolvedFallback, updatedAt: Date.now() };
      return resolvedFallback;
    } finally {
      mediaPending = null;
    }
  })();
  return mediaPending;
}

async function sampleMediaCache(includeArtwork = false) {
  if (mediaSampleInFlight) return false;
  mediaSampleInFlight = true;
  try {
    const fromAudioCtl = await runAudioCtlJson(['media-info'], includeArtwork ? 9000 : 7000);
    if (!(fromAudioCtl && fromAudioCtl.ok && fromAudioCtl.data)) return false;
    const data = fromAudioCtl.data;
    const status = String(data && data.playbackStatus || '').toLowerCase();
    if (status === 'unavailable' && data && data.error) return false;
    const hydrated = includeArtwork ? await hydrateArtwork(data) : data;
    updateMediaCacheFromStream(hydrated);
    mediaPrimaryRetryNotBefore = 0;
    return true;
  } catch {
    return false;
  } finally {
    mediaSampleInFlight = false;
  }
}

function unavailableMediaFallback(error) {
  return { active: false, app: '', source: '', title: '', artist: '', album: '', playbackStatus: 'Unavailable', thumbnail: null, position: 0, duration: 0, error };
}

function collectJellyfinWindowTokens(windowApps) {
  if (!Array.isArray(windowApps) || windowApps.length === 0) return new Set();
  const tokens = new Set();
  windowApps.forEach(item => {
    const processName = String(item && item.processName || '').trim();
    const token = normalizeProcessToken(String(item && item.token || processName));
    const name = String(item && item.name || '').trim();
    const title = String(item && item.title || '').trim();
    if (!token) return;
    if (/jellyfin/i.test(`${processName} ${name} ${title}`)) tokens.add(token);
  });
  return tokens;
}

function isBrowserHostToken(value) {
  return /^(chrome|googlechrome|msedge|microsoftedge|edge|firefox|brave|opera|browser|msedgewebview2|microsoftedgewebview2)$/i.test(String(value || ''));
}

function mediaModeUrlFromSettings(settings) {
  const value = settings && settings.mediaMode ? settings.mediaMode.url : '';
  return String(value || '').trim();
}

function hasConfiguredMediaModeUrl(value) {
  const url = String(value || '').trim();
  return /^https?:\/\//i.test(url);
}

function hasActiveQtWebEngineSession(rawSnapshot) {
  if (!rawSnapshot || typeof rawSnapshot !== 'object') return false;
  const rawApps = Array.isArray(rawSnapshot.apps) ? rawSnapshot.apps : [];
  return rawApps.some(entry => {
    const id = String(entry && entry.id || '');
    const name = String(entry && entry.name || '');
    const label = String(entry && entry.label || '');
    const tokenSource = (id || name || label).replace(/\//g, '\\');
    const base = path.win32.basename(tokenSource).toLowerCase();
    const combined = `${base} ${id} ${name} ${label}`.toLowerCase();
    if (!/qtwebengineprocess(?:\.exe)?/.test(combined)) return false;
    return String(entry && entry.state || '').trim().toLowerCase() === 'active';
  });
}

function buildMediaFallbackFromEmbeddedSession(rawSnapshot, mediaModeUrl, error) {
  const url = String(mediaModeUrl || '').trim();
  if (!hasConfiguredMediaModeUrl(url)) return null;
  if (!hasActiveQtWebEngineSession(rawSnapshot)) return null;

  let title = 'Jellyfin attivo';
  try {
    const parsed = new URL(url);
    if (parsed && parsed.hostname) title = `Jellyfin su ${parsed.hostname}`;
  } catch {}

  return {
    active: true,
    app: 'Jellyfin',
    source: 'Jellyfin',
    title,
    artist: '',
    album: '',
    playbackStatus: 'Unknown',
    thumbnail: null,
    position: 0,
    duration: 0,
    fallback: true,
    error,
  };
}

function buildMediaFallbackFromAudioApps(apps, error, windowApps = null) {
  if (!Array.isArray(apps) || apps.length === 0) return null;
  const isMediaLike = value => /spotify|chrome|edge|firefox|brave|opera|browser|youtube|jellyfin|vlc|mpv|netflix|prime video|disney/i.test(String(value || ''));
  const jellyfinWindowTokens = collectJellyfinWindowTokens(windowApps);

  const candidates = apps
    .map(app => ({
      id: String((app && app.id) || '').trim(),
      name: String((app && app.name) || '').trim(),
      label: String((app && app.label) || '').trim(),
      title: String((app && app.title) || '').trim(),
      state: String((app && app.state) || '').trim(),
    }))
    .filter(app => app.id || app.name || app.label)
    .filter(app => !/system sounds|audiosrv\.dll|operating system|windows audio/i.test(`${app.id} ${app.name} ${app.label}`));

  if (!candidates.length) return null;

  const scored = candidates.map(app => {
    const merged = `${app.id} ${app.name} ${app.label} ${app.title}`;
    const mergedTokens = [
      normalizeProcessToken(app.id),
      normalizeProcessToken(app.name),
      normalizeProcessToken(app.label),
    ].filter(Boolean);
    const explicitJellyfin = /jellyfin/i.test(merged);
    const jellyfinByBrowserWindow = !explicitJellyfin
      && mergedTokens.some(token => isBrowserHostToken(token))
      && mergedTokens.some(token => jellyfinWindowTokens.has(token));
    const score =
      (app.state === 'Active' ? 100 : 0)
      + (app.title ? 20 : 0)
      + (isMediaLike(merged) ? 15 : 0)
      + (explicitJellyfin ? 260 : 0)
      + (jellyfinByBrowserWindow ? 220 : 0);
    return { app, score, explicitJellyfin, jellyfinByBrowserWindow };
  }).sort((left, right) => right.score - left.score);

  const best = scored[0] || null;
  const selected = best ? best.app : null;
  if (!best || !selected || best.score <= 0) return null;

  const sourceName = selected.label || selected.name || selected.id || 'Media';
  const appName = (best.explicitJellyfin || best.jellyfinByBrowserWindow)
    ? 'Jellyfin'
    : displayAppName(sourceName);
  const rawTitle = selected.title || selected.name || selected.label || sourceName || 'Media attivo';
  const split = splitMediaTitle(rawTitle, appName);

  return {
    active: true,
    app: appName,
    source: appName,
    title: split.title || rawTitle,
    artist: split.artist || '',
    album: '',
    playbackStatus: 'Unknown',
    thumbnail: null,
    position: 0,
    duration: 0,
    fallback: true,
    error,
  };
}

function buildMediaFallbackFromWindowApps(windowApps, error) {
  if (!Array.isArray(windowApps) || windowApps.length === 0) return null;
  const candidates = windowApps
    .map(item => ({
      processName: String(item && item.processName || '').trim(),
      token: normalizeProcessToken(String(item && item.token || item && item.processName || '')),
      name: String(item && item.name || '').trim(),
      title: String(item && item.title || '').trim(),
    }))
    .filter(item => item.token || item.name || item.title)
    .filter(item => /jellyfin/i.test(`${item.processName} ${item.name} ${item.title}`));

  if (!candidates.length) return null;

  const selected = candidates.sort((left, right) => {
    const leftScore = (left.title ? 20 : 0) + (/jellyfin/i.test(left.title) ? 40 : 0);
    const rightScore = (right.title ? 20 : 0) + (/jellyfin/i.test(right.title) ? 40 : 0);
    return rightScore - leftScore;
  })[0];

  const rawTitle = selected.title || selected.name || selected.processName || 'Jellyfin attivo';
  const split = splitMediaTitle(rawTitle, 'Jellyfin');
  return {
    active: true,
    app: 'Jellyfin',
    source: 'Jellyfin',
    title: split.title || rawTitle,
    artist: split.artist || '',
    album: '',
    playbackStatus: 'Unknown',
    thumbnail: null,
    position: 0,
    duration: 0,
    fallback: true,
    error,
  };
}

async function getMediaFallback(error) {
  let windowApps = [];
  try {
    windowApps = await getRunningWindowApps();
  } catch {}

  let mediaModeUrl = '';
  try {
    const settings = await readHubSettings();
    mediaModeUrl = mediaModeUrlFromSettings(settings);
  } catch {}

  try {
    const audioSnapshot = await getAudioInfoFromAudioCtl();
    const fromAudioCtl = buildMediaFallbackFromAudioApps(audioSnapshot && audioSnapshot.apps, error, windowApps);
    if (fromAudioCtl) return fromAudioCtl;
    if ((Date.now() - Number(lastAudioCtlRawUpdatedAt || 0)) <= 15000) {
      const fromEmbedded = buildMediaFallbackFromEmbeddedSession(lastAudioCtlRawSnapshot, mediaModeUrl, error);
      if (fromEmbedded) return fromEmbedded;
    }
  } catch {}

  const fromCachedAudio = buildMediaFallbackFromAudioApps(lastAudioInfoSnapshot && lastAudioInfoSnapshot.apps, error, windowApps);
  if (fromCachedAudio) return fromCachedAudio;

  if ((Date.now() - Number(lastAudioCtlRawUpdatedAt || 0)) <= 15000) {
    const fromEmbeddedCached = buildMediaFallbackFromEmbeddedSession(lastAudioCtlRawSnapshot, mediaModeUrl, error);
    if (fromEmbeddedCached) return fromEmbeddedCached;
  }

  const fromWindows = buildMediaFallbackFromWindowApps(windowApps, error);
  if (fromWindows) return fromWindows;

  return unavailableMediaFallback(error);
}

async function getMediaInfoPrimary() {
  const fromAudioCtl = await runAudioCtlJson(['media-info'], 9000);
  if (fromAudioCtl && fromAudioCtl.ok && fromAudioCtl.data) {
    const data = fromAudioCtl.data;
    const status = String(data && data.playbackStatus || '').toLowerCase();
    if (!(status === 'unavailable' && data && data.error)) {
      return data;
    }
    throw new Error(String(data.error || 'AudioCtl media unavailable'));
  }

  if (!fromAudioCtl.available) throw new Error('AudioCtl unavailable');
  throw new Error('AudioCtl media unavailable');
}

function applyOptimisticMediaPlayPauseStatus() {
  const current = mediaCache.data;
  if (!current || !current.active) return false;

  const now = Date.now();
  const duration = Math.max(0, Number(current.duration) || 0);
  const key = mediaItemKey(current);
  const currentStatus = String(current.playbackStatus || mediaTimelineState.status || 'Paused');
  const nextStatus = currentStatus === 'Playing' ? 'Paused' : 'Playing';
  const projectedPosition = (key && key === mediaTimelineState.key)
    ? getMediaTimelineStatePosition(now)
    : clampMediaPosition(current.position, duration);
  const position = clampMediaPosition(projectedPosition, duration);
  const updated = {
    ...current,
    duration,
    position,
    playbackStatus: nextStatus,
    timelineAtMs: now,
  };

  mediaCache = { data: updated, updatedAt: now };
  setMediaTimelineState(position, duration, nextStatus, key, now, position);
  mediaPrimaryRetryNotBefore = 0;

  if (sseClients.size > 0 && (now - lastMediaSsePushedAt) >= MEDIA_SSE_PUSH_MIN_INTERVAL_MS) {
    lastMediaSsePushedAt = now;
    broadcastSSE('media', updated);
  }
  return true;
}

async function mediaAction(action, extraArgs = []) {
  const normalizedAction = String(action || '').trim().toLowerCase();
  const mappedAudioCtlAction = AUDIOCTL_MEDIA_ACTION_MAP[normalizedAction];
  const mappedArgs = mappedAudioCtlAction
    ? [mappedAudioCtlAction, ...extraArgs.map(arg => String(arg))]
    : null;

  if (!mappedArgs) throw new Error(`Unsupported media action: ${normalizedAction}`);

  const fromAudioCtl = await runAudioCtlJson(mappedArgs, 7600);
  if (!fromAudioCtl.available) throw new Error('AudioCtl unavailable');
  if (!fromAudioCtl.ok || !fromAudioCtl.data) throw new Error('AudioCtl media action unavailable');

  const actionResult = fromAudioCtl.data;
  const actionOk = !(actionResult && typeof actionResult === 'object' && actionResult.ok === false);
  if (actionOk) {
    if (normalizedAction === 'playpause') {
      if (!applyOptimisticMediaPlayPauseStatus()) mediaCache.updatedAt = 0;
    } else {
      mediaCache.updatedAt = 0;
    }
  }
  return actionResult;
}

function parseCsvLine(line) {
  const fields = [];
  let cur = '', inQuote = false;
  for (const ch of line) {
    if (ch === '"') { inQuote = !inQuote; }
    else if (ch === ',' && !inQuote) { fields.push(cur); cur = ''; }
    else { cur += ch; }
  }
  fields.push(cur);
  return fields;
}

function buildAudioInfoFromRows(rows) {
  const activeRows = rows.filter(f => f[F.STATE] === 'Active');
  const deviceRows = activeRows.filter(f => f[F.TYPE] === 'Device');

  const speakers = deviceRows.filter(f => f[F.DIR] === 'Render');
  const mics = deviceRows.filter(f => f[F.DIR] === 'Capture');
  const appRowsAll = rows.filter(f => f[F.TYPE] === 'Application' && f[F.DIR] === 'Render');

  const defSpk = speakers.find(f => f[F.DEFAULT] === 'Render') || speakers[0];
  const defMic = mics.find(f => f[F.DEFAULT] === 'Capture') || mics[0];

  if (defSpk) cachedSpeakerId = defSpk[F.CLI_ID];
  if (defMic) cachedMicId = defMic[F.CLI_ID];

  const toDevice = (f, isDefault) => ({
    name: f[F.DEVICE_NAME],
    label: f[F.NAME],
    id: f[F.CLI_ID],
    endpointId: String(f[F.ITEM_ID] || '').trim(),
    isDefault,
    volume: parseInt(f[F.VOL_PCT]) || 0,
    muted: f[F.MUTED] === 'Yes',
  });

  const defaultSpeakerDeviceName = defSpk ? String(defSpk[F.DEVICE_NAME] || '').trim() : '';
  const defaultSpeakerPrefix = defaultSpeakerDeviceName ? `${defaultSpeakerDeviceName}\\Application\\` : '';

  const appMap = new Map();
  appRowsAll.forEach(f => {
    const id = String(f[F.CLI_ID] || f[F.NAME] || '').trim();
    if (!id) return;

    const rawName = String(f[F.NAME] || '').trim();
    const windowTitle = String(f[F.WINDOW_TITLE] || '').trim();
    const baseProcess = path.win32.basename(rawName).toLowerCase();
    const combined = `${rawName} ${windowTitle}`.toLowerCase();
    if (!rawName && !windowTitle) return;
    if (/audiodg|svchost/.test(combined)) return;
    if (/^(?:audiodg|svchost(?:\.exe)?|sihost(?:\.exe)?)$/.test(baseProcess)) return;
    if (/^qtwebengineprocess(?:\.exe)?$/.test(baseProcess)) return;
    const appKey = normalizeMixerAppKey(rawName || id);
    if (!appKey) return;

    const state = String(f[F.STATE] || '');
    const volume = Math.max(0, Math.min(100, parseInt(f[F.VOL_PCT], 10) || 0));
    const muted = String(f[F.MUTED] || '').toLowerCase() === 'yes';
    const onDefaultDevice = defaultSpeakerPrefix && id.startsWith(defaultSpeakerPrefix);
    const score =
      (state === 'Active' ? 100 : 0)
      + (onDefaultDevice ? 30 : 0)
      + (muted ? 0 : 5)
      + (volume / 100);

    const appItem = {
      id,
      name: displayMixerAppName(rawName, windowTitle),
      label: rawName || displayMixerAppName(rawName, windowTitle),
      title: sanitizeMixerWindowTitle(windowTitle),
      volume,
      muted,
      state,
      score,
    };
    applyAppAudioOverride(appItem);

    const existing = appMap.get(appKey);
    if (!existing || appItem.score > existing.score) appMap.set(appKey, appItem);
  });

  const apps = Array.from(appMap.values()).map(item => {
    const copy = { ...item };
    delete copy.score;
    return copy;
  }).sort((left, right) => {
    const leftActive = left.state === 'Active';
    const rightActive = right.state === 'Active';
    if (leftActive !== rightActive) return leftActive ? -1 : 1;
    if (left.muted !== right.muted) return left.muted ? 1 : -1;
    return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
  });

  return {
    speaker: defSpk ? applyDeviceAudioOverride(toDevice(defSpk, true), speakerAudioOverride) : null,
    mic: defMic ? applyDeviceAudioOverride(toDevice(defMic, true), micAudioOverride) : null,
    speakers: speakers.map(f => toDevice(f, f === defSpk)),
    mics: mics.map(f => toDevice(f, f === defMic)),
    apps,
  };
}

function normalizeAudioCtlSessionId(rawId, rawLabel, rawName, isSystem = false) {
  if (isSystem) return 'System Sounds';
  const source = [rawId, rawLabel, rawName].map(v => String(v || '').trim()).find(Boolean) || '';
  if (!source) return '';
  if (/system sounds|audiosrv\.dll/i.test(source)) return 'System Sounds';

  let token = source;
  const appIdx = token.toLowerCase().indexOf('\\application\\');
  if (appIdx >= 0) token = token.slice(appIdx + '\\Application\\'.length);
  token = path.win32.basename(token.replace(/\//g, '\\')).trim();
  if (!token) return '';

  const exeMatch = token.match(/[a-z0-9_.-]+\.exe/i);
  if (exeMatch) token = exeMatch[0];
  else if (/^[a-z0-9_. -]+$/i.test(token)) token = `${token}.exe`;

  token = token.trim();
  if (!token || /[\r\n]/.test(token)) return '';
  return token.slice(0, 160);
}

function buildAudioInfoFromAudioCtlSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const rawSpeakers = Array.isArray(snapshot.speakers) ? snapshot.speakers : [];
  const rawMics = Array.isArray(snapshot.mics) ? snapshot.mics : [];
  const rawApps = Array.isArray(snapshot.apps) ? snapshot.apps : [];
  if (!rawSpeakers.length && !rawMics.length) return null;

  const defaultSpeakerEndpointId = String((snapshot.speaker && (snapshot.speaker.endpointId || snapshot.speaker.id)) || '').trim();
  const defaultMicEndpointId = String((snapshot.mic && (snapshot.mic.endpointId || snapshot.mic.id)) || '').trim();

  const toDevice = (entry, defaultEndpointId) => {
    const endpointId = String((entry && (entry.endpointId || entry.id)) || '').trim();
    const id = String((entry && (entry.id || entry.endpointId)) || endpointId).trim();
    const name = String((entry && (entry.name || entry.label)) || '').trim();
    const label = String((entry && (entry.label || entry.name)) || '').trim();
    return {
      name: name || label || endpointId || id,
      label: label || name || endpointId || id,
      id: id || endpointId,
      endpointId,
      isDefault: !!(entry && entry.isDefault) || (!!defaultEndpointId && endpointId === defaultEndpointId),
      volume: Math.max(0, Math.min(100, parseInt(entry && entry.volume, 10) || 0)),
      muted: !!(entry && entry.muted),
    };
  };

  const speakers = rawSpeakers.map(entry => toDevice(entry, defaultSpeakerEndpointId)).filter(item => item.id || item.endpointId);
  const mics = rawMics.map(entry => toDevice(entry, defaultMicEndpointId)).filter(item => item.id || item.endpointId);
  const defSpk = speakers.find(item => item.isDefault) || speakers[0] || null;
  const defMic = mics.find(item => item.isDefault) || mics[0] || null;

  if (defSpk) cachedSpeakerId = defSpk.id || defSpk.endpointId;
  if (defMic) cachedMicId = defMic.id || defMic.endpointId;

  const appMap = new Map();
  rawApps.forEach(entry => {
    const rawId = String(entry && entry.id || '').trim();
    const defaultRawLabel = String(entry && (entry.label || entry.name || rawId) || '').trim();
    const defaultRawName = String(entry && (entry.name || defaultRawLabel || rawId) || '').trim();
    const looksLikeSystem = /system sounds|audiosrv\.dll/i.test(`${rawId} ${defaultRawLabel} ${defaultRawName}`);
    const isSystem = !!(entry && entry.isSystem) || looksLikeSystem;
    const rawLabel = isSystem ? 'System Sounds' : defaultRawLabel;
    const rawName = isSystem ? 'System Sounds' : defaultRawName;
    const windowTitle = sanitizeMixerWindowTitle(entry && entry.title || '');
    const id = normalizeAudioCtlSessionId(rawId, rawLabel, rawName, isSystem);
    if (!id) return;

    const baseProcess = path.win32.basename(rawLabel || rawName || id).toLowerCase();
    const combined = `${rawLabel} ${windowTitle}`.toLowerCase();
    if (/audiodg|svchost/.test(combined) && !/system sounds/.test(combined)) return;
    if (/^(?:audiodg|svchost(?:\.exe)?|sihost(?:\.exe)?)$/.test(baseProcess)) return;
    if (/^qtwebengineprocess(?:\.exe)?$/.test(baseProcess)) return;

    const appKey = buildAudioCtlMixerAppKey(rawLabel, rawName, id, windowTitle);
    if (!appKey) return;

    const state = String(entry && entry.state || '');
    const volume = Math.max(0, Math.min(100, parseInt(entry && entry.volume, 10) || 0));
    const muted = !!(entry && entry.muted);
    const score = (state === 'Active' ? 100 : 0) + (muted ? 0 : 5) + (volume / 100);

    const appItem = {
      id,
      name: displayMixerAppName(rawLabel || rawName || id, windowTitle),
      label: rawLabel || rawName || id,
      title: windowTitle,
      processId: Number.isFinite(Number(entry && entry.processId)) ? Number(entry.processId) : 0,
      volume,
      muted,
      state,
      score,
    };
    applyAppAudioOverride(appItem);

    const existing = appMap.get(appKey);
    if (!existing || appItem.score > existing.score) appMap.set(appKey, appItem);
  });

  const apps = Array.from(appMap.values()).map(item => {
    const copy = { ...item };
    delete copy.score;
    return copy;
  }).sort((left, right) => {
    const leftActive = left.state === 'Active';
    const rightActive = right.state === 'Active';
    if (leftActive !== rightActive) return leftActive ? -1 : 1;
    if (left.muted !== right.muted) return left.muted ? 1 : -1;
    return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
  });

  return {
    speaker: defSpk ? applyDeviceAudioOverride({ ...defSpk }, speakerAudioOverride) : null,
    mic: defMic ? applyDeviceAudioOverride({ ...defMic }, micAudioOverride) : null,
    speakers,
    mics,
    apps,
  };
}

function getAudioInfoFromSoundVolumeView() {
  return readSoundVolumeRows().then(rows => buildAudioInfoFromRows(rows));
}

async function getAudioInfoFromAudioCtl() {
  const result = await runAudioCtlJson(['snapshot'], 3200);
  if (!result.ok || !result.data) return null;
  try {
    lastAudioCtlRawSnapshot = result.data;
    lastAudioCtlRawUpdatedAt = Date.now();
    const transformed = buildAudioInfoFromAudioCtlSnapshot(result.data);
    if (transformed) {
      lastAudioInfoSnapshot = transformed;
      lastAudioInfoUpdatedAt = Date.now();
    }
    return transformed;
  } catch (error) {
    console.warn('[AudioCtl] Snapshot transform failed:', error && error.message ? error.message : error);
    return null;
  }
}

async function getAudioInfo() {
  const fast = await getAudioInfoFromAudioCtl();
  if (fast) return fast;
  if (!areFallbacksEnabled()) {
    throw new Error('AudioCtl unavailable and fallbacks are disabled');
  }
  if (lastAudioInfoSnapshot) {
    return { ...lastAudioInfoSnapshot, stale: true, staleMs: Math.max(0, Date.now() - lastAudioInfoUpdatedAt) };
  }
  const legacy = await getAudioInfoFromSoundVolumeView();
  if (legacy) {
    lastAudioInfoSnapshot = legacy;
    lastAudioInfoUpdatedAt = Date.now();
  }
  return legacy;
}

function normalizeAudioActivitySnapshot(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const speaker = Math.max(0, Math.min(100, Math.round(Number(source.speaker) || 0)));
  const appsRaw = Array.isArray(source.apps) ? source.apps : [];
  let apps = appsRaw.map(item => {
    const id = sanitizeAudioSessionId(item && item.id);
    const processId = Number.isFinite(Number(item && item.processId)) ? Number(item.processId) : 0;
    if (!id && processId <= 0) return null;
    const activity = Math.max(0, Math.min(100, Math.round(Number(item && item.activity) || 0)));
    return { id, processId, activity };
  }).filter(Boolean);
  // Session meters can occasionally report stale non-zero values while playback is
  // paused/stopped. If endpoint activity is effectively silent, force per-app to zero.
  if (speaker <= AUDIO_ACTIVITY_SILENCE_FLOOR && apps.length) {
    apps = apps.map(item => ({ ...item, activity: 0 }));
  }
  return { speaker, apps };
}

function fallbackAudioActivitySnapshot() {
  const lastApps = lastAudioInfoSnapshot && Array.isArray(lastAudioInfoSnapshot.apps)
    ? lastAudioInfoSnapshot.apps
    : [];
  const apps = lastApps.map(item => {
    const id = sanitizeAudioSessionId(item && item.id);
    const processId = Number.isFinite(Number(item && item.processId)) ? Number(item.processId) : 0;
    return (id || processId > 0) ? { id, processId, activity: 0 } : null;
  }).filter(Boolean);
  return { speaker: 0, apps };
}

function resolveAudioActivityStreamWaiters(hasSample) {
  if (!audioActivityStreamWaiters.size) return;
  const waiters = Array.from(audioActivityStreamWaiters.values());
  audioActivityStreamWaiters.clear();
  waiters.forEach(resolve => {
    try { resolve(!!hasSample); } catch {}
  });
}

function updateAudioActivityCache(raw) {
  const normalized = normalizeAudioActivitySnapshot(raw);
  audioActivityCache = { ...normalized, updatedAt: Date.now() };
  const now = Date.now();
  if (sseClients.size > 0 && (now - lastAudioActivitySsePushedAt) >= AUDIO_ACTIVITY_SSE_PUSH_MIN_INTERVAL_MS) {
    lastAudioActivitySsePushedAt = now;
    broadcastSSE('audio-activity', serializeAudioActivitySnapshot(audioActivityCache, 1));
  }
  resolveAudioActivityStreamWaiters(true);
}

function processAudioActivityStreamChunk(chunk) {
  if (!chunk) return;
  audioActivityStreamBuffer += String(chunk);
  if (audioActivityStreamBuffer.length > AUDIO_ACTIVITY_STREAM_MAX_BUFFER_CHARS) {
    audioActivityStreamBuffer = audioActivityStreamBuffer.slice(-AUDIO_ACTIVITY_STREAM_MAX_BUFFER_CHARS);
  }

  while (true) {
    const newlineIndex = audioActivityStreamBuffer.indexOf('\n');
    if (newlineIndex < 0) break;
    const line = audioActivityStreamBuffer.slice(0, newlineIndex).trim();
    audioActivityStreamBuffer = audioActivityStreamBuffer.slice(newlineIndex + 1);
    if (!line) continue;
    try {
      updateAudioActivityCache(JSON.parse(line));
    } catch {
      // Ignore malformed partial lines and continue.
    }
  }
}

function waitForAudioActivityStreamSample(timeoutMs = AUDIO_ACTIVITY_STREAM_WAIT_MS) {
  const cacheAgeMs = Date.now() - Number(audioActivityCache.updatedAt || 0);
  if (audioActivityCache.updatedAt && cacheAgeMs <= AUDIO_ACTIVITY_CACHE_STALE_MS) {
    return Promise.resolve(true);
  }

  return new Promise(resolve => {
    const waiterId = ++audioActivityStreamWaiterSeq;
    const timer = setTimeout(() => {
      if (!audioActivityStreamWaiters.has(waiterId)) return;
      audioActivityStreamWaiters.delete(waiterId);
      resolve(false);
    }, Math.max(40, Number(timeoutMs) || AUDIO_ACTIVITY_STREAM_WAIT_MS));

    audioActivityStreamWaiters.set(waiterId, hasSample => {
      clearTimeout(timer);
      resolve(!!hasSample);
    });
  });
}

function stopAudioActivityStream() {
  const proc = audioActivityStreamProcess;
  audioActivityStreamProcess = null;
  audioActivityStreamBuffer = '';
  audioActivityStreamStarting = false;
  resolveAudioActivityStreamWaiters(false);
  if (proc && !proc.killed) {
    try { proc.kill(); } catch {}
  }
}

function ensureAudioActivityStreamRunning() {
  if (audioActivityStreamProcess || audioActivityStreamStarting) return;
  if (Date.now() < audioActivityStreamRestartNotBefore) return;
  if (!fs.existsSync(AUDIOCTL_DLL)) return;

  audioActivityStreamStarting = true;
  audioActivityStreamBuffer = '';
  const child = spawn(DOTNET_BIN, [AUDIOCTL_DLL, 'activity-stream', String(AUDIO_ACTIVITY_STREAM_INTERVAL_MS), String(process.pid)], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  audioActivityStreamProcess = child;

  if (child.stdout) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', processAudioActivityStreamChunk);
  }

  if (child.stderr) {
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', () => {});
  }

  child.on('spawn', () => {
    audioActivityStreamStarting = false;
    audioActivityStreamRestartNotBefore = 0;
  });

  child.on('error', () => {
    audioActivityStreamStarting = false;
    audioActivityStreamRestartNotBefore = Date.now() + AUDIO_ACTIVITY_STREAM_RESTART_BACKOFF_MS;
    if (audioActivityStreamProcess === child) {
      audioActivityStreamProcess = null;
    }
  });

  child.on('close', () => {
    if (audioActivityStreamProcess === child) {
      audioActivityStreamProcess = null;
    }
    audioActivityStreamStarting = false;
    audioActivityStreamRestartNotBefore = Date.now() + AUDIO_ACTIVITY_STREAM_RESTART_BACKOFF_MS;
  });
}

async function sampleAudioActivityCache() {
  if (audioActivitySampleInFlight) return false;
  audioActivitySampleInFlight = true;
  try {
    const fast = await runAudioCtlJson(['activity'], 700);
    if (fast.ok && fast.data) {
      updateAudioActivityCache(fast.data);
      return true;
    }
    return false;
  } finally {
    audioActivitySampleInFlight = false;
  }
}

function serializeAudioActivitySnapshot(snapshot, decay = 1) {
  const ratio = Math.max(0, Math.min(1, Number(decay) || 0));
  return {
    speaker: Math.max(0, Math.round((Number(snapshot.speaker) || 0) * ratio)),
    apps: (Array.isArray(snapshot.apps) ? snapshot.apps : []).map(item => ({
      id: String(item.id || ''),
      processId: Number.isFinite(Number(item.processId)) ? Number(item.processId) : 0,
      activity: Math.max(0, Math.round((Number(item.activity) || 0) * ratio)),
    })),
  };
}

async function getAudioActivityInfo() {
  lastAudioActivityRequestAt = Date.now();
  ensureAudioActivityStreamRunning();

  const ageMs = Date.now() - Number(audioActivityCache.updatedAt || 0);
  if (audioActivityCache.updatedAt && ageMs <= AUDIO_ACTIVITY_CACHE_FRESH_MS) {
    return serializeAudioActivitySnapshot(audioActivityCache, 1);
  }

  if (audioActivityCache.updatedAt && ageMs < AUDIO_ACTIVITY_CACHE_STALE_MS) {
    waitForAudioActivityStreamSample(AUDIO_ACTIVITY_STREAM_WAIT_MS).catch(() => {});
    return serializeAudioActivitySnapshot(audioActivityCache, 1);
  }

  const streamed = await waitForAudioActivityStreamSample(AUDIO_ACTIVITY_STREAM_WAIT_MS);
  if (!streamed) await sampleAudioActivityCache();

  const refreshedAgeMs = Date.now() - Number(audioActivityCache.updatedAt || 0);
  if (audioActivityCache.updatedAt && refreshedAgeMs < AUDIO_ACTIVITY_CACHE_STALE_MS) {
    return serializeAudioActivitySnapshot(audioActivityCache, 1);
  }

  return fallbackAudioActivitySnapshot();
}

function setMicMute(mute) {
  setMicAudioOverride({ muted: !!mute });
  runAudioCtl(['set-capture-mute', mute ? '1' : '0'], 1800).then(result => {
    if (result && result.ok) return;
    if (!areFallbacksEnabled()) return;
    const action = mute ? '/Mute' : '/Unmute';
    execFile(SVV, [action, 'DefaultCaptureDevice'], err => { if (err) console.error(err.message); });
  }).catch(() => {});
}

function readBody(req) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end',  () => resolve(body));
  });
}

function sanitizeAudioSessionId(value) {
  const safe = String(value || '').trim().slice(0, 512);
  if (!safe) return '';
  if (/[\r\n]/.test(safe)) return '';
  return safe;
}

async function resolveSvvAppTarget(target) {
  const safeTarget = sanitizeAudioSessionId(target);
  if (!safeTarget) return '';
  if (/\\Application\\/i.test(safeTarget)) return safeTarget;
  if (/^System Sounds$/i.test(safeTarget)) return 'System Sounds';

  if (/\.exe$/i.test(safeTarget)) return safeTarget;
  const token = normalizeMixerAppKey(safeTarget);
  if (!token) return safeTarget;
  return `${token}.exe`;
}

function readBodyBuffer(req, maxBytes = BACKGROUND_MAX_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        const err = new Error('Payload too large');
        err.code = 'PAYLOAD_TOO_LARGE';
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseMultipartBackground(req, body) {
  const contentType = req.headers['content-type'] || '';
  const match = contentType.match(/boundary=(?:(?:"([^"]+)")|([^;]+))/i);
  if (!match) throw new Error('Missing multipart boundary');

  const boundaryText = match[1] || match[2];
  const boundary = Buffer.from(`--${boundaryText}`);
  const separator = Buffer.from('\r\n\r\n');
  const nextBoundaryPrefix = Buffer.from(`\r\n--${boundaryText}`);
  let offset = body.indexOf(boundary);

  while (offset !== -1) {
    let partStart = offset + boundary.length;
    if (body[partStart] === 45 && body[partStart + 1] === 45) break;
    if (body[partStart] === 13 && body[partStart + 1] === 10) partStart += 2;

    const headerEnd = body.indexOf(separator, partStart);
    if (headerEnd === -1) break;
    const headers = body.slice(partStart, headerEnd).toString('latin1');
    const dataStart = headerEnd + separator.length;
    const dataEnd = body.indexOf(nextBoundaryPrefix, dataStart);
    if (dataEnd === -1) break;

    const disposition = headers.match(/content-disposition:\s*([^\r\n]+)/i);
    const name = disposition && disposition[1].match(/name="([^"]+)"/i);
    const filename = disposition && disposition[1].match(/filename="([^"]*)"/i);
    if (name && name[1] === 'background' && filename && filename[1]) {
      const typeMatch = headers.match(/content-type:\s*([^\r\n;]+)/i);
      return {
        originalName: path.basename(filename[1]).replace(/[^A-Za-z0-9._ -]/g, '').slice(0, 120) || 'background',
        contentType: typeMatch ? typeMatch[1].trim().toLowerCase() : '',
        data: body.slice(dataStart, dataEnd),
      };
    }
    offset = body.indexOf(boundary, dataEnd);
  }
  throw new Error('Missing background file');
}

function cleanupOldBackgrounds(keepName) {
  fs.promises.readdir(UPLOADS_DIR).then(files => Promise.all(files
    .filter(file => file.startsWith('background-') && file !== keepName)
    .map(file => fs.promises.unlink(path.join(UPLOADS_DIR, file)).catch(() => {}))
  )).catch(() => {});
}

function execFilePromise(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, ...options }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function ensureAudioCtlAvailable() {
  if (audioCtlReady && fs.existsSync(AUDIOCTL_DLL)) return true;
  if (!fs.existsSync(AUDIOCTL_PROJECT)) return false;
  if (audioCtlBuildInFlight) return audioCtlBuildInFlight;
  audioCtlBuildInFlight = execFilePromise(DOTNET_BIN, ['build', AUDIOCTL_PROJECT, '-c', 'Release'], {
    cwd: __dirname,
    timeout: 120000,
    maxBuffer: 2 * 1024 * 1024,
  }).then(() => {
    audioCtlReady = fs.existsSync(AUDIOCTL_DLL);
    if (audioCtlReady) console.log('[AudioCtl] Ready:', AUDIOCTL_DLL);
    return audioCtlReady;
  }).catch(error => {
    audioCtlReady = false;
    console.warn('[AudioCtl] Build failed:', error && error.message ? error.message : error);
    return false;
  }).finally(() => {
    audioCtlBuildInFlight = null;
  });
  return audioCtlBuildInFlight;
}

async function runAudioCtl(args, timeout = 2500) {
  const available = await ensureAudioCtlAvailable();
  if (!available) return { ok: false, available: false, code: null };
  try {
    await execFilePromise(DOTNET_BIN, [AUDIOCTL_DLL, ...args], { timeout, maxBuffer: 512 * 1024 });
    return { ok: true, available: true, code: 0 };
  } catch (error) {
    const code = Number.isFinite(Number(error && error.code)) ? Number(error.code) : null;
    // Code 2 = no matching app session; caller can safely fall back to SoundVolumeView.
    if (code !== 2) {
      console.warn('[AudioCtl] Command failed:', args.join(' '), error && error.message ? error.message : error);
    }
    return { ok: false, available: true, code };
  }
}

async function runAudioCtlJson(args, timeout = 3000) {
  const available = await ensureAudioCtlAvailable();
  if (!available) return { ok: false, available: false, code: null, data: null };
  try {
    const { stdout } = await execFilePromise(DOTNET_BIN, [AUDIOCTL_DLL, ...args], { timeout, maxBuffer: 1024 * 1024 });
    return { ok: true, available: true, code: 0, data: parseJsonOutput(stdout) };
  } catch (error) {
    const code = Number.isFinite(Number(error && error.code)) ? Number(error.code) : null;
    const primaryArg = Array.isArray(args) && args.length ? String(args[0]).toLowerCase() : '';
    const isMediaInfo = primaryArg === 'media-info';
    // media-info can be slow/transient depending on SMTC state; avoid noisy warnings
    // and let upper layers handle fallback.
    if (code !== 2 && !isMediaInfo) {
      console.warn('[AudioCtl] JSON command failed:', args.join(' '), error && error.message ? error.message : error);
    }
    return { ok: false, available: true, code, data: null };
  }
}

function getFfmpegPath() {
  if (process.env.XEH_FFMPEG) return process.env.XEH_FFMPEG;
  const localCandidates = [
    path.join(__dirname, 'ffmpeg.exe'),
    path.join(__dirname, 'ffmpeg', 'bin', 'ffmpeg.exe'),
  ];
  const local = localCandidates.find(candidate => fs.existsSync(candidate));
  if (local) return local;

  if (process.env.LOCALAPPDATA) {
    const wingetPackages = path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages');
    const wingetFfmpeg = findFirstFile(wingetPackages, 'ffmpeg.exe', 5);
    if (wingetFfmpeg) return wingetFfmpeg;
  }

  return 'ffmpeg.exe';
}

function findFirstFile(root, fileName, maxDepth) {
  if (!root || maxDepth < 0 || !fs.existsSync(root)) return null;
  try {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    const direct = entries.find(entry => entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase());
    if (direct) return path.join(root, direct.name);

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const found = findFirstFile(path.join(root, entry.name), fileName, maxDepth - 1);
      if (found) return found;
    }
  } catch {}
  return null;
}

function isFfmpegMissing(error) {
  return error && (error.code === 'ENOENT' || /not recognized|ENOENT|cannot find/i.test(String(error.message || '')));
}

async function transcodeMp4BackgroundToWebm(sourcePath, targetPath) {
  const ffmpeg = getFfmpegPath();
  await execFilePromise(ffmpeg, [
    '-y',
    '-hide_banner',
    '-loglevel', 'error',
    '-i', sourcePath,
    '-vf', 'fps=30,scale=1920:-2',
    '-an',
    '-c:v', 'libvpx',
    '-deadline', 'good',
    '-cpu-used', '4',
    '-b:v', '6M',
    '-maxrate', '8M',
    '-bufsize', '12M',
    '-auto-alt-ref', '0',
    targetPath,
  ], { timeout: BACKGROUND_TRANSCODE_TIMEOUT_MS, maxBuffer: 1024 * 1024 });

  const stat = await fs.promises.stat(targetPath);
  if (!stat.isFile() || stat.size <= 0) throw new Error('Converted WebM is empty');
  return stat;
}

const DASHBOARD_WIDGET_IDS = Object.freeze(['media', 'mic', 'system', 'shortcut', 'tasks']);
const DASHBOARD_TAB_IDS = Object.freeze(['mixer', 'main', 'net']);
const CALENDAR_TAB_IDS = Object.freeze(['calendar', 'tasks']);
const MEDIA_VIEW_IDS = Object.freeze(['media', 'calendar']);
const DASHBOARD_CARD_IDS = Object.freeze({
  main: ['cpu', 'gpu', 'ram', 'disk'],
  net: ['ping', 'fps', 'latency', 'bandwidth'],
  audio: ['volume', 'speaker', 'microphone'],
});
const DASHBOARD_WIDGET_SIZES = Object.freeze(['compact', 'normal', 'wide', 'tall', 'large', 'full']);
const DASHBOARD_CARD_SIZES = Object.freeze(['compact', 'normal', 'wide']);
const DEFAULT_DASHBOARD_LAYOUT = Object.freeze({
  widgets: Object.freeze({
    media: Object.freeze({ order: 0, size: 'tall', visible: true }),
    mic: Object.freeze({ order: 1, size: 'normal', visible: true }),
    system: Object.freeze({ order: 2, size: 'tall', visible: true }),
    shortcut: Object.freeze({ order: 3, size: 'normal', visible: true }),
    tasks: Object.freeze({ order: 4, size: 'normal', visible: false }),
  }),
  cards: Object.freeze({
    main: Object.freeze({
      cpu: Object.freeze({ order: 0, size: 'normal', visible: true }),
      gpu: Object.freeze({ order: 1, size: 'normal', visible: true }),
      ram: Object.freeze({ order: 2, size: 'normal', visible: true }),
      disk: Object.freeze({ order: 3, size: 'normal', visible: true }),
    }),
    net: Object.freeze({
      ping: Object.freeze({ order: 0, size: 'normal', visible: true }),
      fps: Object.freeze({ order: 1, size: 'normal', visible: true }),
      latency: Object.freeze({ order: 2, size: 'normal', visible: true }),
      bandwidth: Object.freeze({ order: 3, size: 'normal', visible: true }),
    }),
    audio: Object.freeze({
      volume: Object.freeze({ order: 0, size: 'wide', visible: true }),
      speaker: Object.freeze({ order: 1, size: 'normal', visible: true }),
      microphone: Object.freeze({ order: 2, size: 'normal', visible: true }),
    }),
  }),
  tabs: Object.freeze({ order: ['mixer', 'main', 'net'], active: 'mixer' }),
  calendarTabs: Object.freeze({ order: ['calendar', 'tasks'], active: 'calendar' }),
  mediaView: Object.freeze({ active: 'media' }),
});

const DEFAULT_HUB_SETTINGS = Object.freeze({
  accent: '#1ed760',
  background: '#070808',
  text: '#f0f3f1',
  panelAlpha: 0.94,
  bgDim: 0.48,
  bgBlur: 0,
  backgroundMedia: null,
  lockWidgets: Object.freeze({ clock: true, weather: true, media: true, calendar: true }),
  weather: Object.freeze({ mode: 'auto', city: '' }),
  news: Object.freeze({
    feedUrl: NEWS_DEFAULT_FEED_URL,
    refreshMinutes: NEWS_DEFAULT_REFRESH_MINUTES,
    maxResults: NEWS_DEFAULT_RESULTS,
  }),
  calendarSync: Object.freeze({
    feedUrl: '',
    refreshMinutes: CALENDAR_SYNC_DEFAULT_REFRESH_MINUTES,
  }),
  mediaMode: Object.freeze({ url: '' }),
  quickOutputSwitch: Object.freeze({ deviceAId: '', deviceBId: '' }),
  quickShortcut: Object.freeze({ keys: '' }),
  dashboardLayout: DEFAULT_DASHBOARD_LAYOUT,
});

function clampNumber(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, numeric));
}

function normalizeHex(value, fallback) {
  const raw = String(value || '').trim();
  const short = raw.match(/^#?([0-9a-f]{3})$/i);
  if (short) return '#' + short[1].split('').map(ch => ch + ch).join('').toLowerCase();
  const full = raw.match(/^#?([0-9a-f]{6})$/i);
  return full ? '#' + full[1].toLowerCase() : fallback;
}

function sanitizeSettingsBackgroundMedia(value) {
  if (!value || typeof value !== 'object') return null;
  const url = String(value.url || '').trim();
  const name = String(value.name || '').trim().slice(0, 120);
  const type = String(value.type || '').trim().slice(0, 60);
  const version = String(value.version || '').trim().replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40);
  if (!url.startsWith('/uploads/')) return null;
  if (!/^\/uploads\/[A-Za-z0-9._-]+$/.test(url)) return null;
  if (!/^(image|video)\//.test(type)) return null;
  return { url, name: name || url.split('/').pop(), type, version };
}

function normalizeLockWidgets(value) {
  const source = value && typeof value === 'object' ? value : {};
  const defaults = DEFAULT_HUB_SETTINGS.lockWidgets;
  return {
    clock: source.clock !== undefined ? !!source.clock : defaults.clock,
    weather: source.weather !== undefined ? !!source.weather : defaults.weather,
    media: source.media !== undefined ? !!source.media : defaults.media,
    calendar: source.calendar !== undefined ? !!source.calendar : defaults.calendar,
  };
}

function normalizeSettingsWeather(value) {
  const source = value && typeof value === 'object' ? value : {};
  const mode = source.mode === 'manual' ? 'manual' : DEFAULT_HUB_SETTINGS.weather.mode;
  return {
    mode,
    city: sanitizeWeatherCity(source.city),
  };
}

function sanitizeNewsFeedUrl(value) {
  const raw = String(value || '').trim().slice(0, 2048);
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (!/^https?:$/.test(parsed.protocol)) return '';
    return parsed.toString();
  } catch {
    return '';
  }
}

function normalizeSettingsNews(value) {
  const source = value && typeof value === 'object' ? value : {};
  const feedUrl = sanitizeNewsFeedUrl(source.feedUrl) || NEWS_DEFAULT_FEED_URL;
  const refreshMinutesRaw = Number(source.refreshMinutes);
  const refreshMinutes = Number.isFinite(refreshMinutesRaw)
    ? Math.max(NEWS_MIN_REFRESH_MINUTES, Math.min(NEWS_MAX_REFRESH_MINUTES, Math.round(refreshMinutesRaw)))
    : NEWS_DEFAULT_REFRESH_MINUTES;
  const maxResultsRaw = Number(source.maxResults);
  const maxResults = Number.isFinite(maxResultsRaw)
    ? Math.max(NEWS_MIN_RESULTS, Math.min(NEWS_MAX_RESULTS, Math.round(maxResultsRaw)))
    : NEWS_DEFAULT_RESULTS;
  return { feedUrl, refreshMinutes, maxResults };
}

function sanitizeCalendarSyncFeedUrl(value) {
  const raw = String(value || '').trim().slice(0, 2048);
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (!/^https?:$/.test(parsed.protocol)) return '';
    return parsed.toString();
  } catch {
    return '';
  }
}

function normalizeSettingsCalendarSync(value) {
  const source = value && typeof value === 'object' ? value : {};
  const feedUrl = sanitizeCalendarSyncFeedUrl(source.feedUrl);
  const refreshRaw = Number(source.refreshMinutes);
  const refreshMinutes = Number.isFinite(refreshRaw)
    ? Math.max(CALENDAR_SYNC_MIN_REFRESH_MINUTES, Math.min(CALENDAR_SYNC_MAX_REFRESH_MINUTES, Math.round(refreshRaw)))
    : CALENDAR_SYNC_DEFAULT_REFRESH_MINUTES;
  return { feedUrl, refreshMinutes };
}

function sanitizeMediaModeUrl(value) {
  const raw = String(value || '').trim().slice(0, 2048);
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (!/^https?:$/.test(parsed.protocol)) return '';
    return parsed.toString();
  } catch {
    return '';
  }
}

function normalizeSettingsMediaMode(value) {
  const source = value && typeof value === 'object' ? value : {};
  return { url: sanitizeMediaModeUrl(source.url) };
}

function sanitizeSettingsOutputDeviceId(value) {
  const raw = String(value || '').trim().slice(0, 512);
  if (!raw) return '';
  if (/[\r\n]/.test(raw)) return '';
  return raw;
}

function normalizeSettingsQuickOutputSwitch(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    deviceAId: sanitizeSettingsOutputDeviceId(source.deviceAId),
    deviceBId: sanitizeSettingsOutputDeviceId(source.deviceBId),
  };
}

function sanitizeQuickShortcutKeys(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.length > 64) return '';
  if (!/^[\x20-\x7E]+$/.test(raw)) return '';
  return raw;
}

function normalizeSettingsQuickShortcut(value) {
  const source = value && typeof value === 'object' ? value : {};
  return { keys: sanitizeQuickShortcutKeys(source.keys) };
}

function cloneDashboardLayout(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeDashboardOrder(value, fallback, maxOrder) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric)) return fallback;
  return Math.max(0, Math.min(maxOrder, numeric));
}

function normalizeDashboardSize(value, allowedSizes, fallback) {
  return allowedSizes.includes(value) ? value : fallback;
}

function normalizeDashboardItem(sourceItem, fallbackItem, maxOrder, allowedSizes) {
  const source = sourceItem && typeof sourceItem === 'object' ? sourceItem : {};
  return {
    order: normalizeDashboardOrder(source.order, fallbackItem.order, maxOrder),
    size: normalizeDashboardSize(source.size, allowedSizes, fallbackItem.size),
    visible: source.visible === undefined ? true : source.visible !== false,
  };
}

function sortDashboardIds(collection) {
  return Object.keys(collection).sort((left, right) => {
    const diff = collection[left].order - collection[right].order;
    return diff || left.localeCompare(right);
  });
}

function reindexDashboardCollection(collection) {
  sortDashboardIds(collection).forEach((id, index) => { collection[id].order = index; });
}

function normalizeDashboardTabs(sourceTabs) {
  const source = sourceTabs && typeof sourceTabs === 'object' ? sourceTabs : {};
  const sourceOrder = Array.isArray(source.order) ? source.order : DEFAULT_DASHBOARD_LAYOUT.tabs.order;
  const hasMixerInSource = sourceOrder.includes('mixer');
  const order = sourceOrder.filter(tab => DASHBOARD_TAB_IDS.includes(tab));
  DASHBOARD_TAB_IDS.forEach(tab => { if (!order.includes(tab)) order.push(tab); });
  const activeSource = source.active;
  let active = DASHBOARD_TAB_IDS.includes(activeSource) ? activeSource : DEFAULT_DASHBOARD_LAYOUT.tabs.active;
  if (!hasMixerInSource && (activeSource === undefined || activeSource === 'main' || activeSource === 'net')) {
    active = 'mixer';
  }
  return {
    order,
    active,
  };
}

function normalizeCalendarTabs(source) {
  const src = source && typeof source === 'object' ? source : {};
  const srcOrder = Array.isArray(src.order) ? src.order : DEFAULT_DASHBOARD_LAYOUT.calendarTabs.order;
  const order = srcOrder.filter(tab => CALENDAR_TAB_IDS.includes(tab));
  CALENDAR_TAB_IDS.forEach(tab => { if (!order.includes(tab)) order.push(tab); });
  return {
    order,
    active: CALENDAR_TAB_IDS.includes(src.active) ? src.active : DEFAULT_DASHBOARD_LAYOUT.calendarTabs.active,
  };
}

function normalizeMediaView(source) {
  const src = source && typeof source === 'object' ? source : {};
  return {
    active: MEDIA_VIEW_IDS.includes(src.active) ? src.active : DEFAULT_DASHBOARD_LAYOUT.mediaView.active,
  };
}

function normalizeDashboardLayout(value) {
  const source = value && typeof value === 'object' ? value : {};
  const layout = cloneDashboardLayout(DEFAULT_DASHBOARD_LAYOUT);
  const sourceWidgets = source.widgets && typeof source.widgets === 'object' ? source.widgets : {};

  DASHBOARD_WIDGET_IDS.forEach(widgetId => {
    layout.widgets[widgetId] = normalizeDashboardItem(
      sourceWidgets[widgetId],
      DEFAULT_DASHBOARD_LAYOUT.widgets[widgetId],
      DASHBOARD_WIDGET_IDS.length - 1,
      DASHBOARD_WIDGET_SIZES,
    );
  });

  Object.keys(DASHBOARD_CARD_IDS).forEach(groupId => {
    const sourceCards = source.cards && source.cards[groupId] && typeof source.cards[groupId] === 'object'
      ? source.cards[groupId]
      : {};
    DASHBOARD_CARD_IDS[groupId].forEach(cardId => {
      layout.cards[groupId][cardId] = normalizeDashboardItem(
        sourceCards[cardId],
        DEFAULT_DASHBOARD_LAYOUT.cards[groupId][cardId],
        DASHBOARD_CARD_IDS[groupId].length - 1,
        DASHBOARD_CARD_SIZES,
      );
    });
    reindexDashboardCollection(layout.cards[groupId]);
  });

  reindexDashboardCollection(layout.widgets);
  layout.tabs = normalizeDashboardTabs(source.tabs);
  layout.calendarTabs = normalizeCalendarTabs(source.calendarTabs);
  layout.mediaView = normalizeMediaView(source.mediaView);
  return layout;
}

function normalizeHubSettings(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    accent: normalizeHex(source.accent, DEFAULT_HUB_SETTINGS.accent),
    background: normalizeHex(source.background, DEFAULT_HUB_SETTINGS.background),
    text: normalizeHex(source.text, DEFAULT_HUB_SETTINGS.text),
    panelAlpha: clampNumber(source.panelAlpha, SETTINGS_MIN_PANEL_ALPHA, 1, DEFAULT_HUB_SETTINGS.panelAlpha),
    bgDim: clampNumber(source.bgDim, 0.05, 0.9, DEFAULT_HUB_SETTINGS.bgDim),
    bgBlur: clampNumber(source.bgBlur, 0, 24, DEFAULT_HUB_SETTINGS.bgBlur),
    backgroundMedia: sanitizeSettingsBackgroundMedia(source.backgroundMedia),
    lockWidgets: normalizeLockWidgets(source.lockWidgets),
    weather: normalizeSettingsWeather(source.weather),
    news: normalizeSettingsNews(source.news),
    calendarSync: normalizeSettingsCalendarSync(source.calendarSync),
    mediaMode: normalizeSettingsMediaMode(source.mediaMode),
    quickOutputSwitch: normalizeSettingsQuickOutputSwitch(source.quickOutputSwitch),
    quickShortcut: normalizeSettingsQuickShortcut(source.quickShortcut),
    dashboardLayout: normalizeDashboardLayout(source.dashboardLayout),
  };
}

async function readHubSettings() {
  try {
    const raw = await fs.promises.readFile(SETTINGS_FILE, 'utf8');
    return normalizeHubSettings(JSON.parse(raw));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

async function writeHubSettings(settings) {
  const safe = normalizeHubSettings(settings);
  await fs.promises.writeFile(SETTINGS_FILE, JSON.stringify(safe, null, 2), 'utf8');
  return safe;
}

function normalizeEvents(value) {
  const source = Array.isArray(value) ? value : (Array.isArray(value && value.events) ? value.events : []);
  return source.slice(0, 250).map(item => {
    const title = String(item && item.title || '').trim().slice(0, 120);
    const notes = String(item && item.notes || '').trim().slice(0, 600);
    const startsAt = String(item && item.startsAt || '').trim();
    const reminderAt = String(item && item.reminderAt || '').trim();
    const id = String(item && item.id || `${Date.now()}-${Math.random().toString(16).slice(2)}`).slice(0, 80);
    return {
      id,
      title,
      notes,
      startsAt: Number.isFinite(Date.parse(startsAt)) ? startsAt : '',
      reminderAt: Number.isFinite(Date.parse(reminderAt)) ? reminderAt : '',
      notifiedAt: item && item.notifiedAt ? String(item.notifiedAt).slice(0, 40) : '',
      createdAt: item && item.createdAt ? String(item.createdAt).slice(0, 40) : new Date().toISOString(),
    };
  }).filter(item => item.title || item.startsAt || item.notes);
}

async function readEvents() {
  try {
    const raw = await fs.promises.readFile(EVENTS_FILE, 'utf8');
    return normalizeEvents(JSON.parse(raw));
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

async function writeEvents(events) {
  const safe = normalizeEvents(events);
  await fs.promises.writeFile(EVENTS_FILE, JSON.stringify(safe, null, 2), 'utf8');
  return safe;
}

const TASK_PRIORITIES = Object.freeze(['high', 'medium', 'low']);
const TASK_RECURRENCES = Object.freeze(['never', 'daily', 'weekly', 'custom']);

function normalizeTask(item) {
  const text = String(item && item.text || '').trim().slice(0, 200);
  const id = String(item && item.id || `${Date.now()}-${Math.random().toString(16).slice(2)}`).slice(0, 80);
  const priority = TASK_PRIORITIES.includes(item && item.priority) ? item.priority : 'medium';
  const recurrence = TASK_RECURRENCES.includes(item && item.recurrence) ? item.recurrence : 'never';
  const recurrenceDays = (recurrence === 'custom' && Number.isFinite(Number(item && item.recurrenceDays)) && Number(item.recurrenceDays) >= 1)
    ? Math.round(Number(item.recurrenceDays)) : 1;
  const completed = Boolean(item && item.completed);
  const completedAt = completed && item.completedAt ? String(item.completedAt).slice(0, 40) : null;
  const createdAt = item && item.createdAt ? String(item.createdAt).slice(0, 40) : new Date().toISOString();
  return { id, text, priority, recurrence, recurrenceDays, completed, completedAt, createdAt };
}

function normalizeTasks(value) {
  const source = Array.isArray(value) ? value : [];
  return source.slice(0, TASKS_MAX).map(normalizeTask).filter(t => t.text.length > 0);
}

async function readTasks() {
  try {
    const raw = await fs.promises.readFile(TASKS_FILE, 'utf8');
    return normalizeTasks(JSON.parse(raw));
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

async function writeTasks(tasks) {
  const safe = normalizeTasks(tasks);
  await fs.promises.writeFile(TASKS_FILE, JSON.stringify(safe, null, 2), 'utf8');
  return safe;
}

// ── Server-Sent Events infrastructure ────────────────────────────────────────
// Clients connect to GET /sse and receive named events instead of polling.
// Each event carries the same JSON payload the old poll endpoints returned,
// so the client-side render functions need no changes — only the fetch trigger
// changes from setInterval to EventSource.

const sseClients = new Set();

function broadcastSSE(event, data) {
  if (sseClients.size === 0) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); }
    catch { sseClients.delete(res); }
  }
}

// Security: only accept connections from loopback addresses.
// Double-checked at both the TCP socket level (remoteAddress) and the HTTP Host header
// level, so DNS-rebinding / Host-spoofing attacks from non-loopback IPs are blocked.
const LOOPBACK_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const ALLOWED_HOSTS = new Set([
  '127.0.0.1:3030', 'localhost:3030', '[::1]:3030',
  '127.0.0.1', 'localhost', '[::1]',
]);

function isAllowedRequest(req) {
  // Layer 1: TCP source IP must be loopback (blocks LAN spoofing regardless of Host)
  const remoteAddr = req.socket.remoteAddress || '';
  if (!LOOPBACK_IPS.has(remoteAddr)) return false;

  // Layer 2: Host header must be a loopback address (protects against DNS rebinding)
  const host = (req.headers.host || '').toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) return false;

  // Layer 3: If an Origin header is present, it must also be loopback or opaque.
  // 'null' = opaque origin from Qt WebEngine (file:// or qrc:// page) — allowed.
  const origin = req.headers.origin;
  if (origin && origin !== 'null') {
    try {
      const u = new URL(origin);
      if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost' && u.hostname !== '[::1]') return false;
    } catch { return false; }
  }
  return true;
}

const server = http.createServer(async (req, res) => {
  if (!isAllowedRequest(req)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  // CORS headers required for the iCUE widget WebView (opaque origin, qrc:// or file://).
  // Access-Control-Allow-Private-Network is required by Chrome 104+ (Private Network
  // Access spec) when a non-secure context (file://) fetches a private-network address.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // JSONP support: if ?cb=<name> is present, wrap the response in a JS callback.
  // Used by the iCUE widget where fetch() is blocked by Qt WebEngine's
  // LocalContentCanAccessRemoteUrls policy; <script> tag injection bypasses it.
  const urlObj  = new URL(req.url, 'http://localhost');
  const jsonpCb = urlObj.searchParams.get('cb');
  const json    = data => {
    const body = JSON.stringify(data);
    if (jsonpCb && /^[A-Za-z_$][\w$]*$/.test(jsonpCb)) {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
      res.end(jsonpCb + '(' + body + ');');
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
    }
  };
  const err500 = msg  => { res.writeHead(500); res.end(String(msg)); };

  const reqPath = (() => {
    const pathname = urlObj.pathname || '/';
    if (pathname === '/server') return '/';
    if (pathname.startsWith('/server/')) return pathname.slice('/server'.length) || '/';
    return pathname;
  })();

  if ((reqPath === '/' || reqPath === '/index.html') && req.method === 'GET') {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);

  } else if (reqPath === '/toggle' && (req.method === 'POST' || req.method === 'GET')) {
    isMuted = !isMuted;
    setMicMute(isMuted);
    json({ muted: isMuted });

  } else if (reqPath === '/ping' && req.method === 'GET') {
    // 1×1 transparent GIF — used by the iCUE widget to probe connectivity via
    // Image() instead of fetch(), bypassing Qt WebEngine's LocalContentCanAccessRemoteUrls block.
    const gif = Buffer.from('R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==', 'base64');
    res.writeHead(200, { 'Content-Type': 'image/gif', 'Cache-Control': 'no-store' });
    res.end(gif);

  } else if (reqPath === '/status' && req.method === 'GET') {
    json({ muted: isMuted });

  } else if (reqPath === '/audio' && req.method === 'GET') {
    try {
      json(await getAudioInfo());
    } catch (e) {
      if (e && /fallbacks are disabled/i.test(String(e.message || ''))) {
        sendFallbackDisabled(res, '/audio');
      } else {
        err500(e.message);
      }
    }

  } else if (reqPath === '/audio/activity' && req.method === 'GET') {
    try {
      json(await getAudioActivityInfo());
    } catch {
      json(fallbackAudioActivitySnapshot());
    }

  } else if (reqPath === '/system' && req.method === 'GET') {
    try   { json(await getSystemInfo()); }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/network' && req.method === 'GET') {
    try   { json(await getNetworkInfo()); }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/weather' && req.method === 'GET') {
    try {
      const requestedWeather = urlObj.searchParams.has('mode') || urlObj.searchParams.has('city')
        ? { mode: urlObj.searchParams.get('mode'), city: urlObj.searchParams.get('city') }
        : null;
      json(await getWeather(urlObj.searchParams.get('lang') || 'it', requestedWeather));
    }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/news' && req.method === 'GET') {
    try {
      const forceRefresh = urlObj.searchParams.get('refresh') === '1';
      json(await getNewsHeadlines(forceRefresh));
    }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/media' && req.method === 'GET') {
    try   { json(await getMediaInfo()); }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/media/playpause' && (req.method === 'POST' || req.method === 'GET')) {
    try   { json(await mediaAction('playpause')); }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/media/next' && (req.method === 'POST' || req.method === 'GET')) {
    try   { json(await mediaAction('next')); }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/media/previous' && (req.method === 'POST' || req.method === 'GET')) {
    try   { json(await mediaAction('previous')); }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/media/seek' && (req.method === 'POST' || req.method === 'GET')) {
    try {
      let position;
      if (req.method === 'GET') {
        position = Number(urlObj.searchParams.get('position'));
      } else {
        const body = JSON.parse(await readBody(req));
        position = Number(body && body.position);
      }
      if (!Number.isFinite(position)) {
        res.writeHead(400);
        res.end('Invalid position');
        return;
      }
      const targetSeconds = Math.max(0, Math.round(position));
      const result = await mediaAction('seek', [targetSeconds]);
      if (mediaCache.data) {
        const duration = Math.max(0, Number(mediaCache.data.duration) || 0);
        mediaCache.data.position = duration > 0 ? Math.min(duration, targetSeconds) : targetSeconds;
        mediaCache.data.timelineAtMs = Date.now();
        setMediaTimelineState(
          mediaCache.data.position,
          mediaCache.data.duration || 0,
          String(mediaCache.data.playbackStatus || 'Paused'),
          mediaItemKey(mediaCache.data),
          Date.now(),
          mediaCache.data.position,
        );
      }
      json(result);
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/windows' && req.method === 'GET') {
    try {
      const pids = String(urlObj.searchParams.get('pids') || '')
        .split(',')
        .map(value => parseInt(value, 10))
        .filter(value => Number.isFinite(value) && value > 0)
        .slice(0, 64);
      const iconsOnly = urlObj.searchParams.get('icons') === '1' || pids.length > 0;
      if (iconsOnly) {
        if (!pids.length) {
          json({ icons: [] });
          return;
        }
        json(await runPowerShellScript(WINDOWS_SCRIPT, ['icons', '', pids.join(',')], 12000));
        return;
      }
      json(await runPowerShellScript(WINDOWS_SCRIPT, ['list'], 12000));
    }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/windows/focus' && req.method === 'POST') {
    try {
      const { id } = JSON.parse(await readBody(req));
      if (!id || typeof id !== 'string' || !/^\d{1,24}$/.test(id)) {
        res.writeHead(400); res.end('Invalid window id'); return;
      }
      json(await runPowerShellScript(WINDOWS_SCRIPT, ['focus', id], 5000));
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/volume/set' && (req.method === 'POST' || req.method === 'GET')) {
    try {
      let level;
      if (req.method === 'GET') {
        level = parseInt(urlObj.searchParams.get('level'));
      } else {
        ({ level } = JSON.parse(await readBody(req)));
      }
      const vol = Math.max(0, Math.min(100, parseInt(level)));
      const fast = await runAudioCtl(['set-master', String(vol)], 1800);
      if (fast.ok) {
        setSpeakerAudioOverride({ volume: vol });
        json({ ok: true, level: vol });
        return;
      }
      if (!areFallbacksEnabled()) { sendFallbackDisabled(res, '/volume/set'); return; }
      execFile(SVV, ['/SetVolume', 'DefaultRenderDevice', String(vol)], e => {
        if (e) err500(e.message);
        else {
          setSpeakerAudioOverride({ volume: vol });
          json({ ok: true, level: vol });
        }
      });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/audio/app/volume' && req.method === 'POST') {
    try {
      const { id, level } = JSON.parse(await readBody(req));
      const target = sanitizeAudioSessionId(id);
      if (!target) { res.writeHead(400); res.end('Invalid app id'); return; }
      const vol = Math.max(0, Math.min(100, parseInt(level, 10)));
      const fast = await runAudioCtl(['set-app-volume', target, String(vol)], 2200);
      if (fast.ok) {
        setAppAudioOverride(target, { volume: vol });
        json({ ok: true, id: target, level: vol });
        return;
      }
      if (!areFallbacksEnabled()) { sendFallbackDisabled(res, '/audio/app/volume'); return; }
      const svvTarget = await resolveSvvAppTarget(target);
      if (!svvTarget) { err500('Unable to resolve app id'); return; }
      execFile(SVV, ['/SetVolume', svvTarget, String(vol)], e => {
        if (e) err500(e.message);
        else {
          setAppAudioOverride(target, { volume: vol });
          json({ ok: true, id: target, level: vol });
        }
      });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/audio/app/mute' && req.method === 'POST') {
    try {
      const { id, mute } = JSON.parse(await readBody(req));
      const target = sanitizeAudioSessionId(id);
      if (!target) { res.writeHead(400); res.end('Invalid app id'); return; }
      const fast = await runAudioCtl(['set-app-mute', target, mute ? '1' : '0'], 2200);
      if (fast.ok) {
        setAppAudioOverride(target, { muted: !!mute });
        json({ ok: true, id: target, muted: !!mute });
        return;
      }
      if (!areFallbacksEnabled()) { sendFallbackDisabled(res, '/audio/app/mute'); return; }
      const action = mute ? '/Mute' : '/Unmute';
      const svvTarget = await resolveSvvAppTarget(target);
      if (!svvTarget) { err500('Unable to resolve app id'); return; }
      execFile(SVV, [action, svvTarget], e => {
        if (e) err500(e.message);
        else {
          setAppAudioOverride(target, { muted: !!mute });
          json({ ok: true, id: target, muted: !!mute });
        }
      });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/mic/volume' && (req.method === 'POST' || req.method === 'GET')) {
    try {
      let level;
      if (req.method === 'GET') {
        level = parseInt(urlObj.searchParams.get('level'));
      } else {
        ({ level } = JSON.parse(await readBody(req)));
      }
      const vol = Math.max(0, Math.min(100, parseInt(level)));
      const fast = await runAudioCtl(['set-capture', String(vol)], 1800);
      if (fast.ok) {
        setMicAudioOverride({ volume: vol });
        json({ ok: true, level: vol });
        return;
      }
      if (!areFallbacksEnabled()) { sendFallbackDisabled(res, '/mic/volume'); return; }
      execFile(SVV, ['/SetVolume', 'DefaultCaptureDevice', String(vol)], e => {
        if (e) err500(e.message);
        else {
          setMicAudioOverride({ volume: vol });
          json({ ok: true, level: vol });
        }
      });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/speaker/mute' && (req.method === 'POST' || req.method === 'GET')) {
    try {
      let requestedMute = null;
      if (req.method === 'GET') {
        if (urlObj.searchParams.has('mute')) {
          requestedMute = parseBooleanLike(urlObj.searchParams.get('mute'));
        }
      } else {
        const bodyRaw = await readBody(req);
        if (bodyRaw && bodyRaw.trim()) {
          const parsed = JSON.parse(bodyRaw);
          if (parsed && Object.prototype.hasOwnProperty.call(parsed, 'mute')) {
            requestedMute = parseBooleanLike(parsed.mute);
          }
        }
      }

      if (requestedMute === null) {
        const fastToggle = await runAudioCtl(['toggle-master-mute'], 1800);
        if (fastToggle.ok) { json({ ok: true }); return; }
        if (!areFallbacksEnabled()) { sendFallbackDisabled(res, '/speaker/mute toggle'); return; }
        execFile(SVV, ['/Switch', 'DefaultRenderDevice'], e => {
          if (e) err500(e.message); else json({ ok: true });
        });
        return;
      }

      const mute = !!requestedMute;
      const fastSet = await runAudioCtl(['set-master-mute', mute ? '1' : '0'], 1800);
      if (fastSet.ok) {
        setSpeakerAudioOverride({ muted: mute });
        json({ ok: true, muted: mute });
        return;
      }
      if (!areFallbacksEnabled()) { sendFallbackDisabled(res, '/speaker/mute set'); return; }
      const action = mute ? '/Mute' : '/Unmute';
      execFile(SVV, [action, 'DefaultRenderDevice'], e => {
        if (e) err500(e.message);
        else {
          setSpeakerAudioOverride({ muted: mute });
          json({ ok: true, muted: mute });
        }
      });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/speaker/switch' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      const firstId = sanitizeAudioSessionId(body && body.firstId);
      const secondId = sanitizeAudioSessionId(body && body.secondId);
      const firstEndpointId = sanitizeAudioSessionId(body && body.firstEndpointId);
      const secondEndpointId = sanitizeAudioSessionId(body && body.secondEndpointId);
      if (!firstId || !secondId || firstId === secondId) {
        res.writeHead(400);
        res.end('Invalid switch device ids');
        return;
      }
      if (firstEndpointId && secondEndpointId && firstEndpointId !== secondEndpointId) {
        const fast = await runAudioCtl(['switch-default-render', firstEndpointId, secondEndpointId], 1500);
        if (fast.ok) {
          cachedSpeakerId = null;
          json({ ok: true, fast: true });
          return;
        }
      }
      if (!areFallbacksEnabled()) { sendFallbackDisabled(res, '/speaker/switch'); return; }
      const svvFirst = firstEndpointId || firstId;
      const svvSecond = secondEndpointId || secondId;
      execFile(SVV, ['/SwitchDefault', svvFirst, svvSecond, 'all'], e => {
        if (e) err500(e.message);
        else {
          cachedSpeakerId = null;
          json({ ok: true, fast: false });
        }
      });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/speaker/set' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      const id = sanitizeAudioSessionId(body && body.id);
      const endpointId = sanitizeAudioSessionId(body && body.endpointId);
      if (!id) {
        res.writeHead(400);
        res.end('Invalid device id');
        return;
      }
      if (endpointId) {
        const fast = await runAudioCtl(['set-default-render', endpointId], 1500);
        if (fast.ok) {
          cachedSpeakerId = id;
          json({ ok: true, fast: true });
          return;
        }
      }
      if (!areFallbacksEnabled()) { sendFallbackDisabled(res, '/speaker/set'); return; }
      execFile(SVV, ['/SetDefault', endpointId || id, 'all'], e => {
        if (e) err500(e.message); else { cachedSpeakerId = id; json({ ok: true, fast: false }); }
      });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/mic/set' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      const id = sanitizeAudioSessionId(body && body.id);
      const endpointId = sanitizeAudioSessionId(body && body.endpointId);
      if (!id) {
        res.writeHead(400);
        res.end('Invalid device id');
        return;
      }
      if (endpointId) {
        const fast = await runAudioCtl(['set-default-capture', endpointId], 1500);
        if (fast.ok) {
          cachedMicId = id;
          if (isMuted) setMicMute(true);
          json({ ok: true, fast: true });
          return;
        }
      }
      if (!areFallbacksEnabled()) { sendFallbackDisabled(res, '/mic/set'); return; }
      execFile(SVV, ['/SetDefault', endpointId || id, 'all'], e => {
        if (e) { err500(e.message); return; }
        cachedMicId = id;
        if (isMuted) setMicMute(true);
        json({ ok: true, fast: false });
      });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/notes' && req.method === 'GET' && !urlObj.searchParams.has('save')) {
    fs.promises.readFile(NOTES_FILE, 'utf8')
      .then(notes => json({ notes }))
      .catch(e => {
        if (e.code === 'ENOENT') json({ notes: '' });
        else err500(e.message);
      });

  } else if (reqPath === '/notes' && (req.method === 'POST' || (req.method === 'GET' && urlObj.searchParams.has('save')))) {
    try {
      let notes;
      if (req.method === 'GET') {
        notes = urlObj.searchParams.get('data') || '';
      } else {
        const body = JSON.parse(await readBody(req));
        notes = typeof body.notes === 'string' ? body.notes : (typeof body.text === 'string' ? body.text : '');
      }
      // Cap at 200 KB to prevent disk exhaustion via repeated saves.
      const safe = String(notes).slice(0, 200_000);
      fs.promises.writeFile(NOTES_FILE, safe, 'utf8')
        .then(() => json({ ok: true, savedAt: Date.now() }))
        .catch(e => err500(e.message));
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/settings' && req.method === 'GET') {
    try { json({ settings: await readHubSettings() }); }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/settings' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      const settings = await writeHubSettings(body.settings || body);
      json({ ok: true, settings, savedAt: Date.now() });
    } catch (e) { err500(e.message); }

  } else if ((reqPath === '/fallbacks' || reqPath === '/audio/fallbacks') && req.method === 'GET') {
    json({
      ok: true,
      enabled: areFallbacksEnabled(),
      defaultEnabled: FALLBACKS_DEFAULT_ENABLED,
      source: 'runtime',
      envKey: 'XEH_AUDIO_FALLBACKS',
    });

  } else if ((reqPath === '/fallbacks' || reqPath === '/audio/fallbacks') && req.method === 'POST') {
    try {
      const bodyRaw = await readBody(req);
      const body = bodyRaw && bodyRaw.trim() ? JSON.parse(bodyRaw) : {};
      const enabled = parseBooleanLike(body && body.enabled);
      if (enabled === null) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid enabled flag' }));
        return;
      }
      setFallbacksEnabled(enabled);
      json({
        ok: true,
        enabled: areFallbacksEnabled(),
        defaultEnabled: FALLBACKS_DEFAULT_ENABLED,
        updatedAt: Date.now(),
      });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/calendar/events' && req.method === 'GET') {
    try {
      const forceRefresh = urlObj.searchParams.get('refresh') === '1';
      json(await getMergedCalendarEvents(forceRefresh));
    }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/events' && req.method === 'GET' && !urlObj.searchParams.has('save')) {
    try { json({ events: await readEvents() }); }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/events' && (req.method === 'POST' || (req.method === 'GET' && urlObj.searchParams.has('save')))) {
    try {
      let body;
      if (req.method === 'GET') {
        body = JSON.parse(urlObj.searchParams.get('data') || '[]');
      } else {
        body = JSON.parse(await readBody(req));
      }
      const events = await writeEvents(body.events || body);
      json({ ok: true, events, savedAt: Date.now() });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/tasks' && req.method === 'GET') {
    try { json({ tasks: await readTasks() }); }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/tasks' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      const tasks = await writeTasks(body.tasks || body);
      json({ ok: true, tasks, savedAt: Date.now() });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/lock' && req.method === 'POST') {
    exec('rundll32.exe user32.dll,LockWorkStation', e => {
      if (e) err500(e.message); else json({ ok: true });
    });

  } else if (reqPath === '/shortcut' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      const keys = sanitizeQuickShortcutKeys(body && body.keys);
      if (!keys) { res.writeHead(400); res.end('Invalid shortcut keys'); return; }
      json(await runPowerShellScript(SHORTCUT_SCRIPT, [keys], 5000));
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/background' && req.method === 'POST') {
    try {
      const body = await readBodyBuffer(req, BACKGROUND_MAX_BYTES);
      const file = parseMultipartBackground(req, body);
      const extFromName = path.extname(file.originalName).toLowerCase();
      const ext = BACKGROUND_MIME_BY_EXT.has(extFromName) ? extFromName : BACKGROUND_EXT_BY_MIME.get(file.contentType);
      if (!ext || !BACKGROUND_MIME_BY_EXT.has(ext)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unsupported file type' }));
        return;
      }
      const expectedType = BACKGROUND_MIME_BY_EXT.get(ext);
      if (file.contentType && file.contentType !== 'application/octet-stream' && file.contentType !== expectedType) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'File type mismatch' }));
        return;
      }
      await fs.promises.mkdir(UPLOADS_DIR, { recursive: true });
      const safeName = `background-${Date.now()}-${Math.random().toString(16).slice(2)}${ext}`;
      const safePath = path.join(UPLOADS_DIR, safeName);
      await fs.promises.writeFile(safePath, file.data);

      let response = { ok: true, url: `/uploads/${safeName}`, name: file.originalName, type: expectedType, size: file.data.length, conversion: 'not-needed' };
      if (expectedType === 'video/mp4') {
        const webmName = safeName.replace(/\.mp4$/i, '.webm');
        const webmPath = path.join(UPLOADS_DIR, webmName);
        try {
          const webmStat = await transcodeMp4BackgroundToWebm(safePath, webmPath);
          await fs.promises.unlink(safePath).catch(() => {});
          response = {
            ok: true,
            url: `/uploads/${webmName}`,
            name: `${path.basename(file.originalName, path.extname(file.originalName))}.webm`,
            type: 'video/webm',
            size: webmStat.size,
            originalName: file.originalName,
            originalType: expectedType,
            converted: true,
            conversion: 'webm-vp8',
          };
          cleanupOldBackgrounds(webmName);
        } catch (conversionError) {
          await fs.promises.unlink(webmPath).catch(() => {});
          response = {
            ...response,
            conversion: isFfmpegMissing(conversionError) ? 'ffmpeg-missing' : 'failed',
          };
          console.warn(`Background MP4 conversion skipped: ${conversionError.message}`);
          cleanupOldBackgrounds(safeName);
        }
      } else {
        cleanupOldBackgrounds(safeName);
      }

      json(response);
    } catch (e) {
      if (e.code === 'PAYLOAD_TOO_LARGE') {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Payload too large' }));
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    }

  } else if (req.method === 'GET' && reqPath.startsWith('/uploads/')) {
    try {
      const name = decodeURIComponent(reqPath.slice('/uploads/'.length));
      if (!/^[A-Za-z0-9._-]+$/.test(name)) { res.writeHead(403); res.end('Forbidden'); return; }
      const abs = path.join(UPLOADS_DIR, name);
      const ext = path.extname(name).toLowerCase();
      const mime = BACKGROUND_MIME_BY_EXT.get(ext);
      if (!mime) { res.writeHead(404); res.end(); return; }
      const stat = await fs.promises.stat(abs);
      if (!stat.isFile()) { res.writeHead(404); res.end(); return; }

      const baseHeaders = {
        'Content-Type': mime,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=31536000, immutable',
      };
      const range = req.headers.range;

      if (range) {
        const match = String(range).match(/^bytes=(\d*)-(\d*)$/);
        if (!match) {
          res.writeHead(416, { ...baseHeaders, 'Content-Range': `bytes */${stat.size}` });
          res.end();
          return;
        }

        const suffixLength = match[1] === '' ? Number(match[2]) : null;
        const start = suffixLength !== null ? Math.max(0, stat.size - suffixLength) : Number(match[1]);
        const end = match[2] === '' || suffixLength !== null ? stat.size - 1 : Number(match[2]);

        if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start < 0 || end >= stat.size) {
          res.writeHead(416, { ...baseHeaders, 'Content-Range': `bytes */${stat.size}` });
          res.end();
          return;
        }

        res.writeHead(206, {
          ...baseHeaders,
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Content-Length': String(end - start + 1),
        });
        fs.createReadStream(abs, { start, end }).pipe(res);
        return;
      }

      res.writeHead(200, { ...baseHeaders, 'Content-Length': String(stat.size) });
      fs.createReadStream(abs).pipe(res);
    } catch (e) {
      if (e.code === 'ENOENT') { res.writeHead(404); res.end(); }
      else err500(e.message);
    }

  } else if (req.method === 'GET' && /^\/(styles|components|js)(\/|$)/.test(reqPath)) {
    // Static asset handler for refactored CSS/JS files.
    // Normalise to an absolute path and reject any traversal outside __dirname.
    const rel = reqPath.replace(/^\//, '');
    const abs = path.normalize(path.join(__dirname, rel));
    if (!abs.startsWith(path.join(__dirname, path.sep)) && abs !== __dirname) {
      res.writeHead(403); res.end('Forbidden'); return;
    }
    const ext = path.extname(abs).toLowerCase();
    const mime = ext === '.css' ? 'text/css; charset=utf-8'
               : ext === '.js'  ? 'text/javascript; charset=utf-8'
               : 'application/octet-stream';
    fs.promises.readFile(abs)
      .then(data => { res.writeHead(200, { 'Content-Type': mime }); res.end(data); })
      .catch(e => { if (e.code === 'ENOENT') { res.writeHead(404); res.end(); } else err500(e.message); });

  } else if (reqPath === '/sse' && req.method === 'GET') {
    // Server-Sent Events stream — replaces client-side polling for status, media,
    // system and audio data. Keepalive pings prevent proxy connection timeouts.
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(':connected\n\n');

    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));

    // Push current state immediately so the client doesn't wait for the first tick.
    Promise.all([
      getSystemInfo().catch(() => null),
      getMediaInfo(true).catch(() => null),
      getAudioInfo().catch(() => null),
      getAudioActivityInfo().catch(() => null),
    ]).then(([sys, media, audio, audioActivity]) => {
      const now = `event: status\ndata: ${JSON.stringify({ muted: isMuted })}\n\n`;
      if (sys)   res.write(`event: system\ndata: ${JSON.stringify(sys)}\n\n`);
      if (media) res.write(`event: media\ndata: ${JSON.stringify(media)}\n\n`);
      if (audio) res.write(`event: audio\ndata: ${JSON.stringify(audio)}\n\n`);
      if (audioActivity) res.write(`event: audio-activity\ndata: ${JSON.stringify(audioActivity)}\n\n`);
      res.write(now);
    }).catch(() => {});

  } else {
    res.writeHead(404); res.end();
  }
});

function _startListen(host) {
  server.listen(3030, host, () => {
    console.log('Widget server running on http://' + host + ':3030');
    getAudioInfo().then(info => {
      if (info && info.mic && typeof info.mic.muted === 'boolean') isMuted = info.mic.muted;
      console.log('Speaker cache:', cachedSpeakerId);
      console.log('Mic cache:   ', cachedMicId);
      console.log('Mic muted:   ', isMuted);
      console.log('Fallbacks:   ', areFallbacksEnabled() ? 'enabled' : 'disabled');
    }).catch(e => console.error('Audio init failed:', e.message));
  });
}

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error('Porta 3030 già in uso. Chiudi l\'altro processo node prima di riavviare.');
    process.exit(1);
  } else if ((err.code === 'EAFNOSUPPORT' || err.code === 'EADDRNOTAVAIL') && server.listening === false) {
    // IPv6 not available on this system — fall back to IPv4 loopback
    console.warn('IPv6 non disponibile, fallback a 127.0.0.1');
    _startListen('127.0.0.1');
  } else {
    throw err;
  }
});

let shutdownRequested = false;
function shutdownServer(reason = 'signal', exitCode = 0) {
  if (shutdownRequested) return;
  shutdownRequested = true;
  try {
    for (const res of sseClients) {
      try { res.end(); } catch {}
    }
    sseClients.clear();
  } catch {}
  try { if (audioActivityStreamProcess) stopAudioActivityStream(); } catch {}
  try { if (mediaStreamProcess) stopMediaStream(); } catch {}
  try {
    server.close(() => process.exit(exitCode));
  } catch {
    process.exit(exitCode);
    return;
  }
  const failSafe = setTimeout(() => process.exit(exitCode), 500);
  if (typeof failSafe.unref === 'function') failSafe.unref();
}

process.on('SIGINT', () => shutdownServer('SIGINT', 0));
process.on('SIGTERM', () => shutdownServer('SIGTERM', 0));
process.on('SIGBREAK', () => shutdownServer('SIGBREAK', 0));
process.on('SIGHUP', () => shutdownServer('SIGHUP', 0));
process.on('uncaughtException', err => {
  try { console.error('[Server] uncaughtException:', err && err.stack ? err.stack : err); } catch {}
  shutdownServer('uncaughtException', 1);
});
process.on('unhandledRejection', reason => {
  try { console.error('[Server] unhandledRejection:', reason); } catch {}
  shutdownServer('unhandledRejection', 1);
});
process.on('exit', () => {
  try { if (audioActivityStreamProcess) stopAudioActivityStream(); } catch {}
  try { if (mediaStreamProcess) stopMediaStream(); } catch {}
});

// Try IPv6 dual-stack first (accepts both 127.0.0.1 and ::1).
// Falls back to IPv4 via the error handler if IPv6 is unavailable.
_startListen('::');

// ── SSE broadcast timers ──────────────────────────────────────────────────────
// These replace client-side setInterval polling.  Timers only run work when at
// least one SSE client is connected, so they have no cost at idle.

setInterval(() => {
  if (sseClients.size === 0) return;
  broadcastSSE('status', { muted: isMuted });
}, 3000).unref();

setInterval(async () => {
  if (sseClients.size === 0) return;
  try { broadcastSSE('system', await getSystemInfo()); } catch {}
}, 7000).unref();

setInterval(async () => {
  if (sseClients.size === 0) return;
  try { broadcastSSE('audio', await getAudioInfo()); } catch {}
}, AUDIO_SSE_REFRESH_INTERVAL_MS).unref();

// Keep the audio-activity stream alive while requests are active.
// When idle for a while, stop the stream to keep background usage low.
setInterval(() => {
  const hasRecentPullRequests = (Date.now() - lastAudioActivityRequestAt) <= AUDIO_ACTIVITY_KEEPALIVE_MS;
  const isActive = hasRecentPullRequests || sseClients.size > 0;
  if (!isActive) {
    if (audioActivityStreamProcess) stopAudioActivityStream();
    return;
  }

  ensureAudioActivityStreamRunning();
  const ageMs = Date.now() - Number(audioActivityCache.updatedAt || 0);
  if (!audioActivityCache.updatedAt || ageMs > AUDIO_ACTIVITY_CACHE_STALE_MS) {
    sampleAudioActivityCache().catch(() => {});
  }
}, 120).unref();

// Keep the media stream alive while requests are active.
// At idle, stop it to keep background usage low.
setInterval(() => {
  const hasRecentPullRequests = (Date.now() - lastMediaRequestAt) <= MEDIA_STREAM_KEEPALIVE_MS;
  const isActive = hasRecentPullRequests || sseClients.size > 0;
  if (!isActive) {
    if (mediaStreamProcess) stopMediaStream();
    return;
  }

  ensureMediaStreamRunning();
  const ageMs = Date.now() - Number(mediaCache.updatedAt || 0);
  if (!mediaCache.updatedAt || ageMs > MEDIA_STREAM_CACHE_STALE_MS) {
    sampleMediaCache(false).catch(() => {});
  }
}, 120).unref();

// Keepalive ping every 20 s to prevent proxy/load-balancer timeouts.
setInterval(() => {
  if (sseClients.size === 0) return;
  const ping = ':ping\n\n';
  for (const res of sseClients) {
    try { res.write(ping); } catch { sseClients.delete(res); }
  }
}, 20000).unref();
