import type { AppOrchestrator } from "./app.ts";
import type { AnalyzeCommand, ThroughCommand } from "./commands.ts";
import type { ConfigService, Logger } from "./services.ts";

export class MainRouter {
	constructor(
		private readonly app: AppOrchestrator,
		private readonly analyze: AnalyzeCommand,
		private readonly through: ThroughCommand,
		private readonly config: ConfigService,
		private readonly logger: Logger
	) {}

	private parseArgs(argv: string[]): Record<string, string | boolean> {
		const pairs = argv.slice(2).map((p) => {
			const [k, v] = p.replace(/^--/, "").split("=");
			return [k, (v as string | undefined) ?? true] as const;
		});
		return Object.fromEntries(pairs) as Record<string, string | boolean>;
	}

	async run(argv: string[], env: NodeJS.ProcessEnv): Promise<void> {
		const args = this.parseArgs(argv);
		if (args["analyze"]) {
			await this.analyze.run(argv);
			return;
		}
		if (args["through"]) {
			await this.through.run(argv);
			return;
		}
		// default: scrape app
		const cfg = this.config.getConfig();
		await this.app.run(cfg.stationId, cfg.timeFrom, cfg.timeTo, cfg.outDir);
	}
}


