// Safe handling of user-supplied links (organization websites and social profiles).
// Pure functions: usable on server and client. Only http(s) URLs without embedded credentials pass.

export const SOCIAL_KINDS = ["facebook", "instagram", "x", "linkedin", "youtube", "tiktok", "other"] as const;
export type SocialKind = (typeof SOCIAL_KINDS)[number];

export const SOCIAL_LABELS: Record<SocialKind, string> = {
  facebook: "Facebook",
  instagram: "Instagram",
  x: "X (Twitter)",
  linkedin: "LinkedIn",
  youtube: "YouTube",
  tiktok: "TikTok",
  other: "Other link",
};

/** Hostnames each platform may use. "other" accepts any https host. */
const HOSTS: Record<Exclude<SocialKind, "other">, string[]> = {
  facebook: ["facebook.com", "fb.com", "fb.me"],
  instagram: ["instagram.com"],
  x: ["x.com", "twitter.com"],
  linkedin: ["linkedin.com"],
  youtube: ["youtube.com", "youtu.be"],
  tiktok: ["tiktok.com"],
};

export type LinkResult = { ok: true; url: string } | { ok: false; error: string };

function hostMatches(host: string, allowed: string[]): boolean {
  return allowed.some((h) => host === h || host.endsWith(`.${h}`));
}

/** Normalizes an http(s) URL. `requireHttps` is used for social links; websites may be http for legacy sites. */
export function parseWebUrl(raw: string, opts: { requireHttps?: boolean } = {}): LinkResult {
  const value = raw.trim();
  if (!value) return { ok: false, error: "Enter a web address." };
  if (value.length > 300) return { ok: false, error: "That web address is too long." };
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return { ok: false, error: "Enter a full web address starting with https://" };
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && !opts.requireHttps)) {
    return { ok: false, error: opts.requireHttps ? "Must start with https://" : "Must start with http:// or https://" };
  }
  if (u.username || u.password) return { ok: false, error: "Web addresses cannot contain a username or password." };
  if (!u.hostname.includes(".")) return { ok: false, error: "Enter a full web address." };
  u.hash = "";
  return { ok: true, url: u.toString() };
}

export function parseSocialLink(kind: SocialKind, raw: string): LinkResult {
  const r = parseWebUrl(raw, { requireHttps: true });
  if (!r.ok) return r;
  if (kind !== "other") {
    const host = new URL(r.url).hostname.toLowerCase();
    if (!hostMatches(host, HOSTS[kind])) return { ok: false, error: `Use a ${SOCIAL_LABELS[kind]} address.` };
  }
  return r;
}

/** Display text for a link without protocol or trailing slash. */
export function prettyUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, "")}${u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "")}`;
  } catch {
    return url;
  }
}
