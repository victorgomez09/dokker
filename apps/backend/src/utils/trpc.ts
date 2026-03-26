import { TrpcLikeError, trpcStatusCode } from "@/types/trpc";
import { HTTPException } from "hono/http-exception";

export const toHttpError = (error: unknown, fallbackMessage = "Internal Server Error") => {
	if (error instanceof HTTPException) {
		return error;
	}

	const trpcError = error as TrpcLikeError;
	if (trpcError?.code && trpcStatusCode[trpcError.code]) {
		return new HTTPException(trpcStatusCode[trpcError.code] as any, {
			message: trpcError.message || fallbackMessage,
			cause: trpcError.cause,
		});
	}

	return new HTTPException(500, {
		message:
			error instanceof Error && error.message ? error.message : fallbackMessage,
	});
};