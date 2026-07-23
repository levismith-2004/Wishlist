# Wishlist

A shared gift list for two people. Node, no dependencies, one JSON file for storage.

## What's here

| File | Job |
|---|---|
| `server.js` | Serves the page, gates it behind a passcode, stores the list |
| `public/index.html` | The whole app — no build step |
| `data/list.json` | Created on first save |

## Run it locally

```bash
PASSCODE=whatever node server.js
# open http://localhost:3000
```

Node 20 or newer. There is nothing to `npm install`.

## Deploy to Railway

1. Push this folder to a GitHub repo.
2. On railway.com: **New Project → Deploy from GitHub repo**, pick the repo. Railway detects Node and runs `npm start` on its own.
3. Open the service → **Variables** and add:
   - `PASSCODE` — the shared passcode you'll both type in. Anything you'll remember.
   - `DATA_DIR` — `/data`
4. Open the service → **Data** tab (some accounts show it under Settings → Volumes) → **Add Volume**, mount path `/data`. Without this the list is wiped on every redeploy, because Railway containers start with a fresh filesystem each time.
5. **Settings → Networking → Generate Domain** for a `*.up.railway.app` URL, or add your own domain there.
6. Send her the URL and the passcode.

Redeploys happen automatically on every push to the repo's main branch.

## How saving works

The browser sends one small operation per change (`add`, `update`, `delete`, `names`) rather than uploading the whole list, so if you're both editing at once you won't overwrite each other's items. Each tab re-checks the server every 4 seconds, so her additions appear on your screen without a refresh. The green dot near the filters turns pink if the connection drops.

## Backups

The whole list is one file. To pull a copy down:

```bash
railway ssh cat /data/list.json > backup.json
```

## Cost

Railway has no permanent free tier. New accounts get a one-time $5 trial credit; after that the Hobby plan is $5/month, which includes $5 of usage. An app this small sits well inside that, so expect $5/month plus a few cents for the volume.
