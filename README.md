# Unfollow Tracker

A privacy-first web app to find **who unfollowed you, deactivated/got banned, or never followed you back on Instagram** — running entirely in your browser. No login, no password, no servers, no data ever leaves your device.

## Why it works this way

Instagram's API does **not** expose follower lists, and scraping the site while logged in violates Instagram's Terms of Service and can get your account banned. The safe, reliable method is Instagram's official **"Download Your Information"** export, which this tool reads locally.

Because a deactivated, banned, or deleted account silently disappears from your followers list, the only robust way to detect them is to **compare two exports over time**. This app saves a snapshot in your browser so the next export reveals exactly who vanished.

## How to use

1. **Get your data from Instagram** (≈2 minutes):
   - Instagram → **Profile → ☰ Menu → Accounts Center**
   - **Your information and permissions → Download your information**
   - **Download or transfer information** → your account → **Some of your information**
   - Under *Connections*, pick **Followers and following**
   - **Format: JSON**, **Date range: All time** → request download
   - Instagram emails you a `.zip` (usually within minutes)

2. **Open the app** and drop in the `.zip` (or the individual `followers_1.json` / `following.json` files).

3. Browse the tabs:
   - **Don't follow back** — accounts you follow that don't follow you
   - **Fans** — people who follow you but you don't follow back
   - **Mutuals** — follow each other
   - **Save a snapshot.** Later, upload a fresh export and the
     **Unfollowers & gone** / **New followers** tabs light up — including
     accounts that were deactivated or banned.

## Running it

It's a static site — no build step.

```bash
# any static server works, e.g.
python3 -m http.server 8000
# then open http://localhost:8000
```

Or just open `index.html` directly in a browser.

## Privacy

- 100% client-side. The only optional network request is lazily loading a ZIP
  library from a CDN, and only if you upload a `.zip`. Uploading the JSON files
  directly requires no network at all.
- Your snapshot is stored in this browser's `localStorage` and never transmitted.
  Use **Clear history** to delete it.

## Files

- `index.html` — UI
- `styles.css` — styling
- `app.js` — parsing, diffing, snapshot logic
- `sample-data/` — fake export files to try the app without your own data

*Not affiliated with Instagram or Meta.*
