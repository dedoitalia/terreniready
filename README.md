# TerreniReady

MVP SaaS per identificare terreni agricoli vicini a fonti emissive nelle province toscane.

## Cosa fa oggi

- Selezione province Toscana.
- Selezione tipologie di fonti emissive:
  - distributori
  - carrozzerie
  - officine
  - aree/impianti industriali
- Scansione reale server-side su OpenStreetMap tramite Overpass API.
- Individuazione di poligoni agricoli OSM entro `350 m` dalla fonte più vicina.
- Mappa con:
  - satellite Esri
  - layer catastale WMS ufficiale Agenzia delle Entrate
  - cerchi di raggio 350 m
  - poligoni agricoli trovati
- Export `CSV` e `KMZ`.

## Cosa non fa ancora

- Recupero proprietari, nomi e codici fiscali.
- Estrazione ufficiale delle particelle catastali come oggetti interrogabili via API.
- Integrazione diretta con SISTER / SIGMATER / Agenzia Entrate autenticata.
- Motore multi-regione, autenticazione utenti e billing SaaS.

## Fonti dati attuali

- Fonti emissive: OpenStreetMap / Overpass API
- Poligoni agricoli: OpenStreetMap
- Overlay catastale: WMS Agenzia delle Entrate
- Satellite: Esri World Imagery

## Stack

- Next.js 16
- React 19
- TypeScript
- Tailwind CSS v4
- React Leaflet
- Turf.js
- JSZip

## Avvio locale

```bash
npm install
npm run dev
```

Apri [http://localhost:3000](http://localhost:3000).

## Build

```bash
npm run lint
npm run build
```

## Struttura utile

- `src/app/page.tsx`: entry della dashboard
- `src/app/api/scan/route.ts`: API di scansione
- `src/lib/overpass.ts`: logica reale di query e matching geospaziale
- `src/lib/province-data.ts`: province e bounding box
- `src/components/terreni-dashboard.tsx`: UI principale
- `src/components/terrain-map.tsx`: mappa Leaflet e layer catastale

## Prossimi step consigliati

1. Aggiungere persistenza PostgreSQL + PostGIS.
2. Storicizzare scansioni, utenti e shortlist.
3. Introdurre scansione batch schedulata per provincia.
4. Integrare un provider catastale autenticato per proprietari e particelle ufficiali.
5. Aggiungere autenticazione, piani subscription e workspace cliente.
