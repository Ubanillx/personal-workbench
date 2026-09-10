import { healthPayload } from "../lib/context.server";
import { ok } from "../lib/http.server";

export async function loader(): Promise<Response> {
  return ok(await healthPayload());
}
