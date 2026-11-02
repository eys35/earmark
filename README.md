# Earmark

Drop in Shazam screenshots; Earmark reads the songs with Claude, matches them on Spotify, and adds them to a playlist you pick.

- `index.html` is the whole web app. It signs in to Spotify directly from the browser, so it runs on GitHub Pages with no server of its own.
- `supabase/functions/extract/index.ts` is a small Supabase Edge Function that sends each screenshot to Claude and returns the songs it shows. It holds the Anthropic API key so the key never reaches the browser.

## How it works

1. You connect Spotify. Earmark asks only to read and edit your playlists.
2. You pick a playlist, or create one.
3. You drop, choose or paste screenshots. Each is shrunk in the browser and sent to the `extract` function, which checks your Spotify sign-in, asks Claude for the songs, and returns them.
4. Earmark searches Spotify for each song and lists the best match, flagging songs already in the playlist and songs it couldn't find. You can pick another version or search by hand.
5. "Add songs" adds everything that's ticked.

Screenshots aren't stored anywhere; they pass through the function to Claude and are dropped.

## Setup

You need four things: a Supabase project, an Anthropic API key, a Spotify app, and this repo on GitHub Pages.

### 1. Anthropic API key

At https://console.anthropic.com, add billing, then create a key under **API Keys**. Each screenshot costs about a cent.

### 2. Supabase function

Create a new project at https://supabase.com. Then either:

**In the dashboard (no install):**

1. **Edge Functions → Deploy a new function → Via Editor.** Name it `extract`, paste in `supabase/functions/extract/index.ts`, and deploy.
2. Open the function's **Details** and turn **off** "Verify JWT with legacy secret" (or "Enforce JWT verification"). The function checks Spotify sign-ins itself.
3. **Edge Functions → Secrets** (or **Project Settings → Edge Functions**), add:
   - `ANTHROPIC_API_KEY`: the key from step 1
   - `ALLOWED_ORIGINS`: `https://eys35.github.io,http://127.0.0.1:8020`
   - `ALLOWED_SPOTIFY_USERS`: Spotify user IDs allowed to use the AI, comma-separated. Leave it out at first; once you sign in, Earmark shows your Spotify ID next to your name. Add yours and your friends', so a stranger with some other Spotify token can't spend your credit.

**Or with the CLI:**

```bash
brew install supabase/tap/supabase
supabase login
supabase functions deploy extract --project-ref <project-ref> --no-verify-jwt
supabase secrets set --project-ref <project-ref> ANTHROPIC_API_KEY=sk-ant-... ALLOWED_ORIGINS=https://eys35.github.io,http://127.0.0.1:8020
```

The function's URL is `https://<project-ref>.supabase.co/functions/v1/extract`.

### 3. Spotify app

1. At https://developer.spotify.com/dashboard, **Create app**.
2. **Redirect URIs** (both, exactly, including the trailing slash):
   - `https://eys35.github.io/earmark/`
   - `http://127.0.0.1:8020/` (for running it locally; Spotify doesn't accept `localhost`)
3. Under **Which API/SDKs are you planning to use?**, tick **Web API**. Save.
4. Copy the **Client ID** (not the client secret; Earmark doesn't use it).
5. **Settings → User Management**: add each friend's name and the email on their Spotify account. New Spotify apps are in development mode, which only lets listed users sign in: up to 5 per app, and the app owner needs Spotify Premium.

Earmark uses the playlist endpoints from Spotify's February 2026 development-mode changes (`/playlists/{id}/items`, `POST /me/playlists`); the older `/tracks` endpoints are refused for new apps.

### 4. Fill in the app

Near the top of the script in `index.html`:

```js
const SPOTIFY_CLIENT_ID = "your client id";
const EXTRACT_URL = "https://<project-ref>.supabase.co/functions/v1/extract";
```

Both are safe to publish. Push to `main`; GitHub Pages serves it at https://eys35.github.io/earmark/.

## Run it locally

```bash
python3 -m http.server 8020 --bind 127.0.0.1
```

Open http://127.0.0.1:8020/ (not `localhost`, so it matches the Spotify redirect URI).

## Notes

- The model is Claude Opus 5.5 at low effort: reading song names off a screenshot is a simple job, and low effort keeps it quick. Change `effort` in the function if it misreads things.
- If Claude declines a screenshot, the request falls back to another model automatically (`fallbacks: "default"`).
- Earmark only lists playlists you own or that are collaborative, since Spotify won't let you add to anyone else's.
