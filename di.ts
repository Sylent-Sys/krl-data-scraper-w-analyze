export type Token<T> = symbol & { __t?: T };

export function createToken<T>(description: string): Token<T> {
	return Symbol(description) as Token<T>;
}

export class Container {
	private readonly factories = new Map<Token<any>, (c: Container) => any>();
	private readonly singletons = new Map<Token<any>, any>();

	registerFactory<T>(token: Token<T>, factory: (c: Container) => T): void {
		this.factories.set(token, factory);
	}

	registerSingleton<T>(token: Token<T>, factory: (c: Container) => T): void {
		const lazy = (c: Container) => {
			if (!this.singletons.has(token)) {
				this.singletons.set(token, factory(c));
			}
			return this.singletons.get(token) as T;
		};
		this.factories.set(token, lazy);
	}

	resolve<T>(token: Token<T>): T {
		const f = this.factories.get(token);
		if (!f) throw new Error(`No provider for token: ${String(token.description)}`);
		return f(this);
	}
}


