export class StoreUnavailableError extends Error {
  constructor(message = "Не удалось сохранить данные, попробуйте ещё раз.") {
    super(message);
    this.name = "StoreUnavailableError";
  }
}

export const STORE_RETRY_MESSAGE = "Не удалось сохранить данные, попробуйте ещё раз.";
