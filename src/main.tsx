import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./style.css";
async function mount() {
  if (
    import.meta.env.DEV &&
    new URLSearchParams(location.search).has("fixture")
  )
    await import("../tests/browser-fixture");
  createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
void mount();
