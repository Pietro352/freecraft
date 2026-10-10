/*
 * Rete "più robusta" per le partite LAN/multigiocatore di FREECRAFTER.
 *
 * Il client usa WebRTC: i due computer si scambiano l'handshake tramite un
 * relay (WebSocket) e poi parlano direttamente tra loro. Sulla stessa rete di
 * casa basta l'indirizzo locale e tutto funziona. Su reti diverse il browser
 * deve scoprire il proprio indirizzo pubblico (STUN) e, quando il router o il
 * firewall non lasciano passare il traffico diretto, appoggiarsi a un server
 * di rimbalzo (TURN), meglio se raggiungibile su TCP/443 perche' e' la porta
 * che i firewall severi lasciano quasi sempre aperta.
 *
 * Questo file viene caricato dentro l'iframe del client PRIMA che il gioco
 * parta (come game-mods.js) e fa una sola cosa: ogni volta che il client crea
 * una connessione WebRTC, aggiunge in coda alla lista dei server ICE quelli
 * qui sotto. Il codice del gioco non viene toccato.
 *
 * Configurazione (tutta opzionale), salvata in localStorage con la chiave
 * "freecrafter:net:v1" e modificabile dalla pagina rete-test.html:
 *   {
 *     "credentialsUrl": "https://NOME.metered.live/api/v1/turn/credentials?apiKey=CHIAVE",
 *     "turn": [{ "urls": "turns:host:443?transport=tcp", "username": "...", "credential": "..." }],
 *     "forceRelay": false
 *   }
 * - credentialsUrl: indirizzo che restituisce un array di server ICE (formato
 *   del servizio TURN gratuito di Metered). Viene scaricato all'avvio, molto
 *   prima che qualcuno apra una partita LAN.
 * - turn: server TURN scritti a mano.
 * - forceRelay: passa SEMPRE dal TURN. Utile solo per provare che il TURN
 *   funzioni davvero.
 */
(function () {
    'use strict';

    var STORAGE_KEY = 'freecrafter:net:v1';
    var CACHE_KEY = 'freecrafter:net:turn-cache:v1';
    var CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

    // STUN pubblici. Oltre alle porte standard ci sono varianti su 53/80/443:
    // alcune reti bloccano 3478 e 19302 ma non queste.
    var STUN_URLS = [
        'stun:stun.cloudflare.com:3478',
        'stun:stun.cloudflare.com:53',
        'stun:stun.l.google.com:19302',
        'stun:stun1.l.google.com:19302',
        'stun:stun.relay.metered.ca:80'
    ];

    function readJson(storage, key) {
        try {
            var raw = storage.getItem(key);
            return raw ? JSON.parse(raw) : null;
        } catch (e) { return null; }
    }

    function readOptions() {
        var stored = readJson(window.localStorage, STORAGE_KEY) || {};
        return {
            credentialsUrl: typeof stored.credentialsUrl === 'string' ? stored.credentialsUrl.trim() : '',
            turn: Array.isArray(stored.turn) ? stored.turn : [],
            forceRelay: stored.forceRelay === true
        };
    }

    function urlList(server) {
        if (!server || !server.urls) return [];
        return Array.isArray(server.urls) ? server.urls : [server.urls];
    }

    function isValidServer(server) {
        return urlList(server).some(function (u) { return typeof u === 'string' && /^(stun|turn|turns):/i.test(u); });
    }

    var options = readOptions();
    var fetchedTurn = [];

    var cached = readJson(window.localStorage, CACHE_KEY);
    if (cached && Array.isArray(cached.servers) && Date.now() - cached.at < CACHE_MAX_AGE_MS) {
        fetchedTurn = cached.servers.filter(isValidServer);
    }

    // Scarica le credenziali TURN in anticipo: il costruttore di RTCPeerConnection
    // e' sincrono, quindi usa quello che c'e' al momento della chiamata.
    function loadCredentials() {
        if (!options.credentialsUrl || typeof fetch !== 'function') return;
        var controller = typeof AbortController === 'function' ? new AbortController() : null;
        var timer = controller ? setTimeout(function () { controller.abort(); }, 8000) : null;
        fetch(options.credentialsUrl, controller ? { signal: controller.signal } : undefined)
            .then(function (response) { return response.ok ? response.json() : []; })
            .then(function (list) {
                if (!Array.isArray(list)) return;
                fetchedTurn = list.filter(isValidServer);
                try {
                    window.localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), servers: fetchedTurn }));
                } catch (e) { /* storage non disponibile: nessun problema */ }
            })
            .catch(function () { /* offline o bloccato: si va avanti con i soli STUN */ })
            .then(function () { if (timer) clearTimeout(timer); });
    }

    function extraServers() {
        var list = [{ urls: STUN_URLS }];
        return list.concat(options.turn.filter(isValidServer), fetchedTurn);
    }

    // Unisce i server che da' il relay con i nostri, senza duplicati.
    function mergeServers(original) {
        var base = Array.isArray(original) ? original.slice() : (original ? [original] : []);
        var seen = {};
        base.forEach(function (server) {
            urlList(server).forEach(function (u) { seen[u] = true; });
        });
        extraServers().forEach(function (server) {
            var fresh = urlList(server).filter(function (u) { return !seen[u]; });
            if (!fresh.length) return;
            fresh.forEach(function (u) { seen[u] = true; });
            var copy = {};
            for (var k in server) { if (Object.prototype.hasOwnProperty.call(server, k)) copy[k] = server[k]; }
            copy.urls = fresh;
            base.push(copy);
        });
        return base;
    }

    function isFeatureProbe(config) {
        // Il client crea una connessione "finta" verso 127.69.0.1 solo per capire
        // se il browser supporta WebRTC: lasciamola stare.
        return urlList((config.iceServers || [])[0]).some(function (u) { return String(u).indexOf('127.69.0.1') !== -1; });
    }

    var natives = {};
    ['RTCPeerConnection', 'webkitRTCPeerConnection', 'mozRTCPeerConnection'].forEach(function (name) {
        var Native = window[name];
        if (typeof Native !== 'function' || typeof Proxy !== 'function') return;
        natives[name] = Native;
        try {
            window[name] = new Proxy(Native, {
                construct: function (target, args, newTarget) {
                    var config = Object.assign({}, args[0] || {});
                    if (!isFeatureProbe(config)) {
                        config.iceServers = mergeServers(config.iceServers);
                        if (config.iceCandidatePoolSize == null) config.iceCandidatePoolSize = 2;
                        if (options.forceRelay) config.iceTransportPolicy = 'relay';
                    }
                    return Reflect.construct(target, [config].concat(Array.prototype.slice.call(args, 1)), newTarget);
                }
            });
        } catch (e) { /* se il browser non lascia sostituirlo, il gioco usa il suo */ }
    });

    window.FreecrafterNet = {
        Native: natives.RTCPeerConnection || natives.webkitRTCPeerConnection || natives.mozRTCPeerConnection || null,
        stunUrls: STUN_URLS.slice(),
        readOptions: readOptions,
        saveOptions: function (next) {
            try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch (e) { return false; }
            try { window.localStorage.removeItem(CACHE_KEY); } catch (e) { /* ignora */ }
            return true;
        },
        extraServers: extraServers
    };

    loadCredentials();
})();
