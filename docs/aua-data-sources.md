# AUA — Autorizzazione Unica Ambientale: fonti dati per TerreniReady

Questo documento spiega perché TerreniReady oggi **non** ha un feed di
impianti AUA individuali e quali sono i percorsi realistici per
ottenerli, tutti a **costo zero** ma con diverse gradazioni di
complessità tecnica e tempo di sviluppo.

> ⚠️ **Scoperta empirica del 2026-04 (vedi sezione in fondo):**
> lo scraping degli albi pretori provinciali per ottenere le AUA è
> **praticamente inutile**. Le AUA vere sono emesse dallo SUAP dei
> Comuni (273 in Toscana), non dalle 10 Province. Unica via realistica
> oggi: **Opzione A** (richiesta istituzionale ARAMIS).

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

L'AUA (D.P.R. 59/2013) segue un flusso misto:

1. L'impresa presenta l'istanza al **SUAP** (Sportello Unico
   Attività Produttive) del Comune in cui ha sede lo stabilimento.
2. Il SUAP inoltra alla **Provincia/Città Metropolitana** competente.
3. La Provincia istruisce la pratica e indice la Conferenza di
   Servizi con ARPAT/Gestore SII/Vigili del Fuoco/ecc.
4. L'atto finale di **rilascio AUA è adottato dal SUAP comunale**,
   sulla base del provvedimento istruttorio provinciale.

**Conseguenza chiave:** gli albi pretori delle Province NON contengono
gli atti AUA veri e propri. Contengono al massimo provvedimenti
istruttori o richiami generici. L'atto definitivo sta nell'albo
pretorio **del Comune**, ed esiste un albo pretorio per ognuno dei
**273 Comuni toscani**, tutti con CMS diversi.

La Regione Toscana pubblica **solo conteggi aggregati** per anno/provincia
(`D.2.3.csv` su regione.toscana.it), non l'elenco degli impianti.

## Opzione A — Richiesta istituzionale accesso ARAMIS Regione Toscana

ARAMIS è il sistema gestionale interno alla Direzione Ambiente della
Regione Toscana. Riceve i tracciati delle AUA comunali/provinciali
aggregati a livello regionale. **È l'unica via pulita per avere
l'intero universo AUA toscano in un colpo solo**, indipendentemente
da chi ha formalmente emesso il singolo atto.

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
- Provincia/Città Metropolitana procedente e SUAP comunale
- estremi dell'atto (numero e data di determinazione)
- stato: vigente / revocata / scaduta

I dati richiesti sono di natura ambientale e ricadono nell'ambito
della direttiva INSPIRE (d.lgs. 32/2010). L'accesso è motivato da
finalità di analisi territoriale e sviluppo di strumenti open
source per la valutazione di prossimità ambientale, senza alcuno
scopo di lucro diretto o trattamento di dati personali oltre quanto
già pubblico negli albi pretori comunali.

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

## Opzione B — Scraping albi pretori: perché NON funziona

Questa sezione è mantenuta a monito. **Non seguire questa strada.**

### Test empirico eseguito (2026-04-21, Provincia di Pistoia)

1. Query POST a `trasparenza.provincia.pistoia.it/albopretorio/` con
   filtro testuale `s_TESTO=autorizzazione unica ambientale`,
   intervallo 2020-2026.
2. Paginazione: 219 atti totali identificati (3 pagine di 100).
3. Download dei 79 atti più recenti (PDF non firmati, allegato
   principale).
4. `pdftotext -layout` per estrazione testo.
5. Ispezione manuale del contenuto.

**Risultato:** ZERO dei 79 atti erano rilasci AUA. La query
recupera invece:

- Atti di liquidazione fatture che citano il fornitore
  "autorizzazione unica ambientale" come causale
- Determinazioni per lavori pubblici con riferimenti normativi AUA
- Provvedimenti organizzativi dell'Area Tecnica provinciale

Il motivo strutturale è spiegato sopra: l'atto finale AUA è emesso
dal **SUAP del Comune**, non dalla Provincia. La Provincia emette
solo l'atto istruttorio, non la formale autorizzazione.

### Perché anche passare ai Comuni non scala

I Comuni toscani sono **273**, ciascuno con:
- Un proprio albo pretorio online (CMS Halley/WEB22/MunicipioWeb/
  custom in proporzioni variabili)
- Una propria convenzione di nomenclatura per gli atti SUAP
- Una propria frequenza di pubblicazione
- Un proprio formato PDF (molti vecchi scansionati, richiedono OCR)

Stima realistica per il lavoro end-to-end:
- Mappatura 273 albi: 2 settimane
- Scrittura adapter per 4-5 CMS diversi: 2 settimane
- Tuning regex per estrazione nome azienda/indirizzo: 2 settimane
- Geocoding + dedupe + QA: 1 settimana
- Manutenzione continua (i siti cambiano): ~1 giorno/mese perenne

Totale: ~2 mesi per primo deploy + manutenzione continua, con
qualità del dato comunque non affidabile per decisioni business.

**Il rapporto costo/beneficio non regge**, soprattutto se confrontato
con i 30-60 giorni di attesa per una risposta ARAMIS strutturata.

## Opzione C — Dati commerciali (NON gratuito, per riferimento)

- **InfoCamere — Registro Imprese**: elenco PMI manifatturiere per
  codice ATECO → geocoding. Non distingue AUA. A pagamento.
- **Cerved/CRIBIS**: database aziende con metadati ambientali. A
  pagamento e non garantito per AUA.
- **EcoCerved (consortile camerale)**: dati ambientali aggregati
  da Camere di Commercio. A pagamento.

Non sono opzioni gratuite, le cito solo per completezza.

## Raccomandazione finale

**Manda la PEC di Opzione A oggi.** Costa 5 minuti + firma digitale.
Nel peggiore dei casi ricevi un no motivato, nel migliore ricevi un
dump CSV con centinaia/migliaia di impianti AUA georeferenziati in
~2 mesi. Qualunque altra strada è peggiore sul rapporto costo/tempo/
qualità dato.

Mentre aspetti ARAMIS, la copertura "fonti emissive" dell'app resta:
- AIA nazionali (hardcoded, ARPAT): 10 grandi impianti
- MIMIT distributori: centinaia per provincia
- OSM via Overpass: officine, carrozzerie, industriale, energia e
  rifiuti, cave, ciminiere, depuratori, discariche — già migliaia
  di POI per la Toscana

Questa copertura è sufficiente per il matching prossimità particelle
catastali. L'aggiunta delle AUA comunali aumenterebbe la copertura
su PMI minori, che però in OSM sono spesso già mappate sotto
`industrial=*` o `craft=*`.
