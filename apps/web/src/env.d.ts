declare namespace App {
  interface Locals {
    /** The signed-in reader, from the sealed session cookie (src/lib/auth/middleware.ts). */
    session?: import('../server/session.mjs').Session | undefined;
  }
}
