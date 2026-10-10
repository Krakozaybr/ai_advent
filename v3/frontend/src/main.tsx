import React from "react";
import { createRoot } from "react-dom/client";
import { BoardChat } from "./BoardChat";
import { LocalDays } from "./LocalDays";
import "./styles.css";
import "katex/dist/katex.min.css";
import "highlight.js/styles/github.css";

const requestedLocalDay = Number(new URLSearchParams(window.location.search).get("localDay"));
const localDay = [26, 27, 28].includes(requestedLocalDay) ? requestedLocalDay as 26 | 27 | 28 : null;

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {localDay ? <LocalDays initialDay={localDay} /> : <BoardChat />}
  </React.StrictMode>,
);
