import { createPinia } from "pinia";
import { createApp } from "vue";
import App from "./App.vue";
import { router } from "./router";
import { useSession } from "./stores/session";
import "./styles/main.css";

const app = createApp(App).use(createPinia()).use(router);
app.mount("#app");

// Initialise Tide once (this also completes a login redirect), then load who is signed in.
void useSession().start();

// Dev builds only: a handle for the e2e scripts to inspect the Tide session. Not in production.
if (import.meta.env.DEV) void import("./tide/tide").then((tide) => { (window as unknown as { __signguardTide: unknown }).__signguardTide = tide; });
