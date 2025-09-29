#!/usr/bin/env bun
import { buildContainer, TOKENS } from "./container.ts";

const container = buildContainer();
const cfg = container.resolve(TOKENS.Config).getConfig();

try {
	await container.resolve(TOKENS.App).run(cfg.stationId, cfg.timeFrom, cfg.timeTo, cfg.outDir);
} catch (err) {
	container.resolve(TOKENS.Logger).error(String(err instanceof Error ? err.message : err));
	process.exit(1);
}
