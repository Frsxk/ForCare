import { readNurseEmailDomain, readServerConfig } from "../src/config";
import { AppError } from "../src/http/errors";
import { createOperatorAssignmentService } from "../src/patients/operator-service";
import { createDatabase } from "../src/storage/database";

function flag(name: string): string | undefined {
  const index = Bun.argv.indexOf(`--${name}`);
  return index >= 0 ? Bun.argv[index + 1] : undefined;
}

function requiredFlag(name: string): string {
  const value = flag(name)?.trim();
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function requiredVersion(): number {
  const raw = requiredFlag("expected-version");
  if (!/^\d+$/.test(raw)) throw new Error("--expected-version must be a non-negative integer");
  return Number(raw);
}

async function main() {
  const command = Bun.argv[2];
  if (command !== "record" && command !== "primary") {
    throw new Error("usage: patient-assignment.ts record|primary --patient-id ... --operator ... --approval-ref ... --expected-version ...");
  }
  const config = readServerConfig(process.env);
  const sql = createDatabase(config.database, { max: 1, connectionTimeout: 5, idleTimeout: 5 });
  try {
    const service = createOperatorAssignmentService({
      sql,
      config: { nurseEmailDomain: readNurseEmailDomain(process.env) },
    });
    const patientId = requiredFlag("patient-id");
    const operator = requiredFlag("operator");
    const approvalReference = requiredFlag("approval-ref");
    const expectedVersion = requiredVersion();
    if (command === "record") {
      const result = await service.assignRecordNumber({
        patientId,
        recordNumber: requiredFlag("record-number"),
        expectedVersion,
        operator,
        approvalReference,
      });
      console.log(JSON.stringify(result));
      return;
    }
    const result = await service.assignPrimaryNurse({
      patientId,
      nurseId: requiredFlag("nurse-id"),
      expectedVersion,
      operator,
      approvalReference,
    });
    console.log(JSON.stringify(result));
  } finally {
    await sql.close();
  }
}

try {
  await main();
} catch (error) {
  if (error instanceof AppError) {
    console.error(`${error.code}: ${error.message}`);
  } else {
    console.error("Patient assignment failed");
  }
  process.exitCode = 1;
}
