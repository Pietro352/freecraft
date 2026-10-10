/*
 * Worker Cloudflare che genera le credenziali TURN per FREECRAFTER.
 *
 * Il TURN di Cloudflare (Realtime) e' un servizio gestito: non installi nulla,
 * i primi 1000 GB al mese sono gratuiti. Le credenziali pero' vanno create da
 * un piccolo servizio che custodisce la chiave segreta: e' questo Worker
 * (gratuito, nessun server da gestire).
 *
 * Passi (una volta sola):
 *  1. dash.cloudflare.com -> Realtime -> TURN Server -> "Create" -> copia
 *     "TURN Token ID" e "API Token".
 *  2. Workers & Pages -> Create -> "Hello World" -> Deploy -> Edit code:
 *     incolla questo file al posto del codice, poi Deploy.
 *  3. Nel Worker: Settings -> Variables and Secrets -> aggiungi
 *       TURN_KEY_ID    = il Token ID        (come Secret)
 *       TURN_API_TOKEN = l'API Token         (come Secret)
 *     e, se il tuo sito non e' https://pietro352.github.io, aggiungi anche
 *       ALLOWED_ORIGIN = https://il-tuo-sito
 *  4. Copia l'indirizzo del Worker (https://NOME.UTENTE.workers.dev) e
 *     incollalo nel campo di rete-test.html, poi Salva.
 */
const DEFAULT_ORIGIN = 'https://pietro352.github.io';

export default {
  async fetch(request, env) {
    const allowed = env.ALLOWED_ORIGIN || DEFAULT_ORIGIN;
    const origin = request.headers.get('Origin');
    const cors = {
      'Access-Control-Allow-Origin': allowed,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin'
    };

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: cors });
    // Non e' una vera protezione (l'Origin si puo' falsificare fuori dal browser)
    // ma evita che altri siti usino il tuo TURN dal browser.
    if (origin && origin !== allowed) return new Response('Forbidden', { status: 403, headers: cors });
    if (!env.TURN_KEY_ID || !env.TURN_API_TOKEN) {
      return new Response('TURN_KEY_ID / TURN_API_TOKEN non configurati', { status: 500, headers: cors });
    }

    const response = await fetch(
      'https://rtc.live.cloudflare.com/v1/turn/keys/' + env.TURN_KEY_ID + '/credentials/generate-ice-servers',
      {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + env.TURN_API_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl: 86400 })
      }
    );
    if (!response.ok) return new Response('Cloudflare ha risposto ' + response.status, { status: 502, headers: cors });

    const data = await response.json();
    // Il browser blocca la porta 53: la togliamo per non aspettare un timeout.
    const iceServers = (data.iceServers || []).map(function (server) {
      const urls = [].concat(server.urls || []).filter(function (u) { return !/:53(\?|$)/.test(u); });
      return Object.assign({}, server, { urls: urls });
    });
    return new Response(JSON.stringify(iceServers), {
      status: 200,
      headers: Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, cors)
    });
  }
};
