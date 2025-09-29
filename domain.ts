export type PrimitiveCsv = string | number | boolean | null | undefined;

export interface TrainSummaryRow {
	query_station: string;
	time_from: string;
	time_to: string;
	train_id: string;
	ka_name: string;
	route_name: string;
	dest: string;
	color: string;
	time_est: string;
	dest_time: string;
	[key: string]: PrimitiveCsv;
}

export interface StopRow {
	train_id: string;
	ka_name: string;
	route_name: string;
	color: string;
	query_station: string;
	stop_index: number;
	station_name: string;
	time_est: string;
	time_est_min: number | null;
	transit_station: boolean;
	transit_colors: string;
	header_station: string;
	[key: string]: PrimitiveCsv;
}

export interface LegRow {
	train_id: string;
	from_index: number;
	from_station: string;
	to_index: number;
	to_station: string;
	leg_minutes: number | null;
	ka_name: string;
	route_name: string;
	color: string;
	[key: string]: PrimitiveCsv;
}


