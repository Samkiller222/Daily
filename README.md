# Daily Helper

A personal daily dashboard web app that runs on Google Apps Script:

- **Weather** for your area: current conditions, the next 12 hours, and a 7-day forecast (from [Open-Meteo](https://open-meteo.com), free, no API key).
- **Google Calendar**: a full calendar view (month, week and agenda) of all your calendars, where you can add and delete events, plus a one-tap button that adds today's workout to your calendar with the exercises in the event description.
- **Weekly training regimen** stored in a **Google Sheet**. Each day of the week (Monday–Sunday) has its own regimen. It repeats every week until you change it.
- **Daily log**: mark today's training as done and add notes. These are saved to the sheet too.
- **Calorie and macro tracker**: take or choose a photo of a meal and Gemini estimates each item's calories, protein, carbs and fat. You check and edit the numbers before they're saved to the sheet. You can also add food by hand. It shows your progress against daily goals and the last 7 days.

Because the app runs inside Google Apps Script, it already has access to your Sheet and Calendar. You don't need a Google Cloud project or OAuth client. The only key is an optional Gemini API key for food photos.

## Setup (about 5 minutes)

1. **Create the Google Sheet.** Go to [sheets.new](https://sheets.new) and name it something like "Daily Helper".
2. **Open Apps Script.** In the sheet, choose **Extensions → Apps Script**.
3. **Add the code.**
   - Replace the contents of `Code.gs` with [`Code.gs`](Code.gs).
   - Click **+ → HTML**, name the file `index` (lowercase; Apps Script adds `.html`), and paste in [`index.html`](index.html).
   - Click **Project Settings** (the gear icon), tick **Show "appsscript.json" manifest file in editor**, then go back to the editor and replace `appsscript.json` with [`appsscript.json`](appsscript.json).

   Or skip the copy and paste and push from this folder with clasp (see below).
   - In **Project Settings**, set the **Time zone** to your own. Also check that the sheet's time zone (**File → Settings** in the sheet) is correct. The app uses it to work out which day it is.
4. **Deploy.** Click **Deploy → New deployment → Select type: Web app**.
   - *Execute as:* **Me**
   - *Who has access:* **Only myself**
   - Click **Deploy**, then approve the permissions (Sheets, Calendar, and external requests for the weather).
5. **Open the web app URL** it gives you. Bookmark it, or add it to your phone's home screen.

On first load, the app creates any missing tabs in your sheet: **Regimen**, **Settings**, **Log**, and **Food Log**.

### Gemini API key (for food photos)
1. Get a free key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey).
2. In the app, open **Settings → Gemini (food photos)**, paste the key and click **Save key**.

The key is stored in the Apps Script project's Script Properties, not in the sheet, and the page never sends it back to your browser. The model defaults to `gemini-3.8-flash`. You can change it in the same card. Photos are shrunk in the browser before upload and are not stored.

### Updating later
After you change the code, go to **Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy**. The URL stays the same.

### Push from this repo with clasp (optional)
Everything runs from the repo root. You need [Node.js](https://nodejs.org) 20 or later.

1. Turn on the Apps Script API once at [script.google.com/home/usersettings](https://script.google.com/home/usersettings).
2. In the sheet's Apps Script editor, open **Project Settings** and copy the **Script ID**.
3. From the repo root:

   ```sh
   npm install
   npm run login                                  # sign in to Google
   echo '{"scriptId":"PASTE_SCRIPT_ID","rootDir":"."}' > .clasp.json
   npm run push                                   # uploads Code.gs, index.html, appsscript.json
   ```

   `push` replaces the files in the Apps Script project with these three.
4. Deploy the first time from the editor (step 4 above). After later pushes, go to **Deploy → Manage deployments → Edit → New version** so the web app link keeps working.

`.claspignore` makes sure only the three app files are uploaded. `npm run open` opens the Apps Script editor.

## Using the app

| Tab | What it does |
|---|---|
| **Today** | Weather, today's regimen (based on the weekday), a "Mark as done" button with notes, your upcoming calendar events, and "Add today's workout" to your calendar. |
| **Food** | Today's calories and macros against your goals, a 7-day history, **📷 Photo** to analyze a meal with Gemini, **+ Add manually**, and today's log, where you can delete entries. |
| **Calendar** | Your Google Calendar in **Month**, **Week** or **Agenda** view. Move between weeks or months with ‹ ›, or jump back with **Today**. Every calendar you can see appears in its own colour, and you can tap a calendar's name to hide or show it. Tap a day to see its events and that day's training, or tap an event for details. **+ Event** adds an event. One-off events can be deleted here; repeating events are edited in Google Calendar. |
| **Weekly regimen** | Choose a day (Mon–Sun) to add, edit, reorder, or remove exercises (Exercise / Sets / Reps / Weight / Notes). You can also copy another day's regimen. Click **Save**. |
| **Settings** | Search for your city or use your current location, choose °F or °C, pick which calendar to use, set daily calorie and macro goals, and add your Gemini key. |

## Google Sheet layout

You can also edit the sheet directly. The app reads it each time it loads.

**Regimen**: one row per exercise
| Day | Order | Exercise | Sets | Reps | Weight | Notes |
|---|---|---|---|---|---|---|
| Monday | 1 | Back squat | 5 | 5 | 225 lb | |
| Monday | 2 | Romanian deadlift | 3 | 8 | 185 lb | |
| Tuesday | 1 | Easy run | | 5 km | | Zone 2 |

Days with no rows count as rest days.

**Settings**: key/value pairs (location, units, calendar, default workout time, calorie and macro goals, Gemini model).

**Log**: one row per day you mark done or add notes to (Date, Day, Completed, Notes, Logged At).

**Food Log**: one row per food item (Date, Time, Meal, Food, Portion, Calories, Protein (g), Carbs (g), Fat (g), Source, ID). Source is `Gemini` or `Manual`. The ID column lets the app delete the right row, so don't edit it.

## Preview without Google

From the repo root, run:

```sh
npm start
```

Then open http://localhost:3000 to try the app with demo data. No Google account or key is needed, and nothing is saved. You can also open `index.html` directly in a browser.

## Files

| File | What it is |
|---|---|
| `Code.gs` | Server code that runs in Apps Script: Sheets, Calendar, weather and Gemini |
| `index.html` | The web app page, with built-in demo data for local preview |
| `appsscript.json` | Apps Script manifest: permissions, time zone and web app settings |
| `server.js` | Local preview server used by `npm start` |
| `package.json` | `npm start`, plus clasp scripts for pushing to Apps Script |
