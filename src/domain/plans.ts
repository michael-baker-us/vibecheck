export type PlanTaskStatus = "pending" | "in-progress" | "completed";

export type PlanTask = {
  text: string;
  status: PlanTaskStatus;
  line: number;
};

export type PlanDocument = {
  path: string;
  title: string;
  modifiedAt: string;
  excerpt?: string;
  tasks: PlanTask[];
};

export function planProgress(plan: PlanDocument): string | undefined {
  if (!plan.tasks.length) return undefined;
  const completed = plan.tasks.filter((task) => task.status === "completed").length;
  return `${completed}/${plan.tasks.length} steps complete`;
}

export function currentPlanTask(plan: PlanDocument): PlanTask | undefined {
  return plan.tasks.find((task) => task.status === "in-progress") ??
    plan.tasks.find((task) => task.status === "pending");
}
