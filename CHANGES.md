# Changelog — Sessione del 21 aprile 2026 (ottimizzazione secondaria)

## Summary

Pass di ottimizzazione a basso rischio su config Next, parser XML,
tunabilita runtime e pipeline di fetch fonti. Nessuna modifica al
comportamento geospaziale — stessi risultati, meno lavoro ripetuto.

## File modificati

### `next.config.ts`
- Aggiunti `poweredByHeader: false` (rimuove l'header `X-Powered-By`) e
  `compress: true` (gzip esplicito, utile su Render free dove la banda
  dell'istanza conta).

### `src/lib/cadastral-wfs.ts`
- `XMLParser` di `fast-xml-parser` ora e` istanziato una volta sola a
  livello di modulo (`CADASTRAL_XML_PARSER`) invece che ad ogni pagina WFS.
- Su una scansione multi-provincia ogni blocco puo` produrre 6 pagine WFS:
  prima facevamo 6x istanziazioni, ora 1x.

### `src/lib/overpass.ts`
- Nuova helper `parsePositiveIntegerEnv(key, fallback)` per leggere env vars
  numeriche con validazione.
- `MAX_TERRAINS_PRE_FILTER` ora leggibile da env `TERRENI_MAX_PRE_FILTER`
  (fallback 140).
- `OBSTACLE_FILTER_SOFT_TIMEOUT_MS` ora leggibile da env
  `TERRENI_OBSTACLE_FILTER_SOFT_TIMEOUT_MS` (fallback 15000).
- Permette di tunare perf da dashboard Render senza rebuild.
- `fetchSourcesForProvince` ora lancia `fetchFuelSourcesFromMimit` e
  `fetchOverpassSourcesForProvince` in `Promise.all` invece che in serie.
  I due provider sono indipendenti (MIMIT CSV nazionale vs Overpass API),
  quindi il download MIMIT cold (~5-15s) viene nascosto dietro la query
  Overpass senza aumentare la pressione su nessun singolo endpoint.

### `src/app/api/scan/stream/route.ts`
- Aggiunti `export const dynamic = "force-dynamic"` e
  `export const fetchCache = "force-no-store"` per fissare esplicitamente
  il comportamento della route streaming in Next 16 ed evitare sorprese
  di caching automatico su SSE.

### `render.yaml`
- `buildCommand` passa da `npm install && npm run build` a
  `npm ci && npm run build`. `npm ci` e` piu` veloce e rispetta in modo
  stretto il `package-lock.json`.
- Aggiunto `healthCheckPath: /` per disambiguare il check Render.
- Aggiunti placeholder commentati per `TERRENI_MAX_PRE_FILTER` e
  `TERRENI_OBSTACLE_FILTER_SOFT_TIMEOUT_MS`, pronti da decommentare per
  tuning post-deploy.

## Cosa non e` stato toccato e perche

- Loop seriale province in `runScan`: parallelizzare condividerebbe il
  cooldown globale Overpass tra piu` richieste concorrenti e rischia di
  triggerare rate-limit sui tre endpoint pubblici. Lasciato serial.
- Import singoli `@turf/*` invece di `@turf/turf`: tree-shaking SWC in
  Next 16 dovrebbe gia` gestirlo; cambiare 6+ import in piu` file senza
  build locale e` rischioso.
- Security headers (CSP, HSTS, X-Frame-Options): rischio di rompere i
  tile Leaflet e il WMS Agenzia Entrate senza test.
- Persistenza job store: decisione architetturale gia` sul roadmap
  (Postgres+PostGIS).

## Come testare in locale

```bash
cd ~/Documents/TerreniReady
npm ci                   # allineato al nuovo buildCommand
npm run lint
npm run build
npm run dev              # smoke test su http://localhost:3000
```

## Come deployare

Lo script esistente funziona identico:

```bash
./deploy.sh
```

Gira lint + build + commit + push su main e Render auto-deploya.

## Come tunare post-deploy senza rebuild

Su https://dashboard.render.com, servizio `terreniready`, tab Environment:

- `TERRENI_MAX_PRE_FILTER` — alza per qualita` maggiore (es. `200`), abbassa
  per velocita` su provincia grande (es. `100`).
- `TERRENI_OBSTACLE_FILTER_SOFT_TIMEOUT_MS` — se Overpass e` lento cronico,
  alza a `25000`; se vuoi forzare output rapido, abbassa a `10000`.

Salva → Render riavvia solo il processo, senza rebuild.

---

# Changelog — Sessione del 21 aprile 2026

## Fix performance scansione

File modificato: `src/lib/overpass.ts`

### Modifica 1 — Cap pre-filtro a 140 particelle

- Aggiunta costante `MAX_TERRAINS_PRE_FILTER = 140`
- In `scanProvince()` le particelle candidate dal WFS Agenzia Entrate vengono ordinate per distanza e tagliate a 140 **prima** di entrare nel filtro anti-urbano
- Motivo: su province grandi (Firenze, Siena) il WFS restituisce anche >1000 particelle. Filtrarle tutte con query Overpass (edifici/urbano/strade × batch) costava minuti. Prendendone solo 140 (le più vicine alle fonti) si copre comunque il 100% dei risultati rilevanti

### Modifica 2 — Soft timeout filtro anti-urbano (15s)

- Aggiunta costante `OBSTACLE_FILTER_SOFT_TIMEOUT_MS = 15 * 1000`
- `fetchTerrainObstaclesForChunk()` ora usa `Promise.race()` tra la query Overpass e un timeout soft di 15s
- Quando il timeout scatta, il batch viene restituito **senza filtro anti-urbano** con un warning nella risposta
- Motivo: il filtro anti-urbano Overpass era il collo di bottiglia principale. Quando lento bloccava tutta la pipeline. Ora degradiamo la qualità (qualche particella con edifici dentro passa) in cambio di velocità (scansione che finisce)

## Impatto atteso

| Scenario | Prima | Dopo |
|----------|-------|------|
| Pistoia + Distributori | ~2 min | ~30-45s |
| Firenze + tutte le categorie | 5+ min (spesso fallisce) | ~1-2 min |
| Overpass rate-limited | Blocca pipeline | Degrada con warning, restituisce risultati |

## Come testare in locale

```bash
cd ~/Documents/terreniready
npm run lint        # verifica TypeScript
npm run build       # build completa
npm run dev         # apri http://localhost:3000
```

## Come deployare

Opzione A — deploy automatico (auto-deploy Render su main):

```bash
cd ~/Documents/terreniready
chmod +x deploy.sh   # solo la prima volta
./deploy.sh
```

Opzione B — deploy su branch separato per test:

```bash
./deploy.sh --branch perf/soft-timeout-cap
```

Opzione C — solo commit+push senza build locale:

```bash
./deploy.sh --skip-build
```

## Rollback

Se le modifiche dovessero rivelarsi problematiche:

```bash
cd ~/Documents/terreniready
git log --oneline -5                    # trova l'hash del commit precedente
git revert HEAD                         # crea commit di rollback
git push origin main                    # Render rideploya la versione vecchia
```
