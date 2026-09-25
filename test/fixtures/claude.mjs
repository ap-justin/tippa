// stands in for claude in the process table: its own argv is what the helper reads.
// usage: node claude.mjs [claude args...] --run <command...>
import { spawn } from "node:child_process";

const argv = process.argv.slice(2);
const [command, ...args] = argv.slice(argv.indexOf("--run") + 1);
const child = spawn(command, args, { stdio: "inherit" });
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
	process.on(signal, () => child.kill(signal));
}
child.on("exit", (code) => process.exit(code ?? 1));
