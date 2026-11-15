class ErrorResponse extends Error {
  constructor(message, statusCode, code = null) {
    super(message);
    this.statusCode = statusCode;
    if (code) this.code = code;
  }
}
export default ErrorResponse;
  