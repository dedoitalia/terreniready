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
      ...sources.map((source) => [source.latitude, source.longitude] as [number, number]),
      ...terrains.map((terrain) => [terrain.center.lat, terrain.center.lng] as [number, number]),
    ];

    if (bounds.length > 0) {
      map.fitBounds(bounds, { padding: [48, 48] });
      return;
    }

    const provinceCenters = selectedProvinceIds.map((provinceId) => PROVINCE_MAP[provinceId].center);

    if (provinceCenters.length > 0) {
      map.setView([provinceCenters[0].lat, provinceCenters[0].lng], provinceCenters.length === 1 ? 11 : 9);
    }
  }, [map, selectedProvinceIds, sources, terrains]);

  return null;
}

export default function TerrainMap({
  selectedProvinceIds,
  sources,
  terrains,
  activeTerrainId,
  onSelectTerrainId,
}: TerrainMapProps) {
  return (
    <div className="relative h-[62vh] overflow-hidden rounded-[28px] border border-white/60 bg-[#dce6db] shadow-[0_30px_80px_rgba(28,39,31,0.16)] lg:h-[calc(100vh-12rem)]">
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
              attribution='Agenzia delle Entrate - Cartografia Catastale WMS'
            />
          </LayersControl.Overlay>
        </LayersControl>

        <FitToContent
          selectedProvinceIds={selectedProvinceIds}
          sources={sources}
          terrains={terrains}
        />

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
                  {source.address ? <p>{source.address}</p> : null}
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
                color: active ? "#102517" : category.color,
                fillColor: active ? "#d9e564" : "#79b473",
                fillOpacity: active ? 0.58 : 0.36,
                weight: active ? 3 : 1.5,
              }}
            >
              <Popup>
                <div className="space-y-2 text-sm">
                  <p className="font-semibold">{terrain.name}</p>
                  <p>{landuseLabel(terrain.landuse)}</p>
                  <p>{Math.round(terrain.distanceMeters)} m dalla fonte più vicina</p>
                  {terrain.areaSqm ? <p>{terrain.areaSqm.toLocaleString("it-IT")} m² stimati</p> : null}
                  <p>Fonte: {terrain.closestSourceName}</p>
                </div>
              </Popup>
            </Polygon>
          );
        })}
      </MapContainer>

      <div className="pointer-events-none absolute bottom-4 left-4 max-w-xs rounded-2xl bg-[#132017]/86 px-4 py-3 text-xs leading-5 text-white shadow-lg backdrop-blur">
        Dati mappa: immagini satellitari Esri, particelle catastali WMS Agenzia delle Entrate,
        fonti e aree agricole da OpenStreetMap.
      </div>
    </div>
  );
}
