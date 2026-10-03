/**
 * Daily Helper — a Google Apps Script web app.
 *
 * - Weather for your saved location (Open-Meteo, no API key needed)
 * - Your Google Calendar (today + the coming week)
 * - A weekly training regimen stored in this Google Sheet. Each day of the
 *   week has its own regimen that repeats every week until you change it.
 * - A calorie and macro tracker. Snap a photo of a meal and Gemini estimates
 *   calories, protein, carbs and fat; you review it, then it's saved here.
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
    'Protein (g)', 'Carbs (g)', 'Fat (g)', 'Source', 'ID'] }
};

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
  geminiModel: 'gemini-3.8-flash'
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
    foodHistory: getFoodHistory(7),
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
  return { food: getFoodDay(dateStr), foodHistory: getFoodHistory(7) };
}

function deleteFoodEntry(id, dateStr) {
  var sheet = sheet_(SHEETS.food);
  var ids = sheet.getRange(1, FOOD_COL.id + 1, sheet.getLastRow(), 1).getValues();
  for (var i = ids.length - 1; i >= 1; i--) {
    if (String(ids[i][0]) === String(id)) { sheet.deleteRow(i + 1); break; }
  }
  return { food: getFoodDay(dateStr), foodHistory: getFoodHistory(7) };
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
