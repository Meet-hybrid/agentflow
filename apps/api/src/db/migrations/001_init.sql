-- AgentFlow initial schema.
-- Money-moving state is authoritative on-chain; these tables record intent
-- (chain_ops), confirmed outcomes and the off-chain coordination around them.

create table users (
  id uuid primary key default gen_random_uuid(),
  stellar_address text not null unique check (stellar_address ~ '^G[A-Z2-7]{55}$'),
  created_at timestamptz not null default now()
);

create table sessions (
  token_hash bytea primary key,
  user_id uuid not null references users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index sessions_user_idx on sessions(user_id);

-- SEP-10 challenges that have been exchanged for a session (replay protection).
create table used_challenges (
  tx_hash text primary key,
  used_at timestamptz not null default now()
);

create table agents (
  id uuid primary key default gen_random_uuid(),
  operator_id uuid not null references users(id),
  name text not null,
  description text not null default '',
  payout_address text not null check (payout_address ~ '^G[A-Z2-7]{55}$'),
  capabilities jsonb not null,
  status text not null default 'active' check (status in ('active', 'suspended')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (operator_id, name)
);

create table agent_keys (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references agents(id) on delete cascade,
  key_hash bytea not null unique,
  prefix text not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

create table tasks (
  id uuid primary key default gen_random_uuid(),
  onchain_id text not null unique check (onchain_id ~ '^[0-9a-f]{64}$'),
  client_id uuid not null references users(id),
  title text not null,
  description text not null,
  acceptance_criteria text not null,
  task_type text not null,
  spec jsonb not null,
  spec_sha256 text not null,
  asset_code text not null,
  asset_contract text not null,
  amount numeric(39, 0) not null check (amount > 0),
  deadline timestamptz not null,
  max_duration_seconds int not null,
  status text not null check (status in (
    'draft', 'open', 'assigned', 'in_progress', 'submitted', 'under_review', 'approved',
    'paid', 'rejected', 'disputed', 'resolved', 'cancelled', 'refunded')),
  assigned_agent_id uuid references agents(id),
  payee_address text,
  rejections int not null default 0,
  review_window_seconds int,
  submitted_at timestamptz,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index tasks_status_idx on tasks(status);
create index tasks_client_idx on tasks(client_id);
create index tasks_agent_idx on tasks(assigned_agent_id);

create table applications (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks(id) on delete cascade,
  agent_id uuid not null references agents(id),
  message text not null default '',
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'declined', 'withdrawn')),
  created_at timestamptz not null default now(),
  unique (task_id, agent_id)
);
-- At most one accepted application per task, even under concurrent accepts.
create unique index applications_one_accepted on applications(task_id) where status = 'accepted';

create table submissions (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks(id) on delete cascade,
  agent_id uuid not null references agents(id),
  attempt int not null,
  idempotency_key text not null,
  output jsonb not null,
  evidence jsonb not null,
  output_sha256 text not null,
  digest text not null check (digest ~ '^[0-9a-f]{64}$'),
  verification jsonb not null,
  status text not null default 'pending_chain'
    check (status in ('pending_chain', 'submitted', 'approved', 'rejected', 'superseded')),
  created_at timestamptz not null default now(),
  unique (task_id, attempt),
  unique (agent_id, idempotency_key)
);

create table chain_ops (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks(id) on delete cascade,
  action text not null,
  contract_fn text not null,
  params jsonb not null default '{}',
  signer text not null,
  requested_by_type text not null check (requested_by_type in ('user', 'agent')),
  requested_by_id uuid not null,
  status text not null default 'prepared'
    check (status in ('prepared', 'submitted', 'confirmed', 'failed', 'expired', 'superseded')),
  tx_hash text not null unique,
  unsigned_xdr text not null,
  signed_xdr text,
  max_time timestamptz not null,
  from_status text not null,
  pending_status text,
  error text,
  ledger int,
  submitted_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index chain_ops_task_idx on chain_ops(task_id);
create index chain_ops_status_idx on chain_ops(status);
-- One transaction in flight per task: e.g. an approve and a dispute cannot
-- both be pending, so the database never has two competing outcomes.
create unique index chain_ops_one_inflight on chain_ops(task_id) where status = 'submitted';

create table reviews (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks(id) on delete cascade,
  submission_id uuid references submissions(id),
  decision text not null check (decision in ('approved', 'rejected')),
  reason text not null default '',
  reviewer_id uuid not null references users(id),
  chain_op_id uuid not null unique references chain_ops(id),
  created_at timestamptz not null default now()
);

create table disputes (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks(id) on delete cascade,
  opened_by_type text not null check (opened_by_type in ('user', 'agent', 'chain')),
  opened_by_id uuid,
  reason text not null default '',
  status text not null default 'open' check (status in ('open', 'resolved')),
  payee_bps int check (payee_bps between 0 and 10000),
  resolution_reason text,
  resolved_by uuid references users(id),
  open_op_id uuid unique references chain_ops(id),
  resolve_op_id uuid unique references chain_ops(id),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create unique index disputes_one_open on disputes(task_id) where status = 'open';

create table task_events (
  id bigserial primary key,
  task_id uuid not null references tasks(id) on delete cascade,
  actor_type text not null check (actor_type in ('user', 'agent', 'system', 'chain')),
  actor_id text,
  action text not null,
  from_status text,
  to_status text,
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index task_events_task_idx on task_events(task_id, id);

create table agent_runs (
  id bigserial primary key,
  task_id uuid not null references tasks(id) on delete cascade,
  agent_id uuid not null references agents(id),
  status text not null,
  message text not null,
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index agent_runs_task_idx on agent_runs(task_id, id);

create table chain_events (
  id text primary key,
  ledger int not null,
  tx_hash text not null,
  name text not null,
  onchain_task_id text,
  data jsonb not null,
  created_at timestamptz not null default now()
);
create index chain_events_task_idx on chain_events(onchain_task_id);

create table indexer_state (
  key text primary key,
  cursor text,
  ledger int,
  updated_at timestamptz not null default now()
);
