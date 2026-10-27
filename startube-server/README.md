# StarTube server

Lets kids share their StarTube videos with each other — safely. It is a small
Cloudflare Worker, separate from the main site, with an R2 bucket for the video
files and a D1 database for everything else.

Until it is set up, StarTube works exactly as before (everything stays on the
device) and the "Everyone on StarTube" option simply doesn't appear.

## How it keeps 3–10 year olds safe

- **A grown-up says yes before anything is sent.** Sharing needs three rules
  ticked (no faces; no names, school or anything that shows where they live;
  made it themselves and it's kind) and a times-table sum only a grown-up is
  likely to know.
- **Nothing is public until you approve it.** Every upload waits in the review
  room at `/startube/#/review`, which only opens with your `ADMIN_KEY`.
  Rejecting deletes the video from the server (the child keeps their own copy).
- **No names.** Channels are made-up names like "Jolly Panda 62", picked from
  word lists, never typed. Titles and descriptions with links, email addresses
  or phone numbers are refused before they reach you.
- **No comments between children** — only five emoji cheers.
- **One report hides a video at once**, until you look at it again.
- **Limits:** 3 uploads a day per connection, 5 minutes and 95 MB per video,
  and the first bytes of the file are checked to make sure it really is a video.
- **No personal data stored.** No accounts, no IP addresses (rate limits use a
  salted hash, cleared daily), no cookies.

It's still worth adding a short privacy note to the site saying that shared
videos are checked by a grown-up and what you collect (nothing but the video,
its title and its made-up channel name).

## Setting it up (about 15 minutes, in the Cloudflare dashboard)

1. **Storage for the videos.** R2 → *Create bucket* → name it `startube-videos`.
2. **The database.** Storage & Databases → D1 → *Create* → name it `startube`.
   Open it, go to *Console*, paste in the whole of [`schema.sql`](schema.sql) and run it.
   Copy its **Database ID** into `wrangler.jsonc` in place of
   `REPLACE_WITH_YOUR_D1_DATABASE_ID`, and commit that.
3. **The Worker.** Workers & Pages → *Create* → *Import a repository* → pick
   `curiousscout`, and set **Root directory** to `startube-server`.
   (Or from a terminal: `cd startube-server && npx wrangler deploy`.)
4. **Your secret key.** In the new Worker: Settings → Variables and Secrets →
   add a **Secret** called `ADMIN_KEY` — a long password only you know
   (12+ characters). While you're there, set the variable `ALLOWED_ORIGINS` to
   your site's address, e.g. `https://curiousscout.example` (no trailing slash).
5. **Point StarTube at it.** Copy the Worker's address
   (`https://startube-server.<you>.workers.dev`) into `SERVER` near the top of
   the script in `startube/index.html`, then push to `main`.

6. **Turn on the play counter** (optional, works on its own too). Paste the
   same Worker address into `PLAYS_SERVER` near the top of `analytics.js`
   and push. If your database was made before the counter existed, run
   `schema.sql` in the D1 Console again — it only adds what's missing.

Then visit `/startube/#/review` on your site, enter your `ADMIN_KEY`, and you
will see every video waiting to be checked.

## API (for reference)

| Method | Path | |
| --- | --- | --- |
| GET | `/api/videos` | Approved videos |
| POST | `/api/videos` | Details + thumbnail → `{ id, token }` |
| PUT | `/api/videos/:id/file` | The file (header `X-Token`) → waits for review |
| GET | `/api/videos/:id/file`, `/thumb` | Approved only (admin: any) — supports `Range` |
| GET | `/api/videos/:id/mine` | Uploader checks status (`X-Token`) |
| DELETE | `/api/videos/:id` | Uploader deletes (`X-Token`) |
| POST | `/api/videos/:id/view`, `/cheer`, `/report` | |
| GET | `/api/plays` | Play counts for the landing page → `{ plays: { "math mine": 12, … }, total }` |
| POST | `/api/plays/:game` | Count one play (100 a day per connection) |
| GET | `/api/admin/queue` | Pending, reported and live (`Authorization: Bearer ADMIN_KEY`) |
| POST | `/api/admin/videos/:id/approve`, `/reject` | |

Local testing: `npx wrangler d1 execute startube --local --file=schema.sql`,
put `ADMIN_KEY=...` in `.dev.vars`, then `npx wrangler dev`.
