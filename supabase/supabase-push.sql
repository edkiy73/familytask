-- ============================================================
-- FamilyHub · Web Push (часть 2)
-- Выполнить в SQL Editor ПОСЛЕ деплоя edge-функций (см. PUSH-SETUP.md)
-- ============================================================

-- Push-подписки устройств
create table if not exists hub_subs (
  fid        text not null,
  device     text not null,
  member     text,
  sub        jsonb not null,
  created_at timestamptz default now(),
  primary key (fid, device)
);
alter table hub_subs add column if not exists member text;

-- Журнал отправленных пушей (анти-дубль для крона)
create table if not exists hub_push_log (
  fid        text not null,
  key        text not null,
  created_at timestamptz default now(),
  primary key (fid, key)
);

alter table hub_subs     enable row level security;
alter table hub_push_log enable row level security;
revoke all on hub_subs     from anon, authenticated;
revoke all on hub_push_log from anon, authenticated;

-- RPC для клиента: сохранить / удалить подписку устройства
create or replace function hub_sub_put(p_fid text, p_device text, p_member text, p_sub jsonb)
returns void language sql security definer set search_path = public as $$
  insert into hub_subs(fid, device, member, sub) values (p_fid, p_device, p_member, p_sub)
  on conflict (fid, device) do update set sub = excluded.sub, member = excluded.member, created_at = now();
$$;

create or replace function hub_sub_del(p_fid text, p_device text)
returns void language sql security definer set search_path = public as $$
  delete from hub_subs where fid = p_fid and device = p_device;
$$;

grant execute on function hub_sub_put(text, text, text, jsonb), hub_sub_del(text, text) to anon, authenticated;

-- ============================================================
-- Крон: раз в минуту дёргаем edge-функцию push-cron
-- ============================================================
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('hub-deadlines')
 where exists (select 1 from cron.job where jobname = 'hub-deadlines');

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
