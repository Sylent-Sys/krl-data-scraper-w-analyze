import { Container, createToken } from "./di.ts";
import { AppOrchestrator } from "./app.ts";
import type { ConfigService, CsvService, HttpClient, KrlApiService, Logger, TimeService } from "./services.ts";
import { ConsoleLogger, DefaultKrlApiService, DefaultTimeService, EnvCliConfigService, FetchHttpClient, SimpleCsvService } from "./services.ts";

export const TOKENS = {
	Config: createToken<ConfigService>("ConfigService"),
	Logger: createToken<Logger>("Logger"),
	Time: createToken<TimeService>("TimeService"),
	Http: createToken<HttpClient>("HttpClient"),
	Csv: createToken<CsvService>("CsvService"),
	Api: createToken<KrlApiService>("KrlApiService"),
	App: createToken<AppOrchestrator>("AppOrchestrator")
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

	return c;
}


