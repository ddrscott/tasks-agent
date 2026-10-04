import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import { watchViewport } from "./viewport";

watchViewport();

createRoot(document.getElementById("root")!).render(<App />);
