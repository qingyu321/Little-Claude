/**
 * Desktop pet window entry.
 * Separate React root (no StrictMode — avoids double-mounting native listeners
 * in the always-on-top utility window).
 */

import ReactDOM from "react-dom/client";
import { PetApp } from "./pet/PetApp";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<PetApp />);
