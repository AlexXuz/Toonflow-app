type UsageEvent = "onboarding.complete" | "onboarding.skip" | "workspace.canvas" | "workspace.document";
type AgentOutcome = "success" | "failed" | "cancelled";
type CanvasSnapshot = { nodes: readonly { type?: string }[]; edgeCount: number };

// ACT: 保留调用接口以兼容创作组件；本地版不采集、不保存、不上报遥测。
export default {
  track(_event: UsageEvent) {},
  startAgent() { return (_outcome: AgentOutcome) => {}; },
  observeCanvas(_read: () => CanvasSnapshot | undefined) { return () => {}; },
};
export function registerAnonymousData() { return () => {}; }
