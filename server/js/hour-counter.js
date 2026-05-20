'use strict';

const COUNTER_HISTORY_DAYS = 30;
const COUNTER_THRESHOLD_MS = 6 * 60 * 60 * 1000;
const COUNTER_THRESHOLD_STORAGE_KEY = 'counterThresholdNotifiedDate';
const COUNTER_SESSION_AUTOSAVE_DEBOUNCE_MS = 420;

let counterSnapshot = null;
let counterRequestInFlight = false;
let counterBusy = false;
let counterTickTimer = null;
let counterLastSyncAt = 0;
let counterLastRenderedDate = toDateInputValue(new Date());
let counterOverlayNoticeTimer = null;
let counterConfirmResolver = null;
let counterOverlaySelectedDayKey = '';
const counterSessionAutosaveTimers = new Map();
let counterOpenTimePicker = null;
let counterTimePickerHandlersBound = false;
let counterTimeModalState = null;

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

function counterToTimeValue(value) {
  const ms = Date.parse(String(value || '').trim());
  if (!Number.isFinite(ms)) return '';
  const date = new Date(ms);
  return `${counterPad2(date.getHours())}:${counterPad2(date.getMinutes())}`;
}

function counterComposeDateTime(dayKey, timeValue) {
  const safeDay = String(dayKey || '').trim();
  const safeTime = String(timeValue || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(safeDay)) return '';
  if (!/^\d{2}:\d{2}$/.test(safeTime)) return '';
  return `${safeDay}T${safeTime}:00`;
}

function normalizeCounterTimeValue(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/^(\d{1,2}):(\d{1,2})$/);
  if (!match) return '00:00';
  const hour = Math.max(0, Math.min(23, Number(match[1]) || 0));
  const minute = Math.max(0, Math.min(59, Number(match[2]) || 0));
  return `${counterPad2(hour)}:${counterPad2(minute)}`;
}

function parseCounterTimeParts(value) {
  const safe = normalizeCounterTimeValue(value);
  const parts = safe.split(':');
  return {
    hour: Number(parts[0]) || 0,
    minute: Number(parts[1]) || 0,
  };
}

function cycleCounterTimeValue(current, delta, max) {
  const modulo = max + 1;
  const safeCurrent = Number(current) || 0;
  const safeDelta = Number(delta) || 0;
  return ((safeCurrent + safeDelta) % modulo + modulo) % modulo;
}

function renderCounterTimeModalState() {
  const modal = counterTimeModalState;
  if (!modal) return;
  modal.preview.textContent = `${counterPad2(modal.hour)}:${counterPad2(modal.minute)}`;
  modal.hourValue.textContent = counterPad2(modal.hour);
  modal.minuteValue.textContent = counterPad2(modal.minute);
  modal.quickMinuteButtons.forEach(btn => {
    const minute = Number(btn.dataset.minute);
    btn.classList.toggle('active', minute === modal.minute);
  });
}

function ensureCounterTimeModal() {
  if (counterTimeModalState && counterTimeModalState.root && counterTimeModalState.root.isConnected) {
    return counterTimeModalState;
  }
  const overlay = $('counter-overlay');
  if (!overlay) return null;

  const root = document.createElement('div');
  root.className = 'counter-time-modal';
  root.hidden = true;

  const backdrop = document.createElement('button');
  backdrop.type = 'button';
  backdrop.className = 'counter-time-modal-backdrop';
  backdrop.setAttribute('aria-label', t('close'));
  root.appendChild(backdrop);

  const card = document.createElement('section');
  card.className = 'counter-time-modal-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  root.appendChild(card);

  const preview = document.createElement('div');
  preview.className = 'counter-time-modal-preview';
  preview.textContent = '00:00';
  card.appendChild(preview);

  const controls = document.createElement('div');
  controls.className = 'counter-time-modal-controls';
  card.appendChild(controls);

  const makeUnit = (labelText) => {
    const unit = document.createElement('div');
    unit.className = 'counter-time-modal-unit';

    const label = document.createElement('div');
    label.className = 'counter-time-modal-unit-label';
    label.textContent = labelText;
    unit.appendChild(label);

    const plusBtn = document.createElement('button');
    plusBtn.type = 'button';
    plusBtn.className = 'counter-time-modal-step';
    plusBtn.textContent = '+';
    unit.appendChild(plusBtn);

    const valueEl = document.createElement('div');
    valueEl.className = 'counter-time-modal-value';
    valueEl.textContent = '00';
    unit.appendChild(valueEl);

    const minusBtn = document.createElement('button');
    minusBtn.type = 'button';
    minusBtn.className = 'counter-time-modal-step';
    minusBtn.textContent = '-';
    unit.appendChild(minusBtn);

    return { unit, plusBtn, valueEl, minusBtn };
  };

  const hourUnit = makeUnit('H');
  const minuteUnit = makeUnit('M');
  controls.appendChild(hourUnit.unit);
  controls.appendChild(minuteUnit.unit);

  const quickMinutes = document.createElement('div');
  quickMinutes.className = 'counter-time-modal-quick';
  const quickMinuteButtons = [0, 15, 30, 45].map(minute => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'counter-time-modal-chip';
    btn.dataset.minute = String(minute);
    btn.textContent = counterPad2(minute);
    quickMinutes.appendChild(btn);
    return btn;
  });
  card.appendChild(quickMinutes);

  const actions = document.createElement('div');
  actions.className = 'counter-time-modal-actions';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'counter-time-modal-btn ghost';
  cancelBtn.textContent = t('counter_cancel');
  actions.appendChild(cancelBtn);

  const applyBtn = document.createElement('button');
  applyBtn.type = 'button';
  applyBtn.className = 'counter-time-modal-btn primary';
  applyBtn.textContent = t('counter_confirm');
  actions.appendChild(applyBtn);

  card.appendChild(actions);
  overlay.appendChild(root);

  counterTimeModalState = {
    root,
    preview,
    hourValue: hourUnit.valueEl,
    minuteValue: minuteUnit.valueEl,
    quickMinuteButtons,
    cancelBtn,
    applyBtn,
    picker: null,
    hour: 0,
    minute: 0,
  };

  const modal = counterTimeModalState;

  backdrop.addEventListener('click', () => {
    closeAllCounterTimePickers();
  });

  cancelBtn.addEventListener('click', () => {
    closeAllCounterTimePickers();
  });

  applyBtn.addEventListener('click', () => {
    if (!modal.picker || !modal.picker._counterTimePickerApi) {
      closeAllCounterTimePickers();
      return;
    }
    const nextValue = `${counterPad2(modal.hour)}:${counterPad2(modal.minute)}`;
    modal.picker._counterTimePickerApi.setValue(nextValue, true);
    closeAllCounterTimePickers();
  });

  hourUnit.plusBtn.addEventListener('click', () => {
    modal.hour = cycleCounterTimeValue(modal.hour, 1, 23);
    renderCounterTimeModalState();
  });
  hourUnit.minusBtn.addEventListener('click', () => {
    modal.hour = cycleCounterTimeValue(modal.hour, -1, 23);
    renderCounterTimeModalState();
  });
  minuteUnit.plusBtn.addEventListener('click', () => {
    modal.minute = cycleCounterTimeValue(modal.minute, 1, 59);
    renderCounterTimeModalState();
  });
  minuteUnit.minusBtn.addEventListener('click', () => {
    modal.minute = cycleCounterTimeValue(modal.minute, -1, 59);
    renderCounterTimeModalState();
  });

  quickMinuteButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      modal.minute = Number(btn.dataset.minute) || 0;
      renderCounterTimeModalState();
    });
  });

  return counterTimeModalState;
}

function closeCounterTimePicker(picker) {
  if (!picker) return;
  const display = picker.querySelector('.counter-time-display');
  picker.classList.remove('open');
  if (display) display.setAttribute('aria-expanded', 'false');
  if (counterOpenTimePicker === picker) {
    counterOpenTimePicker = null;
    if (counterTimeModalState && counterTimeModalState.root) {
      counterTimeModalState.root.hidden = true;
      counterTimeModalState.picker = null;
    }
  }
}

function closeAllCounterTimePickers(exceptPicker = null) {
  if (counterOpenTimePicker && !counterOpenTimePicker.isConnected) {
    counterOpenTimePicker = null;
    if (counterTimeModalState && counterTimeModalState.root) {
      counterTimeModalState.root.hidden = true;
      counterTimeModalState.picker = null;
    }
  }
  const pickers = document.querySelectorAll('.counter-time-picker.open');
  pickers.forEach(picker => {
    if (picker === exceptPicker) return;
    closeCounterTimePicker(picker);
  });
  if (!exceptPicker && counterTimeModalState && counterTimeModalState.root) {
    counterTimeModalState.root.hidden = true;
    counterTimeModalState.picker = null;
  }
}

function openCounterTimePicker(picker) {
  if (!picker) return;
  const modal = ensureCounterTimeModal();
  if (!modal) return;
  closeAllCounterTimePickers(picker);
  const display = picker.querySelector('.counter-time-display');
  picker.classList.add('open');
  if (display) display.setAttribute('aria-expanded', 'true');
  counterOpenTimePicker = picker;

  const api = picker._counterTimePickerApi;
  const selectedValue = api && typeof api.getValue === 'function'
    ? api.getValue()
    : String(picker && picker.dataset ? picker.dataset.timeValue || '' : '');
  const parts = parseCounterTimeParts(selectedValue);
  modal.picker = picker;
  modal.hour = parts.hour;
  modal.minute = parts.minute;
  modal.cancelBtn.textContent = t('counter_cancel');
  modal.applyBtn.textContent = t('counter_confirm');
  renderCounterTimeModalState();
  modal.root.hidden = false;
}

function bindCounterTimePickerHandlers() {
  if (counterTimePickerHandlersBound) return;
  counterTimePickerHandlersBound = true;
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    closeAllCounterTimePickers();
  });
}

function createCounterSessionTimePicker(initialValue, onChange) {
  const wrap = document.createElement('div');
  wrap.className = 'counter-time-picker';

  const display = document.createElement('button');
  display.type = 'button';
  display.className = 'counter-time-display';
  display.setAttribute('aria-haspopup', 'dialog');
  display.setAttribute('aria-expanded', 'false');

  const label = document.createElement('span');
  label.className = 'counter-time-label';
  display.appendChild(label);

  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('class', 'counter-time-icon');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('aria-hidden', 'true');

  const iconCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  iconCircle.setAttribute('cx', '12');
  iconCircle.setAttribute('cy', '12');
  iconCircle.setAttribute('r', '9');
  icon.appendChild(iconCircle);

  const iconPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  iconPath.setAttribute('d', 'M12 7v5l3 2');
  icon.appendChild(iconPath);

  display.appendChild(icon);
  wrap.appendChild(display);

  let currentValue = normalizeCounterTimeValue(initialValue);
  const setValue = (nextValue, emitChange = false) => {
    currentValue = normalizeCounterTimeValue(nextValue);
    label.textContent = currentValue;
    wrap.dataset.timeValue = currentValue;
    if (emitChange && typeof onChange === 'function') onChange(currentValue);
  };
  setValue(currentValue, false);

  wrap._counterTimePickerApi = {
    getValue: () => currentValue,
    setValue,
  };

  display.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    if (counterOpenTimePicker === wrap) {
      closeCounterTimePicker(wrap);
      return;
    }
    openCounterTimePicker(wrap);
  });

  return {
    root: wrap,
    getValue: () => currentValue,
  };
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

function getCounterWeekStartMs(date = new Date()) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  return start.getTime();
}

function getCounterMonthStartMs(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth(), 1).getTime();
}

function isCounterOverlayOpen() {
  const overlay = $('counter-overlay');
  return !!(overlay && !overlay.hidden);
}

function closeHourCounterOverlay() {
  closeAllCounterTimePickers();
  hideHourCounterConfirm(false);
  setHourCounterOverlayNotice('');
  const overlay = $('counter-overlay');
  if (overlay) overlay.hidden = true;
}

async function openHourCounterOverlay() {
  const overlay = $('counter-overlay');
  if (overlay) overlay.hidden = false;
  setHourCounterOverlayNotice('');
  syncHourCounterConfirmLabels();
  await refreshHourCounter(true);
}

function setHourCounterOverlayNotice(message = '', autoHideMs = 0) {
  const notice = $('counter-overlay-notice');
  if (!notice) return;
  clearTimeout(counterOverlayNoticeTimer);
  const text = String(message || '').trim();
  if (!text) {
    notice.hidden = true;
    notice.textContent = '';
    return;
  }
  notice.hidden = false;
  notice.textContent = text;
  if (Number.isFinite(Number(autoHideMs)) && Number(autoHideMs) > 0) {
    counterOverlayNoticeTimer = setTimeout(() => {
      setHourCounterOverlayNotice('');
    }, Number(autoHideMs));
  }
}

function syncHourCounterConfirmLabels() {
  const cancelBtn = $('counter-inline-confirm-cancel');
  const okBtn = $('counter-inline-confirm-ok');
  if (cancelBtn) cancelBtn.textContent = t('counter_cancel');
  if (okBtn && !okBtn.dataset.customLabel) okBtn.textContent = t('counter_confirm');
}

function hideHourCounterConfirm(shouldResolve = true) {
  const bar = $('counter-inline-confirm');
  const text = $('counter-inline-confirm-text');
  const cancelBtn = $('counter-inline-confirm-cancel');
  const okBtn = $('counter-inline-confirm-ok');
  if (bar) bar.hidden = true;
  if (text) text.textContent = '';
  if (cancelBtn) cancelBtn.onclick = null;
  if (okBtn) {
    okBtn.onclick = null;
    delete okBtn.dataset.customLabel;
    okBtn.textContent = t('counter_confirm');
  }
  if (shouldResolve && typeof counterConfirmResolver === 'function') {
    const resolve = counterConfirmResolver;
    counterConfirmResolver = null;
    resolve(false);
    return;
  }
  counterConfirmResolver = null;
}

function requestHourCounterConfirm(message, confirmLabel = '') {
  return new Promise(resolve => {
    const bar = $('counter-inline-confirm');
    const text = $('counter-inline-confirm-text');
    const cancelBtn = $('counter-inline-confirm-cancel');
    const okBtn = $('counter-inline-confirm-ok');
    if (!bar || !text || !cancelBtn || !okBtn) {
      resolve(true);
      return;
    }

    hideHourCounterConfirm(false);
    counterConfirmResolver = resolve;
    text.textContent = String(message || '').trim();
    cancelBtn.textContent = t('counter_cancel');
    okBtn.textContent = confirmLabel || t('counter_confirm');
    okBtn.dataset.customLabel = '1';
    bar.hidden = false;

    cancelBtn.onclick = () => {
      hideHourCounterConfirm(false);
      resolve(false);
    };
    okBtn.onclick = () => {
      hideHourCounterConfirm(false);
      resolve(true);
    };
  });
}

function getCounterBaseTotals() {
  const today = new Date();
  const todayKey = toDateInputValue(today);
  const weekStartMs = getCounterWeekStartMs(today);
  const monthStartMs = getCounterMonthStartMs(today);
  const days = Array.isArray(counterSnapshot && counterSnapshot.days) ? counterSnapshot.days : [];
  const rawSnapshotMonthMs = Number(counterSnapshot && counterSnapshot.totals && counterSnapshot.totals.monthMs);
  const hasSnapshotMonthMs = Number.isFinite(rawSnapshotMonthMs);
  const snapshotMonthMs = hasSnapshotMonthMs ? Math.max(0, rawSnapshotMonthMs) : 0;
  let windowMs = 0;
  let weekClosedMs = 0;
  let monthClosedMs = 0;
  let todayClosedMs = 0;
  days.forEach(day => {
    const dayKey = String(day && day.date || '');
    const dayStartMs = Date.parse(`${dayKey}T00:00:00`);
    const isThisWeek = Number.isFinite(dayStartMs) && dayStartMs >= weekStartMs;
    const isThisMonth = Number.isFinite(dayStartMs) && dayStartMs >= monthStartMs;
    const sessions = Array.isArray(day && day.sessions) ? day.sessions : [];
    sessions.forEach(session => {
      if (session && session.active) return;
      const duration = Math.max(0, Number(session && session.durationMs) || 0);
      windowMs += duration;
      if (isThisWeek) weekClosedMs += duration;
      if (isThisMonth) monthClosedMs += duration;
      if (dayKey === todayKey) todayClosedMs += duration;
    });
  });
  return {
    windowMs,
    weekClosedMs,
    monthClosedMs: hasSnapshotMonthMs ? snapshotMonthMs : monthClosedMs,
    todayClosedMs,
    todayKey,
    weekStartMs,
    monthStartMs,
  };
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
  const weekActiveMs = Number.isFinite(activeStartMs)
    ? Math.max(0, nowMs - Math.max(activeStartMs, base.weekStartMs))
    : 0;
  const snapshotNowMs = Date.parse(String(counterSnapshot && counterSnapshot.nowAt || '').trim());
  const monthActiveDeltaMs = Number.isFinite(activeStartMs) && Number.isFinite(snapshotNowMs)
    ? Math.max(0, nowMs - Math.max(snapshotNowMs, activeStartMs, base.monthStartMs))
    : 0;
  return {
    todayMs: base.todayClosedMs + todayActiveMs,
    weekMs: base.weekClosedMs + weekActiveMs,
    monthMs: base.monthClosedMs + monthActiveDeltaMs,
    windowMs: base.windowMs + activeLiveMs,
  };
}

function getHourCounterDayTotalMs(dateKey, nowMs = Date.now()) {
  const safeDateKey = String(dateKey || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(safeDateKey)) return 0;
  const days = Array.isArray(counterSnapshot && counterSnapshot.days) ? counterSnapshot.days : [];
  const day = days.find(item => String(item && item.date || '') === safeDateKey);
  const sessions = Array.isArray(day && day.sessions) ? day.sessions : [];
  let totalMs = 0;

  sessions.forEach(session => {
    if (session && session.active) return;
    totalMs += Math.max(0, Number(session && session.durationMs) || 0);
  });

  if (counterSnapshot && counterSnapshot.isRunning && counterSnapshot.active) {
    const activeStartMs = Date.parse(String(counterSnapshot.active.startAt || '').trim());
    const dayStartMs = Date.parse(`${safeDateKey}T00:00:00`);
    if (Number.isFinite(activeStartMs) && Number.isFinite(dayStartMs)) {
      const dayEndMs = dayStartMs + 24 * 60 * 60 * 1000;
      const overlapStartMs = Math.max(activeStartMs, dayStartMs);
      const overlapEndMs = Math.min(Number(nowMs) || Date.now(), dayEndMs);
      if (overlapEndMs > overlapStartMs) totalMs += overlapEndMs - overlapStartMs;
    }
  }

  return totalMs;
}

function syncCalendarHourCounterTotals() {
  if (typeof syncCalendarCounterDayLabels === 'function') syncCalendarCounterDayLabels();
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
  const weekEl = $('counter-week-total');
  const monthEl = $('counter-month-total');
  const sessionEl = $('counter-session-time');
  const statusEl = $('counter-status');
  if (!tile || !toggleBtn || !playIcon || !stopIcon || !totalEl || !statusEl) return;

  const running = !!(counterSnapshot && counterSnapshot.isRunning);
  const nowMs = Date.now();
  const totals = getCounterLiveTotals(nowMs);
  const sessionMs = getCounterActiveLiveMs(nowMs);
  totalEl.textContent = formatCounterDurationHm(totals.todayMs);
  if (weekEl) weekEl.textContent = formatCounterDurationHm(totals.weekMs);
  if (monthEl) monthEl.textContent = formatCounterDurationHm(totals.monthMs);
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
  if (summaryStatus) {
    summaryStatus.textContent = running ? t('counter_running') : t('counter_idle');
    summaryStatus.classList.add('counter-summary-pill');
    summaryStatus.classList.toggle('running', running);
    summaryStatus.classList.toggle('idle', !running);
  }

  const activeDurations = document.querySelectorAll('[data-counter-live-start]');
  activeDurations.forEach(node => {
    const startMs = Number(node && node.dataset ? node.dataset.counterLiveStart : NaN);
    if (!Number.isFinite(startMs)) return;
    const liveMs = Math.max(0, Date.now() - startMs);
    node.textContent = formatCounterDurationHms(liveMs);
  });
  syncCalendarHourCounterTotals();
}

function clampCounterOverlaySelectedDay(days) {
  if (!Array.isArray(days) || !days.length) {
    counterOverlaySelectedDayKey = '';
    return -1;
  }
  const selectedIndex = days.findIndex(day => String(day && day.date || '') === counterOverlaySelectedDayKey);
  if (selectedIndex >= 0) return selectedIndex;
  counterOverlaySelectedDayKey = String(days[0] && days[0].date || '');
  return 0;
}

function selectHourCounterDay(dateKey) {
  const nextKey = String(dateKey || '').trim();
  if (!nextKey) return;
  counterOverlaySelectedDayKey = nextKey;
  renderHourCounterOverlay();
}

function navigateHourCounterDay(step) {
  const days = Array.isArray(counterSnapshot && counterSnapshot.days) ? counterSnapshot.days : [];
  if (!days.length) return;
  const index = clampCounterOverlaySelectedDay(days);
  if (index < 0) return;
  const nextIndex = Math.max(0, Math.min(days.length - 1, index + Number(step || 0)));
  counterOverlaySelectedDayKey = String(days[nextIndex] && days[nextIndex].date || '');
  renderHourCounterOverlay();
}

function renderHourCounterDayCard(day) {
  const sessions = Array.isArray(day && day.sessions) ? [...day.sessions] : [];
  sessions.sort((left, right) => Number(!!(right && right.active)) - Number(!!(left && left.active)));
  const card = document.createElement('section');
  card.className = 'counter-day-card is-focus-day';

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
    return card;
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
      // Active session control lives in the main widget tile; keep row clean here.
    } else {
      const fields = document.createElement('div');
      fields.className = 'counter-session-fields';
      const startPicker = createCounterSessionTimePicker(counterToTimeValue(session.startAt), () => {
        queueHourCounterSessionAutosave(session.id, day && day.date, startPicker.getValue(), endPicker.getValue());
      });
      const endPicker = createCounterSessionTimePicker(counterToTimeValue(session.endAt), () => {
        queueHourCounterSessionAutosave(session.id, day && day.date, startPicker.getValue(), endPicker.getValue());
      });

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'counter-session-btn danger';
      delBtn.textContent = t('counter_delete');
      delBtn.onclick = () => deleteHourCounterSession(session.id);

      fields.appendChild(startPicker.root);
      fields.appendChild(endPicker.root);
      fields.appendChild(delBtn);
      row.appendChild(fields);
    }

    list.appendChild(row);
  });

  card.appendChild(list);
  return card;
}

function renderHourCounterOverlay() {
  if (!isCounterOverlayOpen()) return;
  const daysRoot = $('counter-days-list');
  if (!daysRoot) return;
  syncHourCounterConfirmLabels();
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

  const selectedIndex = clampCounterOverlaySelectedDay(days);
  const safeIndex = Math.max(0, Math.min(days.length - 1, selectedIndex));
  const selectedDay = days[safeIndex];

  const tabsShell = document.createElement('div');
  tabsShell.className = 'counter-day-tabs-shell';

  const prevBtn = document.createElement('button');
  prevBtn.type = 'button';
  prevBtn.className = 'counter-day-tab-nav';
  prevBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="15 6 9 12 15 18"/></svg>';
  prevBtn.title = t('prev_month');
  prevBtn.setAttribute('aria-label', t('prev_month'));
  prevBtn.disabled = safeIndex <= 0;
  prevBtn.onclick = () => navigateHourCounterDay(-1);
  tabsShell.appendChild(prevBtn);

  const tabs = document.createElement('div');
  tabs.className = 'counter-day-tabs';
  days.forEach((day, index) => {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = `counter-day-tab${index === safeIndex ? ' active' : ''}`;
    tab.dataset.date = String(day && day.date || '');
    tab.innerHTML = `<span>${formatCounterDayLabel(day.date)}</span><b>${formatCounterDurationHm(day.totalMs)}</b>`;
    tab.setAttribute('aria-selected', index === safeIndex ? 'true' : 'false');
    tab.onclick = () => selectHourCounterDay(day.date);
    tabs.appendChild(tab);
  });
  tabsShell.appendChild(tabs);

  const nextBtn = document.createElement('button');
  nextBtn.type = 'button';
  nextBtn.className = 'counter-day-tab-nav';
  nextBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="9 6 15 12 9 18"/></svg>';
  nextBtn.title = t('next_month');
  nextBtn.setAttribute('aria-label', t('next_month'));
  nextBtn.disabled = safeIndex >= (days.length - 1);
  nextBtn.onclick = () => navigateHourCounterDay(1);
  tabsShell.appendChild(nextBtn);

  daysRoot.appendChild(tabsShell);
  daysRoot.appendChild(renderHourCounterDayCard(selectedDay));
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

function queueHourCounterSessionAutosave(id, dayKey, startTime, endTime) {
  const safeId = String(id || '').trim();
  if (!safeId) return;
  clearTimeout(counterSessionAutosaveTimers.get(safeId));
  const timer = setTimeout(() => {
    counterSessionAutosaveTimers.delete(safeId);
    saveHourCounterSessionTime(safeId, dayKey, startTime, endTime).catch(() => {});
  }, COUNTER_SESSION_AUTOSAVE_DEBOUNCE_MS);
  counterSessionAutosaveTimers.set(safeId, timer);
}

async function saveHourCounterSessionTime(id, dayKey, startTime, endTime) {
  if (!id) return;
  if (counterBusy) {
    queueHourCounterSessionAutosave(id, dayKey, startTime, endTime);
    return;
  }
  const startAt = counterComposeDateTime(dayKey, startTime);
  const endAt = counterComposeDateTime(dayKey, endTime);
  if (!startAt || !endAt) {
    setHourCounterOverlayNotice(t('counter_invalid_range'), 2600);
    return;
  }

  counterBusy = true;
  setCounterButtonsDisabled(true);
  setHourCounterOverlayNotice('');
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
    setHourCounterOverlayNotice(error && error.message ? error.message : t('counter_invalid_range'));
  } finally {
    counterBusy = false;
    setCounterButtonsDisabled(false);
  }
}

async function deleteHourCounterSession(id) {
  if (!id || counterBusy) return;
  const confirmed = await requestHourCounterConfirm(t('counter_confirm_delete'), t('counter_delete'));
  if (!confirmed) return;
  counterBusy = true;
  setCounterButtonsDisabled(true);
  setHourCounterOverlayNotice('');
  try {
    const data = await postCounterAction('/counter/session/delete', { id });
    counterSnapshot = data && typeof data === 'object' ? data : counterSnapshot;
    counterLastSyncAt = Date.now();
    renderHourCounter();
    renderHourCounterOverlay();
  } catch (error) {
    setHourCounterOverlayNotice(error && error.message ? error.message : t('counter_delete_failed'));
  } finally {
    counterBusy = false;
    setCounterButtonsDisabled(false);
  }
}

async function resetHourCounterDay(dateKey) {
  if (!dateKey || counterBusy) return;
  const confirmed = await requestHourCounterConfirm(t('counter_confirm_reset_day'), t('counter_reset_day'));
  if (!confirmed) return;
  counterBusy = true;
  setCounterButtonsDisabled(true);
  setHourCounterOverlayNotice('');
  try {
    const data = await postCounterAction('/counter/day/reset', { date: dateKey });
    counterSnapshot = data && typeof data === 'object' ? data : counterSnapshot;
    counterLastSyncAt = Date.now();
    renderHourCounter();
    renderHourCounterOverlay();
  } catch (error) {
    setHourCounterOverlayNotice(error && error.message ? error.message : t('counter_reset_failed'));
  } finally {
    counterBusy = false;
    setCounterButtonsDisabled(false);
  }
}

async function resetHourCounterAll() {
  if (counterBusy) return;
  const confirmed = await requestHourCounterConfirm(t('counter_confirm_reset_all'), t('counter_reset_all'));
  if (!confirmed) return;
  counterBusy = true;
  setCounterButtonsDisabled(true);
  setHourCounterOverlayNotice('');
  try {
    const data = await postCounterAction('/counter/reset');
    counterSnapshot = data && typeof data === 'object' ? data : counterSnapshot;
    counterLastSyncAt = Date.now();
    renderHourCounter();
    renderHourCounterOverlay();
  } catch (error) {
    setHourCounterOverlayNotice(error && error.message ? error.message : t('counter_reset_failed'));
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
  bindCounterTimePickerHandlers();
  refreshHourCounter(true);
  if (counterTickTimer) clearInterval(counterTickTimer);
  counterTickTimer = setInterval(hourCounterTick, 1000);
}
