import { redirect } from "react-router";
import { requireUserOrRedirect } from "../lib/ui.server";

// Preserve bookmarked review filters after merging review into the task page.
export function loader({ request }: { request: Request }) {
  requireUserOrRedirect(request);
  const params = new URL(request.url).searchParams;
  if (!params.has("range")) params.set("range", "month");
  const owner = params.get("ownerId");
  if (owner) params.set("assignee", owner);
  params.delete("ownerId");
  return redirect(`/tasks?${params.toString()}`);
}
