// FamilyHub · push-cron
// Вызывается pg_cron раз в минуту: находит наступающие/наступившие
// дедлайны и рассылает пуши всем устройствам семьи (даже закрытым).
// Деплой: supabase functions deploy push-cron --no-verify-jwt

import { createClient } from 'npm:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

const supa = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

webpush.setVapidDetails(
  Deno.env.get('VAPID_SUBJECT') ?? 'mailto:hub@example.com',
  Deno.env.get('VAPID_PUBLIC_KEY')!,
  Deno.env.get('VAPID_PRIVATE_KEY')!,
);

// ---- расшифровка состояния (тот же вывод ключа, что на клиенте) ----
const keyCache = new Map<string, CryptoKey>();
async function familyKey(fid: string): Promise<CryptoKey> {
  const hit = keyCache.get(fid);
  if (hit) return hit;
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(fid), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: new TextEncoder().encode('family-hub/v1'), iterations: 150000, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  keyCache.set(fid, key);
  return key;
}
const unb64 = (x: string) => Uint8Array.from(atob(x), c => c.charCodeAt(0));
async function readState(fid: string, state: any): Promise<any> {
  if (!state || typeof state !== 'object') return state;
  if (!state.__enc) return state;                       // старые незашифрованные данные
  try {
    const key = await familyKey(fid);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(state.iv) }, key, unb64(state.d));
    return JSON.parse(new TextDecoder().decode(pt));
  } catch (_) { return null; }
}

// member=null и members=null → всем в семье; member='id' → одному участнику;
// members=[...] → списку участников («кто видит» дело/заметку)
async function sendToFamily(
  fid: string,
  payload: { title: string; body?: string; tag?: string },
  member?: string | null,
  members?: string[] | null,
) {
  const { data: subs } = await supa.from('hub_subs').select('device,member,sub').eq('fid', fid);
  const allow = members && members.length ? new Set(members) : null;
  for (const row of subs ?? []) {
    if (member && row.member !== member) continue;
    if (allow && !allow.has(row.member)) continue;
    try {
      await webpush.sendNotification(row.sub, JSON.stringify(payload), { TTL: 3600 });
    } catch (e: any) {
      if (e?.statusCode === 404 || e?.statusCode === 410) {
        await supa.from('hub_subs').delete().eq('fid', fid).eq('device', row.device);
      }
    }
  }
}

Deno.serve(async (req) => {
  if (req.headers.get('x-cron-secret') !== Deno.env.get('CRON_SECRET')) {
    return new Response('forbidden', { status: 403 });
  }
  const now = Date.now();
  let fired = 0;

  const { data: rows } = await supa.from('hub_state').select('fid,state');
  for (const row of rows ?? []) {
    const state = await readState(row.fid, row.state);
    if (!state) continue;                                // не удалось прочитать — пропускаем семью
    const tasks = (state.tasks ?? []) as any[];
    const overdue: Record<string, { titles: string[]; target: string | null; targetList: string[] | null }> = {};
    for (const t of tasks) {
      if (t.deleted || t.isDraft || t.completed || t.type !== 'tasks' || !t.deadline) continue;
      // «кто видит» ограничивает и дела, и заметки — пустой список значит «видит вся семья»
      const visibleTo: string[] = Array.isArray(t.visibleTo) && t.visibleTo.length ? t.visibleTo : [];
      // если дело кому-то назначено, получатель — он; иначе это все, кто видит дело
      const target: string | null = t.assignedTo ?? null;
      const targetList: string[] | null = target ? null : (visibleTo.length ? visibleTo : null);

      // дедлайны хранятся как локальное время семьи; state.tz = getTimezoneOffset() пишущего устройства
      // «весь день» (только дата, без времени) → уведомляем в 09:00 локального времени семьи
      const allDay = !/[T ]\d\d:\d\d/.test(t.deadline);
      const local = allDay ? (t.deadline.slice(0, 10) + 'T09:00') : t.deadline;
      const hasTZ = /[Zz]$|[+-]\d\d:?\d\d$/.test(local);
      const off = typeof state.tz === 'number' ? state.tz : 0;
      const d = Date.parse(hasTZ ? local : local + 'Z') + (hasTZ ? 0 : off * 60e3);
      if (isNaN(d)) continue;

      // копим просроченные для обеденной сводки — повторяющееся дело
      // логически не может быть «просроченным», у него всегда есть следующий раз.
      // ключ группы = получатель(и): либо исполнитель, либо конкретный состав видящих —
      // так дела с разной видимостью никогда не попадут в одну рассылку.
      if (now > d && !t.repeat) {
        const groupKey = target ? ('u:' + target) : ('v:' + (visibleTo.length ? [...visibleTo].sort().join(',') : 'ALL'));
        const bucket = (overdue[groupKey] ??= { titles: [], target, targetList });
        bucket.titles.push(t.title);
      }

      const events: [string, string, string][] = [];
      const time = allDay ? 'сегодня' : local.slice(11, 16);
      if (d - now > 0 && d - now <= 30 * 60e3)
        events.push(['s' + t.id + '|' + t.deadline, 'Скоро дедлайн', `${t.title} — в ${time}`]);
      if (now >= d && now - d <= 10 * 60e3)
        events.push(['d' + t.id + '|' + t.deadline, 'Дедлайн наступил', t.title]);

      for (const [key, title, body] of events) {
        // атомарный анти-дубль: вставилось — значит ещё не слали (ключ уникален на семью+событие)
        const { error } = await supa.from('hub_push_log').insert({ fid: row.fid, key });
        if (error) continue; // 23505 = уже отправляли
        await sendToFamily(row.fid, { title, body, tag: key }, target, targetList);
        fired++;
      }
    }

    // ---- ежедневная сводка просроченных в 12:00 по времени семьи ----
    const offFam = typeof state.tz === 'number' ? state.tz : 0;
    const famNow = new Date(now - offFam * 60e3);          // локальное время семьи
    if (famNow.getUTCHours() === 12) {
      const day = famNow.toISOString().slice(0, 10);
      for (const [groupKey, bucket] of Object.entries(overdue)) {
        if (!bucket.titles.length) continue;
        const key = 'od|' + day + '|' + groupKey;
        const { error } = await supa.from('hub_push_log').insert({ fid: row.fid, key });
        if (error) continue;                                // уже отправляли сегодня
        const n = bucket.titles.length;
        const word = n === 1 ? 'просроченное дело' : (n < 5 ? 'просроченных дела' : 'просроченных дел');
        const body = bucket.titles.slice(0, 3).join(', ') + (n > 3 ? ` и ещё ${n - 3}` : '');
        await sendToFamily(row.fid, { title: `${n} ${word}`, body, tag: key }, bucket.target, bucket.targetList);
        fired++;
      }
    }
  }

  // подчистка журнала раз в час
  if (new Date().getMinutes() === 0) {
    await supa.from('hub_push_log').delete()
      .lt('created_at', new Date(now - 7 * 864e5).toISOString());
  }
  return new Response(JSON.stringify({ ok: true, fired }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
