export type OverviewPanelState = { tasks: boolean; schedules: boolean };
export type OverviewPanel = keyof OverviewPanelState;

export function createOverviewPanelState(): OverviewPanelState;
export function setOverviewPanelOpen(state: OverviewPanelState, panel: OverviewPanel, open: boolean): OverviewPanelState;
