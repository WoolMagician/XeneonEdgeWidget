'use strict';

/* ── Custom time picker ─────────────────────────────────────── */
(function initTimePicker() {
  let _tpOpen = false;

  function _pad(n) { return String(n).padStart(2, '0'); }

  function _getSelectedTime() {
    return $('event-time').value || '09:00';
  }

  function _setTime(hh, mm) {
    const val = `${_pad(hh)}:${_pad(mm)}`;
    $('event-time').value = val;
    $('time-picker-label').textContent = val;
  }

  function _buildCol(containerId, count, start, selectedVal, onSelect) {
    const col = $(containerId);
    col.innerHTML = '';
    for (let i = start; i < start + count; i++) {
      const item = document.createElement('div');
      item.className = 'tp-item' + (i === selectedVal ? ' selected' : '');
      item.textContent = _pad(i);
      item.dataset.val = i;
      item.addEventListener('click', function () {
        onSelect(i);
      });
      col.appendChild(item);
    }
    // scroll selected item to top
    const sel = col.querySelector('.tp-item.selected');
    if (sel) col.scrollTop = sel.offsetTop;
  }

  function _rebuild() {
    const parts = _getSelectedTime().split(':');
    const hh = parseInt(parts[0], 10) || 0;
    const mm = parseInt(parts[1], 10) || 0;

    _buildCol('tp-hours', 24, 0, hh, function (h) {
      const cur = _getSelectedTime().split(':');
      _setTime(h, parseInt(cur[1], 10) || 0);
      _rebuild();
    });

    _buildCol('tp-minutes', 60, 0, mm, function (m) {
      const cur = _getSelectedTime().split(':');
      _setTime(parseInt(cur[0], 10) || 0, m);
      _rebuild();
    });
  }

  function toggleTimePicker() {
    _tpOpen = !_tpOpen;
    const dd = $('time-picker-dropdown');
    const btn = $('time-picker-btn');
    if (_tpOpen) {
      _rebuild();
      dd.classList.add('open');
      btn.setAttribute('aria-expanded', 'true');
    } else {
      dd.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
    }
  }

  // close on outside click
  document.addEventListener('click', function (e) {
    if (!_tpOpen) return;
    const wrap = $('time-picker-wrap');
    if (wrap && !wrap.contains(e.target)) {
      _tpOpen = false;
      $('time-picker-dropdown').classList.remove('open');
      $('time-picker-btn').setAttribute('aria-expanded', 'false');
    }
  }, true);

  // expose globally so onclick in HTML works
  window.toggleTimePicker = toggleTimePicker;

  // init label on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      const lbl = $('time-picker-label');
      if (lbl) lbl.textContent = _getSelectedTime();
    });
  }
})();
/* ── End custom time picker ─────────────────────────────────── */

function getCalendarOverlay() {
  return $('calendar-overlay');
}

function getCalendarOverlayBody() {
  return $('calendar-overlay-body');
}

function ensureCalendarOverlayAttachment() {
  const view = $('calendar-view');
  const body = getCalendarOverlayBody();
  if (!view || !body) return;
  if (view.parentElement !== body) body.appendChild(view);
}

function openCalendarOverlay() {
  const overlay = getCalendarOverlay();
  const view = $('calendar-view');
  if (!overlay || !view) return;
  ensureCalendarOverlayAttachment();
  if (typeof closeWeatherDetails === 'function') closeWeatherDetails();
  if (typeof closeSettings === 'function') closeSettings();
  if (typeof closeAppSwitcher === 'function') closeAppSwitcher();
  if (typeof closeTabSwitcher === 'function') closeTabSwitcher();
  if (typeof closeMediaMode === 'function') closeMediaMode();
  overlay.hidden = false;
  view.classList.add('open');
  calendarMode = true;
  calendarAutoShown = false;
  if (typeof switchCalendarTaskView === 'function') switchCalendarTaskView('calendar', { persist: false });
  if (typeof refreshHourCounter === 'function') refreshHourCounter();
  updateCalendarMiniPlayer();
  renderCalendar();
  if ('Notification' in window && Notification.permission === 'default') {
    try { Promise.resolve(Notification.requestPermission()).catch(() => {}); } catch {}
  }
}

function closeCalendarOverlay(automatic) {
  const auto = automatic === true;
  const overlay = getCalendarOverlay();
  const view = $('calendar-view');
  if (overlay) overlay.hidden = true;
  if (view) view.classList.remove('open');
  calendarMode = false;
  updateCalendarMiniPlayer();
  if (!auto && typeof persistDashboardMediaView === 'function') {
    persistDashboardMediaView('media');
  }
}

function showCalendar(show, automatic) {
  const auto = automatic === true;
  const shouldOpen = !!show;

  if (auto) {
    if (!shouldOpen) closeCalendarOverlay(true);
    return;
  }

  if (shouldOpen) {
    openCalendarOverlay();
    if (typeof persistDashboardMediaView === 'function') persistDashboardMediaView('calendar');
    return;
  }
  closeCalendarOverlay(false);
}

ensureCalendarOverlayAttachment();
closeCalendarOverlay(true);

const CAL_SYNC_UI_MIN_REFRESH_MINUTES = 1;
const CAL_SYNC_UI_MAX_REFRESH_MINUTES = 360;
const CAL_SYNC_UI_DEFAULT_REFRESH_MINUTES = 10;
let calendarLocalEvents = [];
let calendarRemoteEvents = [];
let calendarSyncMeta = null;
let calendarRefreshTimer = null;
let configuredCalendarRefreshMs = CAL_SYNC_UI_DEFAULT_REFRESH_MINUTES * 60 * 1000;
let calendarEventsRevision = 0;
let centerCalendarEventRenderStamp = '';

function getConfiguredCalendarRefreshMinutes() {
  const source = hubSettings && hubSettings.calendarSync && Number(hubSettings.calendarSync.refreshMinutes);
  if (!Number.isFinite(source)) return CAL_SYNC_UI_DEFAULT_REFRESH_MINUTES;
  return Math.max(CAL_SYNC_UI_MIN_REFRESH_MINUTES, Math.min(CAL_SYNC_UI_MAX_REFRESH_MINUTES, Math.round(source)));
}

function scheduleCalendarSyncRefresh() {
  const nextMs = getConfiguredCalendarRefreshMinutes() * 60 * 1000;
  configuredCalendarRefreshMs = nextMs;
  if (calendarRefreshTimer) clearInterval(calendarRefreshTimer);
  calendarRefreshTimer = setInterval(() => loadCalendarEvents(true), configuredCalendarRefreshMs);
}

function refreshCalendarEventsFromSettings(options = {}) {
  scheduleCalendarSyncRefresh();
  if (options && options.forceRefresh) loadCalendarEvents(true);
}

function normalizeCalendarEventItem(event, sourceHint = 'local') {
  const source = event && typeof event === 'object' ? event : {};
  const startsAt = String(source.startsAt || '').trim();
  const endsAt = String(source.endsAt || '').trim();
  const sourceType = String(source.source || sourceHint || '').trim().toLowerCase();
  return {
    ...source,
    id: String(source.id || `${Date.now()}-${Math.random().toString(16).slice(2)}`).slice(0, 120),
    title: String(source.title || '').trim().slice(0, 160),
    notes: String(source.notes || '').trim().slice(0, 600),
    startsAt,
    endsAt,
    location: String(source.location || '').trim().slice(0, 160),
    categories: Array.isArray(source.categories) ? source.categories.map(item => String(item || '').trim().slice(0, 80)).filter(Boolean).slice(0, 12) : [],
    source: source.source || sourceHint,
    sourceLabel: String(source.sourceLabel || '').trim(),
    isAllDay: !!source.isAllDay,
    endExclusive: !!source.endExclusive,
    readOnly: source.readOnly === undefined ? (sourceType === 'ical' || sourceType === 'holiday') : !!source.readOnly,
    special: !!source.special,
    holiday: !!source.holiday || sourceType === 'holiday',
  };
}

function rebuildCalendarEvents() {
  calendarEventsRevision += 1;
  const merged = [...calendarLocalEvents, ...calendarRemoteEvents];
  calendarEvents = merged.sort((a, b) => {
    const left = Date.parse(a && a.startsAt);
    const right = Date.parse(b && b.startsAt);
    if (Number.isFinite(left) && Number.isFinite(right) && left !== right) return left - right;
    if (Number.isFinite(left) && !Number.isFinite(right)) return -1;
    if (!Number.isFinite(left) && Number.isFinite(right)) return 1;
    return String(a && a.title || '').localeCompare(String(b && b.title || ''), t('locale'), { sensitivity: 'base' });
  });
}

function getEventStartMs(event) {
  return Date.parse(event && event.startsAt);
}

function getEventEndMs(event) {
  const startMs = getEventStartMs(event);
  if (!Number.isFinite(startMs)) return NaN;
  const parsedEnd = Date.parse(event && event.endsAt);
  if (Number.isFinite(parsedEnd) && parsedEnd > startMs) return parsedEnd;
  return startMs + (event && event.isAllDay ? 24 * 60 * 60 * 1000 : 60 * 1000);
}

function isHolidayCalendarEvent(event) {
  const source = String(event && event.source || '').toLowerCase();
  return !!(event && event.holiday) || source === 'holiday';
}

function eventIntersectsDateValue(event, dateValue) {
  const startMs = getEventStartMs(event);
  const endMs = getEventEndMs(event);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return false;
  const dayStart = new Date(`${dateValue}T00:00:00`).getTime();
  const dayEnd = dayStart + (24 * 60 * 60 * 1000);
  return endMs > dayStart && startMs < dayEnd;
}

function eventsForDate(dateValue) {
  return calendarEvents
    .filter(event => eventIntersectsDateValue(event, dateValue))
    .sort((a, b) => {
      const left = getEventStartMs(a);
      const right = getEventStartMs(b);
      if (Number.isFinite(left) && Number.isFinite(right) && left !== right) return left - right;
      return String(a.title || '').localeCompare(String(b.title || ''), t('locale'), { sensitivity: 'base' });
    });
}

function appendCalendarDayLabel(cell, events, className, fallbackText) {
  if (!events.length) return;
  const label = document.createElement('span');
  label.className = className;
  const baseTitle = events[0] && events[0].title ? events[0].title : fallbackText;
  label.textContent = events.length > 1 ? `${baseTitle} +${events.length - 1}` : baseTitle;
  label.title = events
    .map(event => event && event.title ? event.title : fallbackText)
    .filter(Boolean)
    .join(' · ');
  cell.appendChild(label);
}

function formatCalendarCounterDuration(ms) {
  const safe = Math.max(0, Number(ms) || 0);
  const hours = Math.floor(safe / 3600000);
  const minutes = Math.floor((safe % 3600000) / 60000);
  return `${hours}h ${String(minutes).padStart(2, '0')}m`;
}

function getCalendarCounterDayTotalMs(dateValue) {
  if (typeof getHourCounterDayTotalMs !== 'function') return 0;
  const totalMs = Number(getHourCounterDayTotalMs(dateValue));
  return Number.isFinite(totalMs) ? Math.max(0, totalMs) : 0;
}

function createCalendarCounterHammerIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const pathOne = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  pathOne.setAttribute('d', 'm15 12-8.5 8.5a2.1 2.1 0 0 1-3-3L12 9');
  const pathTwo = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  pathTwo.setAttribute('d', 'm12 5.5 6.5 6.5 1.6-1.6a2 2 0 0 0 0-2.8l-3.7-3.7a2 2 0 0 0-2.8 0L12 5.5Z');
  svg.appendChild(pathOne);
  svg.appendChild(pathTwo);
  return svg;
}

function updateCalendarCellTitle(cell, counterText = '') {
  if (!cell) return;
  const baseTitle = String(cell.dataset.calendarTitleBase || '').trim();
  const parts = [];
  if (baseTitle) parts.push(baseTitle);
  if (counterText) parts.push(`${t('counter_daily_total')}: ${counterText}`);
  if (parts.length) cell.title = parts.join(' · ');
  else cell.removeAttribute('title');
}

function syncCalendarCounterDayLabel(cell, dateValue) {
  if (!cell) return;
  const totalMs = getCalendarCounterDayTotalMs(dateValue);
  const existing = cell.querySelector('.day-cell-counter');

  if (totalMs <= 0) {
    if (existing) existing.remove();
    cell.classList.remove('has-counter-hours');
    updateCalendarCellTitle(cell, '');
    return;
  }

  const labelText = formatCalendarCounterDuration(totalMs);
  let label = existing;
  if (!label) {
    label = document.createElement('span');
    label.className = 'day-cell-counter';
    label.appendChild(createCalendarCounterHammerIcon());
    const value = document.createElement('span');
    value.className = 'day-cell-counter-value';
    label.appendChild(value);
    const firstEventLabel = cell.querySelector('.day-cell-event, .day-cell-holiday');
    if (firstEventLabel) cell.insertBefore(label, firstEventLabel);
    else cell.appendChild(label);
  }
  const value = label.querySelector('.day-cell-counter-value');
  if (value) value.textContent = labelText;
  label.title = `${t('counter_daily_total')}: ${labelText}`;
  cell.classList.add('has-counter-hours');
  updateCalendarCellTitle(cell, labelText);
}

function syncCalendarCounterDayLabels() {
  const dayCells = document.querySelectorAll('#calendar-days .day-cell[data-calendar-date]');
  dayCells.forEach(cell => syncCalendarCounterDayLabel(cell, cell.dataset.calendarDate));
}

function openCalendarDayTile(dateValue) {
  const targetDate = new Date(`${dateValue}T00:00:00`);
  if (!Number.isNaN(targetDate.getTime())) {
    calendarViewDate = new Date(targetDate.getFullYear(), targetDate.getMonth(), 1);
  }
  openDayModal(dateValue);
}

function renderCalendar() {
  const locale = t('locale');
  const monthLabel = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(calendarViewDate);
  const compactMonthFormatter = new Intl.DateTimeFormat(locale, { month: 'short' });
  $('calendar-month').textContent = monthLabel.charAt(0).toUpperCase() + monthLabel.slice(1);

  const weekdays = $('calendar-weekdays');
  weekdays.innerHTML = '';
  t('weekdays').forEach(day => {
    const el = document.createElement('span');
    el.textContent = day;
    weekdays.appendChild(el);
  });

  const days = $('calendar-days');
  days.innerHTML = '';
  const year = calendarViewDate.getFullYear();
  const month = calendarViewDate.getMonth();
  const first = new Date(year, month, 1);
  const offset = (first.getDay() + 6) % 7;
  const totalDays = new Date(year, month + 1, 0).getDate();
  const todayValue = toDateInputValue(new Date());
  const calendarWeeks = Math.ceil((offset + totalDays) / 7);
  const visibleDays = calendarWeeks * 7;
  days.style.setProperty('--calendar-weeks', String(calendarWeeks));

  for (let index = 0; index < visibleDays; index++) {
    const cellDate = new Date(year, month, index - offset + 1);
    const dateValue = toDateInputValue(cellDate);
    const isCurrentMonth = cellDate.getMonth() === month;
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'day-cell';
    cell.dataset.calendarDate = dateValue;
    if (!isCurrentMonth) cell.classList.add('adjacent-month');
    const dayEvents = eventsForDate(dateValue);
    const dayHolidays = dayEvents.filter(isHolidayCalendarEvent);
    const dayRegularEvents = dayEvents.filter(event => !isHolidayCalendarEvent(event));
    if (dateValue === todayValue) cell.classList.add('today');
    if (dateValue === selectedCalendarDate) cell.classList.add('selected');
    if (dayRegularEvents.length) cell.classList.add('has-events');
    if (dayHolidays.length) cell.classList.add('has-holidays');
    if (dayEvents.some(event => String(event && event.source || '').toLowerCase() === 'ical')) cell.classList.add('has-remote-events');
    const dayTitles = dayEvents
      .map(event => event && event.title ? event.title : (isHolidayCalendarEvent(event) ? t('calendar_holiday') : t('ph_title')))
      .filter(Boolean);
    cell.dataset.calendarTitleBase = dayTitles.join(' · ');
    updateCalendarCellTitle(cell);
    const dayNumber = document.createElement('span');
    dayNumber.className = 'day-cell-number';
    if (!isCurrentMonth) {
      const monthTag = document.createElement('span');
      monthTag.className = 'day-cell-month';
      monthTag.textContent = compactMonthFormatter.format(cellDate).replace(/\.$/, '');
      dayNumber.appendChild(monthTag);
    }
    const dayNumberValue = document.createElement('span');
    dayNumberValue.className = 'day-cell-day';
    dayNumberValue.textContent = String(cellDate.getDate());
    dayNumber.appendChild(dayNumberValue);
    cell.appendChild(dayNumber);
    syncCalendarCounterDayLabel(cell, dateValue);
    appendCalendarDayLabel(cell, dayRegularEvents, 'day-cell-event', t('ph_title'));
    appendCalendarDayLabel(cell, dayHolidays, 'day-cell-holiday', t('calendar_holiday'));
    cell.onclick = () => openCalendarDayTile(dateValue);
    days.appendChild(cell);
  }

  renderUpcoming();
}

function getCalendarEventSourceLabel(event) {
  const source = String(event && event.source || '').toLowerCase();
  if (source === 'holiday') return event && event.sourceLabel ? event.sourceLabel : t('calendar_source_holiday');
  if (source === 'ical') return event && event.sourceLabel ? event.sourceLabel : t('calendar_source_ical');
  return t('calendar_source_local');
}

function formatCalendarEventTimeLabel(event) {
  if (!event) return '--';
  const startMs = getEventStartMs(event);
  const endMs = getEventEndMs(event);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return '--';
  if (event.isAllDay) return t('calendar_all_day');
  const start = new Date(startMs);
  const end = new Date(endMs);
  const timeFmt = new Intl.DateTimeFormat(t('locale'), { hour: '2-digit', minute: '2-digit' });
  const sameDay = toDateInputValue(start) === toDateInputValue(end);
  if (sameDay) return `${timeFmt.format(start)} - ${timeFmt.format(end)}`;
  const shortFmt = new Intl.DateTimeFormat(t('locale'), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  return `${shortFmt.format(start)} - ${shortFmt.format(end)}`;
}

function formatCalendarEventUpcomingWhen(event) {
  if (!event) return '--';
  const startMs = getEventStartMs(event);
  if (!Number.isFinite(startMs)) return '--';
  if (event.isAllDay) {
    const fmt = new Intl.DateTimeFormat(t('locale'), { day: '2-digit', month: 'short' });
    return `${fmt.format(new Date(startMs))} · ${t('calendar_all_day')}`;
  }
  const fmt = new Intl.DateTimeFormat(t('locale'), { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  return fmt.format(new Date(startMs));
}

function getCenterCalendarDailySnapshot(nowMs = Date.now()) {
  const todayValue = toDateInputValue(new Date(nowMs));
  const events = eventsForDate(todayValue).filter(event => (
    Number.isFinite(getEventStartMs(event)) && Number.isFinite(getEventEndMs(event))
  ));

  const current = events.find(event => {
    const startMs = getEventStartMs(event);
    const endMs = getEventEndMs(event);
    return startMs <= nowMs && endMs > nowMs;
  });
  if (current) return { kind: 'now', event: current };

  const next = events.find(event => getEventStartMs(event) >= nowMs);
  if (next) return { kind: 'next', event: next };

  return { kind: 'none', event: null };
}

function updateCenterCalendarEventWidget(force = false) {
  const root = $('center-date-event');
  if (!root) return;

  const now = new Date();
  const minuteKey = `${toDateInputValue(now)}T${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const stamp = `${calendarEventsRevision}|${lang}|${minuteKey}`;
  if (!force && centerCalendarEventRenderStamp === stamp) return;
  centerCalendarEventRenderStamp = stamp;

  const title = $('center-event-title');
  const time = $('center-event-time');
  const chip = $('center-event-chip');
  if (!title || !time || !chip) return;

  const snapshot = getCenterCalendarDailySnapshot(now.getTime());
  root.classList.remove('now', 'next', 'empty');

  if (!snapshot.event || snapshot.kind === 'none') {
    root.classList.add('empty');
    chip.hidden = true;
    chip.style.display = 'none';
    title.textContent = t('center_event_none');
    time.textContent = '';
    return;
  }

  chip.hidden = false;
  chip.style.display = 'inline-flex';
  const isNow = snapshot.kind === 'now';
  root.classList.add(isNow ? 'now' : 'next');
  chip.textContent = isNow ? t('center_event_now') : t('center_event_next');
  title.textContent = snapshot.event.title || t('ph_title');
  time.textContent = formatCalendarEventTimeLabel(snapshot.event);
}

function renderUpcoming() {
  const list = $('upcoming-list');
  if (!list) return;
  const now = Date.now();
  const upcoming = calendarEvents
    .filter(event => {
      if (isHolidayCalendarEvent(event)) return false;
      const endMs = getEventEndMs(event);
      return Number.isFinite(endMs) && endMs >= now - 60000;
    })
    .sort((a, b) => {
      const left = getEventStartMs(a);
      const right = getEventStartMs(b);
      if (Number.isFinite(left) && Number.isFinite(right) && left !== right) return left - right;
      return String(a.title || '').localeCompare(String(b.title || ''), t('locale'), { sensitivity: 'base' });
    })
    .slice(0, 4);
  list.innerHTML = '';
  if (!upcoming.length) {
    const empty = document.createElement('div');
    empty.className = 'event-empty';
    empty.textContent = t('no_upcoming');
    list.appendChild(empty);
    updateCenterCalendarEventWidget(true);
    return;
  }
  upcoming.forEach(e => {
    const item = document.createElement('div');
    item.className = 'upcoming-item';
    item.style.cursor = 'pointer';
    item.onclick = () => openDayModal(String(e.startsAt).slice(0, 10));
    const dot = document.createElement('span');
    dot.className = 'upcoming-dot';
    if (e.special) dot.classList.add('special');
    const main = document.createElement('div');
    main.className = 'upcoming-main';
    const name = document.createElement('span');
    name.className = 'upcoming-name';
    name.textContent = e.title || t('ph_title');
    const meta = document.createElement('span');
    meta.className = 'upcoming-meta';
    meta.textContent = formatCalendarEventUpcomingWhen(e);
    const metaSecondary = document.createElement('span');
    metaSecondary.className = 'upcoming-meta-secondary';
    const secondaryParts = [e.location, getCalendarEventSourceLabel(e)].filter(Boolean);
    metaSecondary.textContent = secondaryParts.join(' · ');
    main.appendChild(name);
    main.appendChild(meta);
    if (metaSecondary.textContent) main.appendChild(metaSecondary);
    const when = document.createElement('span');
    when.className = 'upcoming-when';
    when.textContent = formatCalendarEventTimeLabel(e);
    item.appendChild(dot);
    item.appendChild(main);
    item.appendChild(when);
    list.appendChild(item);
  });
  updateCenterCalendarEventWidget(true);
}

function updateDayModalTitle() {
  if (!modalDateValue) return;
  const formatted = new Intl.DateTimeFormat(t('locale'), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(modalDateValue + 'T00:00:00'));
  $('day-modal-title').textContent = formatted.charAt(0).toUpperCase() + formatted.slice(1);
}

function openDayModal(dateValue) {
  modalDateValue = dateValue;
  selectedCalendarDate = dateValue;
  updateDayModalTitle();
  renderDayModalEvents();
  $('event-title').value = '';
  $('event-notes').value = '';
  $('event-time').value = '09:00';
  const lbl = $('time-picker-label');
  if (lbl) lbl.textContent = '09:00';
  $('event-reminder').value = '0';
  $('day-modal').classList.add('open');
  setTimeout(() => $('event-title').focus(), 80);
  if (calendarMode) renderCalendar();
}

function closeDayModal() {
  $('day-modal').classList.remove('open');
  modalDateValue = null;
}

function renderDayModalEvents() {
  const list = $('day-modal-events');
  if (!list) return;
  list.innerHTML = '';
  const events = eventsForDate(modalDateValue || selectedCalendarDate);
  if (!events.length) {
    const empty = document.createElement('div');
    empty.className = 'event-empty';
    empty.textContent = t('no_events');
    list.appendChild(empty);
    return;
  }
  events.forEach(event => {
    const item = document.createElement('div');
    item.className = 'event-item';
    if (isHolidayCalendarEvent(event)) item.classList.add('holiday');
    const top = document.createElement('div');
    top.className = 'event-item-top';
    const name = document.createElement('div');
    name.className = 'event-name';
    name.textContent = event.title || t('ph_title');
    const time = document.createElement('div');
    time.className = 'event-time';
    time.textContent = formatCalendarEventTimeLabel(event);
    top.appendChild(name);
    top.appendChild(time);
    const canDelete = !event.readOnly && event.source !== 'ical';
    if (canDelete) {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'event-delete';
      del.title = t('delete_event');
      del.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
      del.onclick = () => deleteCalendarEvent(event.id);
      top.appendChild(del);
    }
    item.appendChild(top);
    const badges = document.createElement('div');
    badges.className = 'event-badges';
    const sourceBadge = document.createElement('span');
    const sourceClass = isHolidayCalendarEvent(event)
      ? 'holiday'
      : (event.source === 'ical' ? 'ical' : 'local');
    sourceBadge.className = `event-badge ${sourceClass}`;
    sourceBadge.textContent = getCalendarEventSourceLabel(event);
    badges.appendChild(sourceBadge);
    if (event.special) {
      const special = document.createElement('span');
      special.className = 'event-badge special';
      special.textContent = t('calendar_special_day');
      badges.appendChild(special);
    }
    item.appendChild(badges);

    const details = [];
    if (event.location) details.push(event.location);
    if (event.notes) details.push(event.notes);
    if (details.length) {
      const meta = document.createElement('div');
      meta.className = 'event-meta';
      meta.textContent = details.join(' · ');
      item.appendChild(meta);
    }
    list.appendChild(item);
  });
}

function selectCalendarDate(dateValue) {
  selectedCalendarDate = dateValue;
  renderCalendar();
}

function moveCalendarMonth(delta) {
  calendarViewDate = new Date(calendarViewDate.getFullYear(), calendarViewDate.getMonth() + delta, 1);
  renderCalendar();
}

function jumpCalendarToday() {
  const today = new Date();
  selectedCalendarDate = toDateInputValue(today);
  calendarViewDate = new Date(today.getFullYear(), today.getMonth(), 1);
  renderCalendar();
}

async function loadCalendarEvents(forceRefresh = false) {
  scheduleCalendarSyncRefresh();
  try {
    const query = forceRefresh ? '?refresh=1' : '';
    const res = await fetch(`${SERVER}/calendar/events${query}`, { cache: 'no-store' });
    if (!res.ok) throw new Error('calendar events unavailable');
    const data = await res.json().catch(() => ({}));
    const localList = Array.isArray(data.localEvents)
      ? data.localEvents
      : (Array.isArray(data.events) ? data.events.filter(event => {
        const source = String(event && event.source || '').toLowerCase();
        return source !== 'ical' && source !== 'holiday';
      }) : []);
    const remoteList = Array.isArray(data.remoteEvents)
      ? data.remoteEvents
      : (Array.isArray(data.events) ? data.events.filter(event => {
        const source = String(event && event.source || '').toLowerCase();
        return source === 'ical' || source === 'holiday';
      }) : []);
    calendarLocalEvents = localList.map(event => normalizeCalendarEventItem(event, 'local'));
    calendarRemoteEvents = remoteList.map(event => normalizeCalendarEventItem(event, 'ical'));
    calendarSyncMeta = data && data.sync && typeof data.sync === 'object' ? data.sync : null;
    rebuildCalendarEvents();
    calendarLoaded = true;
    if (calendarMode) renderCalendar();
    renderUpcoming();
  } catch {
    try {
      const fallbackRes = await fetch(`${SERVER}/events`, { cache: 'no-store' });
      if (!fallbackRes.ok) throw new Error('events unavailable');
      const fallbackData = await fallbackRes.json().catch(() => ({}));
      const localList = Array.isArray(fallbackData.events) ? fallbackData.events : [];
      calendarLocalEvents = localList.map(event => normalizeCalendarEventItem(event, 'local'));
      calendarRemoteEvents = [];
      calendarSyncMeta = null;
      rebuildCalendarEvents();
      calendarLoaded = true;
      if (calendarMode) renderCalendar();
      renderUpcoming();
    } catch {
      calendarLoaded = true;
      calendarLocalEvents = [];
      calendarRemoteEvents = [];
      calendarSyncMeta = null;
      calendarEvents = [];
      if (calendarMode) renderCalendar();
      renderUpcoming();
    }
  }
}

async function persistCalendarEvents() {
  await fetch(SERVER + '/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ events: calendarLocalEvents }),
  });
}

async function saveCalendarEvent() {
  const title = $('event-title').value.trim();
  const dateValue = modalDateValue || selectedCalendarDate;
  const starts = combineDateTime(dateValue, $('event-time').value);
  if (!title || !starts) return;
  const reminderMinutes = Number($('event-reminder').value);
  const reminderAt = reminderMinutes >= 0 ? toLocalDateTimeValue(new Date(starts.getTime() - reminderMinutes * 60000)) : '';
  calendarLocalEvents.push(normalizeCalendarEventItem({
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    title,
    notes: $('event-notes').value.trim(),
    startsAt: toLocalDateTimeValue(starts),
    reminderAt,
    notifiedAt: '',
    createdAt: toLocalDateTimeValue(new Date()),
    source: 'local',
    sourceLabel: t('calendar_source_local'),
    readOnly: false,
  }, 'local'));
  rebuildCalendarEvents();
  $('event-title').value = '';
  $('event-notes').value = '';
  selectedCalendarDate = dateValue;
  calendarViewDate = new Date(starts.getFullYear(), starts.getMonth(), 1);
  await persistCalendarEvents().catch(() => {});
  if (calendarMode) renderCalendar();
  renderDayModalEvents();
  renderUpcoming();
  if ('Notification' in window && Notification.permission === 'default') {
    try { Promise.resolve(Notification.requestPermission()).catch(() => {}); } catch {}
  }
}

async function deleteCalendarEvent(id) {
  const targetId = String(id || '');
  if (!targetId) return;
  calendarLocalEvents = calendarLocalEvents.filter(event => String(event && event.id || '') !== targetId);
  rebuildCalendarEvents();
  await persistCalendarEvents().catch(() => {});
  if (calendarMode) renderCalendar();
  if ($('day-modal').classList.contains('open')) renderDayModalEvents();
  renderUpcoming();
}

function showReminder(event) {
  const fmt = new Intl.DateTimeFormat(t('locale'), { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  const meta = fmt.format(new Date(event.startsAt));
  const toast = $('event-toast');
  $('toast-kicker').textContent = t('reminder');
  $('toast-title').textContent = event.title || t('ph_title');
  $('toast-meta').textContent = meta;
  toast.classList.remove('show');
  void toast.offsetWidth;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(dismissReminderToast, 14000);
  playReminderSound();
  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      new Notification(t('desktop_title'), { body: `${event.title || t('ph_title')} - ${meta}`, silent: false, requireInteraction: true });
    } catch { }
  }
}

async function checkReminders() {
  if (!calendarLoaded || !calendarLocalEvents.length) return;
  const now = Date.now();
  let changed = false;
  calendarLocalEvents.forEach(event => {
    if (!event.reminderAt || event.notifiedAt) return;
    const reminderTime = Date.parse(event.reminderAt);
    if (Number.isFinite(reminderTime) && reminderTime <= now) {
      event.notifiedAt = new Date().toISOString();
      changed = true;
      showReminder(event);
    }
  });
  if (changed) {
    rebuildCalendarEvents();
    await persistCalendarEvents().catch(() => {});
  }
}
