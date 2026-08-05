import type { AppAuthClaims } from "../modules/auth/jwt.service";

declare global {
  namespace Express {
    interface Request {
      /** Set by requireAppAuth after a verified app JWT (see modules/auth). */
      appAuth?: AppAuthClaims;
    }
  }
}

export {};
