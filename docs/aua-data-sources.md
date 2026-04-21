# AUA — Autorizzazione Unica Ambientale: fonti dati per TerreniReady

Questo documento spiega perché TerreniReady oggi **non** ha un feed di
impianti AUA individuali e quali sono i percorsi realistici per
ottenerli, tutti a **costo zero** ma con diverse gradazioni di
complessità tecnica e tempo di sviluppo.

## Cosa è già integrato

- **AIA nazionali** (10 impianti): raffinerie, acciaierie, chimica
  pesante, grandi centrali. Dati ARPAT hardcoded in
  `src/lib/aia-arpat.ts`. Aggiornamento annuale manuale dal file ODS.
- **Distributori** (MIMIT): intera Toscana, aggiornato 12 h cache.
- **Officine / Carrozzerie / Industriale / Energia-rifiuti**
  (OpenStreetMap via Overpass): copre la maggioranza degli impianti
  censiti volontariamente, fra cui centrali, depuratori, discariche,
  isole ecologiche, ciminiere, cave.

## Perché manca un feed AUA completo

L'AUA (D.P.R. 59/2013) è **gestita dalle Province/Città
Metropolitane** (10 enti in Toscana), non dalla Regione. Ogni
Provincia pubblica le proprie AUA nel proprio **albo pretorio online**
con:

- CMS diversi (Halley, WEB22, PerlaPA, portali custom)
- Nessuna API, nessun RSS, nessun filtro strutturato per tipo atto
- L'oggetto dell'atto è testo libero nel PDF allegato (spesso firmato
  .p7m), non nei metadati HTML
- Dati utili (nome azienda, indirizzo, tipo attività) vanno estratti
  da OCR / text extraction del PDF

La Regione Toscana pubblica **solo conteggi aggregati** per anno/provincia
(`D.2.3.csv` su regione.toscana.it), non l'elenco degli impianti.

## Opzione A — Richiesta istituzionale accesso ARAMIS Regione Toscana

ARAMIS è il sistema gestionale interno alla Direzione Ambiente della
Regione Toscana, contiene tutti gli atti di autorizzazione ambientale
(incluse le AUA aggregate dalle Province). L'accesso in lettura per
uso statistico/riuso dati è **possibile su richiesta motivata**.

### Template PEC

Destinatari suggeriti:
- `regionetoscana@postacert.toscana.it` (protocollo generale)
- `direzione.ambiente@postacert.toscana.it` (Direzione Ambiente ed
  Energia, competente ARAMIS)

Oggetto:
```
Richiesta accesso civico generalizzato ai dati AUA regionali (sistema ARAMIS)
ex art. 5 c.2 d.lgs. 33/2013
```

Corpo:
```
Spett.le Regione Toscana,
Direzione Ambiente ed Energia,

il sottoscritto [NOME COGNOME], nato a [LUOGO] il [DATA],
residente in [INDIRIZZO], codice fiscale [CF], in qualità di
[professionista / rappresentante della società ...],

ai sensi dell'art. 5, comma 2, del d.lgs. 14 marzo 2013, n. 33
(accesso civico generalizzato), chiede di ricevere in formato
elettronico riutilizzabile (CSV, XML, JSON o equivalente) i dati
relativi a tutti i procedimenti di Autorizzazione Unica Ambientale
(AUA) conclusi dalle Province/Città Metropolitana della Toscana
negli ultimi cinque anni (20[XX] - 2025), come tracciati nel
sistema gestionale regionale ARAMIS.

Per ciascun procedimento sono richiesti, ove disponibili e nel
rispetto della normativa sulla privacy (GDPR 2016/679):
- denominazione e codice fiscale/P.IVA dell'azienda autorizzata
  (esclusi dati personali di persone fisiche)
- indirizzo e comune dello stabilimento
- coordinate geografiche, se presenti in ARAMIS
- tipologia di attività autorizzata (codice ATECO, se disponibile)
- autorizzazioni ricomprese nell'AUA (emissioni aria, scarichi
  idrici, rifiuti, ecc.)
- Provincia/Città Metropolitana procedente
- estremi dell'atto (numero e data di determinazione dirigenziale)
- stato: vigente / revocata / scaduta

I dati richiesti sono di natura ambientale e ricadono nell'ambito
della direttiva INSPIRE (d.lgs. 32/2010). L'accesso è motivato da
finalità di analisi territoriale e sviluppo di strumenti open
source per la valutazione di prossimità ambientale, senza alcuno
scopo di lucro diretto o trattamento di dati personali oltre quanto
già pubblico negli albi pretori provinciali.

In subordine, qualora il dato completo non fosse disponibile in
formato aggregato regionale, si chiede indicazione dei referenti
tecnici presso ciascuna delle 10 Province/Città Metropolitane
toscane per inoltrare analoga richiesta.

La presente istanza è effettuata ai sensi della normativa vigente
sull'accesso civico generalizzato. Si confida nel riscontro entro
30 giorni come previsto dall'art. 5 c.6 del d.lgs. 33/2013.

Cordiali saluti,
[FIRMA DIGITALE]
[LUOGO], [DATA]
```

Tempi attesi: 30-60 giorni. Probabilità di ottenere il dato completo:
medio-alta se la richiesta è ben motivata e firmata digitalmente.

## Opzione B — Scraping albi pretori provinciali

Percorso tecnico, stimato 2-3 giorni di sviluppo per Provincia,
moltiplica per le 10 Province toscane = ~3-4 settimane full-time.

### Architettura consigliata (NON da mettere in Next.js runtime)

```
GitHub Actions cron (settimanale)
   ↓
scripts/update-aua.ts (Node.js standalone)
   ↓ per ogni Provincia:
   1. scrape albo pretorio (paginazione)
   2. filtra atti con "AUA" o "autorizzazione unica ambientale"
   3. scarica PDF allegato
   4. estrai testo con pdf-parse (o Tesseract se scansione)
   5. regex su pattern: ragione sociale, via, comune, CAP
   6. geocoding via Nominatim (1 req/sec)
   7. merge + dedupe
   ↓
dati/aua-toscana.json (committato nel repo)
   ↓
src/lib/aua-provinces.ts legge il JSON a cold start
   ↓
integrato in fetchSourcesForProvince accanto ad AIA
```

### URL base degli albi pretori toscani

Verificati manualmente al 2025-2026. Cambiano nel tempo — da
rivalidare prima di ogni run dello scraper.

| Provincia         | Albo pretorio                                                                        | CMS       |
| ----------------- | ------------------------------------------------------------------------------------ | --------- |
| Arezzo            | https://www.provincia.arezzo.it/servizi/atti-amministrativi/albo-pretorio             | Halley    |
| Firenze (CM)      | https://www.cittametropolitana.fi.it/albo-pretorio/                                  | Custom    |
| Grosseto          | https://trasparenza.provincia.grosseto.it/albopretorio/                              | Halley    |
| Livorno           | https://www.provincia.livorno.it/it/albo-pretorio                                    | Custom    |
| Lucca             | https://www.provincia.lucca.it/albo-pretorio                                         | Custom    |
| Massa-Carrara     | https://trasparenza.provincia.ms.it/albopretorio/                                    | Halley    |
| Pisa              | https://www.provincia.pisa.it/it/albo-pretorio                                       | Custom    |
| Pistoia           | https://trasparenza.provincia.pistoia.it/albopretorio/                               | Halley    |
| Prato             | https://trasparenza.provincia.prato.it/albopretorio/                                 | Halley    |
| Siena             | https://www.provincia.siena.it/Albo-Pretorio                                         | Custom    |

Le 5 Province su Halley condividono lo stesso motore di ricerca
(MVPG=AmvRicercaAlbo) quindi un singolo parser copre 50% del lavoro.

### Ricetta Halley (Pistoia/Grosseto/MS/Prato/Arezzo)

```
POST {base}/albopretorio/Main.do
  MVPG=AmvRicercaAlbo
  s_TESTO=autorizzazione unica ambientale
  Search=Cerca
  DATA_DAL=01/01/2020
  DATA_AL=31/12/2025

Parse HTML → estrai elenco {id, numero, data, settore}
Per ogni atto:
  GET {base}/albopretorio/Main.do?MVPG=AmvAlboDettaglio&id={id}
  Parse HTML → trova div "allegato principale"
  Estrai href di AlboDownload.jsp?ID_BLOB=...
  GET quel PDF
  pdf-parse del PDF → testo
  regex:
    /Ditta:?\s*(.+?)[\n\r]/i
    /Sede (?:legale|operativa|stabilimento):?\s*(.+?)[\n\r]/i
    /(\d{5})\s+([A-Z][A-Za-zà-ù'\s]+?)\s*\(([A-Z]{2})\)/
  geocode (nome azienda + indirizzo + comune)
```

### Librerie consigliate

- `got` o `undici` per HTTP
- `pdf-parse` per text extraction (pure-JS, no binary deps)
- `cheerio` per HTML parsing
- `p-queue` per rate limiting (1 req/sec su Nominatim)
- `fast-xml-parser` già nel progetto, non serve aggiungerlo

## Opzione C — Scraping a bassa intensità nel tempo

Se non hai 3 settimane per B, un compromesso:

- Parti da UNA sola Provincia (quella più rilevante per il tuo
  business, probabilmente Pistoia)
- Script manuale su tua macchina, run mensile
- Commit del JSON aggiornato

È l'80/20 pragmatico. Inizia, valuta il rapporto costo/beneficio,
poi scala a 2-3 Province se utile.

## Opzione D — Via dati commerciali (NON gratuito, per riferimento)

- **InfoCamere — Registro Imprese**: elenco PMI manifatturiere per
  codice ATECO → geocoding. Non distingue AUA. A pagamento.
- **Cerved/CRIBIS**: database aziende con metadati ambientali. A
  pagamento e non garantito per AUA.

Non sono opzioni gratuite, le cito solo per completezza.

## Raccomandazione finale

Per un SaaS di prodotto **consiglio fortemente l'Opzione A**
(richiesta ARAMIS): template PEC sopra, tempo di risposta 30-60gg,
costo zero, risultato strutturato e legalmente pulito. Se la
risposta è negativa o parziale, si ripiega su B/C.

L'Opzione B ha senso solo se:
- Non puoi aspettare 60 giorni
- Hai già infrastruttura CI/CD
- Accetti che i dati avranno un tasso di errore ~10-15% (nome
  azienda non sempre ben estratto, indirizzi talvolta incompleti)
