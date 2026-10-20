/** Native task contracts keep work requests independent of process and view lifetimes. */
export interface TaskResource { kind: "front" | "checkpoint" | "diff" | "pull_request" | "flow"; id: string; root: string | null; label: string }
export interface TaskLinks {
  projectId: string | null;
  terminalIds: string[];
  queueItemId?: string | null;
  executorTerminalId?: string | null;
  executionId?: string | null;
  resources?: TaskResource[];
}
export interface NewTask {
  id: string;
  title: string;
  request: string;
  criteria: string[];
  links: TaskLinks;
}
export interface Criterion { id: string; text: string; evidence: string[] }
export interface ValidationCheck { name: string; passed: boolean; evidence: string }
export interface Delivery { summary: string; artifacts: string[]; checks: ValidationCheck[] }
export interface Submission { attemptId?: string; delivery: Delivery; evidence: Record<string, string[]> }
export interface WorkTask {
  id: string;
  title: string;
  request: string;
  status: string;
  criteria: Criterion[];
  links: TaskLinks;
  delivery: Delivery | null;
  createdAt: number;
  updatedAt: number;
  revision: number;
}
export interface TaskCursor { at: number; id: string }
export interface TaskPage { tasks: WorkTask[]; next: TaskCursor | null; total: number; attentionTotal: number }
export interface TaskEvent { id: number; taskId: string; kind: string; at: number; detail: string }
export interface DeliveryRecord { taskId: string; revision: number; at: number; delivery: Delivery; criteria: Criterion[]; recovered: boolean }
export interface TaskQueueResult { task: WorkTask; items: import("./queue").QueueItem[] }
