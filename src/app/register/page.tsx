import { redirect } from "next/navigation";

/** Registration now lives on the combined organization page. Kept so old links keep working. */
export default function RegisterRedirect() {
  redirect("/signin?tab=register");
}
