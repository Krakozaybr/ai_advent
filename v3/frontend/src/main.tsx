import React from "react";
import { createRoot } from "react-dom/client";
import { BoardChat } from "./BoardChat";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BoardChat />
  </React.StrictMode>,
);
