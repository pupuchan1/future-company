CREATE TABLE mcp_subscriptions (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  event_name TEXT NOT NULL,
  arguments_json TEXT NOT NULL,
  department TEXT,
  case_id TEXT,
  callback_url TEXT NOT NULL,
  signing_secret TEXT NOT NULL,
  previous_secret TEXT,
  rotate_until TEXT,
  expires_at TEXT NOT NULL,
  active INTEGER NOT NULL CHECK (active IN (0,1)),
  verified_at TEXT NOT NULL,
  UNIQUE(principal_id, event_name, arguments_json, callback_url)
);
CREATE INDEX mcp_subscriptions_event ON mcp_subscriptions(event_name, active, expires_at);

CREATE TABLE mcp_events (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  body TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);
CREATE TABLE mcp_deliveries (
  subscription_id TEXT NOT NULL REFERENCES mcp_subscriptions(id),
  event_id TEXT NOT NULL REFERENCES mcp_events(id),
  status TEXT NOT NULL CHECK (status IN ('pending','sending','delivered','failed','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  next_attempt_at TEXT NOT NULL,
  lease_until TEXT,
  last_status INTEGER,
  last_error TEXT,
  PRIMARY KEY(subscription_id, event_id)
);
