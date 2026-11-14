import { timingSafeEqual } from "node:crypto";
import { msg } from "@doco/shared/i18n";

interface SetupEnvironment {
  BRAINO_SETUP_TOKEN?: string;
}

/** Why setup can't go on, as text to show with `t(error)`. */
export function setupTokenError(
  supplied: string,
  env: SetupEnvironment = process.env,
): string | null {
  const expected = env.BRAINO_SETUP_TOKEN?.trim();
  if (!expected || expected.length < 32) {
    return msg("BRAINO_SETUP_TOKEN must contain at least 32 characters before first-run setup.");
  }
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied.trim());
  if (
    suppliedBytes.length !== expectedBytes.length ||
    !timingSafeEqual(suppliedBytes, expectedBytes)
  ) {
    return msg("Setup token is incorrect.");
  }
  return null;
}
