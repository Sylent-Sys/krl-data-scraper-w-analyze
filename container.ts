import { Container, createToken } from "./di.ts";
import { AppOrchestrator } from "./app.ts";
import type { ConfigService, CsvService, HttpClient, KrlApiService, Logger, TimeService } from "./services.ts";
import { ConsoleLogger, DefaultKrlApiService, DefaultTimeService, EnvCliConfigService, FetchHttpClient, SimpleCsvService } from "./services.ts";
import { MainRouter } from "./main.ts";
import { AnalyzeCommand, ThroughCommand } from "./commands.ts";

export const TOKENS = {
	Config: createToken<ConfigService>("ConfigService"),
	Logger: createToken<Logger>("Logger"),
	Time: createToken<TimeService>("TimeService"),
	Http: createToken<HttpClient>("HttpClient"),
	Csv: createToken<CsvService>("CsvService"),
	Api: createToken<KrlApiService>("KrlApiService"),
	App: createToken<AppOrchestrator>("AppOrchestrator"),
	Analyze: createToken<AnalyzeCommand>("AnalyzeCommand"),
	Through: createToken<ThroughCommand>("ThroughCommand"),
	Main: createToken<MainRouter>("MainRouter")
} as const;

export function buildContainer(argv: string[] = process.argv, env: NodeJS.ProcessEnv = process.env): Container {
	const c = new Container();

	c.registerSingleton(TOKENS.Config, () => new EnvCliConfigService(argv, env));
	c.registerSingleton(TOKENS.Logger, () => new ConsoleLogger());
	c.registerSingleton(TOKENS.Time, () => new DefaultTimeService());
	c.registerSingleton(TOKENS.Csv, () => new SimpleCsvService());
	c.registerSingleton(TOKENS.Http, (ctn) => {
		const cfg = ctn.resolve(TOKENS.Config).getConfig();
		return new FetchHttpClient(cfg.token);
	});
	c.registerSingleton(TOKENS.Api, (ctn) => {
		const cfg = ctn.resolve(TOKENS.Config).getConfig();
		const http = ctn.resolve(TOKENS.Http);
		return new DefaultKrlApiService(cfg.apiBase, http);
	});
	c.registerSingleton(TOKENS.App, (ctn) => new AppOrchestrator(
		ctn.resolve(TOKENS.Api),
		ctn.resolve(TOKENS.Csv),
		ctn.resolve(TOKENS.Time),
		ctn.resolve(TOKENS.Logger)
	));

	c.registerSingleton(TOKENS.Analyze, (ctn) => new AnalyzeCommand(
		ctn.resolve(TOKENS.Csv),
		ctn.resolve(TOKENS.Logger)
	));

	c.registerSingleton(TOKENS.Through, (ctn) => new ThroughCommand(
		ctn.resolve(TOKENS.Logger)
	));

	c.registerSingleton(TOKENS.Main, (ctn) => new MainRouter(
		ctn.resolve(TOKENS.App),
		ctn.resolve(TOKENS.Analyze),
		ctn.resolve(TOKENS.Through),
		ctn.resolve(TOKENS.Config),
		ctn.resolve(TOKENS.Logger)
	));

	return c;
}


