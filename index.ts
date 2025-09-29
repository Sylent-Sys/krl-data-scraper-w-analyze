#!/usr/bin/env bun
import { buildContainer, TOKENS } from "./container.ts";

const container = buildContainer();

try {
	await container.resolve(TOKENS.Main).run(process.argv, process.env);
} catch (err) {
	container.resolve(TOKENS.Logger).error(String(err instanceof Error ? err.message : err));
	process.exit(1);
}
