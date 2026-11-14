/* eslint-disable @next/next/no-img-element -- same-origin logo route; fixed small size */
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDriver } from "@/server/db";
import { getPublicOrganization, listServiceTypes } from "@/server/modules/directory";
import { SOCIAL_KINDS, SOCIAL_LABELS, prettyUrl } from "@/lib/links";
import { telHref } from "@/lib/domain";
import { ServiceBadge } from "@/components/service-forms";
import { SyntheticBadge } from "@/components/status";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ orgId: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { orgId } = await params;
  const org = await getPublicOrganization(await getDriver(), orgId);
  return { title: org ? org.displayName : "Organization not found" };
}

/** Public organization profile. Only approved, consented, administrator-approved profiles resolve. */
export default async function PublicOrganizationPage({ params }: Params) {
  const { orgId } = await params;
  const db = await getDriver();
  const [org, serviceTypes] = await Promise.all([getPublicOrganization(db, orgId), listServiceTypes(db)]);
  if (!org) notFound();
  const typeOf = (code: string) => serviceTypes.find((t) => t.code === code);
  const primary = { label: org.serviceLabel, shortLabel: org.serviceShort, color: org.serviceColor };
  const socials = SOCIAL_KINDS.filter((k) => org.socialLinks[k]);
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6">
      <Link href="/contacts" className="text-sm text-brand underline">← Contacts</Link>
      <div className="card mt-3 p-5">
        <div className="flex flex-wrap items-center gap-4">
          {org.hasLogo && (
            <img src={`/api/orgs/${org.id}/logo`} alt={org.logoAlt ?? `${org.displayName} logo`} width={72} height={72}
              className="h-[72px] w-[72px] rounded-lg border border-line bg-white object-contain" />
          )}
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-bold">{org.displayName}</h1>
            <div className="mt-1 flex flex-wrap gap-1.5">
              <span className="badge tone-ok">Verified organization</span>
              <SyntheticBadge show={org.isSynthetic} />
            </div>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          <ServiceBadge type={primary} />
          {org.additionalServiceTypes.map((c) => typeOf(c) && <ServiceBadge key={c} type={typeOf(c)!} />)}
        </div>
        {org.description && <p className="mt-4 whitespace-pre-wrap">{org.description}</p>}

        <div className="mt-4 flex flex-wrap gap-2">
          {org.website && (
            <a className="btn btn-primary" href={org.website} target="_blank" rel="noopener noreferrer nofollow">
              Visit website <span className="sr-only">(opens in a new tab)</span>
            </a>
          )}
          {org.publicPhone && <a className="btn btn-secondary" href={telHref(org.publicPhone)}>Call {org.publicPhone}</a>}
          {org.publicEmail && <a className="btn btn-secondary" href={`mailto:${org.publicEmail}`}>Email</a>}
        </div>

        {socials.length > 0 && (
          <section className="mt-5" aria-labelledby="social-h">
            <h2 id="social-h" className="text-sm font-semibold text-muted">Find us online</h2>
            <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
              {socials.map((k) => (
                <li key={k}>
                  <a className="text-brand underline" href={org.socialLinks[k]} target="_blank" rel="noopener noreferrer nofollow">
                    {SOCIAL_LABELS[k]}
                    <span className="sr-only"> (opens in a new tab)</span>
                  </a>
                  <span className="ml-1 text-xs text-muted">{prettyUrl(org.socialLinks[k]!)}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <dl className="mt-5 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[10rem_1fr]">
          {org.countiesServed.length > 0 && (<><dt className="text-muted">Counties served</dt><dd>{org.countiesServed.join("; ")}</dd></>)}
          {org.publicPostalCode && (<><dt className="text-muted">Office ZIP</dt><dd>{org.publicPostalCode}</dd></>)}
          <dt className="text-muted">Locations on the map</dt><dd>{org.publicSiteCount}</dd>
        </dl>
      </div>
      <p className="mt-4 text-xs text-muted">
        This profile is provided by the organization. External links open sites we do not control. In an emergency, call 911.
      </p>
    </div>
  );
}
