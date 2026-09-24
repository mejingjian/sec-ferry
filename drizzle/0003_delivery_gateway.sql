-- 外网交付闭环：download_deliveries + download_events
-- 手工迁移 0003（与 db/schema.ts 保持一致）

CREATE TABLE IF NOT EXISTS download_deliveries (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  external_object_key TEXT,
  download_url TEXT,
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  max_downloads INTEGER NOT NULL DEFAULT 5,
  download_count INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  first_downloaded_at TEXT,
  last_downloaded_at TEXT,
  revoked_at TEXT,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS download_deliveries_application_idx ON download_deliveries(application_id);
CREATE INDEX IF NOT EXISTS download_deliveries_token_hash_idx ON download_deliveries(token_hash);

CREATE TABLE IF NOT EXISTS download_events (
  id TEXT PRIMARY KEY,
  delivery_id TEXT,
  application_id TEXT NOT NULL,
  event TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  result TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS download_events_delivery_idx ON download_events(delivery_id);
CREATE INDEX IF NOT EXISTS download_events_application_idx ON download_events(application_id);
CREATE INDEX IF NOT EXISTS download_events_created_at_idx ON download_events(created_at);
