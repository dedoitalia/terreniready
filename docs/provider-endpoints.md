# Provider ed endpoint per ottimizzare TerreniReady

Aggiornato al 20 aprile 2026.

## Gia integrati nel prodotto

### MIMIT - anagrafica impianti carburante
- Archivio storico open data:
  - https://www.mimit.gov.it/it/open-data/elenco-dataset/carburanti-archivio-prezzi
- File trimestrali `.tar.gz`:
  - `Anagrafica` impianti attivi
  - `Prezzo` alle 8:00
- Uso consigliato:
  - fonte primaria per `fuel`
  - ingest programmato in cache o database

### Agenzia delle Entrate - cartografia catastale WFS
- Metadati RNDT:
  - https://geodati.gov.it/resource/id/age%3Afornitura_dati_catasto_wfs
- GetCapabilities:
  - https://wfs.cartografia.agenziaentrate.gov.it/inspire/wfs/owfs01.php?SERVICE=WFS&REQUEST=GetCapabilities&VERSION=2.0.0
- DescribeFeatureType esempio:
  - https://wfs.cartografia.agenziaentrate.gov.it/inspire/wfs/owfs01.php?service=WFS&version=2.0.0&request=DescribeFeatureType&typeName=CP:CadastralZoning
- GetFeature esempio:
  - https://wfs.cartografia.agenziaentrate.gov.it/inspire/wfs/owfs01.php?service=WFS&version=2.0.0&request=GetFeature&typeName=CP:CadastralZoning&maxFeatures=5&outputFormat=GML_3
- Uso consigliato:
  - geometrie catastali vere
  - matching particelle entro 350 m

### Agenzia delle Entrate - cartografia catastale WMS
- Metadati RNDT:
  - https://geodati.gov.it/resource/id/age%3Aconsultazione_catasto_wms
- Endpoint WMS:
  - https://wms.cartografia.agenziaentrate.gov.it/inspire/wms/ows01.php
- Uso consigliato:
  - sola visualizzazione in mappa
  - overlay catastale ufficiale

## Endpoint ufficiali da integrare subito dopo

### Agenzia delle Entrate - download bulk del catasto
- Metadati RNDT:
  - https://geodati.gov.it/resource/id/age%3Afornitura_dati_catasto
- Download service base:
  - https://wfs.cartografia.agenziaentrate.gov.it/inspire/wfs/GetDataset.php
- Uso consigliato:
  - import locale in PostGIS
  - eliminazione dei limiti del WFS live
  - cache stabile per regioni, province e comuni

### Agenzia delle Entrate - export fogli di mappa in GeoJSON
- Manuale utente:
  - https://unicat.agenziaentrate.gov.it/cgconsade/dist/img/Consultazione%20dei%20fogli%20di%20mappa%20catastale_Manuale_Utente_20251107.pdf
- Nota utile:
  - il manuale indica che il formato `GeoJSON` e disponibile per export nei sistemi Roma40 ed ETRF2000
- Uso consigliato:
  - flusso manuale/ibrido per recuperi puntuali
  - validazione o completamento di aree specifiche

### ISPRA - registro PRTR e LCP
- Pagina registri:
  - https://www.isprambiente.gov.it/it/attivita/cambiamenti-climatici/landamento-delle-emissioni/registro-e-prtr-lcp-ets
- Uso consigliato:
  - fonte primaria per `industrial`
  - copertura ufficiale impianti emissivi maggiori

### ISTAT - confini amministrativi
- Basi territoriali:
  - https://www.istat.it/notizia/basi-territoriali-e-variabili-censuarie/
- Confini amministrativi aggiornati al 1 gennaio 2026:
  - https://www.istat.it/notizia/confini-delle-unita-amministrative-a-fini-statistici-al-1-gennaio-2018-2/
- Uso consigliato:
  - maschera esatta di province e comuni
  - niente piu bbox provinciali approssimate

### InfoCamere - API Registro Imprese
- Catalogo API:
  - https://accessoallebanchedati.registroimprese.it/abdo/api
- Uso consigliato:
  - fonte primaria per `bodyshop` e `repair`
  - sostituzione graduale di OpenStreetMap per anagrafiche aziendali

## Fallback / supporto operativo

### Osservaprezzi carburanti
- Servizio consultazione:
  - https://www.mimit.gov.it/index.php/it/mercato-e-consumatori/prezzi/mercati-dei-carburanti/osservatorio-carburanti
- Uso consigliato:
  - verifica puntuale di singoli impianti
  - QA rispetto ai file bulk MIMIT

### OpenStreetMap / Overpass
- Uso consigliato:
  - solo fallback temporaneo per `repair`, `bodyshop` e filtri anti-urbani
  - da sostituire progressivamente con ingest locale o provider ufficiali

## Ordine di priorita suggerito

1. Portare il catasto su download bulk locale (`GetDataset.php`) + PostGIS.
2. Integrare `ISPRA PRTR` per la categoria industriale.
3. Integrare `InfoCamere API` per carrozzerie e officine.
4. Usare `ISTAT` per boundary amministrativi ufficiali.
5. Lasciare `Overpass` solo come fallback di emergenza.
