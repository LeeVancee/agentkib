
import { StrictMode, createRoot } from "octane";
import "@fontsource-variable/geist";
import "./style.css";
import { WebApplication } from "./router";
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WebApplication hosted={import.meta.env.MODE === "hosted"} />
  </StrictMode>,
);
