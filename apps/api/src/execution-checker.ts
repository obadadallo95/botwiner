export interface ExecutionGetter {
  getExecution(request: { name: string }): Promise<[unknown, ...unknown[]]>;
}

export async function checkExecutionFinished(
  client: ExecutionGetter,
  executionName: string
): Promise<{ finished: boolean; reason?: string }> {
  try {
    const [rawEx] = await client.getExecution({ name: executionName });
    const ex = rawEx as Record<string, unknown> | null | undefined;
    const conditions = Array.isArray(ex?.conditions) ? (ex.conditions as Record<string, unknown>[]) : [];
    const readyCond = conditions.find((c) => c.type === "Ready" || c.type === "Completed");
    const isFinished = Boolean(
      ex?.completionTime ||
      ex?.deleteTime ||
      (readyCond && (readyCond.state === "CONDITION_SUCCEEDED" || readyCond.state === "CONDITION_FAILED")) ||
      (ex?.runningCount !== null && ex?.runningCount !== undefined && ex?.runningCount === 0 && !ex?.reconciling)
    );
    const reasonStr =
      (typeof readyCond?.message === "string" ? readyCond.message : undefined) ||
      (typeof readyCond?.reason === "string" ? readyCond.reason : undefined) ||
      (ex?.completionTime ? "completed" : undefined);
    return {
      finished: isFinished,
      ...(reasonStr !== undefined ? { reason: reasonStr } : {}),
    };
  } catch (error: unknown) {
    const errObj = error && typeof error === "object" ? (error as Record<string, unknown>) : null;
    const status = Number(errObj?.code ?? errObj?.status);
    if (status === 5 || status === 404) {
      return { finished: true, reason: "execution_not_found" };
    }
    return { finished: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
