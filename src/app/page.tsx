import ResourceMap from "@/components/ResourceMap";
import { getDriver } from "@/server/db";
import { listCategories } from "@/server/modules/sites";
import { getCurrentUser } from "@/server/session";
import { listServiceTypes } from "@/server/modules/directory";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const db = await getDriver();
  const [user, categories, serviceTypes] = await Promise.all([getCurrentUser(), listCategories(db), listServiceTypes(db)]);
  return (
    <>
      <ResourceMap categories={categories} signedIn={Boolean(user)} serviceTypes={serviceTypes} />
    </>
  );
}
