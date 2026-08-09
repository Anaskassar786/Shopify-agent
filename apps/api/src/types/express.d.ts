import type { AppAuthClaims } from "../modules/auth/jwt.service";

declare global {
  namespace Express {
    interface Request {
      /** Set by requireAppAuth after a verified app JWT (see modules/auth). */
      appAuth?: AppAuthClaims;
      /** M6: operator id from a verified X-Admin-Session step-up token (admin writes). */
      adminOperatorId?: string;
    }
  }
}

export {};
