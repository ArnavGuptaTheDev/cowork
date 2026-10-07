-- Phase 3: Google Calendar sync and time tracking.
-- Safe on existing data: new tables only.

-- One-way Google Calendar sync. The refresh token is AES-GCM encrypted with CALENDAR_TOKEN_KEY (never plaintext).
CREATE TABLE calendar_links (
  user_id           TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  google_sub        TEXT NOT NULL,
  calendar_id       TEXT,
  refresh_token_enc TEXT NOT NULL,
  scope             TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  last_sync_at      INTEGER,
  last_error        TEXT
);

-- Which Google event mirrors which todo in whose calendar.
CREATE TABLE calendar_events (
  todo_id     TEXT NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id    TEXT NOT NULL,
  synced_hash TEXT,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (todo_id, user_id)
);
CREATE INDEX calendar_events_user ON calendar_events(user_id);

-- Time tracking. The running timer is the row with ended_at IS NULL (at most one per user).
CREATE TABLE time_entries (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  todo_id    TEXT NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  started_at INTEGER NOT NULL,
  ended_at   INTEGER,
  note       TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);
CREATE UNIQUE INDEX time_entries_running ON time_entries(user_id) WHERE ended_at IS NULL;
CREATE INDEX time_entries_todo ON time_entries(todo_id);
CREATE INDEX time_entries_user ON time_entries(user_id, started_at);
