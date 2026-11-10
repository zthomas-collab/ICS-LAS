import { describe, expect, it } from "vitest";
import { directionsUrl, displayAvailability, isResourceVisibilityAllowed, telHref } from "@/lib/domain";

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
    expect(displayAvailability("TEMPORARILY_CLOSED", "FRESH").tone).toBe("bad");
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
