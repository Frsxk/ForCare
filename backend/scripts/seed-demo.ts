import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, realpath, rm } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { hashPassword } from "../src/auth/password";
import { readNurseEmailDomain, readServerConfig } from "../src/config";
import { AppError } from "../src/http/errors";
import { normalizeEmail } from "../src/http/request";
import { provisionNurseInTransaction } from "../src/staff/provisioning";
import { createDatabase } from "../src/storage/database";

const APPROVED_DOMAIN = "nurse.invalid";
const NURSES = [
  { label: "Ayu Pratama", fullName: "Ayu Pratama", staffCode: "NUR-001", email: "ayu@nurse.invalid" },
  { label: "Bima Santoso", fullName: "Bima Santoso", staffCode: "NUR-002", email: "bima@nurse.invalid" },
  { label: "Citra Lestari", fullName: "Citra Lestari", staffCode: "NUR-003", email: "citra@nurse.invalid" },
];

function flag(name: string): string | undefined {
  const index = Bun.argv.indexOf(`--${name}`);
  return index >= 0 ? Bun.argv[index + 1] : undefined;
}

function requiredFlag(name: string): string {
  const value = flag(name)?.trim();
  if (!value) throw new Error(`seed aborted: --${name} is required`);
  return value;
}

async function resolveOutsideOutput(outputArgument: string): Promise<string> {
  const repositoryRoot = await realpath(fileURLToPath(new URL("../..", import.meta.url)));
  const output = resolve(outputArgument);
  if (output === repositoryRoot || output.startsWith(`${repositoryRoot}${sep}`)) {
    throw new Error("seed aborted: --output must be outside the repository");
  }

  const parent = dirname(output);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  // Resolve the effective parent after creation so a symlinked path cannot
  // smuggle the credentials file back inside the repository. A concurrent
  // directory swap is outside this check's threat model (openat would be
  // required to exclude it fully).
  const realParent = await realpath(parent);
  if (realParent === repositoryRoot || realParent.startsWith(`${repositoryRoot}${sep}`)) {
    throw new Error("seed aborted: --output must be outside the repository");
  }
  return join(realParent, basename(output));
}

async function main() {
  if (flag("confirm") !== "synthetic-demo-nurses") {
    throw new Error("seed aborted: --confirm synthetic-demo-nurses is required");
  }
  const outputArgument = requiredFlag("output");
  const operator = requiredFlag("operator");
  const approvalReference = requiredFlag("approval-ref");
  const nurseDomain = readNurseEmailDomain(process.env);
  if (!nurseDomain || nurseDomain !== APPROVED_DOMAIN) {
    throw new AppError("GATE_UNAVAILABLE", `seed requires AUTH_NURSE_EMAIL_DOMAIN=${APPROVED_DOMAIN}`, 503, {
      gate: "G01",
    });
  }

  const output = await resolveOutsideOutput(outputArgument);

  const config = readServerConfig(process.env);
  const sql = createDatabase(config.database, { max: 2, connectionTimeout: 5, idleTimeout: 5 });
  let credentialsWritten = false;
  try {
    const prepared = NURSES.map((nurse) => ({ ...nurse, email: normalizeEmail(nurse.email) }));
    const collisions = await sql.begin(async (tx) => {
      const found: string[] = [];
      for (const nurse of prepared) {
        const rows = (await tx`
          SELECT 1 FROM public.accounts WHERE email_normalized = ${nurse.email}
          UNION ALL
          SELECT 1 FROM public.staff WHERE staff_code = ${nurse.staffCode}
          LIMIT 1
        `) as unknown as unknown[];
        if (rows.length > 0) found.push(nurse.label);
      }
      return found;
    });
    if (collisions.length > 0) {
      throw new Error(`seed aborted: existing identity collision for ${collisions.join(", ")}; no records were changed`);
    }

    const credentials = await Promise.all(
      prepared.map(async (nurse) => ({
        label: nurse.label,
        fullName: nurse.fullName,
        staffCode: nurse.staffCode,
        email: nurse.email,
        password: randomBytes(24).toString("base64url"),
      })),
    );
    const handle = await open(
      output,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    credentialsWritten = true;
    try {
      await handle.writeFile(
        `${JSON.stringify(
          {
            generatedAt: new Date().toISOString(),
            nurseDomain,
            nurses: credentials,
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
    } finally {
      await handle.close();
    }

    const passwordHashes = await Promise.all(credentials.map((entry) => hashPassword(entry.password)));
    await sql.begin(async (tx) => {
      for (const [index, nurse] of prepared.entries()) {
        const rows = (await tx`
          SELECT 1 FROM public.accounts WHERE email_normalized = ${nurse.email}
          UNION ALL
          SELECT 1 FROM public.staff WHERE staff_code = ${nurse.staffCode}
          LIMIT 1
        `) as unknown as unknown[];
        if (rows.length > 0) {
          throw new Error(`seed aborted: existing identity collision for ${nurse.label}; no records were changed`);
        }
        await provisionNurseInTransaction(tx, {
          email: nurse.email,
          passwordHash: passwordHashes[index],
          staffCode: nurse.staffCode,
          displayName: nurse.fullName,
          approvalReference,
          operator,
          nurseDomain,
        });
      }
    });
    console.log(`Synthetic nurse seed complete: ${prepared.length} staff accounts provisioned. Credentials file: ${output}`);
  } catch (error) {
    if (credentialsWritten) await rm(output, { force: true });
    throw error;
  } finally {
    await sql.close();
  }
}

try {
  await main();
} catch (error) {
  if (error instanceof AppError) {
    console.error(`${error.code}: ${error.message}`);
  } else if (error instanceof Error) {
    console.error(error.message);
  } else {
    console.error("Synthetic nurse seed failed");
  }
  process.exitCode = 1;
}
