/*
 * Modalita' offline della homepage FREECRAFT.
 *
 * Senza connessione la homepage si apre lo stesso: la serve sw.js dalla copia
 * che ha messo da parte. Questo file se ne accorge e lo dice: "sei passato alla
 * modalita' offline". Se il client di gioco e' gia' stato scaricato - cioe' se
 * hai gia' giocato una volta con la rete - Gioca funziona come sempre, perche'
 * anche il client lo serve sw.js dal suo archivio. Se invece non e' mai stato
 * scaricato lo spiega, invece di lasciarti davanti a un errore.
 *
 * Vive in un file suo perche' la Content-Security-Policy dichiarata in
 * netlify.toml consente solo script serviti dal sito.
 */
(() => {
    'use strict';

    const notice = document.getElementById('fc-offline-notice');
    const title = document.getElementById('fc-offline-title');
    const text = document.getElementById('fc-offline-text');
    const mainMenu = document.getElementById('main-menu');
    const playBtn = document.getElementById('play-btn');
    const retryBtn = document.getElementById('retry-btn');
    if (!notice || !title || !text || !playBtn) return;

    const GAME_URL = '/freecraft/index.html';
    // Un file del sito che non passa mai dall'archivio del service worker: serve
    // solo a vedere se la rete risponde davvero.
    const PING_URL = 'sw.js';
    const PING_TIMEOUT_MS = 5000;
    const ONLINE_RECHECK_MS = 60000;
    const OFFLINE_RECHECK_MS = 8000;

    let offline = false;
    let clientSaved = false;
    let pending = null;
    let rerun = false;
    let timer = null;
    // Vero se e' stato questo file a spegnere Gioca: cosi' lo riaccendiamo solo
    // noi, e mai mentre il launcher sta avviando la partita.
    let playBlocked = false;

    // navigator.onLine dice "no" solo quando e' proprio cosi', ma dice "si'"
    // anche quando il Wi-Fi c'e' e internet no: per quel caso si prova a
    // raggiungere il sito.
    async function isReachable() {
        if (navigator.onLine === false) return false;
        const controller = new AbortController();
        const giveUp = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);
        try {
            // Qualunque risposta, anche un errore del server, vuol dire che la
            // rete funziona: fetch fallisce soltanto quando non c'e' collegamento.
            await fetch(`${PING_URL}?ping=${Date.now()}`, { method: 'HEAD', cache: 'no-store', signal: controller.signal });
            return true;
        } catch {
            return false;
        } finally {
            clearTimeout(giveUp);
        }
    }

    // Il client e' stato scaricato se sta in uno degli archivi del service worker.
    async function clientIsSaved() {
        try {
            return Boolean(window.caches && await caches.match(GAME_URL));
        } catch {
            return false;
        }
    }

    const menuIsShowing = () => Boolean(mainMenu) && mainMenu.style.display !== 'none';

    function releasePlay() {
        if (!playBlocked) return;
        playBtn.disabled = false;
        playBlocked = false;
    }

    function render() {
        document.body.classList.toggle('is-offline', offline);
        if (!offline) {
            notice.hidden = true;
            releasePlay();
            return;
        }

        notice.classList.toggle('is-blocked', !clientSaved);
        if (clientSaved) {
            title.textContent = 'Sei passato alla modalità offline';
            text.textContent = 'Non c\u2019è connessione, ma puoi giocare lo stesso: il client è già salvato su questo dispositivo e i tuoi mondi restano qui. La CraftChat torna quando sei di nuovo online.';
            releasePlay();
        } else {
            title.textContent = 'Sei offline';
            text.textContent = 'Il client di gioco non è ancora stato scaricato su questo dispositivo. Connettiti e avvia il gioco almeno una volta: dopo potrai giocare anche senza rete.';
            if (menuIsShowing()) {
                playBtn.disabled = true;
                playBlocked = true;
            }
        }
        notice.hidden = false;
    }

    function schedule() {
        clearTimeout(timer);
        // In partita o a scheda nascosta non serve controllare: al ritorno lo fa
        // visibilitychange.
        if (document.hidden || document.body.classList.contains('is-in-game')) return;
        timer = setTimeout(update, offline ? OFFLINE_RECHECK_MS : ONLINE_RECHECK_MS);
    }

    function update() {
        // Se arriva un evento mentre un controllo e' in corso, quel controllo
        // potrebbe restituire un risultato gia' vecchio: se ne fa un altro subito
        // dopo.
        if (pending) {
            rerun = true;
            return pending;
        }
        pending = (async () => {
            const [reachable, saved] = await Promise.all([isReachable(), clientIsSaved()]);
            const wasOffline = offline;
            offline = !reachable;
            clientSaved = saved;
            render();
            if (wasOffline && !offline && !document.body.classList.contains('is-in-game')) {
                window.FreecrafterPanels?.toast('Connessione ripristinata.');
            }
        })().finally(() => {
            pending = null;
            if (rerun) {
                rerun = false;
                update();
            } else {
                schedule();
            }
        });
        return pending;
    }

    window.addEventListener('offline', update);
    window.addEventListener('online', update);
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) clearTimeout(timer);
        else update();
    });
    // "Torna al menu" dopo un errore riaccende Gioca (vedi launcher-boot.js): se
    // siamo ancora offline senza client va rispento.
    if (retryBtn) retryBtn.addEventListener('click', render);

    update();
})();
