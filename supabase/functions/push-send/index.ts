// FamilyHub · push-send
// Мгновенный пуш всем устройствам семьи (кроме отправителя).
// Деплой: supabase functions deploy push-send --no-verify-jwt

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

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

export async function sendToFamily(
  fid: string,
  payload: { title: string; body?: string; tag?: string },
  exclude?: string,
  member?: string | null,
  members?: string[] | null,
): Promise<number> {
  const { data: subs } = await supa.from('hub_subs').select('device,member,sub').eq('fid', fid);
  const allow = members && members.length ? new Set(members) : null;
  let sent = 0;
  for (const row of subs ?? []) {
    if (exclude && row.device === exclude) continue;
    if (member && row.member !== member) continue;      // одному участнику
    if (allow && !allow.has(row.member)) continue;      // списку участников
    try {
      await webpush.sendNotification(row.sub, JSON.stringify(payload), { TTL: 3600 });
      sent++;
    } catch (e: any) {
      // подписка умерла — чистим
      if (e?.statusCode === 404 || e?.statusCode === 410) {
        await supa.from('hub_subs').delete().eq('fid', fid).eq('device', row.device);
      }
    }
  }
  return sent;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const { fid, title, body, tag, exclude, member, members } = await req.json();
    if (!fid || !title) return json({ error: 'fid and title required' }, 400);

    // fid — секретный код семьи, он же и авторизация: семья должна существовать
    const { data: fam } = await supa.from('hub_state').select('fid').eq('fid', fid).maybeSingle();
    if (!fam) return json({ error: 'unknown family' }, 404);

    const sent = await sendToFamily(fid, { title, body, tag }, exclude, member, members);
    return json({ ok: true, sent });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
