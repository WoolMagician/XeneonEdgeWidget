'use strict';

const COUNTER_HISTORY_DAYS = 30;
const COUNTER_THRESHOLD_MS = 6 * 60 * 60 * 1000;
const COUNTER_THRESHOLD_STORAGE_KEY = 'counterThresholdNotifiedDate';

let counterSnapshot = null;
let counterRequestInFlight = false;
let counterBusy = false;
let counterTickTimer = null;
let counterLastSyncAt = 0;
let counterLastRenderedDate = toDateInputValue(new Date());

function counterPad2(value) {
  return String(Math.max(0, Math.floor(Number(value) || 0))).padStart(2, '0');
}

function counterToInputValue(value) {
  const ms = Date.parse(String(value || '').trim());
  if (!Number.isFinite(ms)) return '';
  const date = new Date(ms);
  return `${toDateInputValue(date)}T${counterPad2(date.getHours())}:${counterPad2(date.getMinutes())}`;
}

function counterToApiValue(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(raw)) return `${raw}:00`;
  return raw;
}

function formatCounterDurationHm(ms) {
  const safe = Math.max(0, Number(ms) || 0);
  const hours = Math.floor(safe / 3600000);
  const minutes = Math.floor((safe % 3600000) / 60000);
  return `${hours}h ${counterPad2(minutes)}m`;
}

function formatCounterDurationHms(ms) {
  const safe = Math.max(0, Number(ms) || 0);
  const hours = Math.floor(safe / 3600000);
  const minutes = Math.floor((safe % 3600000) / 60000);
  const seconds = Math.floor((safe % 60000) / 1000);
  return `${hours}:${counterPad2(minutes)}:${counterPad2(seconds)}`;
}

function formatCounterDayLabel(dateKey) {
  const ms = Date.parse(`${dateKey}T00:00:00`);
  if (!Number.isFinite(ms)) return dateKey;
  const date = new Date(ms);
  const dayPart = new Intl.DateTimeFormat(t('locale'), { weekday: 'short', day: '2-digit', month: 'short' }).format(date);
  return dayPart.charAt(0).toUpperCase() + dayPart.slice(1);
}

function isCounterOverlayOpen() {
  const overlay = $('counter-overlay');
  return !!(overlay && !overlay.hidden);
}

function closeHourCounterOverlay() {
  const overlay = $('counter-overlay');
  if (overlay) overlay.hidden = true;
}

async function openHourCounterOverlay() {
  const overlay = $('counter-overlay');
  if (overlay) overlay.hidden = false;
  await refreshHourCounter(true);
}

function getCounterBaseTotals() {
  const todayKey = toDateInputValue(new Date());
  const days = Array.isArray(counterSnapshot && counterSnapshot.days) ? counterSnapshot.days : [];
  let windowMs = 0;
  let todayClosedMs = 0;
  days.forEach(day => {
    const sessions = Array.isArray(day && day.sessions) ? day.sessions : [];
    sessions.forEach(session => {
      if (session && session.active) return;
      const duration = Math.max(0, Number(session && session.durationMs) || 0);
      windowMs += duration;
      if (String(day && day.date || '') === todayKey) todayClosedMs += duration;
    });
  });
  return { windowMs, todayClosedMs, todayKey };
}

function getCounterActiveLiveMs(nowMs = Date.now()) {
  if (!counterSnapshot || !counterSnapshot.isRunning || !counterSnapshot.active) return 0;
  const startMs = Date.parse(String(counterSnapshot.active.startAt || '').trim());
  if (!Number.isFinite(startMs)) return 0;
  return Math.max(0, nowMs - startMs);
}

function getCounterLiveTotals(nowMs = Date.now()) {
  const base = getCounterBaseTotals();
  const activeLiveMs = getCounterActiveLiveMs(nowMs);
  const todayStartMs = new Date(`${base.todayKey}T00:00:00`).getTime();
  const activeStartMs = counterSnapshot && counterSnapshot.active ? Date.parse(counterSnapshot.active.startAt) : NaN;
  const todayActiveMs = Number.isFinite(activeStartMs)
    ? Math.max(0, nowMs - Math.max(activeStartMs, todayStartMs))
    : 0;
  return {
    todayMs: base.todayClosedMs + todayActiveMs,
    windowMs: base.windowMs + activeLiveMs,
  };
}

function setCounterButtonsDisabled(disabled) {
  const toggleBtn = $('counter-toggle-btn');
  const historyBtn = $('counter-open-overlay-btn');
  if (toggleBtn) toggleBtn.disabled = !!disabled;
  if (historyBtn) historyBtn.disabled = !!disabled;
}

function renderHourCounter() {
  const tile = $('counter-tile');
  const toggleBtn = $('counter-toggle-btn');
  const playIcon = $('counter-play-icon');
  const stopIcon = $('counter-stop-icon');
  const totalEl = $('counter-today-total');
  const sessionEl = $('counter-session-time');
  const statusEl = $('counter-status');
  if (!tile || !toggleBtn || !playIcon || !stopIcon || !totalEl || !statusEl) return;

  const running = !!(counterSnapshot && counterSnapshot.isRunning);
  const nowMs = Date.now();
  const totals = getCounterLiveTotals(nowMs);
  const sessionMs = getCounterActiveLiveMs(nowMs);
  totalEl.textContent = formatCounterDurationHm(totals.todayMs);
  if (sessionEl) sessionEl.textContent = formatCounterDurationHms(sessionMs);

  tile.classList.toggle('running', running);
  playIcon.style.display = running ? 'none' : '';
  stopIcon.style.display = running ? '' : 'none';
  statusEl.textContent = running ? t('counter_running') : t('counter_idle');

  if (counterBusy) {
    toggleBtn.disabled = true;
  } else {
    toggleBtn.disabled = false;
  }

  const summaryToday = $('counter-summary-today');
  const summaryWindow = $('counter-summary-window');
  const summaryStatus = $('counter-summary-status');
  if (summaryToday) summaryToday.textContent = formatCounterDurationHm(totals.todayMs);
  if (summaryWindow) summaryWindow.textContent = formatCounterDurationHm(totals.windowMs);
  if (summaryStatus) summaryStatus.textContent = running ? t('counter_running') : t('counter_idle');

  const activeDurations = document.querySelectorAll('[data-counter-live-start]');
  activeDurations.forEach(node => {
    const startMs = Number(node && node.dataset ? node.dataset.counterLiveStart : NaN);
    if (!Number.isFinite(startMs)) return;
    const liveMs = Math.max(0, Date.now() - startMs);
    node.textContent = formatCounterDurationHms(liveMs);
  });
}

function renderHourCounterOverlay() {
  if (!isCounterOverlayOpen()) return;
  const daysRoot = $('counter-days-list');
  if (!daysRoot) return;
  const days = Array.isArray(counterSnapshot && counterSnapshot.days) ? counterSnapshot.days : [];
  daysRoot.innerHTML = '';

  if (!days.length) {
    const empty = document.createElement('div');
    empty.className = 'counter-empty';
    empty.textContent = t('counter_empty');
    daysRoot.appendChild(empty);
    renderHourCounter();
    return;
  }

  days.forEach(day => {
    const sessions = Array.isArray(day && day.sessions) ? day.sessions : [];
    const card = document.createElement('section');
    card.className = 'counter-day-card';

    const head = document.createElement('div');
    head.className = 'counter-day-head';

    const label = document.createElement('div');
    label.className = 'counter-day-label';
    label.textContent = formatCounterDayLabel(day.date);
    head.appendChild(label);

    const right = document.createElement('div');
    right.className = 'counter-day-actions';
    const total = document.createElement('div');
    total.className = 'counter-day-total';
    total.textContent = formatCounterDurationHm(day.totalMs);
    right.appendChild(total);

    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'counter-day-reset';
    resetBtn.textContent = t('counter_reset_day');
    resetBtn.onclick = () => resetHourCounterDay(day.date);
    right.appendChild(resetBtn);

    head.appendChild(right);
    card.appendChild(head);

    const list = document.createElement('div');
    list.className = 'counter-session-list';
    if (!sessions.length) {
      const empty = document.createElement('div');
      empty.className = 'counter-empty';
      empty.textContent = t('counter_day_empty');
      list.appendChild(empty);
      card.appendChild(list);
      daysRoot.appendChild(card);
      return;
    }

    sessions.forEach(session => {
      const row = document.createElement('div');
      row.className = `counter-session-row${session.active ? ' active' : ''}`;

      const top = document.createElement('div');
      top.className = 'counter-session-top';
      const duration = document.createElement('div');
      duration.className = 'counter-session-duration';
      if (session.active) {
        duration.dataset.counterLiveStart = String(Date.parse(String(session.startAt || '').trim()));
        duration.textContent = formatCounterDurationHms(getCounterActiveLiveMs(Date.now()));
      } else {
        duration.textContent = formatCounterDurationHm(session.durationMs);
      }
      top.appendChild(duration);

      const tag = document.createElement('div');
      tag.className = 'counter-session-tag';
      tag.textContent = session.active ? t('counter_running') : t('counter_session');
      top.appendChild(tag);
      row.appendChild(top);

      if (session.active) {
        const stopWrap = document.createElement('div');
        stopWrap.className = 'counter-session-fields';
        const stopBtn = document.createElement('button');
        stopBtn.type = 'button';
        stopBtn.className = 'counter-session-btn';
        stopBtn.textContent = t('counter_stop');
        stopBtn.onclick = () => toggleHourCounter();
        stopWrap.appendChild(stopBtn);
        row.appendChild(stopWrap);
      } else {
        const fields = document.createElement('div');
        fields.className = 'counter-session-fields';
        const startInput = document.createElement('input');
        startInput.type = 'datetime-local';
        startInput.className = 'counter-session-input';
        startInput.value = counterToInputValue(session.startAt);
        const endInput = document.createElement('input');
        endInput.type = 'datetime-local';
        endInput.className = 'counter-session-input';
        endInput.value = counterToInputValue(session.endAt);

        const saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.className = 'counter-session-btn';
        saveBtn.textContent = t('counter_save');
        saveBtn.onclick = () => saveHourCounterSession(session.id, startInput.value, endInput.value);

        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'counter-session-btn danger';
        delBtn.textContent = t('counter_delete');
        delBtn.onclick = () => deleteHourCounterSession(session.id);

        fields.appendChild(startInput);
        fields.appendChild(endInput);
        fields.appendChild(saveBtn);
        fields.appendChild(delBtn);
        row.appendChild(fields);
      }

      list.appendChild(row);
    });

    card.appendChild(list);
    daysRoot.appendChild(card);
  });

  renderHourCounter();
}

async function fetchCounterSnapshot() {
  const res = await fetch(`${SERVER}/counter/state?days=${COUNTER_HISTORY_DAYS}`, { cache: 'no-store' });
  if (!res.ok) throw new Error('Counter state unavailable');
  return res.json().catch(() => ({}));
}

async function refreshHourCounter(force = false) {
  if (counterRequestInFlight && !force) return;
  counterRequestInFlight = true;
  try {
    const data = await fetchCounterSnapshot();
    counterSnapshot = data && typeof data === 'object' ? data : null;
    counterLastSyncAt = Date.now();
    renderHourCounter();
    renderHourCounterOverlay();
    checkHourCounterThreshold();
  } catch {
    // keep previous snapshot
  } finally {
    counterRequestInFlight = false;
  }
}

async function postCounterAction(path, payload = null) {
  const res = await fetch(`${SERVER}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload ? JSON.stringify(payload) : '{}',
  });
  if (!res.ok) throw new Error(await res.text().catch(() => 'Counter action failed'));
  return res.json().catch(() => ({}));
}

async function toggleHourCounter() {
  if (counterBusy) return;
  counterBusy = true;
  setCounterButtonsDisabled(true);
  try {
    const running = !!(counterSnapshot && counterSnapshot.isRunning);
    const data = await postCounterAction(running ? '/counter/stop' : '/counter/start');
    counterSnapshot = data && typeof data === 'object' ? data : counterSnapshot;
    counterLastSyncAt = Date.now();
    renderHourCounter();
    renderHourCounterOverlay();
    checkHourCounterThreshold();
  } catch {
    await refreshHourCounter(true);
  } finally {
    counterBusy = false;
    setCounterButtonsDisabled(false);
  }
}

async function saveHourCounterSession(id, startAt, endAt) {
  if (!id || counterBusy) return;
  counterBusy = true;
  setCounterButtonsDisabled(true);
  try {
    const data = await postCounterAction('/counter/session/update', {
      id,
      startAt: counterToApiValue(startAt),
      endAt: counterToApiValue(endAt),
    });
    counterSnapshot = data && typeof data === 'object' ? data : counterSnapshot;
    counterLastSyncAt = Date.now();
    renderHourCounter();
    renderHourCounterOverlay();
  } catch (error) {
    alert(error && error.message ? error.message : t('counter_invalid_range'));
  } finally {
    counterBusy = false;
    setCounterButtonsDisabled(false);
  }
}

async function deleteHourCounterSession(id) {
  if (!id || counterBusy) return;
  if (!confirm(t('counter_confirm_delete'))) return;
  counterBusy = true;
  setCounterButtonsDisabled(true);
  try {
    const data = await postCounterAction('/counter/session/delete', { id });
    counterSnapshot = data && typeof data === 'object' ? data : counterSnapshot;
    counterLastSyncAt = Date.now();
    renderHourCounter();
    renderHourCounterOverlay();
  } catch (error) {
    alert(error && error.message ? error.message : t('counter_delete_failed'));
  } finally {
    counterBusy = false;
    setCounterButtonsDisabled(false);
  }
}

async function resetHourCounterDay(dateKey) {
  if (!dateKey || counterBusy) return;
  if (!confirm(t('counter_confirm_reset_day'))) return;
  counterBusy = true;
  setCounterButtonsDisabled(true);
  try {
    const data = await postCounterAction('/counter/day/reset', { date: dateKey });
    counterSnapshot = data && typeof data === 'object' ? data : counterSnapshot;
    counterLastSyncAt = Date.now();
    renderHourCounter();
    renderHourCounterOverlay();
  } catch (error) {
    alert(error && error.message ? error.message : t('counter_reset_failed'));
  } finally {
    counterBusy = false;
    setCounterButtonsDisabled(false);
  }
}

async function resetHourCounterAll() {
  if (counterBusy) return;
  if (!confirm(t('counter_confirm_reset_all'))) return;
  counterBusy = true;
  setCounterButtonsDisabled(true);
  try {
    const data = await postCounterAction('/counter/reset');
    counterSnapshot = data && typeof data === 'object' ? data : counterSnapshot;
    counterLastSyncAt = Date.now();
    renderHourCounter();
    renderHourCounterOverlay();
  } catch (error) {
    alert(error && error.message ? error.message : t('counter_reset_failed'));
  } finally {
    counterBusy = false;
    setCounterButtonsDisabled(false);
  }
}

function showHourCounterThresholdToast(totalMs) {
  const toast = $('event-toast');
  if (!toast) return;
  $('toast-kicker').textContent = t('counter_threshold_kicker');
  $('toast-title').textContent = t('counter_threshold_title');
  $('toast-meta').textContent = `${t('counter_today_sum')}: ${formatCounterDurationHm(totalMs)}`;
  toast.classList.remove('show');
  void toast.offsetWidth;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(dismissReminderToast, 14000);
  playReminderSound();
}

function checkHourCounterThreshold() {
  if (!counterSnapshot) return;
  const totals = getCounterLiveTotals(Date.now());
  const todayKey = toDateInputValue(new Date());
  const alreadyNotified = localStorage.getItem(COUNTER_THRESHOLD_STORAGE_KEY);
  if (totals.todayMs >= COUNTER_THRESHOLD_MS && alreadyNotified !== todayKey) {
    localStorage.setItem(COUNTER_THRESHOLD_STORAGE_KEY, todayKey);
    showHourCounterThresholdToast(totals.todayMs);
  }
}

function hourCounterTick() {
  if (!counterSnapshot) return;
  renderHourCounter();

  const nowDateKey = toDateInputValue(new Date());
  if (nowDateKey !== counterLastRenderedDate) {
    counterLastRenderedDate = nowDateKey;
    refreshHourCounter(true);
    return;
  }

  if (Date.now() - counterLastSyncAt > 60000) refreshHourCounter();
  checkHourCounterThreshold();
}

function initHourCounter() {
  if (!$('counter-toggle-btn')) return;
  refreshHourCounter(true);
  if (counterTickTimer) clearInterval(counterTickTimer);
  counterTickTimer = setInterval(hourCounterTick, 1000);
}
