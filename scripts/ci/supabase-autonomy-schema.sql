CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TABLE IF NOT EXISTS users (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  clerk_user_id TEXT UNIQUE NOT NULL,
  email TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS autonomy_streams (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  workflow_type TEXT NOT NULL CHECK (workflow_type IN ('provisioning', 'factory')),
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'retry_scheduled', 'completed', 'failed_terminal', 'inconsistent')),
  current_state JSONB NOT NULL DEFAULT '{}',
  last_seq_no BIGINT NOT NULL DEFAULT 0,
  retry_count INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 5,
  next_tick_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  last_error TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS autonomy_events (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  stream_id UUID NOT NULL REFERENCES autonomy_streams(id) ON DELETE CASCADE,
  seq_no BIGINT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json JSONB NOT NULL DEFAULT '{}',
  metadata_json JSONB NOT NULL DEFAULT '{}',
  idempotency_key TEXT NOT NULL,
  prev_hash TEXT,
  event_hash TEXT NOT NULL,
  actor_type TEXT,
  actor_id TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE (stream_id, seq_no),
  UNIQUE (stream_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS autonomy_leases (
  stream_id UUID PRIMARY KEY REFERENCES autonomy_streams(id) ON DELETE CASCADE,
  worker_id TEXT NOT NULL,
  lease_expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  heartbeat_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS autonomy_dead_letters (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  stream_id UUID NOT NULL REFERENCES autonomy_streams(id) ON DELETE CASCADE,
  terminal_reason TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  last_event_id UUID REFERENCES autonomy_events(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS autonomy_snapshots (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  stream_id UUID NOT NULL REFERENCES autonomy_streams(id) ON DELETE CASCADE,
  last_seq_no BIGINT NOT NULL,
  state_blob JSONB NOT NULL DEFAULT '{}',
  state_hash TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE (stream_id)
);

DROP TRIGGER IF EXISTS update_users_updated_at ON users;
CREATE TRIGGER update_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_autonomy_streams_updated_at ON autonomy_streams;
CREATE TRIGGER update_autonomy_streams_updated_at
  BEFORE UPDATE ON autonomy_streams
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_autonomy_leases_updated_at ON autonomy_leases;
CREATE TRIGGER update_autonomy_leases_updated_at
  BEFORE UPDATE ON autonomy_leases
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_autonomy_snapshots_updated_at ON autonomy_snapshots;
CREATE TRIGGER update_autonomy_snapshots_updated_at
  BEFORE UPDATE ON autonomy_snapshots
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
