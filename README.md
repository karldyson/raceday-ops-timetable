# Race Day Operations Timetable

A browser-based timetable tool for motorsport race meetings. The ops clerk enters actual times as the day progresses; all other officials see a live, auto-refreshing read-only view on their own devices. Predicted session times cascade automatically from actuals, with variance tracking, curfew warnings, and advised grid/formation lap times for race sessions.

## License

Copyright © contributors. Licensed under the [Apache License, Version 2.0](LICENSE).

A copy of the license is included in this repository as `LICENSE`. You can also obtain it from:
https://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software distributed under this license is distributed on an **"AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND**, either express or implied.

---

## Features

- **Live timetable** — auto-refreshes every 30 seconds on all connected devices
- **Ops Mode** — PIN-protected write access for the clerk entering actual times; auto-refresh pauses automatically while active
- **Cascading predictions** — predicted start/finish times ripple forward from the last known actual, using duration and tidy-time overrides where set
- **Advised times** — grid assembly and formation lap start times calculated automatically for race sessions
- **Variance tracking** — per-session variance against schedule with colour-coded indicators; running totals shown in the status bar
- **Curfew countdown** — live countdown pill in the header; predicted finish times colour-warn as sessions approach or exceed curfew
- **Session statuses** — Pending, Active, GFL, Completed, Red Flag, Cancelled, with cancelled sessions correctly propagating through the cascade
- **Override columns** — duration and tidy-time overrides let the clerk adjust predictions without altering the original schedule
- **Actual times with "now" stamps** — Grid, GFL, Start, and Finish actual times each have a ⏱ button to stamp the current time in one click
- **Circuit & layout management** — multiple venues, each with named layouts, per-layout GFL and grid assembly times, and a default curfew
- **Event setup** — create events against a circuit layout, with optional per-event GFL/grid overrides and curfew adjustments
- **Session management** — add, edit, reorder, and delete sessions; break/lunch rows excluded from race numbering and advised time calculations

---

## Requirements

| Component | Minimum version |
|-----------|----------------|
| PHP | 8.1 |
| MySQL | 5.7 |
| MariaDB | 10.3 (alternative to MySQL) |
| Apache | 2.4 with `mod_rewrite` and `AllowOverride All` |

No Node.js, no build step, no package manager. The front end is plain HTML, CSS, and JavaScript.

---

## Installation

### 1. Download the code

Clone the repository or download and extract the ZIP:

```bash
git clone https://github.com/your-org/raceday-ops-timetable.git
cd raceday-ops-timetable
```

### 2. Create the database

Run the schema file against your MySQL/MariaDB server. This creates the `raceday_timetable` database, all tables, and inserts sample UK circuit data:

```bash
mysql -u root -p < db/schema.sql
```

Create a dedicated MySQL user for the application (replace the password):

```sql
CREATE USER 'raceday'@'localhost' IDENTIFIED BY 'your_password_here';
GRANT SELECT, INSERT, UPDATE, DELETE ON raceday_timetable.* TO 'raceday'@'localhost';
FLUSH PRIVILEGES;
```

### 3. Create the configuration file

`api/config.php` is intentionally excluded from version control (it contains credentials). Create it by copying the example and editing it:

```bash
cp api/config.php.example api/config.php
```

Then open `api/config.php` and set:

```php
define('DB_DSN',  'mysql:host=localhost;port=3306;dbname=raceday_timetable;charset=utf8mb4');
define('DB_USER', 'raceday');       // MySQL user created above
define('DB_PASS', 'your_password_here');
define('OPS_PIN', '1234');          // Change this — protects all write operations
```

> **Security note:** `api/config.php` is blocked from direct HTTP access by `api/.htaccess`. Keep it out of version control and never commit credentials.

### 4. Deploy to Apache

Copy or symlink the project directory into your Apache document root (e.g. `/var/www/html/timetable`), or configure a virtual host pointing at the project directory.

Ensure the Apache configuration for the directory allows `.htaccess` overrides:

```apache
<Directory "/var/www/html/timetable">
    AllowOverride All
    Require all granted
</Directory>
```

Restart Apache after any configuration change:

```bash
sudo systemctl restart apache2   # Debian / Ubuntu
sudo systemctl restart httpd     # RHEL / CentOS
```

### 5. Open in a browser

Navigate to your Apache URL, e.g. `http://your-server/timetable/`. Select an event from the dropdown — if no events exist yet, use **Setup / Admin** to create one.

---

## Project structure

```
raceday-ops-timetable/
├── index.html          # Main timetable view (read-only + Ops Mode)
├── setup.html          # Event and session setup (requires Ops PIN)
├── circuits.html       # Circuit and layout management (requires Ops PIN)
├── css/
│   └── styles.css
├── js/
│   ├── api.js          # Shared API client (RDT namespace)
│   ├── timetable.js    # Timetable calculations and rendering
│   ├── setup.js        # Event/session setup logic
│   └── circuits.js     # Circuit/layout management logic
├── api/
│   ├── config.php      # ⚠ NOT committed — create from config.php.example
│   ├── config.php.example
│   ├── events.php      # REST endpoint: events
│   ├── sessions.php    # REST endpoint: sessions
│   ├── circuits.php    # REST endpoint: circuits
│   ├── layouts.php     # REST endpoint: circuit layouts
│   └── .htaccess       # Blocks direct HTTP access to config.php
├── db/
│   ├── schema.sql      # Full database schema + sample circuit data
│   └── .htaccess       # Blocks all HTTP access to this directory
├── LICENSE
└── README.md
```

---

## First-time setup workflow

1. Open **circuits.html** and verify the pre-loaded circuits and layouts. Add your venue if it is not listed, or adjust the default curfew time and GFL/grid minutes for existing layouts.
2. Open **setup.html**, create an event (date, circuit layout, curfew time), then add sessions in running order.
3. Open **index.html** and select your event from the dropdown — the timetable populates immediately.
4. Share the URL (with `?event=N`) with other officials. Their browsers will auto-refresh every 30 seconds.
5. On the day, activate **Ops Mode** with the PIN and enter actual times as each session progresses.

---

## Ops Mode

Ops Mode is activated by clicking the **Ops Mode** button on the main timetable and entering the PIN set in `api/config.php`. While active:

- Input fields appear in the Override (duration, tidy) and Actual (Grid, GFL, Start, Finish) columns
- Each time field has a ⏱ button to stamp the current time instantly
- A status dropdown and **Update** button appear on each row
- Auto-refresh is suspended — the timetable will not reload under you while you are entering data
- An unsaved-changes banner appears if you navigate away before saving

Click the button again (or refresh the page) to exit Ops Mode.

---

## Security considerations

- The Ops PIN is a lightweight operational control, not a security boundary. Anyone with network access to the server can read the timetable; only write operations require the PIN.
- `api/config.php` must not be committed to version control. The `.gitignore` excludes it by default.
- `api/.htaccess` blocks direct HTTP requests to `config.php` even if it is accidentally deployed to a public directory.
- `db/.htaccess` blocks all HTTP access to the `db/` directory.
- For a public-facing deployment, consider placing the application behind HTTPS and restricting access to `setup.html` and `circuits.html` at the web-server level.

---

## Browser compatibility

Tested in current versions of Chrome, Firefox, and Safari. Requires ES2020 (optional chaining, nullish coalescing) — no legacy browser support.

---

## Contributing

Pull requests are welcome. Please open an issue first for significant changes. All contributions are accepted under the terms of the Apache 2.0 license.
