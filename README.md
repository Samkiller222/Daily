# Daily Helper

A personal daily dashboard web app that runs on Google Apps Script:

- **Weather** for your area: current conditions, the next 12 hours, and a 7-day forecast (from [Open-Meteo](https://open-meteo.com), free, no API key).
- **Google Calendar**: a full calendar view (month, week and agenda) of all your calendars, where you can add and delete events, plus a one-tap button that adds today's workout to your calendar with the exercises in the event description.
- **Weekly training regimen** stored in a **Google Sheet**. Each day of the week (Monday–Sunday) has its own regimen. It repeats every week until you change it.
- **Morning brief**: the top of the Today tab sums up your day in one place: weather, today's events, your workout and streak, tasks left, calories and protein left, and your habit counts. You can also get it by email every morning.
- **Workout check-off**: tick off each exercise in today's session. Ticking the last one marks the day done. Your training streak and this week's sessions are shown alongside. You can still mark the day done and add notes in one tap.
- **Habit counters**: tap + or − for water, sleep or anything else you count, each with its own daily goal.
- **Daily checklist**: weekly tasks that come back on the days you pick, plus one-time tasks you can add from the dashboard. Tick them off and drag them into any order.
- **Calorie and macro tracker**: take or choose a photo of a meal and Gemini estimates each item's calories, protein, carbs and fat. You check and edit the numbers before they're saved to the sheet. You can also add food by hand, or pick a meal you eat often from your saved recipes. It shows your progress against daily goals (editable from the Food tab or Settings), the last 7 days, and your on-target streak (days within 10% of your calorie goal).
- **Weekly summary**: charts of calories against your goal, average macros, training sessions and notes, checklist completion and habits for any week.

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
   - Click **Deploy**, then approve the permissions (Sheets, Calendar, external requests for the weather, and sending email and running a daily trigger for the optional morning email).
5. **Open the web app URL** it gives you. Bookmark it, or add it to your phone's home screen.

On first load, the app creates any missing tabs in your sheet: **Regimen**, **Settings**, **Log**, **Food Log**, **Recipes**, **Tasks**, **Task Checks**, **Workout Checks**, **Habits** and **Habit Log**. **Habits** starts with Water (8 glasses) and Sleep (8 hours), which you can change in the app.

### Gemini API key (for food photos)
1. Get a free key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey).
2. In the app, open **Settings → Gemini (food photos)**, paste the key and click **Save key**.

The key is stored in the Apps Script project's Script Properties, not in the sheet, and the page never sends it back to your browser. The model defaults to `gemini-3.8-flash`. You can change it in the same card. Photos are shrunk in the browser before upload and are not stored.

### Morning email (optional)
In the app, open **Settings → Morning email**, tick **Send it every day**, pick a time and click **Save**. This adds a daily trigger to the Apps Script project that emails the brief to the Google account that deployed the app. **Send one now** sends a test. Untick and save to turn it off.

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

### Automatic updates from GitHub
`.github/workflows/deploy-apps-script.yml` uploads the code and updates the live web app every time `Code.gs`, `index.html` or `appsscript.json` changes on the repo's default branch. The web app link stays the same. You can also run it by hand from the **Actions** tab (**Deploy to Apps Script → Run workflow**).

Before uploading, the workflow runs `npm test` (`scripts/check.js`) and stops if anything is broken: a syntax error in `Code.gs` or the page's scripts, a function the page calls that `Code.gs` doesn't have (or that ends in `_`, which Apps Script keeps private), a function defined twice, or an invalid `appsscript.json`. The same check runs on every pull request. Run `npm test` locally before pushing to catch these early.

It needs one repository secret:
1. Sign in with `npm run login` (or `npx clasp login --no-localhost` on a machine without a browser).
2. Copy the whole contents of `~/.clasprc.json`.
3. On GitHub go to **Settings → Secrets and variables → Actions → New repository secret**, name it `CLASPRC_JSON`, and paste the contents in.

The secret gives access to your Apps Script projects, so keep the repo private or limit who can edit it. To cancel it, remove "clasp" at [myaccount.google.com/permissions](https://myaccount.google.com/permissions). The script and deployment IDs are set at the top of the workflow file.

## Using the app

| Tab | What it does |
|---|---|
| **Today** | The morning brief, weather, today's regimen (based on the weekday) with a tick box per exercise, your streak, a "Mark as done" button with notes, habit counters, your upcoming calendar events, and "Add today's workout" to your calendar. Tap a line in the brief to jump to that part of the app. Tap **⚙ Edit** on Habits to add, rename, delete or change the goal of a habit. |
| **Checklist** | Today's tasks with a progress bar. Tick tasks off, drag the ⋮⋮ handle to reorder (the order is kept on later days too), and add one-time tasks for today or a later date. One-time tasks you don't finish carry over to the next day, and future ones are listed under **Coming up**. **⚙ Settings** (only on this tab) is where you add, rename, delete and choose the days for weekly tasks. The **Today** tab shows the same list, where you can also tick, reorder and add one-time tasks. |
| **Food** | Today's calories and macros against your goals (**Edit goals** changes them), a 7-day history with your on-target streak, **📷 Photo** to analyze a meal with Gemini, **+ Add manually**, a saved-recipe list (**Recipes** adds, edits and deletes them; **☆ Save as recipe** saves what you're about to log), and today's log, where you can delete entries. |
| **Summary** | A week at a glance: average calories, days on target, workouts done and checklist completion, then charts for calories against your goal, average macros, training sessions with their notes, checklist completion and habits. Move between weeks with ‹ ›. Hover over (or tap) a bar or square for its numbers. |
| **Calendar** | Your Google Calendar in **Month**, **Week** or **Agenda** view. Move between weeks or months with ‹ ›, or jump back with **Today**. Every calendar you can see appears in its own colour, and you can tap a calendar's name to hide or show it. Tap a day to see its events and that day's training, or tap an event for details. **+ Event** adds an event. One-off events can be deleted here; repeating events are edited in Google Calendar. |
| **Weekly regimen** | Choose a day (Mon–Sun) to add, edit, reorder, or remove exercises (Exercise / Sets / Reps / Weight / Notes). You can also copy another day's regimen. Click **Save**. |
| **Settings** | Search for your city or use your current location, choose °F or °C, pick which calendar to use, set daily calorie and macro goals, turn on the morning email, and add your Gemini key. |

## Google Sheet layout

You can also edit the sheet directly. The app reads it each time it loads.

**Regimen**: one row per exercise
| Day | Order | Exercise | Sets | Reps | Weight | Notes |
|---|---|---|---|---|---|---|
| Monday | 1 | Back squat | 5 | 5 | 225 lb | |
| Monday | 2 | Romanian deadlift | 3 | 8 | 185 lb | |
| Tuesday | 1 | Easy run | | 5 km | | Zone 2 |

Days with no rows count as rest days.

**Settings**: key/value pairs (location, units, calendar, default workout time, calorie and macro goals, Gemini model, morning email on/off and hour).

**Log**: one row per day you mark done or add notes to (Date, Day, Completed, Notes, Logged At).

**Food Log**: one row per food item (Date, Time, Meal, Food, Portion, Calories, Protein (g), Carbs (g), Fat (g), Source, ID). Source is `Gemini` or `Manual`. The ID column lets the app delete the right row, so don't edit it.

**Recipes**: one row per saved recipe (ID, Name, Portion, Calories, Protein (g), Carbs (g), Fat (g), Created), with calories and macros per serving. They fill the recipe list on the Food tab. Save one from the Food tab with **☆ Save as recipe** (several items are added up into one), or add and edit them under **Recipes**.

**Tasks**: one row per checklist task (ID, Type, Title, Days, Date, Order, Created). Type is `weekly` (shown on the comma-separated Days, e.g. `Monday,Thursday`) or `once` (shown from Date until ticked). Order is the list position. Don't edit the ID column.

**Task Checks**: one row each time a task is ticked (Date, Task ID, Checked At). Unticking removes the row.

**Workout Checks**: one row per exercise ticked off (Date, Exercise, Checked At). Unticking removes the row.

**Habits**: one row per habit (ID, Name, Icon, Target, Unit, Order, Created). Target is the daily goal; leave it blank or 0 for no goal. Don't edit the ID column.

**Habit Log**: one row per habit per day (Date, Habit ID, Count, Updated).

The streak counts days marked done in the **Log** tab in a row. Days with nothing in the regimen are rest days and don't break it.

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
| `scripts/check.js` | Pre-deploy checks run by `npm test` and the GitHub workflows |
| `package.json` | `npm start`, `npm test`, plus clasp scripts for pushing to Apps Script |
