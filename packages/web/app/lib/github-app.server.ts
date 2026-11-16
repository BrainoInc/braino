export function githubEncryptionKey(): string {
  const value = process.env.DOCO_ENCRYPTION_KEY?.trim();
  if (!value || value.length < 32) {
    throw new Error("DOCO_ENCRYPTION_KEY must contain at least 32 characters.");
  }
  return value;
}

export function githubPublicUrl(request: Request): string {
  return (process.env.DOCO_PUBLIC_HOST ?? new URL(request.url).origin).replace(/\/$/, "");
}
