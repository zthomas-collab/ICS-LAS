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
      <h1 className="sr-only">Find disaster recovery resources near you</h1>
      <ResourceMap categories={categories} signedIn={Boolean(user)} serviceTypes={serviceTypes} />
    </>
  );
}
