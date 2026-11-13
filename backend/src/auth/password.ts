let dummyHashPromise: Promise<string> | null = null;

export async function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, {
    algorithm: "argon2id",
    memoryCost: 65_536,
    timeCost: 2,
  });
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  try {
    return await Bun.password.verify(password, hash);
  } catch {
    return false;
  }
}

export function dummyPasswordHash(): Promise<string> {
  dummyHashPromise ??= hashPassword("forcare-synthetic-dummy-password");
  return dummyHashPromise;
}
