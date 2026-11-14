"use client";

import { useSyncExternalStore } from "react";
import { MAP_APP_LABELS, directionsLinks, preferredMapApp, type MapApp } from "@/lib/domain";

const OTHER_APPS: MapApp[] = ["google", "apple", "waze", "osm"];

/**
 * Directions that open the navigation app on the person's own phone: the lead button follows the device
 * (Apple Maps on iPhone, the phone's default maps app on Android, Google Maps elsewhere) and a short list
 * offers Google Maps, Apple Maps, Waze and OpenStreetMap. Only rendered for publicly disclosed locations.
 */
const noSubscribe = () => () => {};

export function DirectionsMenu({ lat, lng }: { lat: number; lng: number }) {
  // Server render and first paint use Google Maps; the device-specific app is chosen once on the client.
  const lead = useSyncExternalStore<MapApp>(noSubscribe, () => preferredMapApp(navigator.userAgent), () => "google");
  const links = directionsLinks(lat, lng);
  return (
    <>
      <a
        className="btn btn-secondary"
        href={links[lead]}
        {...(lead === "device" ? {} : { target: "_blank", rel: "noopener noreferrer" })}
      >
        Directions{lead === "google" ? "" : ` (${MAP_APP_LABELS[lead]})`}
      </a>
      <details className="relative">
        <summary className="btn btn-secondary cursor-pointer list-none">Other map apps</summary>
        <ul className="mt-1 rounded-lg border border-line bg-white p-1 shadow">
          {OTHER_APPS.filter((a) => a !== lead).map((a) => (
            <li key={a}>
              <a className="block rounded px-3 py-2 text-sm underline" href={links[a]} target="_blank" rel="noopener noreferrer">
                {MAP_APP_LABELS[a]}
              </a>
            </li>
          ))}
        </ul>
      </details>
    </>
  );
}
