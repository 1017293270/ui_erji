import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DoodleFX } from "@echomind/ui";
import { App } from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <DoodleFX />
    <App />
  </StrictMode>,
);
