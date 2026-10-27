-- StarTube server database (Cloudflare D1). Run once:
--   npx wrangler d1 execute startube --remote --file=schema.sql
CREATE TABLE IF NOT EXISTS videos (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  descr       TEXT NOT NULL DEFAULT '',
  channel     TEXT NOT NULL,              -- a made-up name like "Purple Comet 42"
  dur         REAL NOT NULL,              -- seconds
  size        INTEGER NOT NULL,
  type        TEXT NOT NULL,              -- mp4 | webm | mov
  status      TEXT NOT NULL,              -- uploading | pending | public | reported
  created     INTEGER NOT NULL,
  approved    INTEGER,
  views       INTEGER NOT NULL DEFAULT 0,
  cheers      TEXT NOT NULL DEFAULT '{}', -- {"star": 3, "clap": 1, ...}
  reports     INTEGER NOT NULL DEFAULT 0,
  report_why  TEXT,
  token_hash  TEXT NOT NULL               -- lets the uploader check on or delete it
);
CREATE INDEX IF NOT EXISTS videos_status ON videos (status, approved);

-- Rate-limit counters. k = what + day + salted hash of the IP; never the IP itself.
CREATE TABLE IF NOT EXISTS limits (
  k    TEXT PRIMARY KEY,
  n    INTEGER NOT NULL,
  day  TEXT NOT NULL
);

-- How many times each CuriousScout game has been played (the landing page counter).
-- game = the game's directory name, e.g. "math mine".
CREATE TABLE IF NOT EXISTS plays (
  game  TEXT PRIMARY KEY,
  n     INTEGER NOT NULL DEFAULT 0
);
