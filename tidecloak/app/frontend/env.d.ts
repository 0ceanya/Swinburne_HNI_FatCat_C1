/// <reference types="vite/client" />

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<object, object, unknown>;
  export default component;
}

/** tidecloak/tidecloak.json, the adapter exported by bootstrap.py (public keys and ids only). */
declare module "virtual:tidecloak-adapter" {
  const adapter: Record<string, unknown> & { realm: string; resource: string; "auth-server-url": string; vendorId: string };
  export default adapter;
}
