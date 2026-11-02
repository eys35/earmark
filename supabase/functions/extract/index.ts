// Reads Shazam (and similar) screenshots with Claude and returns the songs they show.
// The caller must send a Spotify access token; we check it with Spotify so only signed-in
// players (optionally only the Spotify accounts in ALLOWED_SPOTIFY_USERS) can spend API credit.
import Anthropic from "npm:@anthropic-ai/sdk@0.135.0";

const client = new Anthropic(); // reads ANTHROPIC_API_KEY from the function's secrets

const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const ALLOWED_USERS = (Deno.env.get("ALLOWED_SPOTIFY_USERS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const MAX_IMAGES = 10;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MEDIA_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;
type MediaType = (typeof MEDIA_TYPES)[number];

const SYSTEM = `You read screenshots and list the songs they identify.

Most screenshots come from Shazam: a song page (big title, artist underneath), the library or history list (many songs), or a "song found" notification. Some come from other apps such as Spotify, Apple Music, SoundHound, Instagram or TikTok.

List each song the screenshot identifies, in the order it appears. Use the title and main artist exactly as shown, fixing only obvious truncation ("Bohemian Rhaps..." -> "Bohemian Rhapsody") when you are sure. Skip anything the app is only suggesting: "Recommended", "Top songs", "Similar", charts, ads, and playlists. If the screenshot shows no identifiable song, return an empty list.`;

const SCHEMA = {
  type: "object",
  properties: {
    songs: {
      type: "array",
      items: {
        type: "object",
        properties: { title: { type: "string" }, artist: { type: "string" } },
        required: ["title", "artist"],
        additionalProperties: false,
      },
    },
  },
  required: ["songs"],
  additionalProperties: false,
};

function cors(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") ?? "";
  const allow = ALLOWED_ORIGINS.length === 0 ? "*" : ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, content-type, x-spotify-token, apikey, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function reply(req: Request, status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...cors(req), "Content-Type": "application/json" } });
}

async function spotifyUser(token: string): Promise<string | null> {
  const r = await fetch("https://api.spotify.com/v1/me", { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) return null;
  const me = await r.json();
  return typeof me.id === "string" ? me.id : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors(req) });
  if (req.method !== "POST") return reply(req, 405, { error: "Use POST." });

  const token = req.headers.get("x-spotify-token") ?? "";
  const user = token ? await spotifyUser(token) : null;
  if (!user) return reply(req, 401, { error: "Sign in to Spotify again." });
  if (ALLOWED_USERS.length && !ALLOWED_USERS.includes(user)) {
    return reply(req, 403, { error: "This Spotify account isn't on the guest list for this app." });
  }

  let images: { data: string; mediaType: MediaType }[];
  try {
    const body = await req.json();
    images = body.images;
    if (!Array.isArray(images) || images.length === 0 || images.length > MAX_IMAGES) throw new Error();
    for (const img of images) {
      if (typeof img.data !== "string" || !MEDIA_TYPES.includes(img.mediaType)) throw new Error();
      if (img.data.length * 0.75 > MAX_IMAGE_BYTES) return reply(req, 413, { error: "One of the images is over 5 MB." });
    }
  } catch {
    return reply(req, 400, { error: `Send 1 to ${MAX_IMAGES} images as {images: [{data, mediaType}]}.` });
  }

  try {
    // One request per screenshot keeps each answer tied to its image.
    const results = await Promise.all(images.map(async (img) => {
      const response = await client.beta.messages.create({
        model: "claude-opus-5-5",
        max_tokens: 4096,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
        system: SYSTEM,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } },
            { type: "text", text: "List the songs this screenshot identifies." },
          ],
        }],
      } as Anthropic.Beta.Messages.MessageCreateParamsNonStreaming);

      if (response.stop_reason === "refusal") return { songs: [], error: "This screenshot couldn't be read." };
      if (response.stop_reason === "max_tokens") return { songs: [], error: "Too many songs in one screenshot. Crop it and try again." };
      const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      const parsed = JSON.parse(text) as { songs: { title: string; artist: string }[] };
      return { songs: parsed.songs.filter((s) => s.title.trim()) };
    }));
    return reply(req, 200, { results });
  } catch (error) {
    if (error instanceof Anthropic.RateLimitError) return reply(req, 429, { error: "Too many screenshots at once. Wait a minute and try again." });
    if (error instanceof Anthropic.AuthenticationError) {
      console.error("Anthropic API key rejected");
      return reply(req, 500, { error: "The app's AI key isn't set up correctly." });
    }
    if (error instanceof Anthropic.APIError) {
      console.error(`Anthropic API error ${error.status}:`, error.message);
      return reply(req, 502, { error: "The AI service had a problem. Try again." });
    }
    console.error(error);
    return reply(req, 500, { error: "Something went wrong reading the screenshots." });
  }
});
