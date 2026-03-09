export class ToolStatusState {
  private readonly statuses = new Map<string, string>();
  private readonly order: string[] = [];

  set(toolCallId: string | undefined, status: string): void {
    if (!toolCallId) return;
    if (!this.statuses.has(toolCallId)) {
      this.order.push(toolCallId);
    }
    this.statuses.set(toolCallId, status);
  }

  delete(toolCallId: string | undefined): void {
    if (!toolCallId) return;
    this.statuses.delete(toolCallId);
    const index = this.order.lastIndexOf(toolCallId);
    if (index !== -1) {
      this.order.splice(index, 1);
    }
  }

  current(): string {
    for (let index = this.order.length - 1; index >= 0; index -= 1) {
      const toolCallId = this.order[index];
      const status = this.statuses.get(toolCallId);
      if (status) return status;
    }
    return '';
  }
}