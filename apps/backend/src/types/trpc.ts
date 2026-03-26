export type TrpcLikeError = {
	code?: string;
	message?: string;
	cause?: unknown;
};

export const trpcStatusCode: Record<string, number> = {
	UNAUTHORIZED: 401,
	BAD_REQUEST: 400,
	FORBIDDEN: 403,
	NOT_FOUND: 404,
	CONFLICT: 409,
	TOO_MANY_REQUESTS: 429,
	INTERNAL_SERVER_ERROR: 500,
};