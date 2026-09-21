// Service worker: tiene da parte il client di gioco e la pagina del launcher,
// cosi' si puo' giocare anche senza connessione.
//
// Il client (/freecraft/index.html) pesa 18 MB. Senza questo file il browser se
// lo tiene in cache dieci minuti (vedi netlify.toml) e poi ricomincia da capo:
// chi gioca tutti i giorni si ritrova a scaricare 18 MB ogni volta, e con la
// connessione del telefono e' un'attesa lunga e traffico buttato.
//
// Qui invece: la prima volta lo scarichiamo e lo mettiamo in un archivio del
// browser, e da li' in poi lo serviamo da quell'archivio, subito e senza rete.
//
// Per la modalita' offline non basta il client: senza rete il browser non
// riuscirebbe nemmeno ad aprire la homepage che lo lancia. Percio' teniamo da
// parte anche la pagina del launcher e i file di assets/ che usa (script, stili,
// immagini) e, dopo il primo avvio, il font. Chi non ha mai giocato non ha il
// client in archivio: offline la homepage si apre lo stesso, ma glielo dice.
//
// GAME_BUILD e' l'impronta del contenuto del client, riscritta in automatico da
// tools/stamp-assets.mjs a ogni rilascio. Quando pubblichiamo un client nuovo
// l'impronta cambia, il nome dell'archivio cambia con lei e il gioco nuovo viene
// scaricato. Nessuno resta indietro.
const GAME_BUILD = "7e605eb2cdcd";
const GAME_CACHE_PREFIX = "freecraft-game-";
const CACHE = `${GAME_CACHE_PREFIX}${GAME_BUILD}`;
const GAME_PATH = "/freecraft/index.html";

// Archivio della homepage e delle sue risorse. Il nome non cambia mai: dentro
// c'e' una sola versione di ogni file, le vecchie le butta storeAsset().
const SHELL_CACHE = "freecraft-shell";
const SHELL_PAGE = "/";

// Se la rete non risponde entro questi secondi la homepage si apre dalla copia
// che abbiamo: meglio una pagina di qualche ora fa che uno schermo bianco.
const NAVIGATION_TIMEOUT_MS = 6000;
const PRECACHE_TIMEOUT_MS = 20000;

// Quanta parte iniziale del client leggere per trovare gli script che chiama:
// stanno tutti nelle prime righe, prima dei 18 MB di dati.
const GAME_HEAD_BYTES = 65536;

// Appena installato prende servizio, senza aspettare che si chiudano le schede
// gia' aperte: altrimenti dopo un aggiornamento la versione nuova resterebbe in
// attesa fino alla chiusura di tutte le finestre di Freecraft.
self.addEventListener("install", (event) => {
  event.waitUntil(Promise.all([
    self.skipWaiting(),
    // Un fallimento qui non deve impedire l'installazione: la homepage verra'
    // messa da parte alla prossima visita.
    withTimeout(precacheShell(), PRECACHE_TIMEOUT_MS).catch(() => {}),
  ]));
});

// Il client di un rilascio precedente si butta solo quando quello nuovo e' gia'
// al sicuro: se chi e' offline aggiornasse il service worker prima di aver
// riscaricato il gioco, si ritroverebbe senza niente su cui giocare.
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const current = await caches.open(CACHE);
    if (await current.match(GAME_PATH)) await dropOldGameCaches();
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Tocchiamo soltanto la pagina del gioco, quella del launcher, i file di
  // assets/ e il font. Tutto il resto - la chat, le funzioni, la telemetria -
  // passa senza che ce ne occupiamo: se questo file avesse un difetto, resterebbe
  // un difetto confinato al caricamento del sito invece di rompere la chat.
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  if (url.origin === self.location.origin) {
    if (url.pathname === GAME_PATH) {
      event.respondWith(serveGame(event));
    } else if (request.mode === "navigate" && (url.pathname === "/" || url.pathname === "/index.html")) {
      event.respondWith(serveLauncherPage(event));
    } else if (url.pathname.startsWith("/assets/")) {
      event.respondWith(serveAsset(event));
    }
    return;
  }

  // Il font Minecraft arriva da cdnfonts.com (vedi il tag <link> in index.html).
  if (url.hostname === "cdnfonts.com" || url.hostname.endsWith(".cdnfonts.com")) {
    event.respondWith(serveFont(event));
  }
});

// --- Client di gioco ---

async function serveGame(event) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(GAME_PATH);
  if (cached) return cached;

  try {
    const response = await fetch(event.request);

    // Mettiamo da parte solo una risposta completa e riuscita. Una risposta
    // parziale o un errore del server salvato in archivio significherebbe un
    // gioco rotto che si ripresenta identico a ogni avvio.
    //
    // Il salvataggio non viene atteso: la pagina deve ricevere i byte mentre
    // arrivano, perche' e' contandoli che disegna la barra di avanzamento.
    // Aspettando qui, al primo avvio la barra resterebbe ferma a zero per tutti
    // i 18 MB e poi salterebbe di colpo alla fine. waitUntil tiene comunque in
    // vita il service worker finche' la copia non e' stata scritta.
    if (response.ok && response.status === 200) {
      event.waitUntil(saveGame(cache, response.clone()));
    }
    return response;
  } catch (error) {
    // Senza rete un client di un rilascio precedente e' meglio di niente.
    const older = await caches.match(GAME_PATH);
    if (older) return older;
    throw error;
  }
}

async function saveGame(cache, response) {
  await cache.put(GAME_PATH, response);
  await dropOldGameCaches();

  // Il client chiama alcuni file di assets/ che la homepage non usa (le mod).
  // Se il primo avvio li scaricasse senza passare di qui, offline il gioco
  // partirebbe senza: li mettiamo da parte adesso, insieme a lui.
  try {
    await cacheGameAssets(await cache.match(GAME_PATH));
  } catch (error) {
    // Non bloccante: i file mancanti verranno salvati la prossima volta che il
    // gioco li richiede con la rete attiva (vedi serveAsset).
  }
}

// Mette da parte i file di assets/ che il client chiama, leggendoli dalla sua
// copia in archivio (i primi kilobyte, non i 18 MB).
async function cacheGameAssets(game) {
  const head = await readHead(game, GAME_HEAD_BYTES);
  await cacheAssets(assetPaths(head, GAME_PATH));
}

async function dropOldGameCaches() {
  const names = await caches.keys();
  await Promise.all(names
    .filter((name) => name.startsWith(GAME_CACHE_PREFIX) && name !== CACHE)
    .map((name) => caches.delete(name)));
}

// --- Homepage del launcher ---

// Prima la rete, cosi' chi e' online vede sempre l'ultima versione appena
// pubblicata; la copia serve solo quando la rete manca o non risponde.
async function serveLauncherPage(event) {
  const cache = await caches.open(SHELL_CACHE);
  const network = fetch(event.request).then((response) => {
    if (isCacheable(response)) keepAlive(event, cache.put(SHELL_PAGE, response.clone()));
    return response;
  });
  // Se vince il timeout la richiesta continua comunque: quando arriva
  // aggiorna la copia per la volta dopo.
  network.catch(() => {});

  try {
    return await withTimeout(network, NAVIGATION_TIMEOUT_MS);
  } catch (error) {
    const cached = await cache.match(SHELL_PAGE);
    if (cached) return cached;
    return network;
  }
}

// Script, stili e immagini del launcher. Gli indirizzi con il timbro
// (?v=6f2a91c4, vedi tools/stamp-assets.mjs) non cambiano mai contenuto, quindi
// si servono dall'archivio senza chiedere niente. Quelli senza timbro potrebbero
// cambiare: prima la rete, e la copia solo se manca.
async function serveAsset(event) {
  const { request } = event;
  const cache = await caches.open(SHELL_CACHE);
  const stamped = new URL(request.url).searchParams.has("v");

  if (stamped) {
    const cached = await cache.match(request);
    if (cached) return cached;
  }

  try {
    const response = await fetch(request);
    if (isCacheable(response)) keepAlive(event, storeAsset(cache, request.url, response.clone()));
    return response;
  } catch (error) {
    // Offline: si accetta anche un'altra versione dello stesso file, purche'
    // il gioco parta.
    const fallback = await cache.match(request, { ignoreSearch: true });
    if (fallback) return fallback;
    throw error;
  }
}

// Il font non cambia mai, ma la risposta del foglio di stile non si puo'
// leggere (arriva da un altro dominio): si serve la copia e intanto si prova ad
// aggiornarla, cosi' un salvataggio andato male si sistema da solo.
async function serveFont(event) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(event.request);
  const refresh = fetch(event.request).then(async (response) => {
    if (response.ok || response.type === "opaque") {
      // Un salvataggio andato male non deve togliere il font alla pagina.
      await cache.put(event.request, response.clone()).catch(() => {});
    }
    return response;
  });

  if (cached) {
    event.waitUntil(refresh.catch(() => {}));
    return cached;
  }
  return refresh;
}

// --- Archivio delle risorse ---

async function precacheShell() {
  const cache = await caches.open(SHELL_CACHE);
  const page = await fetch(SHELL_PAGE, { cache: "no-cache" });
  if (!isCacheable(page)) return;

  const html = await page.clone().text();
  await cache.put(SHELL_PAGE, page);
  await cacheAssets(assetPaths(html, SHELL_PAGE));

  // Chi ha gia' il client in archivio (ha gia' giocato, magari prima di questo
  // aggiornamento) deve poter giocare offline subito, senza dover giocare
  // un'altra volta con la rete per far salvare anche i file che il client chiama.
  const game = await caches.match(GAME_PATH);
  if (game) await cacheGameAssets(game);
}

// Scarica e archivia i file che non abbiamo ancora. Uno che non si riesce a
// prendere non ferma gli altri.
async function cacheAssets(paths) {
  const cache = await caches.open(SHELL_CACHE);
  await Promise.all(paths.map(async (path) => {
    try {
      if (await cache.match(path)) return;
      const response = await fetch(path);
      if (isCacheable(response)) await storeAsset(cache, path, response);
    } catch (error) {
      // Lo riproveremo alla prossima richiesta di quel file.
    }
  }));
}

// Salva un file e butta le versioni precedenti dello stesso file (stesso nome,
// timbro diverso), altrimenti dopo qualche rilascio l'archivio si riempirebbe
// di copie che nessuno chiede piu'.
async function storeAsset(cache, address, response) {
  const url = new URL(address, self.location.origin);
  await cache.put(url.href, response);
  if (!url.searchParams.has("v")) return;
  for (const old of await cache.keys()) {
    const oldUrl = new URL(old.url);
    if (oldUrl.pathname === url.pathname && oldUrl.search !== url.search) await cache.delete(old);
  }
}

// I file di assets/ chiamati da una pagina, con il loro timbro. Cerchiamo solo
// dentro src="..." e href="..." come fa tools/stamp-assets.mjs.
function assetPaths(html, pagePath) {
  const page = new URL(pagePath, self.location.origin);
  const paths = new Set();
  for (const match of html.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)) {
    try {
      const url = new URL(match[1], page);
      if (url.origin === self.location.origin && url.pathname.startsWith("/assets/")) {
        paths.add(url.pathname + url.search);
      }
    } catch (error) {
      // Un indirizzo che non si legge non e' un file nostro: si salta.
    }
  }
  return [...paths];
}

// --- Utilita' ---

// Vale la pena salvare solo una risposta completa, arrivata dal nostro sito e
// senza giri di reindirizzamento: una pagina "spostata" servita dall'archivio
// verrebbe rifiutata dal browser.
function isCacheable(response) {
  return response.ok && response.status === 200 && response.type === "basic" && !response.redirected;
}

// Tiene in vita il service worker finche' un salvataggio non e' finito. Se la
// risposta arriva dopo che la pagina e' gia' stata servita (un timeout) il
// browser non accetta piu' waitUntil: il salvataggio parte lo stesso.
function keepAlive(event, promise) {
  promise.catch(() => {});
  try {
    event.waitUntil(promise);
  } catch (error) {
    // Evento gia' concluso: si va avanti senza garanzie.
  }
}

// Legge solo l'inizio di una risposta e lascia perdere il resto.
async function readHead(response, limit) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (text.length < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return text;
}

function withTimeout(promise, ms) {
  let timer;
  const expiry = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), ms);
  });
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
}
