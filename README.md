# Dubai5 Social Automation 🔮

Automated social media posting tool for **Dubai5 Foresight** — scrapes today's articles from `dubai5.space` and posts them automatically to LinkedIn (and soon Instagram, Facebook, X).

---

## How It Works

```
6:00 AM (Dubai) → Scrape dubai5.space → Save 5 articles to queue
7:00 AM         → Post Article #1 to LinkedIn
8:00 AM         → Post Article #2 to LinkedIn
9:00 AM         → Post Article #3 to LinkedIn
10:00 AM        → Post Article #4 to LinkedIn
11:00 AM        → Post Article #5 to LinkedIn
```

---

## Setup (One Time)

### 1. Fill in your credentials
```bash
# Edit .env file
LINKEDIN_EMAIL=your@email.com
LINKEDIN_PASSWORD=yourpassword
```

### 2. Login to LinkedIn (saves session cookies)
```bash
node setup.js
```
> A Chrome window opens → log in manually → press Enter → session saved forever

### 3. Start the automation
```bash
npm start
```

---

## Commands

| Command | What it does |
|---|---|
| `npm start` | Start scheduler (runs 24/7) |
| `node setup.js` | First-time login setup |
| `node scraper.js` | Test scraper manually |
| `npm run post:linkedin` | Test LinkedIn post (uses first queued article) |
| `node dashboard-server.js` | Open monitoring dashboard |

---

## Dashboard

Open `http://localhost:3456` after starting the app to see:
- Today's article queue
- Posting status per platform
- Live activity logs
- Schedule timeline

---

## Server Deployment (AWS/VPS)

```bash
npm install -g pm2
pm2 start index.js --name dubai5-social
pm2 save
pm2 startup
```

---

## Phase 2 — Coming Soon
- Instagram
- Facebook
- X (Twitter)
