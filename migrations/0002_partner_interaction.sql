-- Phase 1: shared todos/projects, reactions, nudges, comments, evening wrap-up.
-- Safe on existing data: every new column is nullable or has a default; completions are backfilled.

-- Shared todos and projects. A todo is effectively shared when todos.is_shared = 1 or its project is shared.
ALTER TABLE todos ADD COLUMN is_shared INTEGER NOT NULL DEFAULT 0 CHECK (is_shared IN (0, 1));
-- Who a shared todo is for: a user id, or NULL for "either of us". Unused for unshared todos.
ALTER TABLE todos ADD COLUMN assigned_to TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE projects ADD COLUMN is_shared INTEGER NOT NULL DEFAULT 0 CHECK (is_shared IN (0, 1));

-- Who ticked an instance off (the owner, or the partner on a shared todo).
ALTER TABLE todo_instances ADD COLUMN completed_by TEXT REFERENCES users(id) ON DELETE SET NULL;
UPDATE todo_instances SET completed_by = user_id WHERE status = 'done' AND completed_by IS NULL;

-- Evening wrap-up: local HH:MM, NULL = off. Existing users get the default.
ALTER TABLE users ADD COLUMN wrapup_time TEXT DEFAULT '21:00';
ALTER TABLE users ADD COLUMN wrapup_sent_on TEXT;

CREATE INDEX todos_shared ON todos(user_id, is_shared);
CREATE INDEX projects_shared ON projects(user_id, is_shared);

CREATE TABLE reactions (
  instance_id TEXT NOT NULL REFERENCES todo_instances(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji       TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (instance_id, user_id)
);

CREATE TABLE nudges (
  id           TEXT PRIMARY KEY,
  todo_id      TEXT NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  instance_id  TEXT REFERENCES todo_instances(id) ON DELETE SET NULL,
  from_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL
);
CREATE INDEX nudges_todo ON nudges(todo_id, created_at);

CREATE TABLE comments (
  id         TEXT PRIMARY KEY,
  todo_id    TEXT NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  author_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX comments_todo ON comments(todo_id, created_at);
