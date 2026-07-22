-- ============================================================
-- Семейный Хаб · ПОЛНАЯ установка Supabase (одним файлом)
--
-- Выполните этот скрипт целиком в Supabase → SQL Editor → Run.
-- Он безопасно пересоздаёт всё: удаляет старые функции/расписание
-- и ставит актуальные (с адресными пуш-уведомлениями).
-- Edge-функции push-send и push-cron у вас уже развёрнуты — их
-- передеплоивать нужно только если менялся их код (push-send обновлён).
-- ============================================================

-- ---------- очистка старого ----------
do $$ begin
  if exists (select 1 from pg_extension where extname='pg_cron') then
    perform cron.unschedule('hub-deadlines') where exists (select 1 from cron.job where jobname='hub-deadlines');
  end if;
end $$;

drop function if exists hub_pull(text);
drop function if exists hub_push(text, bigint, jsonb);
drop function if exists hub_img_put(text, text, text);
drop function if exists hub_img_get(text, text);
drop function if exists hub_img_del(text, text);
drop function if exists hub_sub_put(text, text, jsonb);
drop function if exists hub_sub_put(text, text, text, jsonb);
drop function if exists hub_sub_del(text, text);

-- ---------- таблицы ----------
create table if not exists hub_state (
  fid        text primary key,
  rev        bigint not null default 1,
  state      jsonb  not null,
  updated_at timestamptz default now()
);

create table if not exists hub_images (
  fid        text not null,
  id         text not null,
  data       text not null,
  created_at timestamptz default now(),
  primary key (fid, id)
);

create table if not exists hub_subs (
  fid        text not null,
  device     text not null,
  member     text,
  sub        jsonb not null,
  created_at timestamptz default now(),
  primary key (fid, device)
);
alter table hub_subs add column if not exists member text;

create table if not exists hub_push_log (
  fid        text not null,
  key        text not null,
  created_at timestamptz default now(),
  primary key (fid, key)
);

-- ---------- доступ: только через RPC ----------
alter table hub_state     enable row level security;
alter table hub_images    enable row level security;
alter table hub_subs      enable row level security;
alter table hub_push_log  enable row level security;
revoke all on hub_state    from anon, authenticated;
revoke all on hub_images   from anon, authenticated;
revoke all on hub_subs     from anon, authenticated;
revoke all on hub_push_log from anon, authenticated;

-- ---------- состояние ----------
create or replace function hub_pull(p_fid text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r record;
begin
  select rev, state into r from hub_state where fid = p_fid;
  if not found then
    return jsonb_build_object('rev', 0, 'state', null);
  end if;
  return jsonb_build_object('rev', r.rev, 'state', r.state);
end $$;

create or replace function hub_push(p_fid text, p_base_rev bigint, p_state jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare cur bigint;
begin
  select rev into cur from hub_state where fid = p_fid for update;
  if not found then
    insert into hub_state(fid, rev, state) values (p_fid, 1, p_state);
    return jsonb_build_object('ok', true, 'rev', 1);
  end if;
  if cur <> p_base_rev then
    return (select jsonb_build_object('ok', false, 'rev', rev, 'state', state)
            from hub_state where fid = p_fid);
  end if;
  update hub_state set rev = rev + 1, state = p_state, updated_at = now()
   where fid = p_fid;
  return jsonb_build_object('ok', true, 'rev', cur + 1);
end $$;

-- ---------- фото ----------
create or replace function hub_img_put(p_fid text, p_id text, p_data text)
returns void language sql security definer set search_path = public as $$
  insert into hub_images(fid, id, data) values (p_fid, p_id, p_data)
  on conflict (fid, id) do update set data = excluded.data;
$$;

create or replace function hub_img_get(p_fid text, p_id text)
returns text language sql security definer set search_path = public as $$
  select data from hub_images where fid = p_fid and id = p_id;
$$;

create or replace function hub_img_del(p_fid text, p_id text)
returns void language sql security definer set search_path = public as $$
  delete from hub_images where fid = p_fid and id = p_id;
$$;

-- ---------- push-подписки ----------
create or replace function hub_sub_put(p_fid text, p_device text, p_member text, p_sub jsonb)
returns void language sql security definer set search_path = public as $$
  insert into hub_subs(fid, device, member, sub) values (p_fid, p_device, p_member, p_sub)
  on conflict (fid, device) do update set sub = excluded.sub, member = excluded.member, created_at = now();
$$;

create or replace function hub_sub_del(p_fid text, p_device text)
returns void language sql security definer set search_path = public as $$
  delete from hub_subs where fid = p_fid and device = p_device;
$$;

-- ---------- права на RPC ----------
grant execute on function
  hub_pull(text),
  hub_push(text, bigint, jsonb),
  hub_img_put(text, text, text),
  hub_img_get(text, text),
  hub_img_del(text, text),
  hub_sub_put(text, text, text, jsonb),
  hub_sub_del(text, text)
to anon, authenticated;

-- ---------- крон: дедлайны раз в минуту ----------
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'hub-deadlines',
  '* * * * *',
  $$
  select net.http_post(
    url     := 'https://qviioxefqtnhashdbtls.supabase.co/functions/v1/push-cron',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', 'cbfcce263d9dde5670d1844afc30b83dc1f41b035f15ae7d'
    ),
    body    := '{}'::jsonb
  );
  $$
);
