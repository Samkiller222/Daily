/**
 * Daily Helper — a Google Apps Script web app.
 *
 * - Weather for your saved location (Open-Meteo, no API key needed)
 * - Your Google Calendar (today + the coming week)
 * - A weekly training regimen stored in this Google Sheet. Each day of the
 *   week has its own regimen that repeats every week until you change it.
 * - A calorie and macro tracker. Snap a photo of a meal and Gemini estimates
 *   calories, protein, carbs and fat; you review it, then it's saved here.
 *   Meals you eat often can be saved as recipes and picked from a list.
 * - A daily checklist of weekly repeating tasks and one-time tasks.
 * - Workout check-off: tick off each exercise, with a training streak.
 * - Habit counters (water, sleep, ...) you tap up and down through the day.
 * - A weekly summary and a morning brief, in the app or as a daily email.
 *
 * The script must be bound to the spreadsheet (Extensions > Apps Script),
 * which is where all data lives.
 */

var DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

var SHEETS = {
  regimen: { name: 'Regimen', headers: ['Day', 'Order', 'Exercise', 'Sets', 'Reps', 'Weight', 'Notes'] },
  settings: { name: 'Settings', headers: ['Key', 'Value'] },
  log: { name: 'Log', headers: ['Date', 'Day', 'Completed', 'Notes', 'Logged At'] },
  food: { name: 'Food Log', headers: ['Date', 'Time', 'Meal', 'Food', 'Portion', 'Calories',
    'Protein (g)', 'Carbs (g)', 'Fat (g)', 'Source', 'ID'] },
  recipes: { name: 'Recipes', headers: ['ID', 'Name', 'Portion', 'Calories', 'Protein (g)', 'Carbs (g)', 'Fat (g)', 'Created'] },
  tasks: { name: 'Tasks', headers: ['ID', 'Type', 'Title', 'Days', 'Date', 'Order', 'Created'] },
  taskChecks: { name: 'Task Checks', headers: ['Date', 'Task ID', 'Checked At'] },
  workoutChecks: { name: 'Workout Checks', headers: ['Date', 'Exercise', 'Checked At'] },
  habits: { name: 'Habits', headers: ['ID', 'Name', 'Icon', 'Target', 'Unit', 'Order', 'Created'],
    seed: function () {
      return [[Utilities.getUuid(), 'Water', '💧', 8, 'glasses', 1, new Date()],
        [Utilities.getUuid(), 'Sleep', '😴', 8, 'hours', 2, new Date()]];
    } },
  habitLog: { name: 'Habit Log', headers: ['Date', 'Habit ID', 'Count', 'Updated'] }
};

// How many days of food totals the app loads (the Food tab shows the last 7,
// the rest is for the on-target streak).
var FOOD_HISTORY_DAYS = 30;

var DEFAULT_SETTINGS = {
  locationName: '',
  latitude: '',
  longitude: '',
  units: 'fahrenheit',       // or 'celsius'
  calendarId: 'primary',
  workoutTime: '07:00',
  workoutMinutes: '60',
  calorieGoal: '2000',
  proteinGoal: '150',
  carbsGoal: '200',
  fatGoal: '65',
  geminiModel: 'gemini-3.8-flash',
  morningEmail: 'off',       // 'on' sends the morning brief by email every day
  morningEmailHour: '7'      // hour of the day (0-23) in the script's time zone
};

// The Gemini API key is kept in Script Properties (never in the sheet).
var GEMINI_KEY_PROP = 'GEMINI_API_KEY';

// ---------------------------------------------------------------------------
// Web app entry point
// ---------------------------------------------------------------------------

function doGet() {
  ensureSheets_();
  return HtmlService.createTemplateFromFile('index')
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
    calendarError: null,
    food: getFoodDay(Utilities.formatDate(now, tz, 'yyyy-MM-dd')),
    foodHistory: getFoodHistory(FOOD_HISTORY_DAYS),
    recipes: getRecipes(),
    checklist: getChecklist(Utilities.formatDate(now, tz, 'yyyy-MM-dd')),
    workout: getWorkoutDay(Utilities.formatDate(now, tz, 'yyyy-MM-dd')),
    habits: getHabits(Utilities.formatDate(now, tz, 'yyyy-MM-dd')),
    geminiConfigured: isGeminiConfigured()
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

// Google Calendar's event colour ids -> hex.
var EVENT_COLORS = {
  '1': '#7986cb', '2': '#33b679', '3': '#8e24aa', '4': '#e67c73', '5': '#f6bf26', '6': '#f4511e',
  '7': '#039be5', '8': '#616161', '9': '#3f51b5', '10': '#0b8043', '11': '#d50000'
};

/**
 * Events from every calendar you can see, between two dates (yyyy-MM-dd,
 * end exclusive). Used by the Calendar tab.
 */
function getCalendarRange(startStr, endStr) {
  var tz = timeZone_();
  var start = parseLocal_(startStr);
  var end = parseLocal_(endStr);
  var defaultId = CalendarApp.getDefaultCalendar().getId();
  var calendars = [];
  var events = [];
  CalendarApp.getAllCalendars().forEach(function (cal) {
    var info = {
      id: cal.getId(),
      name: cal.getId() === defaultId ? 'My calendar' : cal.getName(),
      color: cal.getColor(),
      hidden: cal.isHidden(),
      primary: cal.getId() === defaultId,
      canEdit: cal.isOwnedByMe()
    };
    calendars.push(info);
    var list;
    try { list = cal.getEvents(start, end); } catch (e) { return; }
    list.forEach(function (e) {
      var allDay = e.isAllDayEvent();
      var s = allDay ? e.getAllDayStartDate() : e.getStartTime();
      var en = allDay ? e.getAllDayEndDate() : e.getEndTime();
      events.push({
        id: e.getId(),
        calendarId: info.id,
        title: e.getTitle() || '(No title)',
        allDay: allDay,
        start: Utilities.formatDate(s, tz, "yyyy-MM-dd'T'HH:mm"),
        end: Utilities.formatDate(en, tz, "yyyy-MM-dd'T'HH:mm"),
        location: e.getLocation(),
        description: e.getDescription(),
        color: EVENT_COLORS[e.getColor()] || info.color,
        recurring: e.isRecurringEvent(),
        canEdit: info.canEdit
      });
    });
  });
  events.sort(function (a, b) { return a.start < b.start ? -1 : a.start > b.start ? 1 : 0; });
  calendars.sort(function (a, b) { return (b.primary - a.primary) || a.name.localeCompare(b.name); });
  return { calendars: calendars, events: events };
}

/**
 * Creates an event. ev: {calendarId, title, date, endDate?, allDay, startTime, endTime,
 * location, description}. Dates are yyyy-MM-dd and times HH:mm.
 */
function createCalendarEvent(ev) {
  if (!ev || !String(ev.title || '').trim()) throw new Error('Give the event a title.');
  var cal = ev.calendarId ? CalendarApp.getCalendarById(ev.calendarId) : CalendarApp.getDefaultCalendar();
  if (!cal) throw new Error('Calendar not found.');
  var opts = { location: ev.location || '', description: ev.description || '' };
  if (ev.allDay) {
    var first = parseLocal_(ev.date, '12:00');
    var last = parseLocal_(ev.endDate || ev.date, '12:00');
    if (last < first) throw new Error('The end date is before the start date.');
    // CalendarApp's all-day end date is exclusive.
    var endExclusive = new Date(last.getTime() + 864e5);
    if (endExclusive - first <= 864e5) cal.createAllDayEvent(ev.title.trim(), first, opts);
    else cal.createAllDayEvent(ev.title.trim(), first, endExclusive, opts);
  } else {
    var start = parseLocal_(ev.date, ev.startTime || '09:00');
    var end = parseLocal_(ev.endDate || ev.date, ev.endTime || ev.startTime || '10:00');
    if (end <= start) end = new Date(start.getTime() + 3600e3);
    cal.createEvent(ev.title.trim(), start, end, opts);
  }
  return true;
}

/** Deletes a one-off event (recurring events are edited in Google Calendar). */
function deleteCalendarEvent(calendarId, eventId) {
  var cal = CalendarApp.getCalendarById(calendarId);
  if (!cal) throw new Error('Calendar not found.');
  var ev = cal.getEventById(eventId);
  if (!ev) throw new Error('Event not found. It may already be deleted.');
  if (ev.isRecurringEvent()) throw new Error('This is a repeating event. Delete it in Google Calendar.');
  ev.deleteEvent();
  return true;
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
// Daily checklist
// ---------------------------------------------------------------------------
// Weekly tasks show up on the weekdays listed in their Days column, every week.
// One-time tasks show up on their date and carry over each day until ticked.
// A row in Task Checks marks a task done on a date. Order is shared by all
// tasks, so a drag on one day keeps that order on later days.

var TASK_COL = { id: 0, type: 1, title: 2, days: 3, date: 4, order: 5, created: 6 };

function taskRows_() {
  return sheet_(SHEETS.tasks).getDataRange().getValues().slice(1)
    .map(function (r, i) {
      return {
        id: String(r[TASK_COL.id]),
        type: String(r[TASK_COL.type]) === 'weekly' ? 'weekly' : 'once',
        title: String(r[TASK_COL.title]),
        days: String(r[TASK_COL.days]).split(',')
          .map(function (d) { return d.trim(); })
          .filter(function (d) { return DAYS.indexOf(d) !== -1; }),
        date: normalizeDate_(r[TASK_COL.date]),
        order: Number(r[TASK_COL.order]) || 0,
        row: i
      };
    })
    .filter(function (t) { return t.id !== '' && t.title !== ''; })
    .sort(function (a, b) { return (a.order - b.order) || (a.row - b.row); });
}

/** { taskId: [yyyy-MM-dd, ...] } for every tick ever made. */
function taskChecks_() {
  var map = {};
  sheet_(SHEETS.taskChecks).getDataRange().getValues().slice(1).forEach(function (r) {
    var id = String(r[1]);
    if (id) (map[id] = map[id] || []).push(normalizeDate_(r[0]));
  });
  return map;
}

/**
 * The checklist for a date (yyyy-MM-dd):
 * { date, items: [{id, type, title, done, date, overdue}], upcoming: [...], weekly: [{id, title, days}] }
 */
function getChecklist(dateStr) {
  return checklistFor_(dateStr, taskRows_(), taskChecks_());
}

/** getChecklist() with the sheet rows already read, so a week can share one read. */
function checklistFor_(dateStr, rows, checks) {
  var day = dayName_(parseLocal_(dateStr, '12:00'));
  var out = { date: dateStr, items: [], upcoming: [], weekly: [] };
  rows.forEach(function (t) {
    var ticked = checks[t.id] || [];
    if (t.type === 'weekly') {
      out.weekly.push({ id: t.id, title: t.title, days: t.days });
      if (t.days.indexOf(day) !== -1) {
        out.items.push({ id: t.id, type: 'weekly', title: t.title, done: ticked.indexOf(dateStr) !== -1 });
      }
      return;
    }
    if (t.date > dateStr) {
      out.upcoming.push({ id: t.id, type: 'once', title: t.title, date: t.date });
      return;
    }
    var doneToday = ticked.indexOf(dateStr) !== -1;
    if (ticked.length && !doneToday) return; // finished on another day
    out.items.push({ id: t.id, type: 'once', title: t.title, done: doneToday, date: t.date, overdue: t.date < dateStr });
  });
  out.upcoming.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
  return out;
}

/** Adds a one-time task for dateStr (defaults to dashboardDate). */
function addOnceTask(title, dateStr, dashboardDate) {
  title = String(title || '').trim();
  if (!title) throw new Error('Give the task a name.');
  withLock_(function () { appendTask_('once', title, '', dateStr || dashboardDate); });
  return getChecklist(dashboardDate);
}

/** Creates a weekly task, or updates one when task.id is set. task: {id?, title, days: ['Monday', ...]} */
function saveWeeklyTask(task, dashboardDate) {
  var title = String(task && task.title || '').trim();
  if (!title) throw new Error('Give the task a name.');
  var days = DAYS.filter(function (d) { return (task.days || []).indexOf(d) !== -1; });
  if (!days.length) throw new Error('Pick at least one day.');
  withLock_(function () {
    if (!task.id) { appendTask_('weekly', title, days.join(','), ''); return; }
    var row = findRowById_(SHEETS.tasks, task.id);
    if (row === -1) throw new Error('Task not found. Reload the page.');
    sheet_(SHEETS.tasks).getRange(row, TASK_COL.title + 1, 1, 2).setNumberFormat('@').setValues([[title, days.join(',')]]);
  });
  return getChecklist(dashboardDate);
}

function deleteTask(id, dashboardDate) {
  withLock_(function () {
    var row = findRowById_(SHEETS.tasks, id);
    if (row !== -1) sheet_(SHEETS.tasks).deleteRow(row);
    var checks = sheet_(SHEETS.taskChecks);
    var values = checks.getDataRange().getValues();
    for (var i = values.length - 1; i >= 1; i--) {
      if (String(values[i][1]) === String(id)) checks.deleteRow(i + 1);
    }
  });
  return getChecklist(dashboardDate);
}

/** Ticks or unticks a task for dateStr. */
function setTaskDone(id, dateStr, done) {
  withLock_(function () {
    var sheet = sheet_(SHEETS.taskChecks);
    var values = sheet.getDataRange().getValues();
    for (var i = values.length - 1; i >= 1; i--) {
      if (String(values[i][1]) === String(id) && normalizeDate_(values[i][0]) === dateStr) sheet.deleteRow(i + 1);
    }
    if (done) {
      var r = sheet.getLastRow() + 1;
      sheet.getRange(r, 1, 1, 2).setNumberFormat('@');
      sheet.getRange(r, 1, 1, 3).setValues([[dateStr, String(id), new Date()]]);
    }
  });
  return getChecklist(dateStr);
}

/**
 * Saves a new order for the tasks in ids (the list as it was dragged). Tasks
 * not in ids keep their places; the listed ones swap into each other's slots.
 */
function saveTaskOrder(ids, dashboardDate) {
  withLock_(function () {
    var all = taskRows_();
    var listed = {};
    (ids || []).forEach(function (id) { listed[id] = true; });
    var moved = (ids || []).filter(function (id) { return all.some(function (t) { return t.id === id; }); });
    var k = 0;
    var ordered = all.map(function (t) { return listed[t.id] ? moved[k++] : t.id; });
    var sheet = sheet_(SHEETS.tasks);
    var values = sheet.getDataRange().getValues();
    var position = {};
    ordered.forEach(function (id, i) { position[id] = i + 1; });
    var column = values.slice(1).map(function (r) {
      var id = String(r[TASK_COL.id]);
      return [id in position ? position[id] : r[TASK_COL.order]];
    });
    if (column.length) sheet.getRange(2, TASK_COL.order + 1, column.length, 1).setValues(column);
  });
  return getChecklist(dashboardDate);
}

function appendTask_(type, title, days, date) {
  var sheet = sheet_(SHEETS.tasks);
  var last = taskRows_().reduce(function (m, t) { return Math.max(m, t.order); }, 0);
  var r = sheet.getLastRow() + 1;
  sheet.getRange(r, 1, 1, 5).setNumberFormat('@');
  sheet.getRange(r, 1, 1, 7).setValues([[Utilities.getUuid(), type, title, days, date, last + 1, new Date()]]);
}

/** 1-based row of the record whose first column is id, or -1. */
function findRowById_(def, id) {
  var sheet = sheet_(def);
  var ids = sheet.getRange(1, 1, Math.max(sheet.getLastRow(), 1), 1).getValues();
  for (var i = 1; i < ids.length; i++) {
    if (String(ids[i][0]) === String(id)) return i + 1;
  }
  return -1;
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try { return fn(); } finally { lock.releaseLock(); }
}

// ---------------------------------------------------------------------------
// Calorie & macro tracker
// ---------------------------------------------------------------------------

var FOOD_COL = { date: 0, time: 1, meal: 2, food: 3, portion: 4, calories: 5, protein: 6, carbs: 7, fat: 8, source: 9, id: 10 };

function rowToFood_(r) {
  return {
    id: String(r[FOOD_COL.id]),
    date: normalizeDate_(r[FOOD_COL.date]),
    time: r[FOOD_COL.time] instanceof Date ? Utilities.formatDate(r[FOOD_COL.time], timeZone_(), 'HH:mm') : String(r[FOOD_COL.time]),
    meal: String(r[FOOD_COL.meal]),
    food: String(r[FOOD_COL.food]),
    portion: String(r[FOOD_COL.portion]),
    calories: Number(r[FOOD_COL.calories]) || 0,
    protein: Number(r[FOOD_COL.protein]) || 0,
    carbs: Number(r[FOOD_COL.carbs]) || 0,
    fat: Number(r[FOOD_COL.fat]) || 0,
    source: String(r[FOOD_COL.source])
  };
}

function foodRows_() {
  return sheet_(SHEETS.food).getDataRange().getValues().slice(1)
    .filter(function (r) { return r[FOOD_COL.food] !== '' || r[FOOD_COL.calories] !== ''; })
    .map(rowToFood_);
}

/** All food entries for one date (yyyy-MM-dd). */
function getFoodDay(dateStr) {
  return foodRows_().filter(function (f) { return f.date === dateStr; });
}

/** Daily totals for the last `days` days, oldest first. */
function getFoodHistory(days) {
  var tz = timeZone_();
  var totals = {};
  var dates = [];
  for (var i = (days || 7) - 1; i >= 0; i--) {
    var d = Utilities.formatDate(new Date(Date.now() - i * 864e5), tz, 'yyyy-MM-dd');
    dates.push(d);
    totals[d] = { date: d, calories: 0, protein: 0, carbs: 0, fat: 0 };
  }
  foodRows_().forEach(function (f) {
    var t = totals[f.date];
    if (!t) return;
    t.calories += f.calories; t.protein += f.protein; t.carbs += f.carbs; t.fat += f.fat;
  });
  return dates.map(function (d) { return totals[d]; });
}

/**
 * Saves one or more food items for a date. Each item:
 * {food, portion, calories, protein, carbs, fat}. Returns the day's entries.
 */
function addFoodEntries(dateStr, meal, items, source) {
  var sheet = sheet_(SHEETS.food);
  var time = Utilities.formatDate(new Date(), timeZone_(), 'HH:mm');
  var rows = (items || [])
    .filter(function (x) { return x && String(x.food || '').trim() !== ''; })
    .map(function (x) {
      return [dateStr, time, meal || '', String(x.food).trim(), x.portion || '',
        num_(x.calories), num_(x.protein), num_(x.carbs), num_(x.fat), source || 'Manual', Utilities.getUuid()];
    });
  if (rows.length) {
    var start = sheet.getLastRow() + 1;
    sheet.getRange(start, 1, rows.length, 2).setNumberFormat('@');
    sheet.getRange(start, 1, rows.length, rows[0].length).setValues(rows);
  }
  return { food: getFoodDay(dateStr), foodHistory: getFoodHistory(FOOD_HISTORY_DAYS) };
}

function deleteFoodEntry(id, dateStr) {
  var sheet = sheet_(SHEETS.food);
  var ids = sheet.getRange(1, FOOD_COL.id + 1, sheet.getLastRow(), 1).getValues();
  for (var i = ids.length - 1; i >= 1; i--) {
    if (String(ids[i][0]) === String(id)) { sheet.deleteRow(i + 1); break; }
  }
  return { food: getFoodDay(dateStr), foodHistory: getFoodHistory(FOOD_HISTORY_DAYS) };
}

// ---------------------------------------------------------------------------
// Saved recipes
// ---------------------------------------------------------------------------
// Each row of Recipes is one meal you eat often, with calories and macros per
// serving. Picking it on the Food tab fills in a food entry you can still edit.

var RECIPE_COL = { id: 0, name: 1, portion: 2, calories: 3, protein: 4, carbs: 5, fat: 6, created: 7 };

/** Saved recipes, A to Z: [{id, name, portion, calories, protein, carbs, fat}]. */
function getRecipes() {
  return sheet_(SHEETS.recipes).getDataRange().getValues().slice(1)
    .map(function (r) {
      return {
        id: String(r[RECIPE_COL.id]),
        name: String(r[RECIPE_COL.name]),
        portion: String(r[RECIPE_COL.portion]),
        calories: Number(r[RECIPE_COL.calories]) || 0,
        protein: Number(r[RECIPE_COL.protein]) || 0,
        carbs: Number(r[RECIPE_COL.carbs]) || 0,
        fat: Number(r[RECIPE_COL.fat]) || 0
      };
    })
    .filter(function (x) { return x.id !== '' && x.name !== ''; })
    .sort(function (a, b) { return a.name.toLowerCase().localeCompare(b.name.toLowerCase()); });
}

/**
 * Creates a recipe, or updates one when recipe.id is set. Saving a new recipe
 * under a name that already exists replaces that one. Returns all recipes.
 * recipe: {id?, name, portion, calories, protein, carbs, fat}
 */
function saveRecipe(recipe) {
  var name = String(recipe && recipe.name || '').trim();
  if (!name) throw new Error('Give the recipe a name.');
  var values = [name, String(recipe.portion || '').trim(),
    num_(recipe.calories), num_(recipe.protein), num_(recipe.carbs), num_(recipe.fat)];
  withLock_(function () {
    var sheet = sheet_(SHEETS.recipes);
    var id = recipe.id;
    if (!id) {
      var same = getRecipes().filter(function (x) { return x.name.toLowerCase() === name.toLowerCase(); })[0];
      if (same) id = same.id;
    }
    if (!id) {
      var r = sheet.getLastRow() + 1;
      sheet.getRange(r, 1, 1, 3).setNumberFormat('@');
      sheet.getRange(r, 1, 1, 8).setValues([[Utilities.getUuid()].concat(values, [new Date()])]);
      return;
    }
    var row = findRowById_(SHEETS.recipes, id);
    if (row === -1) throw new Error('Recipe not found. Reload the page.');
    sheet.getRange(row, RECIPE_COL.name + 1, 1, 2).setNumberFormat('@');
    sheet.getRange(row, RECIPE_COL.name + 1, 1, values.length).setValues([values]);
  });
  return getRecipes();
}

function deleteRecipe(id) {
  withLock_(function () {
    var row = findRowById_(SHEETS.recipes, id);
    if (row !== -1) sheet_(SHEETS.recipes).deleteRow(row);
  });
  return getRecipes();
}

function num_(v) {
  var n = Number(v);
  return isFinite(n) ? Math.round(n * 10) / 10 : 0;
}

// ---------------------------------------------------------------------------
// Gemini: estimate macros from a food photo
// ---------------------------------------------------------------------------

function isGeminiConfigured() {
  return !!PropertiesService.getScriptProperties().getProperty(GEMINI_KEY_PROP);
}

/** Stores the Gemini API key privately. Pass '' to remove it. */
function saveGeminiKey(key) {
  var props = PropertiesService.getScriptProperties();
  key = String(key || '').trim();
  if (key) props.setProperty(GEMINI_KEY_PROP, key); else props.deleteProperty(GEMINI_KEY_PROP);
  return isGeminiConfigured();
}

/**
 * Sends a food photo (base64, no data: prefix) to Gemini and returns
 * { items: [{food, portion, calories, protein, carbs, fat}], notes }.
 * Nothing is saved until the user confirms with addFoodEntries().
 */
function analyzeFoodImage(base64, mimeType, description) {
  var key = PropertiesService.getScriptProperties().getProperty(GEMINI_KEY_PROP);
  if (!key) throw new Error('Add your Gemini API key in Settings first.');
  var model = getSettings().geminiModel || DEFAULT_SETTINGS.geminiModel;

  var prompt = [
    'You are a nutrition assistant. Identify each distinct food or drink in this photo and estimate',
    'its portion size and nutrition. Use visual cues (plate size, utensils, packaging) to judge portions.',
    description ? 'Extra details from the user: ' + description : '',
    'Respond with JSON only, in exactly this shape:',
    '{"items":[{"food":"string","portion":"string, e.g. 150 g or 1 cup","calories":number,',
    '"protein":number,"carbs":number,"fat":number}],"notes":"string, short caveats or empty"}',
    'calories are kcal; protein, carbs and fat are grams. If there is no food in the image,',
    'return {"items":[],"notes":"No food found"}.'
  ].join(' ');

  var body = {
    contents: [{
      role: 'user',
      parts: [
        { inline_data: { mime_type: mimeType || 'image/jpeg', data: base64 } },
        { text: prompt }
      ]
    }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0.2 }
  };

  var res = UrlFetchApp.fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent',
    {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-goog-api-key': key },
      payload: JSON.stringify(body),
      muteHttpExceptions: true
    }
  );
  var code = res.getResponseCode();
  var data = JSON.parse(res.getContentText() || '{}');
  if (code !== 200) {
    var msg = data.error && data.error.message ? data.error.message : res.getContentText();
    throw new Error('Gemini error (' + code + '): ' + msg);
  }

  var parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
  var text = parts.map(function (p) { return p.text || ''; }).join('').trim();
  // Strip ```json fences in case the model adds them.
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  var parsed;
  try { parsed = JSON.parse(text); } catch (e) { throw new Error('Could not read Gemini\'s answer. Try another photo.'); }

  return {
    items: (parsed.items || []).map(function (x) {
      return {
        food: String(x.food || ''),
        portion: String(x.portion || ''),
        calories: num_(x.calories),
        protein: num_(x.protein),
        carbs: num_(x.carbs),
        fat: num_(x.fat)
      };
    }),
    notes: String(parsed.notes || '')
  };
}

// ---------------------------------------------------------------------------
// Workout check-off and streak
// ---------------------------------------------------------------------------
// Each ticked exercise is a row in Workout Checks (Date, Exercise). Ticking the
// last one marks the day done in the Log tab. The streak counts days marked
// done in a row; rest days (no exercises in the regimen) don't break it, and
// today only counts once it's done.

/** { date: {completed, notes} } for every row in the Log tab. */
function logMap_() {
  var map = {};
  sheet_(SHEETS.log).getDataRange().getValues().slice(1).forEach(function (r) {
    var d = normalizeDate_(r[0]);
    if (d) map[d] = { completed: r[2] === true || r[2] === 'TRUE', notes: String(r[3]) };
  });
  return map;
}

/** Exercise names ticked on dateStr. */
function workoutChecks_(dateStr) {
  return sheet_(SHEETS.workoutChecks).getDataRange().getValues().slice(1)
    .filter(function (r) { return normalizeDate_(r[0]) === dateStr; })
    .map(function (r) { return String(r[1]); });
}

/**
 * Today's workout: { date, day, checked: [exercise names], completed, streak,
 * weekDone, weekPlanned }. The exercises themselves come from the regimen.
 */
function getWorkoutDay(dateStr) {
  var regimen = getWeekRegimen();
  var logs = logMap_();
  var today = parseLocal_(dateStr, '12:00');

  var streak = 0;
  for (var i = 0; i < 400; i++) {
    var d = new Date(today.getTime() - i * 864e5);
    var key = Utilities.formatDate(d, timeZone_(), 'yyyy-MM-dd');
    var done = logs[key] && logs[key].completed;
    if (done) { streak++; continue; }
    if (i === 0) continue;                                  // today isn't over yet
    if (!(regimen[dayName_(d)] || []).length) continue;    // rest day
    break;
  }

  // This week, Monday to Sunday.
  var weekDone = 0, weekPlanned = 0;
  var monday = new Date(today.getTime() - DAYS.indexOf(dayName_(today)) * 864e5);
  for (var k = 0; k < 7; k++) {
    var wd = new Date(monday.getTime() + k * 864e5);
    var wkey = Utilities.formatDate(wd, timeZone_(), 'yyyy-MM-dd');
    if ((regimen[DAYS[k]] || []).length) weekPlanned++;
    if (logs[wkey] && logs[wkey].completed) weekDone++;
  }

  return {
    date: dateStr,
    day: dayName_(today),
    checked: workoutChecks_(dateStr),
    completed: !!(logs[dateStr] && logs[dateStr].completed),
    notes: logs[dateStr] ? logs[dateStr].notes : '',
    streak: streak,
    weekDone: weekDone,
    weekPlanned: Math.max(weekPlanned, weekDone)
  };
}

/**
 * Ticks or unticks one exercise. Ticking the last one marks the day done;
 * unticking one after that marks it not done again.
 */
function setExerciseDone(dateStr, exercise, done) {
  var names = (getWeekRegimen()[dayName_(parseLocal_(dateStr, '12:00'))] || [])
    .map(function (x) { return x.exercise; });
  withLock_(function () {
    var sheet = sheet_(SHEETS.workoutChecks);
    var values = sheet.getDataRange().getValues();
    var before = values.slice(1).filter(function (r) { return normalizeDate_(r[0]) === dateStr; })
      .map(function (r) { return String(r[1]); });
    for (var i = values.length - 1; i >= 1; i--) {
      if (normalizeDate_(values[i][0]) === dateStr && String(values[i][1]) === String(exercise)) sheet.deleteRow(i + 1);
    }
    if (done) {
      var r = sheet.getLastRow() + 1;
      sheet.getRange(r, 1, 1, 2).setNumberFormat('@');
      sheet.getRange(r, 1, 1, 3).setValues([[dateStr, String(exercise), new Date()]]);
    }
    var after = before.filter(function (n) { return n !== String(exercise); });
    if (done) after.push(String(exercise));
    var allBefore = names.length && names.every(function (n) { return before.indexOf(n) !== -1; });
    var allAfter = names.length && names.every(function (n) { return after.indexOf(n) !== -1; });
    if (allAfter !== allBefore) {
      var log = getLogEntry(dateStr);
      saveLogEntry(dateStr, allAfter, log ? log.notes : '');
    }
  });
  return getWorkoutDay(dateStr);
}

// ---------------------------------------------------------------------------
// Habit counters (water, sleep, anything you count)
// ---------------------------------------------------------------------------
// Habits holds what you track; Habit Log holds one row per habit per day with
// that day's count.

var HABIT_COL = { id: 0, name: 1, icon: 2, target: 3, unit: 4, order: 5, created: 6 };

function habitRows_() {
  return sheet_(SHEETS.habits).getDataRange().getValues().slice(1)
    .map(function (r, i) {
      return {
        id: String(r[HABIT_COL.id]),
        name: String(r[HABIT_COL.name]),
        icon: String(r[HABIT_COL.icon]),
        target: Number(r[HABIT_COL.target]) || 0,
        unit: String(r[HABIT_COL.unit]),
        order: Number(r[HABIT_COL.order]) || 0,
        row: i
      };
    })
    .filter(function (h) { return h.id !== '' && h.name !== ''; })
    .sort(function (a, b) { return (a.order - b.order) || (a.row - b.row); });
}

/** { 'yyyy-MM-dd|habitId': count } */
function habitCounts_() {
  var map = {};
  sheet_(SHEETS.habitLog).getDataRange().getValues().slice(1).forEach(function (r) {
    map[normalizeDate_(r[0]) + '|' + String(r[1])] = Number(r[2]) || 0;
  });
  return map;
}

/** Habits with their count for dateStr: [{id, name, icon, target, unit, count}]. */
function getHabits(dateStr) {
  var counts = habitCounts_();
  return habitRows_().map(function (h) {
    return { id: h.id, name: h.name, icon: h.icon, target: h.target, unit: h.unit,
      count: counts[dateStr + '|' + h.id] || 0 };
  });
}

/** Adds delta (e.g. 1 or -1) to a habit's count for dateStr. Never goes below 0. */
function bumpHabit(id, dateStr, delta) {
  withLock_(function () {
    var sheet = sheet_(SHEETS.habitLog);
    var values = sheet.getDataRange().getValues();
    for (var i = values.length - 1; i >= 1; i--) {
      if (normalizeDate_(values[i][0]) === dateStr && String(values[i][1]) === String(id)) {
        var next = Math.max(0, num_((Number(values[i][2]) || 0) + Number(delta)));
        sheet.getRange(i + 1, 3, 1, 2).setValues([[next, new Date()]]);
        return;
      }
    }
    var r = sheet.getLastRow() + 1;
    sheet.getRange(r, 1, 1, 2).setNumberFormat('@');
    sheet.getRange(r, 1, 1, 4).setValues([[dateStr, String(id), Math.max(0, num_(delta)), new Date()]]);
  });
  return getHabits(dateStr);
}

/** Creates a habit, or updates one when habit.id is set. habit: {id?, name, icon, target, unit} */
function saveHabit(habit, dateStr) {
  var name = String(habit && habit.name || '').trim();
  if (!name) throw new Error('Give the habit a name.');
  var values = [name, String(habit.icon || '').trim(), num_(habit.target), String(habit.unit || '').trim()];
  withLock_(function () {
    var sheet = sheet_(SHEETS.habits);
    if (!habit.id) {
      var last = habitRows_().reduce(function (m, h) { return Math.max(m, h.order); }, 0);
      sheet.appendRow([Utilities.getUuid()].concat(values, [last + 1, new Date()]));
      return;
    }
    var row = findRowById_(SHEETS.habits, habit.id);
    if (row === -1) throw new Error('Habit not found. Reload the page.');
    sheet.getRange(row, HABIT_COL.name + 1, 1, 4).setValues([values]);
  });
  return getHabits(dateStr);
}

/** Deletes a habit and its history. */
function deleteHabit(id, dateStr) {
  withLock_(function () {
    var row = findRowById_(SHEETS.habits, id);
    if (row !== -1) sheet_(SHEETS.habits).deleteRow(row);
    var log = sheet_(SHEETS.habitLog);
    var values = log.getDataRange().getValues();
    for (var i = values.length - 1; i >= 1; i--) {
      if (String(values[i][1]) === String(id)) log.deleteRow(i + 1);
    }
  });
  return getHabits(dateStr);
}

// ---------------------------------------------------------------------------
// Weekly summary
// ---------------------------------------------------------------------------

/**
 * Seven days from mondayStr (yyyy-MM-dd): food totals, training, checklist and
 * habit counts per day. { start, days: [...], habits: [{id, name, icon, target, unit, counts}] }
 */
function getWeekSummary(mondayStr) {
  var tz = timeZone_();
  var monday = parseLocal_(mondayStr, '12:00');
  var dates = [];
  for (var i = 0; i < 7; i++) dates.push(Utilities.formatDate(new Date(monday.getTime() + i * 864e5), tz, 'yyyy-MM-dd'));

  var food = {};
  dates.forEach(function (d) { food[d] = { calories: 0, protein: 0, carbs: 0, fat: 0, items: 0 }; });
  foodRows_().forEach(function (f) {
    var t = food[f.date];
    if (!t) return;
    t.calories += f.calories; t.protein += f.protein; t.carbs += f.carbs; t.fat += f.fat; t.items++;
  });

  var regimen = getWeekRegimen();
  var logs = logMap_();
  var tasks = taskRows_();
  var checks = taskChecks_();
  var counts = habitCounts_();
  var habits = habitRows_();

  return {
    start: mondayStr,
    days: dates.map(function (d, i) {
      var list = checklistFor_(d, tasks, checks).items;
      var f = food[d];
      return {
        date: d,
        day: DAYS[i],
        calories: num_(f.calories), protein: num_(f.protein), carbs: num_(f.carbs), fat: num_(f.fat),
        foodItems: f.items,
        planned: (regimen[DAYS[i]] || []).length > 0,
        trained: !!(logs[d] && logs[d].completed),
        notes: logs[d] ? logs[d].notes : '',
        tasksDone: list.filter(function (t) { return t.done; }).length,
        tasksTotal: list.length
      };
    }),
    habits: habits.map(function (h) {
      return { id: h.id, name: h.name, icon: h.icon, target: h.target, unit: h.unit,
        counts: dates.map(function (d) { return counts[d + '|' + h.id] || 0; }) };
    })
  };
}

// ---------------------------------------------------------------------------
// Morning brief by email (optional)
// ---------------------------------------------------------------------------
// The app shows the brief at the top of the Today tab. Turning on the email in
// Settings adds a daily trigger that runs sendMorningBrief().

var BRIEF_TRIGGER_FN = 'sendMorningBrief';

/** Turns the daily email on or off and sets its hour (0-23). */
function setMorningEmail(enabled, hour) {
  hour = Math.max(0, Math.min(23, Math.floor(Number(hour)) || 0));
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === BRIEF_TRIGGER_FN) ScriptApp.deleteTrigger(t);
  });
  if (enabled) ScriptApp.newTrigger(BRIEF_TRIGGER_FN).timeBased().everyDays(1).atHour(hour).create();
  return saveSettings({ morningEmail: enabled ? 'on' : 'off', morningEmailHour: String(hour) });
}

/** Emails today's brief to the account that deployed the app. Also used by the "Send now" button. */
function sendMorningBrief() {
  var to = Session.getEffectiveUser().getEmail();
  if (!to) throw new Error('Could not find your email address.');
  var brief = buildMorningBrief_();
  MailApp.sendEmail({ to: to, subject: brief.subject, htmlBody: brief.html, name: 'Daily Helper' });
  return to;
}

function buildMorningBrief_() {
  var d = getDashboard();
  var tz = timeZone_();
  var e = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var dateLabel = Utilities.formatDate(parseLocal_(d.today, '12:00'), tz, 'EEEE d MMMM');
  var parts = [];

  if (d.weather) {
    var w = d.weather, t = w.daily[0];
    parts.push('<h3>Weather</h3><p>' + Math.round(w.current.temp) + w.units.temp + ' now, high ' + Math.round(t.max) +
      '°, low ' + Math.round(t.min) + '°, ' + (t.precipChance || 0) + '% chance of rain.</p>');
  }

  var todays = d.events.filter(function (ev) { return ev.date === d.today; });
  parts.push('<h3>Today\'s events</h3>' + (d.calendarError ? '<p>Couldn\'t load your calendar: ' + e(d.calendarError) + '</p>' : todays.length ? '<ul>' + todays.map(function (ev) {
    return '<li>' + (ev.allDay ? 'All day' : e(ev.start.slice(11))) + ' · ' + e(ev.title) + '</li>';
  }).join('') + '</ul>' : '<p>Nothing on your calendar.</p>'));

  var ex = d.regimen[d.dayName] || [];
  parts.push('<h3>Training</h3>' + (ex.length ? '<ul>' + ex.map(function (x) {
    return '<li>' + e(formatExercise_(x)) + '</li>';
  }).join('') + '</ul>' : '<p>Rest day.</p>') +
    (d.workout.streak ? '<p>Streak: ' + d.workout.streak + ' day' + (d.workout.streak === 1 ? '' : 's') + '.</p>' : ''));

  var items = d.checklist.items.filter(function (t) { return !t.done; });
  if (items.length) {
    parts.push('<h3>Checklist</h3><ul>' + items.map(function (t) { return '<li>' + e(t.title) + '</li>'; }).join('') + '</ul>');
  }

  var y = d.foodHistory[d.foodHistory.length - 2];
  parts.push('<h3>Food</h3><p>Goal: ' + e(d.settings.calorieGoal) + ' kcal, ' + e(d.settings.proteinGoal) + ' g protein.' +
    (y && y.calories ? ' Yesterday: ' + Math.round(y.calories) + ' kcal, ' + Math.round(y.protein) + ' g protein.' : '') + '</p>');

  if (d.habits.length) {
    parts.push('<h3>Habits</h3><p>' + d.habits.map(function (h) {
      return e(h.icon + ' ' + h.name) + ': ' + (h.target ? h.target + ' ' + e(h.unit) : 'track it');
    }).join(' · ') + '</p>');
  }

  return {
    subject: 'Your day: ' + dateLabel,
    html: '<div style="font-family:system-ui,sans-serif;max-width:560px">' +
      '<h2>Good morning. Here\'s ' + e(dateLabel) + '.</h2>' + parts.join('') + '</div>'
  };
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
    // Starter rows for a brand-new tab, e.g. a Water counter.
    var seed = def.seed ? def.seed() : [];
    if (seed.length) sheet.getRange(2, 1, seed.length, seed[0].length).setValues(seed);
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
