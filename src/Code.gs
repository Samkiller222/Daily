/**
 * Daily Helper — a Google Apps Script web app.
 *
 * - Weather for your saved location (Open-Meteo, no API key needed)
 * - Your Google Calendar (today + the coming week)
 * - A weekly training regimen stored in this Google Sheet. Each day of the
 *   week has its own regimen that repeats every week until you change it.
 *
 * The script must be bound to the spreadsheet (Extensions > Apps Script),
 * which is where all data lives.
 */

var DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

var SHEETS = {
  regimen: { name: 'Regimen', headers: ['Day', 'Order', 'Exercise', 'Sets', 'Reps', 'Weight', 'Notes'] },
  settings: { name: 'Settings', headers: ['Key', 'Value'] },
  log: { name: 'Log', headers: ['Date', 'Day', 'Completed', 'Notes', 'Logged At'] }
};

var DEFAULT_SETTINGS = {
  locationName: '',
  latitude: '',
  longitude: '',
  units: 'fahrenheit',       // or 'celsius'
  calendarId: 'primary',
  workoutTime: '07:00',
  workoutMinutes: '60'
};

// ---------------------------------------------------------------------------
// Web app entry point
// ---------------------------------------------------------------------------

function doGet() {
  ensureSheets_();
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('Daily Helper')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

/** Everything the page needs on first load, in one round trip. */
function getDashboard() {
  ensureSheets_();
  var settings = getSettings();
  var tz = timeZone_();
  var now = new Date();
  var result = {
    today: Utilities.formatDate(now, tz, 'yyyy-MM-dd'),
    dayName: dayName_(now),
    settings: settings,
    regimen: getWeekRegimen(),
    log: getLogEntry(Utilities.formatDate(now, tz, 'yyyy-MM-dd')),
    weather: null,
    weatherError: null,
    events: [],
    calendarError: null
  };
  if (settings.latitude !== '' && settings.longitude !== '') {
    try { result.weather = getWeather(); } catch (e) { result.weatherError = String(e.message || e); }
  }
  try { result.events = getUpcomingEvents(7); } catch (e) { result.calendarError = String(e.message || e); }
  return result;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function getSettings() {
  var sheet = sheet_(SHEETS.settings);
  var values = sheet.getDataRange().getValues().slice(1);
  var settings = {};
  Object.keys(DEFAULT_SETTINGS).forEach(function (k) { settings[k] = DEFAULT_SETTINGS[k]; });
  values.forEach(function (row) {
    if (row[0] !== '') settings[row[0]] = String(row[1]);
  });
  return settings;
}

function saveSettings(partial) {
  var sheet = sheet_(SHEETS.settings);
  var values = sheet.getDataRange().getValues();
  Object.keys(partial).forEach(function (key) {
    if (!(key in DEFAULT_SETTINGS)) return;
    var value = partial[key] == null ? '' : String(partial[key]);
    var rowIndex = -1;
    for (var i = 1; i < values.length; i++) {
      if (values[i][0] === key) { rowIndex = i; break; }
    }
    if (rowIndex === -1) {
      sheet.appendRow([key, value]);
      values.push([key, value]);
    } else {
      // Store as plain text so Sheets doesn't turn "07:00" into a time.
      sheet.getRange(rowIndex + 1, 2).setNumberFormat('@').setValue(value);
    }
  });
  return getSettings();
}

// ---------------------------------------------------------------------------
// Weather (Open-Meteo — free, no key)
// ---------------------------------------------------------------------------

/** Search for a place by name. Returns a short list of matches. */
function searchLocation(query) {
  var url = 'https://geocoding-api.open-meteo.com/v1/search?count=5&language=en&format=json&name=' +
    encodeURIComponent(query);
  var data = JSON.parse(UrlFetchApp.fetch(url).getContentText());
  return (data.results || []).map(function (r) {
    return {
      name: [r.name, r.admin1, r.country].filter(Boolean).join(', '),
      latitude: r.latitude,
      longitude: r.longitude
    };
  });
}

function getWeather() {
  var s = getSettings();
  if (s.latitude === '' || s.longitude === '') throw new Error('Set your location first.');
  var fahrenheit = s.units !== 'celsius';
  var url = 'https://api.open-meteo.com/v1/forecast' +
    '?latitude=' + encodeURIComponent(s.latitude) +
    '&longitude=' + encodeURIComponent(s.longitude) +
    '&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,is_day' +
    '&hourly=temperature_2m,precipitation_probability,weather_code' +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset,uv_index_max' +
    '&timezone=auto&forecast_days=7' +
    '&temperature_unit=' + (fahrenheit ? 'fahrenheit' : 'celsius') +
    '&wind_speed_unit=' + (fahrenheit ? 'mph' : 'kmh') +
    '&precipitation_unit=' + (fahrenheit ? 'inch' : 'mm');
  var data = JSON.parse(UrlFetchApp.fetch(url).getContentText());

  // Next 12 hours starting from the current hour.
  var nowHour = data.current.time.slice(0, 13);
  var start = Math.max(0, data.hourly.time.findIndex(function (t) { return t.slice(0, 13) === nowHour; }));
  var hourly = [];
  for (var i = start; i < Math.min(start + 12, data.hourly.time.length); i++) {
    hourly.push({
      time: data.hourly.time[i],
      temp: data.hourly.temperature_2m[i],
      precipChance: data.hourly.precipitation_probability[i],
      code: data.hourly.weather_code[i]
    });
  }

  return {
    location: s.locationName,
    units: { temp: fahrenheit ? '°F' : '°C', wind: fahrenheit ? 'mph' : 'km/h', precip: fahrenheit ? 'in' : 'mm' },
    current: {
      temp: data.current.temperature_2m,
      feelsLike: data.current.apparent_temperature,
      humidity: data.current.relative_humidity_2m,
      precipitation: data.current.precipitation,
      wind: data.current.wind_speed_10m,
      code: data.current.weather_code,
      isDay: data.current.is_day === 1
    },
    hourly: hourly,
    daily: data.daily.time.map(function (date, i) {
      return {
        date: date,
        code: data.daily.weather_code[i],
        max: data.daily.temperature_2m_max[i],
        min: data.daily.temperature_2m_min[i],
        precipChance: data.daily.precipitation_probability_max[i],
        sunrise: data.daily.sunrise[i],
        sunset: data.daily.sunset[i],
        uv: data.daily.uv_index_max[i]
      };
    })
  };
}

// ---------------------------------------------------------------------------
// Google Calendar
// ---------------------------------------------------------------------------

function calendar_() {
  var id = getSettings().calendarId || 'primary';
  var cal = id === 'primary' ? CalendarApp.getDefaultCalendar() : CalendarApp.getCalendarById(id);
  if (!cal) throw new Error('Calendar not found: ' + id);
  return cal;
}

function listCalendars() {
  return CalendarApp.getAllCalendars().map(function (c) {
    return { id: c.getId(), name: c.getName() };
  });
}

function getUpcomingEvents(days) {
  var tz = timeZone_();
  var start = parseLocal_(Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd'));
  var end = new Date(start.getTime() + (days || 7) * 24 * 3600 * 1000);
  return calendar_().getEvents(start, end).map(function (e) {
    return {
      title: e.getTitle(),
      date: Utilities.formatDate(e.getStartTime(), tz, 'yyyy-MM-dd'),
      start: Utilities.formatDate(e.getStartTime(), tz, "yyyy-MM-dd'T'HH:mm"),
      end: Utilities.formatDate(e.getEndTime(), tz, "yyyy-MM-dd'T'HH:mm"),
      allDay: e.isAllDayEvent(),
      location: e.getLocation()
    };
  });
}

/**
 * Adds a workout event for the given date (yyyy-MM-dd) at time (HH:mm),
 * with the regimen for that weekday in the description.
 */
function addWorkoutToCalendar(dateStr, timeStr, minutes) {
  var start = parseLocal_(dateStr, timeStr || '07:00');
  var end = new Date(start.getTime() + (Number(minutes) || 60) * 60000);
  var day = dayName_(parseLocal_(dateStr, '12:00'));
  var exercises = getWeekRegimen()[day] || [];
  var description = exercises.length
    ? exercises.map(function (x) { return '• ' + formatExercise_(x); }).join('\n')
    : 'No exercises set for ' + day + '.';
  calendar_().createEvent('Training — ' + day, start, end, { description: description });
  saveSettings({ workoutTime: timeStr, workoutMinutes: String(minutes) });
  return getUpcomingEvents(7);
}

// ---------------------------------------------------------------------------
// Weekly training regimen
// ---------------------------------------------------------------------------

/** Returns { Monday: [ {exercise, sets, reps, weight, notes}, ... ], ... } */
function getWeekRegimen() {
  var rows = sheet_(SHEETS.regimen).getDataRange().getValues().slice(1);
  var week = {};
  DAYS.forEach(function (d) { week[d] = []; });
  rows.forEach(function (r) {
    if (!week[r[0]] || r[2] === '') return;
    week[r[0]].push({
      order: Number(r[1]) || 0,
      exercise: String(r[2]),
      sets: String(r[3]),
      reps: String(r[4]),
      weight: String(r[5]),
      notes: String(r[6])
    });
  });
  DAYS.forEach(function (d) { week[d].sort(function (a, b) { return a.order - b.order; }); });
  return week;
}

/** Replaces the regimen for one day of the week. */
function saveDayRegimen(day, exercises) {
  if (DAYS.indexOf(day) === -1) throw new Error('Unknown day: ' + day);
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sheet = sheet_(SHEETS.regimen);
    var all = sheet.getDataRange().getValues();
    var header = all[0];
    var kept = all.slice(1).filter(function (r) { return r[0] !== day && r.join('') !== ''; });
    var fresh = (exercises || [])
      .filter(function (x) { return x && String(x.exercise || '').trim() !== ''; })
      .map(function (x, i) {
        return [day, i + 1, String(x.exercise).trim(), x.sets || '', x.reps || '', x.weight || '', x.notes || ''];
      });
    var rows = kept.concat(fresh);
    rows.sort(function (a, b) {
      return (DAYS.indexOf(a[0]) - DAYS.indexOf(b[0])) || (Number(a[1]) - Number(b[1]));
    });
    sheet.getRange(2, 1, Math.max(sheet.getLastRow(), 2), header.length).clearContent();
    if (rows.length) {
      sheet.getRange(2, 1, rows.length, header.length).setNumberFormat('@').setValues(
        rows.map(function (r) { return r.map(String); })
      );
    }
  } finally {
    lock.releaseLock();
  }
  return getWeekRegimen();
}

/** Copies one day's regimen onto another day. */
function copyDayRegimen(fromDay, toDay) {
  return saveDayRegimen(toDay, getWeekRegimen()[fromDay] || []);
}

// ---------------------------------------------------------------------------
// Daily log (optional: mark today's training done)
// ---------------------------------------------------------------------------

function getLogEntry(dateStr) {
  var rows = sheet_(SHEETS.log).getDataRange().getValues().slice(1);
  for (var i = rows.length - 1; i >= 0; i--) {
    if (normalizeDate_(rows[i][0]) === dateStr) {
      return { date: dateStr, completed: rows[i][2] === true || rows[i][2] === 'TRUE', notes: String(rows[i][3]) };
    }
  }
  return null;
}

function saveLogEntry(dateStr, completed, notes) {
  var sheet = sheet_(SHEETS.log);
  var rows = sheet.getDataRange().getValues();
  var row = [dateStr, dayName_(parseLocal_(dateStr, '12:00')), !!completed, notes || '', new Date()];
  for (var i = rows.length - 1; i >= 1; i--) {
    if (normalizeDate_(rows[i][0]) === dateStr) {
      sheet.getRange(i + 1, 1).setNumberFormat('@');
      sheet.getRange(i + 1, 1, 1, row.length).setValues([row]);
      return getLogEntry(dateStr);
    }
  }
  sheet.appendRow(row);
  sheet.getRange(sheet.getLastRow(), 1).setNumberFormat('@').setValue(dateStr);
  return getLogEntry(dateStr);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureSheets_() {
  Object.keys(SHEETS).forEach(function (k) { sheet_(SHEETS[k]); });
}

function sheet_(def) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(def.name);
  if (!sheet) {
    sheet = ss.insertSheet(def.name);
    sheet.getRange(1, 1, 1, def.headers.length).setValues([def.headers]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function timeZone_() {
  return SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone() || Session.getScriptTimeZone();
}

/** Day name in the spreadsheet's time zone (Monday..Sunday). */
function dayName_(date) {
  return Utilities.formatDate(date, timeZone_(), 'EEEE');
}

/** Parses 'yyyy-MM-dd' (+ optional 'HH:mm') in the spreadsheet's time zone. */
function parseLocal_(dateStr, timeStr) {
  return Utilities.parseDate(dateStr + ' ' + (timeStr || '00:00'), timeZone_(), 'yyyy-MM-dd HH:mm');
}

function normalizeDate_(v) {
  return v instanceof Date ? Utilities.formatDate(v, timeZone_(), 'yyyy-MM-dd') : String(v);
}

function formatExercise_(x) {
  var detail = [];
  if (x.sets && x.reps) detail.push(x.sets + '×' + x.reps);
  else if (x.sets) detail.push(x.sets + ' sets');
  else if (x.reps) detail.push(x.reps);
  if (x.weight) detail.push('@ ' + x.weight);
  var s = x.exercise + (detail.length ? ' — ' + detail.join(' ') : '');
  return x.notes ? s + ' (' + x.notes + ')' : s;
}
