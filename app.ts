import fs from "node:fs/promises";
import path from "node:path";
import type { CsvService, KrlApiService, Logger, TimeService } from "./services.ts";
import type { LegRow, StopRow, TrainSummaryRow } from "./domain.ts";

export class AppOrchestrator {
	constructor(
		private readonly api: KrlApiService,
		private readonly csv: CsvService,
		private readonly time: TimeService,
		private readonly logger: Logger
	) {}

	async run(stationId: string, timeFrom: string, timeTo: string, outDir: string): Promise<void> {
		const stationsAll = await this.api.fetchStations();
		const stationMatch = stationsAll.find(s => s.sta_id.toUpperCase() === stationId.toUpperCase());
		if (!stationMatch) {
			const suggestions = stationsAll
				.filter(s => s.fg_enable === 1)
				.slice(0, 20)
				.map(s => `${s.sta_id} (${s.sta_name})`)
				.join(", ");
			this.logger.error(`ERROR: stationId '${stationId}' tidak ditemukan di API krl-station.`);
			if (suggestions) this.logger.error(`Contoh stationId valid: ${suggestions}`);
			throw new Error("Station not found");
		}
		if (Number(stationMatch.fg_enable) !== 1) {
			this.logger.error(`ERROR: stationId '${stationId}' (${stationMatch.sta_name}) saat ini tidak aktif (fg_enable=0).`);
			throw new Error("Station disabled");
		}

		// Prepare output directory: create subfolder "stationId from to" and sanitize for Windows paths
		const sanitizePathSegment = (s: string): string => s.replace(/[:<>"/\\|?*]/g, "-").trim();
		const subFolderName = `${sanitizePathSegment(stationId)}-${sanitizePathSegment(timeFrom)}-${sanitizePathSegment(timeTo)}`;
		const runOutDir = path.join(outDir, subFolderName);
		await fs.mkdir(runOutDir as unknown as import("node:fs").PathLike, { recursive: true });
		this.logger.info(`Scraping station=${stationId} from=${timeFrom} to=${timeTo} ...`);
		const schedule = await this.api.fetchSchedule(stationId, timeFrom, timeTo);

		const trainsSummary: TrainSummaryRow[] = schedule.map(o => ({
			query_station: stationId,
			time_from: timeFrom,
			time_to: timeTo,
			train_id: o.train_id,
			ka_name: o.ka_name,
			route_name: o.route_name,
			dest: o.dest,
			color: o.color,
			time_est: o.time_est,
			dest_time: o.dest_time
		}));

		const stopsAll: StopRow[] = [];
		const legsAll: LegRow[] = [];

		let done = 0;
		// Limit concurrent fetchTrain calls (batching) to avoid overwhelming the API
		const mapWithConcurrency = async <T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<PromiseSettledResult<R>[]> => {
			const results: PromiseSettledResult<R>[] = new Array(items.length);
			let nextIndex = 0;
			const worker = async (): Promise<void> => {
				while (true) {
					const i = nextIndex++;
					if (i >= items.length) break;
					try {
						const value = await fn(items[i]!, i);
						results[i] = { status: "fulfilled", value } as PromiseFulfilledResult<R>;
					} catch (reason) {
						results[i] = { status: "rejected", reason } as PromiseRejectedResult;
					}
				}
			};
			const workerCount = Math.min(limit, items.length);
			await Promise.all(Array.from({ length: workerCount }, () => worker()));
			return results;
		};

		const results = await mapWithConcurrency(trainsSummary, 10, async (t) => {
			try {
				const stops = await this.api.fetchTrain(t.train_id);
				const header = stops[0];
				const localStops: StopRow[] = [];
				const localLegs: LegRow[] = [];
				for (let i = 0; i < stops.length; i++) {
					const s = stops[i]!;
					localStops.push({
						train_id: t.train_id,
						ka_name: t.ka_name,
						route_name: t.route_name,
						color: t.color,
						query_station: stationId,
						stop_index: i,
						station_name: s.station_name,
						time_est: s.time_est,
						time_est_min: this.time.hmsToMin(s.time_est),
						transit_station: !!s.transit_station,
						transit_colors: Array.isArray(s.transit)
							? s.transit.join("|")
							: (typeof s.transit === "string" ? s.transit : ""),
						header_station: header?.station_name ?? "",
					});
					if (i > 0) {
						const prev = stops[i - 1]!;
						localLegs.push({
							train_id: t.train_id,
							from_index: i - 1,
							from_station: prev.station_name,
							to_index: i,
							to_station: s.station_name,
							leg_minutes: this.time.diffMin(prev.time_est, s.time_est),
							ka_name: t.ka_name,
							route_name: t.route_name,
							color: t.color
						});
					}
				}
				return { ok: true as const, stops: localStops, legs: localLegs, trainId: t.train_id };
			} catch (err) {
				return {
					ok: false as const,
					trainId: t.train_id,
					ka_name: t.ka_name,
					route_name: t.route_name,
					color: t.color,
					reason: String(err instanceof Error ? err.message : err)
				};
			} finally {
				done++;
				this.logger.progress(`  • selesai ${done}/${trainsSummary.length}\r`);
			}
		});
		this.logger.progress("\n");

		for (const r of results) {
			if (r.status === "fulfilled") {
				if (r.value.ok) {
					stopsAll.push(...r.value.stops);
					legsAll.push(...r.value.legs);
				} else {
					this.logger.error(
						`Gagal memproses train ${r.value.trainId} (${r.value.ka_name} - ${r.value.route_name} - ${r.value.color}): ${r.value.reason}`
					);
				}
			} else {
				this.logger.error("Gagal memproses satu train: " + String(r.reason));
			}
		}

		await fs.writeFile(path.join(runOutDir, "trains.csv"),
			this.csv.toCSV(trainsSummary, [
				"query_station", "time_from", "time_to", "train_id", "ka_name", "route_name", "dest", "color", "time_est", "dest_time"
			])
		);
		await fs.writeFile(path.join(runOutDir, "stops.csv"),
			this.csv.toCSV(stopsAll, [
				"train_id", "stop_index", "station_name", "time_est", "time_est_min",
				"transit_station", "transit_colors", "ka_name", "route_name", "color", "query_station", "header_station"
			])
		);
		await fs.writeFile(path.join(runOutDir, "legs.csv"),
			this.csv.toCSV(legsAll, [
				"train_id", "from_index", "from_station", "to_index", "to_station", "leg_minutes", "ka_name", "route_name", "color"
			])
		);

		this.logger.info(`Selesai. File CSV ada di: ${path.resolve(runOutDir)}`);
		this.logger.info(`- trains.csv  : ringkasan kereta dari endpoint schedule`);
		this.logger.info(`- stops.csv   : daftar stop/ETA tiap stasiun`);
		this.logger.info(`- legs.csv    : durasi antar stasiun (menit)`);
	}
}


