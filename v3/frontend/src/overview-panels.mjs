export function createOverviewPanelState() {
  return { tasks: false, schedules: false };
}

export function setOverviewPanelOpen(state, panel, open) {
  if (state[panel] === open) return state;
  return { ...state, [panel]: open };
}
