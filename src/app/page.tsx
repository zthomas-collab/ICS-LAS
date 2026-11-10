import ResourceMap from "@/components/ResourceMap";
import { getDriver } from "@/server/db";
import { listCategories } from "@/server/modules/sites";
import { getCurrentUser } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const [user, categories] = await Promise.all([getCurrentUser(), getDriver().then(listCategories)]);
  return (
    <>
      <h1 className="sr-only">Find disaster recovery resources near you</h1>
      <ResourceMap categories={categories} signedIn={Boolean(user)} />
    </>
  );
}
