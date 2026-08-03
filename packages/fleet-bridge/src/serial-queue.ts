export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  /** `.then(operation, operation)` on both arms so a rejected predecessor still lets the next operation run. */
  run<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
