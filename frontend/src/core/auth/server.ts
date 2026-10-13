import { STATIC_WEBSITE_USER } from "./static-user";
import { type AuthResult } from "./types";

/**
 * Single-user deployment: there is no session to resolve, so the workspace
 * always renders as the default user. Kept as a tagged result so callers that
 * switch on ``AuthResult`` continue to type-check.
 */
export async function getServerSideUser(): Promise<AuthResult> {
  return {
    tag: "authenticated",
    user: STATIC_WEBSITE_USER,
  };
}
