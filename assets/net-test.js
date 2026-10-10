/*
 * Pagina di diagnostica della rete (rete-test.html).
 *
 * Da aprire sul computer che NON riesce a collegarsi: dice se i relay del
 * gioco sono raggiungibili, se i server STUN rispondono (condizione per
 * collegarsi da reti diverse) e se il TURN di ripiego funziona. Cosi' si vede
 * subito cosa blocca il router/DNS invece di indovinare.
 */
(function () {
    'use strict';

    var net = window.FreecrafterNet;
    var $ = function (id) { return document.getElementById(id); };

    // Gli stessi relay configurati in freecraft/index.html.
    var RELAYS = [
        'wss://relay.deev.is/',
        'wss://relay.shhnowisnottheti.me/',
        'wss://relay.webmc.fun/',
        'wss://relay.webmc.xyz/'
    ];

    function row(list, state, label, detail) {
        var li = document.createElement('li');
        li.className = state;
        var strong = document.createElement('strong');
        strong.textContent = label;
        li.appendChild(strong);
        if (detail) li.appendChild(document.createTextNode(' - ' + detail));
        list.appendChild(li);
        return li;
    }

    function setRow(li, state, detail) {
        li.className = state;
        var strong = li.firstChild;
        li.textContent = '';
        li.appendChild(strong);
        if (detail) li.appendChild(document.createTextNode(' - ' + detail));
    }

    function testRelay(url) {
        return new Promise(function (resolve) {
            var done = false;
            var started = Date.now();
            var socket;
            var finish = function (ok, detail) {
                if (done) return;
                done = true;
                try { socket.close(); } catch (e) { /* gia' chiuso */ }
                resolve({ ok: ok, detail: detail });
            };
            try { socket = new WebSocket(url); } catch (e) { return finish(false, 'indirizzo rifiutato dal browser'); }
            socket.onopen = function () { finish(true, 'raggiungibile (' + (Date.now() - started) + ' ms)'); };
            socket.onerror = function () { finish(false, 'non raggiungibile: bloccato (DNS/firewall) o relay spento'); };
            setTimeout(function () { finish(false, 'nessuna risposta in 7 secondi'); }, 7000);
        });
    }

    // Raccoglie i candidati ICE con un solo server alla volta e dice di che tipo
    // sono usciti: "srflx" = STUN ok, "relay" = TURN ok.
    function gather(server, timeoutMs) {
        return new Promise(function (resolve) {
            var found = {};
            var finished = false;
            var pc;
            var finish = function () {
                if (finished) return;
                finished = true;
                try { pc.close(); } catch (e) { /* gia' chiusa */ }
                resolve(found);
            };
            try {
                pc = new net.Native({ iceServers: [server] });
            } catch (e) { return resolve(found); }
            pc.onicecandidate = function (event) {
                if (!event.candidate) return finish();
                var match = / typ (\w+)/.exec(event.candidate.candidate);
                if (match) found[match[1]] = true;
            };
            pc.createDataChannel('probe');
            pc.createOffer().then(function (offer) { return pc.setLocalDescription(offer); }).catch(finish);
            setTimeout(finish, timeoutMs);
        });
    }

    function describeServer(server) {
        return [].concat(server.urls)[0];
    }

    async function runTests() {
        var out = $('results');
        out.textContent = '';
        $('run').disabled = true;
        var summary = { relays: 0, stun: 0, turn: 0, turnConfigured: 0 };

        var h1 = document.createElement('h2');
        h1.textContent = '1. Relay del gioco (handshake)';
        out.appendChild(h1);
        var relayList = document.createElement('ul');
        out.appendChild(relayList);
        var relayRows = RELAYS.map(function (url) { return { url: url, li: row(relayList, 'wait', url, 'controllo...') }; });
        await Promise.all(relayRows.map(function (item) {
            return testRelay(item.url).then(function (result) {
                if (result.ok) summary.relays++;
                setRow(item.li, result.ok ? 'ok' : 'bad', result.detail);
            });
        }));

        var h2 = document.createElement('h2');
        h2.textContent = '2. Server STUN (scoprire l\'indirizzo pubblico)';
        out.appendChild(h2);
        var stunList = document.createElement('ul');
        out.appendChild(stunList);
        var stunUrls = net.stunUrls;
        await Promise.all(stunUrls.map(function (url) {
            var li = row(stunList, 'wait', url, 'controllo...');
            return gather({ urls: url }, 6000).then(function (found) {
                if (found.srflx) summary.stun++;
                setRow(li, found.srflx ? 'ok' : 'bad', found.srflx ? 'risponde' : 'nessuna risposta (bloccato o irraggiungibile)');
            });
        }));

        var h3 = document.createElement('h2');
        h3.textContent = '3. Server TURN (ripiego quando il collegamento diretto non passa)';
        out.appendChild(h3);
        var turnList = document.createElement('ul');
        out.appendChild(turnList);
        var turns = net.extraServers().filter(function (s) { return s.username || s.credential; });
        summary.turnConfigured = turns.length;
        if (!turns.length) {
            row(turnList, 'warn', 'Nessun TURN disponibile', 'nessun server TURN da provare');
        }
        await Promise.all(turns.map(function (server) {
            var li = row(turnList, 'wait', describeServer(server), 'controllo...');
            return gather(server, 9000).then(function (found) {
                if (found.relay) summary.turn++;
                setRow(li, found.relay ? 'ok' : 'bad', found.relay ? 'funziona' : 'nessun candidato relay (credenziali errate o porta bloccata)');
            });
        }));

        var verdict = $('verdict');
        var text;
        var state;
        if (summary.relays === 0) {
            state = 'bad';
            text = 'Nessun relay raggiungibile: il gioco non riesce nemmeno a scambiare l\'handshake. Controlla i log di NextDNS e del UniFi per i domini sopra e sblocca quelli (oppure prova da un\'altra rete per capire quale blocca).';
        } else if (summary.stun === 0 && summary.turn === 0) {
            state = 'bad';
            text = 'I relay rispondono ma STUN e TURN no: il traffico UDP/WebRTC viene bloccato. Serve un TURN su TCP/443 (campo qui sopra).';
        } else if (summary.turn > 0) {
            state = 'ok';
            text = 'Tutto a posto: anche se il collegamento diretto fallisse, il TURN fa da ponte.';
        } else {
            state = 'warn';
            text = 'STUN funziona ma nessun TURN risponde: molte reti vanno bene lo stesso, ma con NAT severi (CGNAT, alcuni hotspot e Wi-Fi aziendali) il collegamento puo\' fallire.';
        }
        verdict.className = 'verdict ' + state;
        verdict.textContent = text;
        $('run').disabled = false;
    }

    function loadForm() {
        var options = net.readOptions();
        $('credentialsUrl').value = options.credentialsUrl;
        $('forceRelay').checked = options.forceRelay;
        $('turnHost').value = options.manual.host || '';
        $('turnUser').value = options.manual.username || '';
        $('turnPass').value = options.manual.credential || '';
    }

    function manualServers(host, username, credential) {
        // Accetta anche "turn:host:3478" incollato per intero: teniamo solo il nome host.
        var clean = host.replace(/^[a-z]+:/i, '').replace(/^\/\//, '').replace(/[:?/].*$/, '').trim();
        if (!clean || !username || !credential) return [];
        return [{
            urls: [
                'turns:' + clean + ':443?transport=tcp',
                'turn:' + clean + ':3478?transport=tcp',
                'turn:' + clean + ':3478?transport=udp'
            ],
            username: username,
            credential: credential
        }];
    }

    function saveForm() {
        var host = $('turnHost').value.trim();
        var username = $('turnUser').value.trim();
        var credential = $('turnPass').value.trim();
        var ok = net.saveOptions({
            credentialsUrl: $('credentialsUrl').value.trim(),
            turn: manualServers(host, username, credential),
            manual: { host: host, username: username, credential: credential },
            forceRelay: $('forceRelay').checked
        });
        $('saved').textContent = ok ? 'Salvato. Ricarica la pagina e il gioco per applicarlo.' : 'Impossibile salvare (storage bloccato dal browser).';
    }

    if (!net || !net.Native) {
        $('results').textContent = 'Questo browser non supporta WebRTC: il multigiocatore non puo\' funzionare qui.';
        $('run').disabled = true;
        return;
    }
    loadForm();
    $('save').addEventListener('click', saveForm);
    $('run').addEventListener('click', runTests);
})();
