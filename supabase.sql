-- ============================================================
-- Семейный Хаб · настройка Supabase
-- Выполните этот скрипт целиком в Supabase → SQL Editor → Run
-- ============================================================

-- Состояние семьи: один JSON-документ на семью + счётчик ревизий
create table if not exists hub_state (
  fid        text primary key,
  rev        bigint not null default 1,
  state      jsonb  not null,
  updated_at timestamptz default now()
);

-- Фотографии (задачи и аватарки), base64 jpeg
create table if not exists hub_images (
  fid        text not null,
  id         text not null,
  data       text not null,
  created_at timestamptz default now(),
  primary key (fid, id)
);

-- Прямой доступ к таблицам закрыт полностью:
-- клиент работает ТОЛЬКО через RPC-функции ниже,
-- каждая требует код семьи (fid). Без кода данные недостижимы.
alter table hub_state  enable row level security;
alter table hub_images enable row level security;
revoke all on hub_state  from anon, authenticated;
revoke all on hub_images from anon, authenticated;

-- Забрать состояние
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

-- Записать состояние (оптимистичная блокировка по rev)
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

-- Фото: положить / забрать / удалить
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

grant execute on function
  hub_pull(text),
  hub_push(text, bigint, jsonb),
  hub_img_put(text, text, text),
  hub_img_get(text, text),
  hub_img_del(text, text)
to anon, authenticated;
