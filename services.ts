import { z } from "zod/v4";
import type { PrimitiveCsv } from "./domain.ts";

// Config service
export interface AppConfig {
	apiBase: string;
	token: string;
	outDir: string;
	stationId: string;
	timeFrom: string;
	timeTo: string;
}

export interface ConfigService {
	getConfig(): AppConfig;
}

export class EnvCliConfigService implements ConfigService {
	constructor(private readonly argv: string[], private readonly env: NodeJS.ProcessEnv) {}

	private getStringArg(map: Record<string, string | boolean>, key: string, fallback: string): string {
		const v = map[key];
		return typeof v === "string" && v.length > 0 ? v : fallback;
	}

	getConfig(): AppConfig {
		const apiBase = (this.env.KRL_API_BASE?.replace(/\/$/, "") || "https://api-partner.krl.co.id");
		const token = this.env.KRL_TOKEN;
		if (!token) throw new Error("Env KRL_TOKEN belum diset");
		const args: Record<string, string | boolean> = Object.fromEntries(
			this.argv.slice(2).map((p: string) => {
				const [k, v] = p.replace(/^--/, "").split("=");
				return [k, (v as string | undefined) ?? true];
			})
		);
		const stationId: string = this.getStringArg(args, "station", this.getStringArg(args, "s", "THB"));
		const timeFrom: string = this.getStringArg(args, "from", "00:00");
		const timeTo: string = this.getStringArg(args, "to", this.getStringArg(args, "timeto", "23:00"));
		const outDir: string = this.getStringArg(args, "out", "./out");
		return { apiBase, token, outDir, stationId, timeFrom, timeTo };
	}
}

// Logger service
export interface Logger {
	info(msg: string): void;
	error(msg: string): void;
	progress(msg: string): void;
}

export class ConsoleLogger implements Logger {
	info(msg: string): void { console.log(msg); }
	error(msg: string): void { console.error(msg); }
	progress(msg: string): void { process.stdout.write(msg); }
}

// Time utils
export interface TimeService {
	hmsToMin(hms: string | null | undefined): number | null;
	diffMin(aHms: string | null | undefined, bHms: string | null | undefined): number | null;
}

export class DefaultTimeService implements TimeService {
	private static readonly MIN_IN_DAY = 24 * 60;
	hmsToMin(hms: string | null | undefined): number | null {
		if (!hms) return null;
		const [hStr, mStr, sStr = "0"] = hms.split(":");
		const h = Number(hStr);
		const m = Number(mStr);
		const s = Number(sStr);
		if (Number.isNaN(h) || Number.isNaN(m)) return null;
		return h * 60 + m + (Number.isNaN(s) ? 0 : s / 60);
	}
	diffMin(aHms: string | null | undefined, bHms: string | null | undefined): number | null {
		const a = this.hmsToMin(aHms);
		const b = this.hmsToMin(bHms);
		if (a == null || b == null) return null;
		let d = b - a;
		if (d < 0) d += DefaultTimeService.MIN_IN_DAY;
		return d;
	}
}

// HTTP client
export interface HttpClient {
	getJSON<T>(url: string, opts?: { timeoutMs?: number; retries?: number }): Promise<T>;
}

export class FetchHttpClient implements HttpClient {
	constructor(private readonly token: string) {}

	async getJSON<T = unknown>(
		url: string,
		{ timeoutMs = 15000, retries = 2 }: { timeoutMs?: number; retries?: number } = {}
	): Promise<T> {
		for (let attempt = 0; attempt <= retries; attempt++) {
			const ctrl = new AbortController();
			const t = setTimeout(() => ctrl.abort(), timeoutMs);
			try {
				const res = await fetch(url, {
					headers: {
						"Authorization": `Bearer ${this.token}`,
						"Accept": "application/json",
						"User-Agent": "Mozilla/5.0"
					},
					signal: ctrl.signal
				});
				clearTimeout(t);
				if (!res.ok) {
					const body = await res.text().catch(() => "");
					throw new Error(`HTTP ${res.status} ${res.statusText}: ${body.slice(0, 200)}`);
				}
				return (await res.json()) as T;
			} catch (e) {
				clearTimeout(t);
				if (attempt === retries) throw e;
				await new Promise(r => setTimeout(r, 750 * (attempt + 1)));
			}
		}
		throw new Error("Request failed after retries");
	}
}

// CSV
export interface CsvService {
	toCSV<T extends Record<string, PrimitiveCsv>>(rows: T[], headerOrder?: string[]): string;
}

export class SimpleCsvService implements CsvService {
	toCSV<T extends Record<string, PrimitiveCsv>>(rows: T[], headerOrder?: string[]): string {
		if (!rows.length) return "";
		const headers = headerOrder ?? Array.from(new Set(rows.flatMap(r => Object.keys(r as Record<string, PrimitiveCsv>)))) as string[];
		const esc = (v: PrimitiveCsv) => {
			const s = v == null ? "" : String(v);
			return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
		};
		return [
			headers.join(","),
			...rows.map(r => headers.map(h => esc((r as Record<string, PrimitiveCsv>)[h])).join(","))
		].join("\n");
	}
}

// API service
export const StationMetaSchema = z.object({
	sta_id: z.string(),
	sta_name: z.string(),
	group_wil: z.number(),
	fg_enable: z.number()
});
export type StationMeta = z.infer<typeof StationMetaSchema>;

export const ScheduleItemSchema = z.object({
	train_id: z.string(),
	ka_name: z.string(),
	route_name: z.string(),
	dest: z.string(),
	color: z.string(),
	time_est: z.string(),
	dest_time: z.string()
});
export type ScheduleItem = z.infer<typeof ScheduleItemSchema>;

export const TrainStopSchema = z.object({
	station_name: z.string(),
	time_est: z.string(),
	transit_station: z.union([z.boolean(), z.literal(0), z.literal(1)]).nullish(),
	transit: z.union([z.array(z.string()), z.string()]).nullable().optional()
});
export type TrainStop = z.infer<typeof TrainStopSchema>;

function makeEnvelopeSchema<T extends z.ZodTypeAny>(inner: T) {
	return z.object({ data: z.array(inner).optional() });
}

export interface KrlApiService {
	fetchStations(): Promise<StationMeta[]>;
	fetchSchedule(sta: string, from: string, to: string): Promise<ScheduleItem[]>;
	fetchTrain(trainId: string): Promise<TrainStop[]>;
}

export class DefaultKrlApiService implements KrlApiService {
	constructor(private readonly base: string, private readonly http: HttpClient) {}

	async fetchStations(): Promise<StationMeta[]> {
		const url = `${this.base}/krl-webs/v1/krl-station`;
		const j = await this.http.getJSON<unknown>(url);
		const parsed = makeEnvelopeSchema(StationMetaSchema).parse(j);
		return parsed.data ?? [];
	}

	async fetchSchedule(sta: string, from: string, to: string): Promise<ScheduleItem[]> {
		const url = `${this.base}/krl-webs/v1/schedule?stationid=${encodeURIComponent(sta)}&timefrom=${encodeURIComponent(from)}&timeto=${encodeURIComponent(to)}`;
		const j = await this.http.getJSON<unknown>(url);
		const parsed = makeEnvelopeSchema(ScheduleItemSchema).parse(j);
		return parsed.data ?? [];
	}

	async fetchTrain(trainId: string): Promise<TrainStop[]> {
		const url = `${this.base}/krl-webs/v1/schedule-train?trainid=${encodeURIComponent(trainId)}`;
		const j = await this.http.getJSON<unknown>(url);
		const parsed = makeEnvelopeSchema(TrainStopSchema).parse(j);
		return parsed.data ?? [];
	}
}


