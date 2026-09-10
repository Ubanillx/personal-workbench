import type { CurrentUser } from "./domain";

export interface AccessRequest {
  token: string;
}

export interface AccessResponse {
  user: CurrentUser;
}

export interface SessionUserResponse {
  user: CurrentUser | null;
}
