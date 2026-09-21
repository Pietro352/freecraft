import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("unsafe custom JavaScript mods stay disabled", async () => {
  const [config, runtime] = await Promise.all([
    readFile(new URL("../assets/launcher-config.js", import.meta.url), "utf8"),
    readFile(new URL("../assets/game-mods.js", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(config, /Mod personalizzata/);
  assert.doesNotMatch(runtime, /new Function\s*\(/);
});

test("the packaged game client carries the FREECRAFT title texture", async () => {
  const { readClientAsset } = await import("../tools/client-bundle.mjs");
  const { decodePng } = await import("../tools/png.mjs");

  const texture = decodePng(readClientAsset("assets/minecraft/textures/gui/title/minecraft.png"));
  assert.equal(texture.width, 256);
  assert.equal(texture.height, 256);

  // The wordmark lives in the two 155x44 tiles at the top of the texture and is
  // green, unlike the grey Minecraft logo it replaced.
  let green = 0;
  for (let i = 0; i < texture.width * 89 * 4; i += 4) {
    if (texture.data[i + 3] > 200 && texture.data[i + 1] > texture.data[i] + 40) green++;
  }
  assert.ok(green > 500, `expected a green wordmark in the title tiles, found ${green} pixels`);
});

test("the game page still has the markup that boots the client", async () => {
  const page = await readFile(new URL("../freecraft/index.html", import.meta.url), "latin1");
  const lines = page.split("\n");

  // The client bundle is one enormous base64 line. Editing it has already once
  // swallowed the tags around it, which boots into a black screen, so pin the
  // exact structure: the payload line must close its own <style>, and the
  // bootstrap script that hands the payload to the client must follow it.
  const bundleLine = lines.findIndex((line) => line.includes('id="freecrafterClientBundle"'));
  assert.ok(bundleLine >= 0, "client bundle element is missing");
  assert.match(lines[bundleLine], /base64,[A-Za-z0-9+/]+={0,2}<\/style>$/);
  assert.equal(lines[bundleLine + 1], '<script type="text/javascript">');
  assert.match(page, /window\.eaglercraftXClientBundle = freecrafterBundleUnwrap\("freecrafterClientBundle"\)/);
});

test("launcher exposes onboarding, releases and real download progress", async () => {
  // The boot logic used to live in an inline <script> in index.html. It now sits
  // in assets/launcher-boot.js so the page can run under a Content-Security-Policy
  // that refuses inline scripts, which is what stops injected code from reading
  // the session token. These assertions follow it there.
  const [html, boot, clientHtml, panels, releases] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../assets/launcher-boot.js", import.meta.url), "utf8"),
    readFile(new URL("../freecraft/index.html", import.meta.url), "utf8"),
    readFile(new URL("../assets/launcher-panels.js", import.meta.url), "utf8"),
    readFile(new URL("../assets/releases.js", import.meta.url), "utf8"),
  ]);
  assert.match(boot, /response\.body\.getReader/);
  assert.doesNotMatch(boot, /Math\.random\(\) \* 8/);
  // The progress fetch must stay a byte counter: keeping the chunks meant
  // holding the whole ~18 MB client in a string and handing it to srcdoc.
  assert.doesNotMatch(boot, /\.srcdoc\s*=/);
  assert.match(boot, /freecraftFrame\.src = FREECRAFT_SOURCE/);
  assert.match(panels, /BENVENUTO IN FREECRAFT/);
  assert.doesNotMatch(clientHtml, /freecraft_menu_brand/);

  // index.html must not grow an inline <script> again, or the CSP would break
  // the launcher on the next deploy rather than in review.
  assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)[^>]*>/);
  assert.match(html, /<script src="assets\/launcher-boot\.js/);
});

test("the changelog stays newest-first so the Novita panel opens on the latest release", async () => {
  const releases = await readFile(new URL("../assets/releases.js", import.meta.url), "utf8");
  const versions = [...releases.matchAll(/version: '(\d+)\.(\d+)\.(\d+)'/g)]
    .map(([, major, minor, patch]) => [Number(major), Number(minor), Number(patch)]);

  assert.ok(versions.length > 0, "the changelog has no entries");
  // launcher-panels.js reads entry 0 as "the newest one" to decide whether to
  // light up the unread badge, so an out-of-order file would show the wrong
  // release and mark it read.
  for (let i = 1; i < versions.length; i++) {
    const [previous, current] = [versions[i - 1], versions[i]];
    assert.ok(
      previous[0] > current[0] ||
      (previous[0] === current[0] && previous[1] > current[1]) ||
      (previous[0] === current[0] && previous[1] === current[1] && previous[2] > current[2]),
      `release ${current.join(".")} is listed after ${previous.join(".")}`,
    );
  }
});

test("the game menu shows the logo and nothing else in its corners", async () => {
  const { readClientBundle } = await import("../tools/client-bundle.mjs");
  const { readStringPool } = await import("../tools/patch-game-menu.mjs");

  const { classes } = readClientBundle();
  const pool = readStringPool(classes);
  // CREDITS.txt, the version stamps and the copyright notices all come out of
  // these pool slots; the patch empties them so the menu measures them at zero
  // width and skips their panels too.
  for (const index of [6219, 6224, 6234, 6235, 6236, 6237, 6238, 6239, 6240]) {
    const entry = pool.entries[index];
    assert.equal(classes.slice(entry.start, entry.end), '""', `pool entry ${index} is not blank`);
  }
  // The runtime build stamp and the credits click target are drawn from code
  // rather than from those strings, so they need their own checks.
  assert.match(classes, /AOw\(\);if\(B\(\)\)\{break _;\}g=C\(6\);/);
  assert.ok(classes.includes("if(0){g=C(6243);"), "the CREDITS.txt click target is still live");
});

test("the packaged client speaks Italian by default", async () => {
  const { readClientBundle } = await import("../tools/client-bundle.mjs");
  const { LANG_ASSET, LANGUAGE, readStringPool } = await import("../tools/patch-game-menu.mjs");

  const { classes, epk } = readClientBundle();
  const italian = epk.entries.find((entry) => entry.name === LANG_ASSET);
  assert.ok(italian, `${LANG_ASSET} is not packaged`);

  const keys = new Map(
    italian.content
      .toString("utf8")
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
  assert.equal(keys.get("language.code"), LANGUAGE);
  assert.equal(keys.get("menu.singleplayer"), "Giocatore singolo");
  // English is loaded first and Italian overlaid on top, so a partial file
  // would silently leave half the game in English.
  const english = epk.entries.find((entry) => entry.name === "assets/minecraft/lang/en_US.lang");
  const englishKeys = english.content.toString("utf8").split("\n").filter((line) => line.includes("=")).length;
  assert.equal(keys.size, englishKeys);

  // The profile falls back to the language at this pool index when nothing has
  // been saved yet, so it has to point at the entry holding "it_IT".
  const pool = readStringPool(classes);
  const index = Number(/a\.b\$b=C\((\d+)\);/.exec(classes)[1]);
  const entry = pool.entries[index];
  assert.equal(classes.slice(entry.start, entry.end), `"${LANGUAGE}"`);
  assert.ok(classes.includes(`?b.lang:"${LANGUAGE}"`), "the JSON profile still falls back to en_US");
});

test("the service worker keeps the launcher and its files for offline play", async () => {
  const sw = await readFile(new URL("../sw.js", import.meta.url), "utf8");

  // Senza la pagina del launcher in archivio, offline il browser non aprirebbe
  // nemmeno la homepage che lancia il client.
  assert.match(sw, /const SHELL_CACHE = "freecraft-shell"/);
  assert.match(sw, /request\.mode === "navigate"/);
  assert.match(sw, /url\.pathname\.startsWith\("\/assets\/"\)/);

  // Il resto del sito - chat, funzioni, telemetria - deve continuare a passare
  // senza che il service worker lo tocchi: un suo difetto non deve rompere la
  // chat. Le richieste che non sono GET escono subito, e nessun percorso delle
  // funzioni compare nel file.
  assert.match(sw, /request\.method !== "GET"\) return;/);
  assert.doesNotMatch(sw, /\/api\/|\.netlify/);

  // Il client vecchio si butta solo dopo aver salvato quello nuovo: chi e'
  // offline durante un aggiornamento deve poter giocare con quello che ha.
  const saveGame = sw.slice(sw.indexOf("async function saveGame"));
  assert.ok(
    saveGame.indexOf("await cache.put(GAME_PATH") < saveGame.indexOf("await dropOldGameCaches()"),
    "the old game cache is dropped before the new client is stored",
  );
  assert.match(sw, /if \(await current\.match\(GAME_PATH\)\) await dropOldGameCaches\(\);/);
});

test("the homepage announces offline mode without an inline script", async () => {
  const [html, offline, boot] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../assets/offline-mode.js", import.meta.url), "utf8"),
    readFile(new URL("../assets/launcher-boot.js", import.meta.url), "utf8"),
  ]);

  assert.match(html, /id="fc-offline-notice"[^>]*\shidden/);
  assert.match(html, /<script src="assets\/offline-mode\.js\?v=[A-Za-z0-9]+"><\/script>/);
  // La CSP consente le richieste solo verso il sito stesso (connect-src 'self'):
  // il controllo della rete deve restare su un indirizzo relativo.
  assert.match(offline, /const PING_URL = 'sw\.js'/);
  assert.doesNotMatch(offline, /https?:\/\//);
  // Il pulsante Gioca si spegne solo senza client scaricato: chi lo ha deve poter
  // giocare offline.
  assert.match(offline, /caches\.match\(GAME_URL\)/);
  assert.match(offline, /if \(clientSaved\) \{/);
  // Se il client manca l'errore deve dire di collegarsi, non di caricare cartelle.
  assert.match(boot, /Sei offline e il client di gioco non è ancora stato scaricato/);
});

test("losing the network never logs the chat out", async () => {
  const chat = await readFile(new URL("../assets/chat.js", import.meta.url), "utf8");

  // La modalita' offline apre la homepage anche senza rete. Se il controllo della
  // sessione fallito per mancanza di rete cancellasse il gettone, chi apre il
  // sito in treno si ritroverebbe senza accesso per altri 30 giorni.
  assert.match(chat, /error\.offline = true/);
  assert.match(chat, /if \(!error\.offline\) setLoggedOut\(\)/);
  assert.match(chat, /window\.addEventListener\('online'/);
});
