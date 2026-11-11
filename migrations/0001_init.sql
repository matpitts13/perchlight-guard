-- perchlight-guard: usage samples, alerts sent, what could be read.

-- One row per limit per check. Kept 35 days.
CREATE TABLE samples (
  id           INTEGER PRIMARY KEY,
  taken_at     TEXT NOT NULL DEFAULT (datetime('now')),
  limit_id     TEXT NOT NULL,
  period_start TEXT NOT NULL,
  used         REAL,
  limit_value  REAL NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('ok', 'unreadable', 'nodata')),
  error        TEXT
);
CREATE INDEX samples_limit_time ON samples (limit_id, taken_at);

-- Every alert sent. The unique key is what makes "once per period" hold,
-- even when two checks run at the same time.
-- kind: threshold:<pct> | projected | charging | blind | summary
CREATE TABLE alerts (
  id           INTEGER PRIMARY KEY,
  limit_id     TEXT NOT NULL,
  period_start TEXT NOT NULL,
  kind         TEXT NOT NULL,
  sent_at      TEXT NOT NULL DEFAULT (datetime('now')),
  message      TEXT NOT NULL DEFAULT '',
  channels     TEXT NOT NULL DEFAULT '',
  error        TEXT,
  UNIQUE (limit_id, period_start, kind)
);

-- Which analytics datasets the account offers, from the last schema check.
CREATE TABLE datasets (
  name       TEXT PRIMARY KEY,
  available  INTEGER NOT NULL CHECK (available IN (0, 1)),
  checked_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_error TEXT
);

-- Small pieces of state: consecutive failed checks, last check time.
CREATE TABLE state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- GitHub repository visibility, checked at most once a day per repo.
CREATE TABLE repo_visibility (
  name       TEXT PRIMARY KEY,
  public     INTEGER NOT NULL CHECK (public IN (0, 1)),
  checked_at TEXT NOT NULL DEFAULT (datetime('now'))
);
