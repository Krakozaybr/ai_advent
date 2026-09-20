import { DAY13_PHASE_LABELS, DAY13_PHASES } from "./day13.js";

export const DAY15_SCOPE_ID = "day15-default";
export const DAY15_STATES = DAY13_PHASES;
export const DAY15_STATE_LABELS = DAY13_PHASE_LABELS;

export const DAY15_GUARDS = {
  planApproved: {
    label: "План утверждён",
    description: "Разрешает переход planning → execution.",
  },
  implementationComplete: {
    label: "Реализация завершена",
    description: "Разрешает переход execution → validation.",
  },
  validationPassed: {
    label: "Проверка пройдена",
    description: "Разрешает переход validation → done.",
  },
};

export const DAY15_TRANSITIONS = {
  planning: { target: "execution", guard: "planApproved" },
  execution: { target: "validation", guard: "implementationComplete" },
  validation: { target: "done", guard: "validationPassed" },
};

export const DAY15_DEFAULT_LIFECYCLE = {
  title: "Выпустить минимальную версию локального AI-ассистента",
  state: "planning",
  paused: false,
  guards: {
    planApproved: false,
    implementationComplete: false,
    validationPassed: false,
  },
};
