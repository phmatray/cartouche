// RetroAchievements relay: forwards Cartouche's rc_client calls to retroachievements.org/dorequest.php, which answers
// no web page (no CORS) and reads the emulator's identity from User-Agent (which fetch can't set). It adds both and
// keeps nothing: no logs, no storage. Deploy: npx wrangler deploy (from this folder).
const UPSTREAM = 'https://retroachievements.org/dorequest.php';
const ORIGINS = /^(https:\/\/phmatray\.github\.io|http:\/\/localhost(:\d+)?|http:\/\/127\.0\.0\.1(:\d+)?)$/;
const CLIENT = /^Cartouche\/\d+\.\d+\.\d+( \([\w .,;-]{1,64}\))?( [\w.-]+\/\d+\.\d+\.\d+)?$/;

export default {
  async fetch(req) {
    const origin = req.headers.get('Origin') ?? '';
    if (!ORIGINS.test(origin)) return new Response('Forbidden', { status: 403 });
    const cors = {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST',
      'Access-Control-Allow-Headers': 'Content-Type, X-RA-Client',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const client = req.headers.get('X-RA-Client') ?? '';
    if (req.method !== 'POST' || !CLIENT.test(client)) return new Response('Bad request', { status: 400, headers: cors });
    const r = await fetch(UPSTREAM, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': client },
      body: await req.text(),
    });
    return new Response(r.body, { status: r.status, headers: { ...cors, 'Content-Type': r.headers.get('Content-Type') ?? 'application/json' } });
  },
};
