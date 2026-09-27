export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const badRequest = (msg, details) => new HttpError(400, msg, details);
export const notFound = (what = 'Record') => new HttpError(404, `${what} not found.`);
export const conflict = (msg, details) => new HttpError(409, msg, details);

export const actor = (user) => (user ? { id: user._id, name: user.name } : { name: 'system' });
