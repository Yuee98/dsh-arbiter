export class WebRequestError extends Error {
  readonly pending: boolean;
  constructor(message: string, pending: boolean) {
    super(message);
    this.pending = pending;
  }
}
