"use client";

import "maplibre-gl/dist/maplibre-gl.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Map as MLMap, GeoJSONSource } from "maplibre-gl";
import {
  directionsUrl,
  displayAvailability,
  telHref,
  type AvailabilityStatus,
  type Freshness,
} from "@/lib/domain";
import type { MapResult, MapSite } from "@/server/modules/map";

type Bbox = { w: number; s: number; e: number; n: number };
type Category = { code: string; label: string };

const STYLE_URL = process.env.NEXT_PUBLIC_MAP_STYLE_URL || "https://tiles.openfreemap.org/styles/liberty";
const [DEF_LNG, DEF_LAT, DEF_ZOOM] = (process.env.NEXT_PUBLIC_DEFAULT_VIEW || "-82.55,35.6,9").split(",").map(Number);
const MAX_SPAN = 12;

function siteTone(site: MapSite): "ok" | "warn" | "muted" | "bad" {
  const d = site.resources.map((r) => displayAvailability(r.reportedStatus as AvailabilityStatus, r.freshness as Freshness));
  if (d.some((x) => x.tone === "ok")) return "ok";
  if (d.some((x) => x.tone === "warn")) return "warn";
  if (d.length && d.every((x) => x.tone === "bad")) return "bad";
  return "muted";
}

function fmtTime(iso: string | null) {
  if (!iso) return "never";
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function boundsAround(lng: number, lat: number, d = 0.4): Bbox {
  return { w: lng - d, s: lat - d, e: lng + d, n: lat + d };
}

function distanceKm(aLat: number, aLng: number, bLat: number, bLng: number) {
  const r = Math.PI / 180;
  const x = (bLng - aLng) * r * Math.cos(((aLat + bLat) / 2) * r);
  const y = (bLat - aLat) * r;
  return Math.sqrt(x * x + y * y) * 6371;
}

export default function ResourceMap({ categories, signedIn }: { categories: Category[]; signedIn: boolean }) {
  const mapEl = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [mapFailed, setMapFailed] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  const [bbox, setBbox] = useState<Bbox>(boundsAround(DEF_LNG, DEF_LAT));
  const [center, setCenter] = useState({ lat: DEF_LAT, lng: DEF_LNG });
  const [selectedCats, setSelectedCats] = useState<string[]>([]);
  const [confirmedOnly, setConfirmedOnly] = useState(false);
  const [data, setData] = useState<MapResult | null>(null);
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<"map" | "list">("map");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<{ id: string; name: string; label: string; lat: number; lng: number }[] | null>(null);
  const [geoMsg, setGeoMsg] = useState<string | null>(null);

  const tooWide = bbox.e - bbox.w > MAX_SPAN || bbox.n - bbox.s > MAX_SPAN;

  // ---- data loading -------------------------------------------------------
  const load = useCallback(async () => {
    if (tooWide) {
      setError(null);
      return;
    }
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const p = new URLSearchParams({
      w: bbox.w.toFixed(5), s: bbox.s.toFixed(5), e: bbox.e.toFixed(5), n: bbox.n.toFixed(5),
      confirmedOnly: String(confirmedOnly),
    });
    if (selectedCats.length) p.set("categories", selectedCats.join(","));
    setLoading(true);
    try {
      const res = await fetch(`/api/map/resources?${p}`, { signal: ctrl.signal, credentials: "same-origin" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setData(body as MapResult);
      setLastSync(body.asOf);
      setError(null);
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setError(navigator.onLine === false ? "You appear to be offline." : (err as Error).message || "Could not refresh.");
    } finally {
      if (abortRef.current === ctrl) setLoading(false);
    }
  }, [bbox, confirmedOnly, selectedCats, tooWide]);

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  // Refresh periodically so urgent availability changes appear without user action.
  useEffect(() => {
    const t = setInterval(() => document.visibilityState === "visible" && load(), 60_000);
    const online = () => load();
    window.addEventListener("online", online);
    return () => {
      clearInterval(t);
      window.removeEventListener("online", online);
    };
  }, [load]);

  // ---- map setup -----------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const maplibregl = (await import("maplibre-gl")).default;
        if (cancelled || !mapEl.current) return;
        const map = new maplibregl.Map({
          container: mapEl.current,
          style: STYLE_URL,
          center: [DEF_LNG, DEF_LAT],
          zoom: DEF_ZOOM,
          attributionControl: { compact: true },
        });
        mapRef.current = map;
        if (process.env.NODE_ENV !== "production") (window as unknown as { __icsMap?: MLMap }).__icsMap = map; // dev debugging only
        map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
        const sync = () => {
          const b = map.getBounds();
          setBbox({ w: Math.max(-180, b.getWest()), s: Math.max(-90, b.getSouth()), e: Math.min(180, b.getEast()), n: Math.min(90, b.getNorth()) });
          const c = map.getCenter();
          setCenter({ lat: c.lat, lng: c.lng });
        };
        map.on("error", (e) => {
          if (!map.isStyleLoaded() && String(e.error?.message ?? "").match(/style|fetch|load/i)) setMapFailed(true);
        });
        map.on("load", () => {
          map.addSource("sites", { type: "geojson", data: { type: "FeatureCollection", features: [] }, cluster: true, clusterRadius: 45, clusterMaxZoom: 13 });
          map.addLayer({ id: "clusters", type: "circle", source: "sites", filter: ["has", "point_count"],
            paint: { "circle-color": "#0f4c5c", "circle-opacity": 0.85, "circle-radius": ["step", ["get", "point_count"], 16, 10, 22, 50, 28], "circle-stroke-width": 2, "circle-stroke-color": "#fff" } });
          map.addLayer({ id: "cluster-count", type: "symbol", source: "sites", filter: ["has", "point_count"],
            layout: { "text-field": ["get", "point_count_abbreviated"], "text-size": 13, "text-font": ["Noto Sans Regular"] }, paint: { "text-color": "#fff" } });
          map.addLayer({ id: "points", type: "circle", source: "sites", filter: ["!", ["has", "point_count"]],
            paint: {
              "circle-radius": ["case", ["==", ["get", "id"], ""], 9, 9],
              "circle-color": ["match", ["get", "tone"], "ok", "#1d6b3a", "warn", "#b06a00", "bad", "#a3271f", "#6b7178"],
              "circle-stroke-width": ["case", ["==", ["get", "restricted"], true], 3, 2],
              "circle-stroke-color": ["case", ["==", ["get", "restricted"], true], "#8a5300", "#ffffff"],
            } });
          map.on("click", "clusters", async (e) => {
            const f = map.queryRenderedFeatures(e.point, { layers: ["clusters"] })[0];
            const src = map.getSource("sites") as GeoJSONSource;
            const zoom = await src.getClusterExpansionZoom(f.properties.cluster_id as number);
            map.easeTo({ center: (f.geometry as GeoJSON.Point).coordinates as [number, number], zoom });
          });
          map.on("click", "points", (e) => {
            const id = e.features?.[0]?.properties?.id as string | undefined;
            if (id) setSelectedId(id);
          });
          for (const l of ["clusters", "points"]) {
            map.on("mouseenter", l, () => (map.getCanvas().style.cursor = "pointer"));
            map.on("mouseleave", l, () => (map.getCanvas().style.cursor = ""));
          }
          setMapReady(true);
          sync();
        });
        map.on("moveend", sync);
      } catch {
        setMapFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  // Push data into the map source.
  useEffect(() => {
    const map = mapRef.current;
    const src = map?.getSource("sites") as GeoJSONSource | undefined;
    if (!src) return;
    src.setData({
      type: "FeatureCollection",
      features: (data?.sites ?? []).map((s) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [s.lng, s.lat] },
        properties: { id: s.id, tone: siteTone(s), restricted: s.visibility !== "PUBLIC" },
      })),
    });
  }, [data, mapReady]);

  // ---- derived -----------------------------------------------------------
  const sites = useMemo(
    () => [...(data?.sites ?? [])].sort((a, b) => distanceKm(center.lat, center.lng, a.lat, a.lng) - distanceKm(center.lat, center.lng, b.lat, b.lng)),
    [data, center],
  );
  const selected = sites.find((s) => s.id === selectedId) ?? null;
  const stale = Boolean(error && data);

  function flyTo(lng: number, lat: number, zoom = 13) {
    if (mapRef.current) mapRef.current.flyTo({ center: [lng, lat], zoom });
    else {
      setBbox(boundsAround(lng, lat, 0.1));
      setCenter({ lat, lng });
    }
  }

  async function runSearch(e: React.FormEvent) {
    e.preventDefault();
    if (query.trim().length < 2) return;
    try {
      const res = await fetch(`/api/map/search?q=${encodeURIComponent(query.trim())}`);
      const body = await res.json();
      setHits(res.ok ? body.hits : []);
    } catch {
      setHits([]);
    }
  }

  function nearMe() {
    if (!navigator.geolocation) return setGeoMsg("Location is not available on this device.");
    setGeoMsg("Finding your location… (used only on this device to move the map)");
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setGeoMsg(null);
        flyTo(p.coords.longitude, p.coords.latitude, 12);
      },
      () => setGeoMsg("Location permission denied. Search by city, county or ZIP instead."),
      { timeout: 10_000, maximumAge: 60_000 },
    );
  }

  const toggleCat = (code: string) => setSelectedCats((c) => (c.includes(code) ? c.filter((x) => x !== code) : [...c, code]));

  // ---- render ------------------------------------------------------------
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-line bg-surface px-3 py-2">
        <form onSubmit={runSearch} role="search" className="flex gap-2">
          <label htmlFor="q" className="sr-only">Search by city, county, ZIP or address</label>
          <input id="q" className="input" placeholder="City, county, ZIP or address" value={query} onChange={(e) => setQuery(e.target.value)} />
          <button className="btn btn-primary" type="submit">Search</button>
          <button className="btn btn-secondary whitespace-nowrap" type="button" onClick={nearMe}>Near me</button>
        </form>
        {geoMsg && <p role="status" className="mt-1 text-sm text-muted">{geoMsg}</p>}
        {hits && (
          <div className="mt-2">
            {hits.length === 0 ? (
              <p className="text-sm text-muted">No listed sites match “{query}”. Try a nearby city or ZIP, or move the map.</p>
            ) : (
              <ul className="flex flex-wrap gap-2" aria-label="Search results">
                {hits.map((h) => (
                  <li key={h.id}>
                    <button className="btn btn-secondary text-sm" onClick={() => { setHits(null); setSelectedId(h.id); flyTo(h.lng, h.lat); }}>
                      {h.name} <span className="text-muted">{h.label}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <details className="mt-2">
          <summary className="cursor-pointer text-sm font-semibold">
            Filters{selectedCats.length ? ` (${selectedCats.length})` : ""}{confirmedOnly ? " · confirmed only" : ""}
          </summary>
          <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label="Resource categories">
            {categories.map((c) => (
              <button key={c.code} type="button" aria-pressed={selectedCats.includes(c.code)} onClick={() => toggleCat(c.code)}
                className={`badge cursor-pointer border px-3 py-1.5 text-sm ${selectedCats.includes(c.code) ? "border-brand bg-brand text-brand-ink" : "border-line bg-surface"}`}>
                {c.label}
              </button>
            ))}
          </div>
          <label className="mt-2 flex items-center gap-2 text-sm">
            <input type="checkbox" checked={confirmedOnly} onChange={(e) => setConfirmedOnly(e.target.checked)} />
            Only show confirmed availability (excludes unconfirmed and expired listings)
          </label>
        </details>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs" aria-live="polite">
          {loading && <span className="text-muted">Loading…</span>}
          {lastSync && !stale && <span className="text-muted">Data as of {fmtTime(lastSync)}</span>}
          {data?.scope === "authenticated" && <span className="badge tone-warn">Signed in: includes restricted listings you are authorized to see</span>}
          {data?.truncated && <span className="badge tone-warn">Showing the {data.sites.length} most recently updated sites — zoom in for all</span>}
          {tooWide && <span className="badge tone-muted">Zoom in to load resources</span>}
          <span className="ml-auto flex gap-1 md:hidden" role="group" aria-label="View">
            <button className={`btn px-3 ${view === "map" ? "btn-primary" : "btn-secondary"}`} onClick={() => setView("map")} aria-pressed={view === "map"}>Map</button>
            <button className={`btn px-3 ${view === "list" ? "btn-primary" : "btn-secondary"}`} onClick={() => setView("list")} aria-pressed={view === "list"}>List</button>
          </span>
        </div>
        {error && (
          <p role="alert" className="mt-2 rounded-md bg-warn-bg p-2 text-sm text-warn">
            Couldn&apos;t refresh: {error}{" "}
            {data ? <>Showing data from {fmtTime(lastSync)} — availability may have changed.</> : null}{" "}
            <button className="underline" onClick={load}>Retry</button>
          </p>
        )}
      </div>

      <div className="relative flex min-h-0 flex-1">
        <div className={`${view === "map" ? "flex" : "hidden"} relative min-h-[55vh] flex-1 md:flex`}>
          {mapFailed ? (
            <div className="m-4 self-start rounded-md bg-warn-bg p-3 text-sm text-warn">
              The map could not load on this device or network. Use the list — it shows the same results.
            </div>
          ) : (
            // Inline position wins over .maplibregl-map { position: relative } from MapLibre's stylesheet.
            <div ref={mapEl} style={{ position: "absolute", inset: 0 }} role="region" aria-label="Resource map" />
          )}
        </div>
        <aside
          aria-label="Resource list"
          className={`${view === "list" || mapFailed ? "block" : "hidden"} w-full overflow-y-auto border-l border-line bg-bg md:block md:w-[26rem] md:flex-none ${stale ? "opacity-70" : ""}`}
        >
          {selected && <SiteDetail site={selected} stale={stale} onClose={() => setSelectedId(null)} />}
          <h2 className="px-3 pt-3 text-sm font-semibold text-muted">
            {sites.length} site{sites.length === 1 ? "" : "s"} in this area{signedIn ? "" : " (public listings)"}
          </h2>
          <ul className="grid gap-2 p-3">
            {sites.map((s) => (
              <li key={s.id}>
                <button
                  className={`card w-full p-3 text-left ${s.id === selectedId ? "ring-2 ring-brand" : ""}`}
                  onClick={() => { setSelectedId(s.id); mapRef.current?.easeTo({ center: [s.lng, s.lat] }); }}
                >
                  <div className="flex flex-wrap items-center gap-1">
                    <span className="font-semibold">{s.name}</span>
                    {s.isSynthetic && <span className="badge tone-warn">SYNTHETIC DEMO</span>}
                    {s.visibility !== "PUBLIC" && <span className="badge tone-warn">Restricted</span>}
                  </div>
                  <div className="text-sm text-muted">{s.orgName} · {[s.city, s.state].filter(Boolean).join(", ")} · {distanceKm(center.lat, center.lng, s.lat, s.lng).toFixed(1)} km</div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {s.resources.slice(0, 4).map((r) => {
                      const d = displayAvailability(r.reportedStatus as AvailabilityStatus, r.freshness as Freshness);
                      return <span key={r.id} className={`badge tone-${d.tone}`}>{r.categoryLabel}: {d.label}</span>;
                    })}
                    {s.resources.length > 4 && <span className="badge tone-muted">+{s.resources.length - 4} more</span>}
                  </div>
                </button>
              </li>
            ))}
            {!loading && sites.length === 0 && !tooWide && (
              <li className="text-sm text-muted">No listed resources in this area{selectedCats.length || confirmedOnly ? " match your filters" : ""}. Try zooming out or another location. If you need emergency help, call 911; for other help, dial 211.</li>
            )}
          </ul>
        </aside>
      </div>
    </div>
  );
}

function SiteDetail({ site, stale, onClose }: { site: MapSite; stale: boolean; onClose: () => void }) {
  const isPublic = site.visibility === "PUBLIC";
  return (
    <section className="card m-3 p-4" aria-labelledby="site-detail-h">
      <div className="flex items-start gap-2">
        <h2 id="site-detail-h" className="flex-1 text-lg font-bold">{site.name}</h2>
        <button className="btn btn-secondary px-3" onClick={onClose} aria-label="Close details">✕</button>
      </div>
      <div className="mt-1 flex flex-wrap gap-1">
        {site.isSynthetic && <span className="badge tone-warn">SYNTHETIC DEMO DATA — not a real resource</span>}
        {!isPublic && <span className="badge tone-warn">Restricted: {site.visibility.replaceAll("_", " ").toLowerCase()} — do not share</span>}
      </div>
      <p className="mt-1 text-sm">Operated by <strong>{site.orgName}</strong> <span className="badge tone-ok">Verified organization</span></p>
      {(site.addressLine || site.city) && (
        <p className="mt-1 text-sm">{[site.addressLine, site.city, site.state, site.postalCode].filter(Boolean).join(", ")}</p>
      )}
      {site.hoursText && <p className="mt-1 text-sm">Hours: {site.hoursText}</p>}
      {site.description && <p className="mt-1 text-sm text-muted">{site.description}</p>}
      <p className="mt-1 text-xs text-muted">Site last confirmed {fmtTime(site.lastConfirmedAt)}{stale ? " · this view may be out of date" : ""}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {site.publicPhone && <a className="btn btn-primary" href={telHref(site.publicPhone)}>Call {site.publicPhone}</a>}
        {isPublic && (
          <a className="btn btn-secondary" href={directionsUrl(site.lat, site.lng)} target="_blank" rel="noopener noreferrer">Directions</a>
        )}
      </div>
      <h3 className="mt-4 font-semibold">Resources</h3>
      <ul className="mt-1 divide-y divide-line">
        {site.resources.map((r) => {
          const d = displayAvailability(r.reportedStatus as AvailabilityStatus, r.freshness as Freshness);
          return (
            <li key={r.id} className="py-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{r.name}</span>
                <span className="text-xs text-muted">{r.categoryLabel}</span>
                <span className={`badge tone-${d.tone}`}>{d.label}</span>
                {r.visibility !== "PUBLIC" && <span className="badge tone-warn">Restricted</span>}
              </div>
              {d.note && <div className="text-xs text-muted">{d.note}</div>}
              {r.reportedQuantity !== null && (
                <div className="text-sm">{r.reportedQuantity} {r.quantityUnit} <span className="text-xs text-muted">({r.quantityBasis === "VERIFIED_COUNT" ? "verified count" : "reported by organization"})</span></div>
              )}
              <div className="text-xs text-muted">Last confirmed {fmtTime(r.lastConfirmedAt)}</div>
            </li>
          );
        })}
        {site.resources.length === 0 && <li className="py-2 text-sm text-muted">No resources listed.</li>}
      </ul>
      <p className="mt-3 text-xs text-muted">Call ahead before traveling. Availability is reported by the organization and can change quickly.</p>
    </section>
  );
}
