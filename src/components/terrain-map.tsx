"use client";

import { useEffect } from "react";
import {
  Circle,
  LayersControl,
  MapContainer,
  Polygon,
  Popup,
  TileLayer,
  WMSTileLayer,
  useMap,
} from "react-leaflet";

import { PROVINCE_MAP } from "@/lib/province-data";
import { SOURCE_CATEGORY_MAP, landuseLabel } from "@/lib/source-types";
import type { ProvinceId, SourceFeature, TerrainFeature } from "@/types/scan";

type TerrainMapProps = {
  selectedProvinceIds: ProvinceId[];
  sources: SourceFeature[];
  terrains: TerrainFeature[];
  activeTerrainId?: string;
  onSelectTerrainId: (terrainId: string) => void;
};

function FitToContent({
  selectedProvinceIds,
  sources,
  terrains,
}: Pick<TerrainMapProps, "selectedProvinceIds" | "sources" | "terrains">) {
  const map = useMap();

  useEffect(() => {
    const bounds = [
      ...sources.map(
        (source) => [source.latitude, source.longitude] as [number, number],
      ),
      ...terrains.map(
        (terrain) => [terrain.center.lat, terrain.center.lng] as [number, number],
      ),
    ];

    if (bounds.length > 0) {
      map.fitBounds(bounds, { padding: [48, 48] });
      return;
    }

    const provinceCenters = selectedProvinceIds.map(
      (provinceId) => PROVINCE_MAP[provinceId].center,
    );

    if (provinceCenters.length > 0) {
      map.setView(
        [provinceCenters[0].lat, provinceCenters[0].lng],
        provinceCenters.length === 1 ? 11 : 9,
      );
    }
  }, [map, selectedProvinceIds, sources, terrains]);

  return null;
}

function FocusActiveTerrain({
  activeTerrain,
}: {
  activeTerrain: TerrainFeature | undefined;
}) {
  const map = useMap();

  useEffect(() => {
    if (!activeTerrain) {
      return;
    }

    const polygonBounds = activeTerrain.coordinates.map(
      ([lng, lat]) => [lat, lng] as [number, number],
    );

    if (polygonBounds.length >= 3) {
      map.fitBounds(polygonBounds, {
        padding: [72, 72],
        maxZoom: 18,
      });
      return;
    }

    map.setView([activeTerrain.center.lat, activeTerrain.center.lng], 18, {
      animate: true,
    });
  }, [activeTerrain, map]);

  return null;
}

export default function TerrainMap({
  selectedProvinceIds,
  sources,
  terrains,
  activeTerrainId,
  onSelectTerrainId,
}: TerrainMapProps) {
  const activeTerrain = terrains.find((terrain) => terrain.id === activeTerrainId);

  return (
    <div className="terrain-map-frame relative h-[64vh] overflow-hidden lg:h-[calc(100vh-14rem)]">
      <MapContainer
        bounds={[
          [43.58, 10.12],
          [44.12, 11.45],
        ]}
        scrollWheelZoom
        className="h-full w-full"
      >
        <LayersControl position="topright">
          <LayersControl.BaseLayer checked name="Satellite">
            <TileLayer
              attribution='&copy; <a href="https://www.esri.com/">Esri</a>'
              url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
            />
          </LayersControl.BaseLayer>
          <LayersControl.BaseLayer name="Street">
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />
          </LayersControl.BaseLayer>
          <LayersControl.Overlay checked name="Particelle catastali">
            <WMSTileLayer
              url="https://wms.cartografia.agenziaentrate.gov.it/inspire/wms/ows01.php?language=ita&"
              layers="CP.CadastralParcel"
              format="image/png"
              transparent
              opacity={0.72}
              attribution="Agenzia delle Entrate - Cartografia Catastale WMS"
            />
          </LayersControl.Overlay>
        </LayersControl>

        <FitToContent
          selectedProvinceIds={selectedProvinceIds}
          sources={sources}
          terrains={terrains}
        />
        <FocusActiveTerrain activeTerrain={activeTerrain} />

        {sources.map((source) => {
          const category = SOURCE_CATEGORY_MAP[source.primaryCategoryId];

          return (
            <Circle
              key={source.id}
              center={[source.latitude, source.longitude]}
              radius={350}
              pathOptions={{
                color: category.color,
                fillColor: category.color,
                fillOpacity: 0.08,
                weight: 1.5,
              }}
            >
              <Popup>
                <div className="space-y-2 text-sm">
                  <p className="font-semibold">{source.name}</p>
                  <p>{category.label}</p>
                  <p className="text-[var(--muted)]">{source.providerLabel}</p>
                  {source.address ? <p>{source.address}</p> : null}
                  {source.referenceUrl ? (
                    <a
                      href={source.referenceUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex text-xs font-medium text-[var(--accent-ink)] underline underline-offset-2"
                    >
                      Apri sorgente dati
                    </a>
                  ) : null}
                </div>
              </Popup>
            </Circle>
          );
        })}

        {terrains.map((terrain) => {
          const active = terrain.id === activeTerrainId;
          const category = SOURCE_CATEGORY_MAP[terrain.closestSourceCategoryId];

          return (
            <Polygon
              key={terrain.id}
              positions={terrain.coordinates.map(([lng, lat]) => [lat, lng])}
              eventHandlers={{
                click: () => onSelectTerrainId(terrain.id),
              }}
              pathOptions={{
                color: active ? "#112117" : category.color,
                fillColor: active ? "#d9e26a" : "#7fb277",
                fillOpacity: active ? 0.62 : 0.34,
                weight: active ? 3 : 1.4,
              }}
            >
              <Popup>
                <div className="space-y-2 text-sm">
                  <p className="font-semibold">{terrain.name}</p>
                  <p>{landuseLabel(terrain.landuse)}</p>
                  <p>{Math.round(terrain.distanceMeters)} m dalla fonte più vicina</p>
                  {terrain.areaSqm ? (
                    <p>{terrain.areaSqm.toLocaleString("it-IT")} m² stimati</p>
                  ) : null}
                  <p>Fonte: {terrain.closestSourceName}</p>
                  <p className="text-[var(--muted)]">{terrain.providerLabel}</p>
                </div>
              </Popup>
            </Polygon>
          );
        })}
      </MapContainer>

      <div className="terrain-map-overlay pointer-events-none absolute left-4 top-4 max-w-sm px-4 py-3">
        <div className="text-[11px] uppercase tracking-[0.2em] text-[#b8c6b1]">
          Stage mappa
        </div>
        <div className="mt-2 text-sm leading-6 text-[#eef4eb]">
          {selectedProvinceIds.length > 0
            ? selectedProvinceIds.map((provinceId) => PROVINCE_MAP[provinceId].name).join(" · ")
            : "Toscana"}
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2 text-xs text-[#d2ddcf]">
          <div className="terrain-map-overlay-stat px-3 py-2">
            <div className="uppercase tracking-[0.18em] text-[#a5b69d]">Fonti</div>
            <div className="mt-1 text-sm font-semibold text-white">{sources.length}</div>
          </div>
          <div className="terrain-map-overlay-stat px-3 py-2">
            <div className="uppercase tracking-[0.18em] text-[#a5b69d]">Terreni</div>
            <div className="mt-1 text-sm font-semibold text-white">{terrains.length}</div>
          </div>
          <div className="terrain-map-overlay-stat px-3 py-2">
            <div className="uppercase tracking-[0.18em] text-[#a5b69d]">Buffer</div>
            <div className="mt-1 text-sm font-semibold text-white">350m</div>
          </div>
        </div>
      </div>

      {activeTerrain ? (
        <div className="terrain-map-overlay terrain-map-overlay-light pointer-events-none absolute bottom-4 right-4 max-w-xs px-4 py-3 text-xs leading-5">
          <div className="uppercase tracking-[0.2em] text-[var(--muted)]">
            Terreno attivo
          </div>
          <div className="mt-2 text-sm font-semibold text-[var(--foreground)]">
            {activeTerrain.name}
          </div>
          <div className="mt-1">
            {landuseLabel(activeTerrain.landuse)} ·{" "}
            {Math.round(activeTerrain.distanceMeters)} m
          </div>
        </div>
      ) : null}

      <div className="terrain-map-overlay pointer-events-none absolute bottom-4 left-4 max-w-xs px-4 py-3 text-xs leading-5">
        Dati mappa: immagini satellitari Esri, particelle catastali WMS Agenzia
        delle Entrate, fonti da MIMIT e OpenStreetMap, particelle da WFS
        ufficiale con filtro anti-urbano geospaziale.
      </div>
    </div>
  );
}
