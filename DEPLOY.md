# Chronicle — D&D 5e Campaign Tracker
## Deployment Guide

---

## What you have

```
chronicle/
├── server/
│   ├── server.js       ← Node.js WebSocket + REST server
│   ├── package.json    ← Dependencies
│   └── railway.toml    ← Railway deployment config
└── client/
    └── chronicle.html  ← The app. Share this file with your players.
```

---

## Step 1 — Deploy the server to Railway (free, 5 minutes)

### 1.1 Create a GitHub repository

1. Go to https://github.com/new
2. Name it `chronicle-server` (private is fine)
3. Clone it locally, copy the **contents of the `server/` folder** into it
4. Commit and push:
   ```
   git add .
   git commit -m "Initial deploy"
   git push
   ```

### 1.2 Deploy on Railway

1. Go to https://railway.app and sign in with GitHub (free account)
2. Click **New Project → Deploy from GitHub repo**
3. Select your `chronicle-server` repo
4. Railway auto-detects Node.js and runs `npm start` — no config needed
5. Click **Settings → Networking → Generate Domain**
   - You'll get a URL like `https://chronicle-server-production-abc123.up.railway.app`
   - **Copy this URL** — this is your server URL

### 1.3 Set environment variables (recommended)

In Railway → your project → **Variables**, add:

| Variable    | Value                  | Purpose                          |
|-------------|------------------------|----------------------------------|
| `ADMIN_KEY` | any secret string      | Lets you wipe/reset the session  |
| `DATA_FILE` | `/app/data/session.json` | Persist data in Railway volume |

> **Persistence note:** Railway's free tier has ephemeral storage — the file resets on redeploy.
> For guaranteed persistence, add a Railway **Volume** (free, 1GB):
> - Railway project → **New → Volume** → mount path `/app/data`
> - Your session.json will survive restarts and redeploys permanently.

---

## Step 2 — Configure the client

Open `chronicle.html` in a text editor. Find this line near the top:

```html
<input id="server-url" placeholder="wss://your-app.railway.app"
```

You can optionally hardcode your server URL as the default value so players don't have to type it:

```html
<input id="server-url" value="wss://chronicle-server-production-abc123.up.railway.app"
```

Note the `wss://` prefix (not `https://`). Railway serves over HTTPS/WSS automatically.

---

## Step 3 — Share with your group

1. **Give every player the `chronicle.html` file** — via Discord, email, WhatsApp, USB stick, anything.
   - They open it locally in any browser (Chrome, Firefox, Edge, Safari)
   - No install required, no account needed
2. **Tell them the server URL** (or bake it in as above)
3. That's it. Everyone connects to the same session.

---

## How to run a session

### DM (first time)
1. Open `chronicle.html`
2. Enter your server URL
3. Click **Dungeon Master**, set a PIN (e.g. `dragon42`)
4. Click **Enter the Realm** — this creates the session on the server
5. Go to **⚙ Setup** to add player character names
6. Each player character: click **Configure** to fill in their full 5e sheet
7. Click **⚔ Begin Adventure**

### Players
1. Open `chronicle.html`
2. Enter the server URL
3. Click **Player**, type their character name **exactly** as the DM entered it
4. Click **Enter the Realm**
5. They can see all characters, and edit only their own

### Ongoing sessions
- Everyone opens `chronicle.html` and logs in as before
- The session is always loaded from the server — picks up exactly where you left off
- No need to re-do Setup unless adding new characters

---

## Permissions summary

| Action                          | DM | Player (own char) | Player (others) |
|--------------------------------|----|-------------------|-----------------|
| View all characters             | ✓  | ✓                 | ✓               |
| Edit own character stats        | ✓  | ✓                 | ✗               |
| Edit another player's character | ✓  | ✗                 | ✗               |
| Add/remove NPCs                 | ✓  | ✗                 | ✗               |
| Start/end combat                | ✓  | ✗                 | ✗               |
| Advance round counter           | ✓  | ✗                 | ✗               |
| Campaign setup                  | ✓  | ✗                 | ✗               |

---

## Alternative: Run on your Synology NAS

If you prefer to run it locally on your NAS instead of Railway:

1. Enable **Node.js** in Synology Package Center
2. SSH into your NAS, copy the `server/` folder
3. `cd server && npm install && npm start`
4. Forward port 3000 on your router to the NAS IP
5. Set a static IP or use DDNS (Synology has a free DDNS service built in)
6. Use `wss://your-ddns-hostname.synology.me:3000` as the server URL

Railway is simpler for internet play; the NAS is a good backup/local option.

---

## Resetting a session (admin)

To wipe all session data and start fresh:

```bash
curl -X DELETE https://your-server-url/health \
  -H "x-admin-key: your-admin-key"
```

Or just delete `data/session.json` on the server and restart.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| "Cannot reach server" | Check the URL uses `wss://` not `https://` |
| Status dot stays red | Server may be sleeping (Railway free tier sleeps after 10min) — wait 30s for cold start |
| Player can't log in | Character name must match exactly (case-insensitive, but no typos) |
| Changes not syncing | Check the green "Live" indicator in the top bar |
| Lost DM PIN | Admin-delete the session (above) and start fresh |
