import { NextRequest, NextResponse } from "next/server";

/**
 * Wraps an App Route handler so unexpected errors are logged and returned as
 * a generic 500 instead of leaking stack traces or provider error messages.
 * Expected/client errors (4xx responses thrown intentionally) should still be
 * returned as normal NextResponse.json(...) from inside the handler.
 */
export function withApiErrorHandler<
  Args extends [NextRequest, ...unknown[]],
  Return extends NextResponse<unknown>,
>(handler: (...args: Args) => Promise<Return>): (...args: Args) => Promise<Return | NextResponse> {
  return async (...args: Args) => {
    try {
      return await handler(...args);
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      console.error("API route error:", message, err);
      return NextResponse.json({ error: "Internal server error" }, { status: 500 }) as Return | NextResponse;
    }
  };
}
