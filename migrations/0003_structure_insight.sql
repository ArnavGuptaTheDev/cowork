-- Phase 2: subtasks, templates, joint habits, shared goals, pause mode, photo timeline.
-- Safe on existing data: new tables, and new columns with defaults only.

-- Subtasks: the checklist belongs to the todo; ticks belong to an instance, so it resets per occurrence.
CREATE TABLE subtasks (
  id         TEXT PRIMARY KEY,
  todo_id    TEXT NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX subtasks_todo ON subtasks(todo_id, position);

CREATE TABLE subtask_checks (
  subtask_id  TEXT NOT NULL REFERENCES subtasks(id) ON DELETE CASCADE,
  instance_id TEXT NOT NULL REFERENCES todo_instances(id) ON DELETE CASCADE,
  checked_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  checked_at  INTEGER NOT NULL,
  PRIMARY KEY (subtask_id, instance_id)
);
CREATE INDEX subtask_checks_instance ON subtask_checks(instance_id);

-- Templates: named sets of todos (with subtasks and recurrence), per user, optionally shared with the partner.
CREATE TABLE templates (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  is_shared  INTEGER NOT NULL DEFAULT 0 CHECK (is_shared IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX templates_user ON templates(user_id);

CREATE TABLE template_items (
  id                   TEXT PRIMARY KEY,
  template_id          TEXT NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
  position             INTEGER NOT NULL DEFAULT 0,
  title                TEXT NOT NULL,
  notes                TEXT NOT NULL DEFAULT '',
  category             TEXT NOT NULL CHECK (category IN ('personal', 'work', 'habit')),
  due_time             TEXT,
  reminder_time        TEXT,
  recurrence           TEXT NOT NULL DEFAULT 'none' CHECK (recurrence IN ('none', 'daily', 'weekly', 'monthly')),
  recurrence_weekdays  TEXT,
  recurrence_month_day INTEGER CHECK (recurrence_month_day BETWEEN 1 AND 31),
  subtasks             TEXT NOT NULL DEFAULT '[]',   -- JSON array of subtask titles
  -- Items saved from private todos stay private: never shown or applied for the partner.
  is_private           INTEGER NOT NULL DEFAULT 0 CHECK (is_private IN (0, 1))
);
CREATE INDEX template_items_template ON template_items(template_id, position);

-- Joint habits: a shared repeating todo that counts for a day only when both partners complete it.
ALTER TABLE todos ADD COLUMN is_joint INTEGER NOT NULL DEFAULT 0 CHECK (is_joint IN (0, 1));
CREATE TABLE instance_completions (
  instance_id  TEXT NOT NULL REFERENCES todo_instances(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  completed_at INTEGER NOT NULL,
  PRIMARY KEY (instance_id, user_id)
);

-- Shared weekly targets ("gym 4 times each"): each partner links one of their todos.
CREATE TABLE goals (
  id                TEXT PRIMARY KEY,
  created_by        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title             TEXT NOT NULL,
  target_per_person INTEGER NOT NULL CHECK (target_per_person BETWEEN 1 AND 50),
  created_at        INTEGER NOT NULL,
  archived_at       INTEGER
);
CREATE INDEX goals_creator ON goals(created_by);
CREATE TABLE goal_links (
  goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  todo_id TEXT NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  PRIMARY KEY (goal_id, user_id)
);

-- Pause mode: date ranges (owner's local dates) when reminders and nudges are silenced and
-- recurring instances are marked paused instead of missed, so streaks freeze.
CREATE TABLE pauses (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  start_date TEXT NOT NULL,
  end_date   TEXT NOT NULL,
  note       TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  CHECK (end_date >= start_date)
);
CREATE INDEX pauses_user ON pauses(user_id, end_date);
ALTER TABLE todo_instances ADD COLUMN paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1));

-- Photo timeline: newest first.
CREATE INDEX photos_created ON photos(created_at, id);
