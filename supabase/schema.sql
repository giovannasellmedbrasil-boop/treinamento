-- Plataforma de Treinamentos Sellmed
-- Treinamentos (um por produto/tema) → aulas (vídeo, apresentação ou quiz) → progresso e tentativas dos participantes.
-- Vídeos, apresentações e capas ficam no bucket público "treinamentos" (nomes com sufixo aleatório).

create table if not exists public.treinamentos (
  id           uuid primary key default gen_random_uuid(),
  slug         text not null unique check (slug ~ '^[a-z0-9-]{1,90}$'),
  title        text not null check (char_length(title) between 1 and 140),
  description  text not null default '' check (char_length(description) <= 1200),
  product      text not null default '' check (char_length(product) <= 120),
  area         text not null default '' check (char_length(area) <= 60),
  manufacturer text not null default '' check (char_length(manufacturer) <= 60),
  cover_url    text,
  published    boolean not null default true,
  sort_order   int not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table if not exists public.aulas (
  id             uuid primary key default gen_random_uuid(),
  treinamento_id uuid not null references public.treinamentos(id) on delete cascade,
  kind           text not null check (kind in ('video', 'apresentacao', 'quiz')),
  title          text not null check (char_length(title) between 1 and 140),
  description    text not null default '' check (char_length(description) <= 1200),
  media_url      text,                 -- link externo (YouTube, Vimeo, Drive…) ou arquivo enviado ao Storage
  file_name      text not null default '',
  size           bigint not null default 0,
  duration_min   int,
  quiz           jsonb,                -- { questions: [{ text, options[], correct, explanation }] }
  pass_score     int not null default 70 check (pass_score between 0 and 100),
  sort_order     int not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists aulas_treinamento on public.aulas (treinamento_id, sort_order);

create table if not exists public.participantes (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (char_length(name) between 1 and 120),
  email      text not null check (char_length(email) between 3 and 160),
  area       text not null default '' check (char_length(area) <= 80),
  created_at timestamptz not null default now(),
  last_seen  timestamptz not null default now()
);
create unique index if not exists participantes_email on public.participantes (lower(email));

create table if not exists public.conclusoes (
  participante_id uuid not null references public.participantes(id) on delete cascade,
  aula_id         uuid not null references public.aulas(id) on delete cascade,
  done_at         timestamptz not null default now(),
  primary key (participante_id, aula_id)
);

create table if not exists public.tentativas (
  id              uuid primary key default gen_random_uuid(),
  participante_id uuid not null references public.participantes(id) on delete cascade,
  aula_id         uuid not null references public.aulas(id) on delete cascade,
  score           int not null,        -- 0 a 100
  correct         int not null,
  total           int not null,
  passed          boolean not null,
  answers         jsonb not null,
  created_at      timestamptz not null default now()
);
create index if not exists tentativas_aula on public.tentativas (aula_id, participante_id);

-- Acesso só pelas funções da Vercel (conexão direta ao Postgres); nada exposto pela API pública do Supabase
alter table public.treinamentos  enable row level security;
alter table public.aulas         enable row level security;
alter table public.participantes enable row level security;
alter table public.conclusoes    enable row level security;
alter table public.tentativas    enable row level security;
revoke all on public.treinamentos, public.aulas, public.participantes, public.conclusoes, public.tentativas from anon, authenticated;

-- Bucket público (leitura pública; envio/remoção só pelo servidor com a chave secreta).
-- Sem limite próprio: vale o limite de arquivo do projeto (50 MB no plano gratuito).
insert into storage.buckets (id, name, public, allowed_mime_types)
values ('treinamentos', 'treinamentos', true, array[
  'video/mp4', 'video/webm', 'video/quicktime',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-powerpoint',
  'image/jpeg'])
on conflict (id) do nothing;

-- ---------- Login com senha (12/11/2026) ----------
-- Só e-mails do domínio permitido (ALLOWED_DOMAIN, padrão sellmedbrasil.com). No primeiro acesso a pessoa
-- recebe por e-mail um link de uso único para criar a senha; o mesmo fluxo serve para "esqueci minha senha".
alter table public.participantes add column if not exists password_hash text;
alter table public.participantes add column if not exists password_set_at timestamptz;
alter table public.participantes add column if not exists failed_logins int not null default 0;
alter table public.participantes add column if not exists locked_until timestamptz;

-- Links enviados por e-mail (guardamos só o hash do token)
create table if not exists public.auth_tokens (
  token_hash      text primary key,
  participante_id uuid not null references public.participantes(id) on delete cascade,
  purpose         text not null check (purpose in ('primeiro', 'redefinir')),
  expires_at      timestamptz not null,
  used_at         timestamptz,
  created_at      timestamptz not null default now()
);
create index if not exists auth_tokens_participante on public.auth_tokens (participante_id, created_at);

-- Sessões abertas no navegador (guardamos só o hash do token)
create table if not exists public.sessoes (
  token_hash      text primary key,
  participante_id uuid not null references public.participantes(id) on delete cascade,
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null
);
create index if not exists sessoes_participante on public.sessoes (participante_id);

alter table public.auth_tokens enable row level security;
alter table public.sessoes     enable row level security;
revoke all on public.auth_tokens, public.sessoes from anon, authenticated;
