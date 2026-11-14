import { describe, expect, it } from "vitest";
import { freshDb } from "./helpers/db";
import { runIn } from "@/server/db/context";
import { STATUS_KEY, bestSiteStatus, directionsLinks, directionsUrl, displayAvailability, preferredMapApp, isResourceVisibilityAllowed, telHref } from "@/lib/domain";

describe("displayAvailability", () => {
  it("never shows Available when the confirmation expired", () => {
    const d = displayAvailability("AVAILABLE", "EXPIRED");
    expect(d.label).toBe("Unconfirmed");
    expect(d.confirmedAvailable).toBe(false);
    expect(d.note).toBe("Last reported: Available");
  });
  it("treats never-confirmed records as unconfirmed", () => {
    expect(displayAvailability("AVAILABLE", "NEVER_CONFIRMED")).toMatchObject({ label: "Unconfirmed", confirmedAvailable: false });
  });
  it("shows confirmed positive statuses", () => {
    expect(displayAvailability("LIMITED", "FRESH")).toMatchObject({ label: "Limited", tone: "warn", confirmedAvailable: true });
    expect(displayAvailability("AVAILABLE", "DUE_SOON")).toMatchObject({ label: "Available", note: "Reconfirmation due soon" });
  });
  it("depleted and closed are never confirmed-available", () => {
    expect(displayAvailability("DEPLETED", "FRESH").confirmedAvailable).toBe(false);
    expect(displayAvailability("TEMPORARILY_CLOSED", "FRESH")).toMatchObject({ kind: "closed", label: "Temporarily closed" });
  });
});

describe("visibility ordering", () => {
  it("allows equal or stricter resource visibility only", () => {
    expect(isResourceVisibilityAllowed("PUBLIC", "PUBLIC")).toBe(true);
    expect(isResourceVisibilityAllowed("PUBLIC", "PRIVATE_ORGANIZATION")).toBe(true);
    expect(isResourceVisibilityAllowed("PRIVATE_ORGANIZATION", "PUBLIC")).toBe(false);
    expect(isResourceVisibilityAllowed("AUTHORIZED_RESPONDERS", "ORGANIZATION_NETWORK")).toBe(false);
  });
});

describe("contact helpers", () => {
  it("builds safe tel: and directions links", () => {
    expect(telHref("(828) 555-0100 ext")).toBe("tel:8285550100");
    expect(directionsUrl(35.5951234, -82.5515)).toBe("https://www.openstreetmap.org/directions?to=35.595123%2C-82.551500");
  });
});

describe("directions for the phone's own map app", () => {
  it("builds Google, Apple, Waze, OSM and geo: links for the same point", () => {
    const l = directionsLinks(35.5951234, -82.5515);
    expect(l.google).toBe("https://www.google.com/maps/dir/?api=1&destination=35.595123%2C-82.551500&travelmode=driving");
    expect(l.apple).toBe("https://maps.apple.com/?daddr=35.595123,-82.551500&dirflg=d");
    expect(l.waze).toBe("https://waze.com/ul?ll=35.595123%2C-82.551500&navigate=yes");
    expect(l.osm).toBe(directionsUrl(35.5951234, -82.5515));
    expect(l.device).toBe("geo:35.595123,-82.551500?q=35.595123,-82.551500");
  });
  it("leads with the app that fits the device", () => {
    expect(preferredMapApp("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)")).toBe("apple");
    expect(preferredMapApp("Mozilla/5.0 (Linux; Android 14; Pixel 8)")).toBe("device");
    expect(preferredMapApp("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("google");
  });
});

describe("service type colors (accessibility)", () => {
  it("every color gives white text at least 4.5:1 contrast, and the database rejects darker-failing colors", async () => {
    const db = await freshDb();
    const rows = await runIn(db, { kind: "system" }, (tx) =>
      tx.query<{ code: string; ratio: string }>(`SELECT code, ics.white_text_contrast(color)::text AS ratio FROM service_types`),
    );
    for (const r of rows) expect(Number(r.ratio), r.code).toBeGreaterThanOrEqual(4.5);
    await expect(
      runIn(db, { kind: "system" }, (tx) => tx.query(`UPDATE service_types SET color = '#ffcc00' WHERE code = 'FOOD'`)),
    ).rejects.toThrow(/service_types_color_contrast/);
    await db.close();
  });
});

describe("HopeGrid status semantics", () => {
  it("maps every status to its own semantic kind with a text label", () => {
    expect(displayAvailability("AVAILABLE", "FRESH").kind).toBe("available");
    expect(displayAvailability("LIMITED", "FRESH").kind).toBe("limited");
    expect(displayAvailability("DEPLETED", "FRESH").kind).toBe("depleted");
    expect(displayAvailability("TEMPORARILY_CLOSED", "FRESH").kind).toBe("closed");
    expect(displayAvailability("UNKNOWN", "FRESH").kind).toBe("unknown");
    expect(displayAvailability("AVAILABLE", "EXPIRED")).toMatchObject({ kind: "unconfirmed", label: "Unconfirmed" });
  });
  it("a map pin shows the most useful confirmed status among its resources", () => {
    expect(bestSiteStatus([{ reportedStatus: "DEPLETED", freshness: "FRESH" }, { reportedStatus: "LIMITED", freshness: "FRESH" }])).toBe("limited");
    expect(bestSiteStatus([{ reportedStatus: "AVAILABLE", freshness: "EXPIRED" }, { reportedStatus: "DEPLETED", freshness: "FRESH" }])).toBe("depleted");
    expect(bestSiteStatus([{ reportedStatus: "AVAILABLE", freshness: "EXPIRED" }])).toBe("unconfirmed");
    expect(bestSiteStatus([])).toBe("unconfirmed");
  });
  it("the map key covers every status with a letter", () => {
    expect(STATUS_KEY.map((k) => k.kind)).toEqual(["available", "limited", "depleted", "closed", "unknown", "unconfirmed"]);
    for (const k of STATUS_KEY) expect(k.letter).toMatch(/^[A-Z?]$/);
  });
});

describe("type colors never reuse status colors", () => {
  it("rejects a reserved status color as an organization type color", async () => {
    const db = await freshDb();
    await expect(
      runIn(db, { kind: "system" }, (tx) => tx.query(`UPDATE service_types SET color = '#2e7d32' WHERE code = 'SHELTER'`)),
    ).rejects.toThrow(/service_types_not_status_color/);
    const rows = await runIn(db, { kind: "system" }, (tx) => tx.query<{ code: string; color: string }>(`SELECT code, color FROM service_types`));
    expect(rows.find((r) => r.code === "SHELTER")?.color).toBe("#00695c");
    await db.close();
  });
});
